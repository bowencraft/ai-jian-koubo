#!/usr/bin/env node
/**
 * 审核服务器
 *
 * 功能：
 * 1. 提供静态文件服务（review.html, audio.mp3）
 * 2. POST /api/fcpxml - 接收删除列表，导出 FCPXML 工程文件（可导入剪映 / Final Cut Pro）
 * 3. POST /api/audio /api/srt - 导出按审核结果剪好的 MP3 音频和 SRT 字幕
 *
 * 用法: node review_server.js [port] [video_file]
 * video_file 可选：没有转录/审核数据时，服务会把根路径指向 editor.html，作为项目启动器。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { buildFcpxml, buildTimelineFcpxml } = require('./lib/fcpxml');
const { computeFinalKeeps } = require('./lib/compute_keeps');
const {
  buildEditedSrt,
  normalizeBitrate,
  runEditedAudioExport,
  totalKeepDuration,
} = require('./lib/review_exports');
const { createLegacyProject, normalizeProject, stripProjectWaveforms } = require('./lib/timeline_project');
const { hashBuffer, findDuplicateAsset } = require('./lib/asset_dedupe');
const { resolveReviewPlaybackFile } = require('./lib/review_media');
const { renderTimelineAudio, timelineAudioSignature } = require('./lib/timeline_audio');
const { writeReviewAudioAnalysis } = require('./lib/review_audio_analysis');

const PORT = process.argv[2] || 8899;
const VIDEO_FILE = process.argv[3];

if (VIDEO_FILE && !fs.existsSync(VIDEO_FILE)) {
  console.error(`❌ 错误: 视频文件不存在: ${VIDEO_FILE}`);
  process.exit(1);
}

// 静音边界，由 generate_review.js 预计算（对 audio.mp3 跑 silencedetect，自适应阈值 = 峰值 - 35dB）
// 切割算法本身在 lib/compute_keeps.js（前后端共用，单一来源）
let silencePeriods = [];
try {
  silencePeriods = JSON.parse(fs.readFileSync('silence_periods.json', 'utf8'));
  silencePeriods.sort((a, b) => a.start - b.start); // 确保按时间升序
  console.log('🔕 读取到 ' + silencePeriods.length + ' 个静音段');
} catch (e) {
  console.warn('⚠️ 读取 silence_periods.json 失败，末尾裁剪已跳过');
}

// 自进化学习需要的原料：词级文本（重建上下文）+ AI 初选 idx（diff 基线）。
// 都在 data.json（generate_review.js 生成，与本进程同在 3_审核/）里，启动时读一次。
let reviewWords = [];
let aiSelectedIdx = [];
try {
  const d = JSON.parse(fs.readFileSync('data.json', 'utf8'));
  reviewWords = Array.isArray(d.words) ? d.words : [];
  aiSelectedIdx = Array.isArray(d.autoSelected) ? d.autoSelected : [];
} catch (e) {
  console.warn('⚠️ 读取 data.json 失败，导出时将无法生成 review_log.json（自进化学习日志）');
}

const reviewDuration = reviewWords.reduce((max, w) => {
  const end = Number(w && w.end);
  return Number.isFinite(end) && end > max ? end : max;
}, 0);

const PROJECT_FILE = path.resolve('project.json');
const WAVEFORM_CACHE_FILE = path.resolve('waveform_cache.json');
const REVIEW_AUDIO_FILE = path.resolve('audio.mp3');
const REVIEW_AUDIO_SIGNATURE_FILE = path.resolve('.review_audio_signature');

function readWaveformCache() {
  try {
    const parsed = JSON.parse(fs.readFileSync(WAVEFORM_CACHE_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' && parsed.assets && typeof parsed.assets === 'object'
      ? parsed.assets
      : {};
  } catch (err) {
    return {};
  }
}

function writeWaveformCache(project) {
  const previous = readWaveformCache();
  const assets = {};
  project.assets.forEach((asset) => {
    if (Array.isArray(asset.waveform) && asset.waveform.length) {
      assets[asset.id] = asset.waveform;
    } else if (Array.isArray(previous[asset.id])) {
      assets[asset.id] = previous[asset.id];
    }
  });
  if (Object.keys(assets).length) {
    fs.writeFileSync(WAVEFORM_CACHE_FILE, JSON.stringify({
      version: 1,
      updatedAt: new Date().toISOString(),
      assets,
    }));
  } else if (fs.existsSync(WAVEFORM_CACHE_FILE)) {
    fs.unlinkSync(WAVEFORM_CACHE_FILE);
  }
}

function attachCachedWaveforms(project) {
  const cache = readWaveformCache();
  if (!Object.keys(cache).length) return project;
  return normalizeProject({
    ...project,
    assets: project.assets.map(asset => (
      Array.isArray(asset.waveform) || !Array.isArray(cache[asset.id])
        ? asset
        : { ...asset, waveform: cache[asset.id] }
    )),
  });
}

function reviewReady() {
  return fs.existsSync('data.json') && fs.existsSync('review.html');
}

function readProject() {
  if (fs.existsSync(PROJECT_FILE)) {
    return attachCachedWaveforms(normalizeProject(JSON.parse(fs.readFileSync(PROJECT_FILE, 'utf8'))));
  }
  if (!VIDEO_FILE) {
    return normalizeProject({ version: 1, name: path.basename(process.cwd()), assets: [], clips: [] });
  }
  const legacyProject = createLegacyProject({ videoFile: VIDEO_FILE, duration: reviewDuration });
  fs.writeFileSync(PROJECT_FILE, JSON.stringify(legacyProject, null, 2));
  return legacyProject;
}

function writeProject(project) {
  const normalized = normalizeProject(project);
  writeWaveformCache(normalized);
  fs.writeFileSync(PROJECT_FILE, JSON.stringify({
    ...stripProjectWaveforms(normalized),
    updatedAt: new Date().toISOString(),
  }, null, 2));
  return normalized;
}

function readReviewAudioSignature() {
  try {
    return fs.readFileSync(REVIEW_AUDIO_SIGNATURE_FILE, 'utf8').trim();
  } catch (err) {
    return '';
  }
}

function writeReviewAudioSignature(signature) {
  fs.writeFileSync(REVIEW_AUDIO_SIGNATURE_FILE, signature + '\n');
}

function markTranscriptStale(project) {
  const previous = project.transcript && typeof project.transcript === 'object' ? project.transcript : {};
  if (previous.status === 'stale') return project;
  return normalizeProject({
    ...project,
    transcript: {
      ...previous,
      status: 'stale',
      reason: 'timeline audio changed',
      markedAt: new Date().toISOString(),
    },
  });
}

function refreshReviewAudioIfNeeded(project, signature, { force = false } = {}) {
  if (!reviewReady()) return { updated: false, skipped: 'review-not-ready' };
  const storedSignature = readReviewAudioSignature();
  const needsUpdate = force || !fs.existsSync(REVIEW_AUDIO_FILE) || storedSignature !== signature;
  if (!needsUpdate) return { updated: false, skipped: 'current' };

  const tmpAudio = path.resolve(`audio.tmp-${process.pid}-${Date.now()}.mp3`);
  try {
    renderTimelineAudio({
      project,
      outputFile: tmpAudio,
      projectDir: process.cwd(),
      stdio: 'pipe',
    });
    fs.renameSync(tmpAudio, REVIEW_AUDIO_FILE);
    const analysis = writeReviewAudioAnalysis({
      audioFile: REVIEW_AUDIO_FILE,
      outputDir: process.cwd(),
    });
    silencePeriods = analysis.silencePeriods;
    writeReviewAudioSignature(signature);
    return {
      updated: true,
      file: path.basename(REVIEW_AUDIO_FILE),
      peaksCount: analysis.peaksCount,
      silenceCount: analysis.silencePeriods.length,
      analysisWarning: analysis.silenceError || analysis.peaksError || null,
    };
  } catch (err) {
    try {
      if (fs.existsSync(tmpAudio)) fs.unlinkSync(tmpAudio);
    } catch (_) {
      // best effort cleanup for failed ffmpeg output
    }
    return { updated: false, error: err.message };
  }
}

let timelineProject;
try {
  timelineProject = readProject();
  console.log('🎛️ 项目时间线: ' + timelineProject.assets.length + ' 素材 / ' + timelineProject.clips.length + ' 片段');
} catch (e) {
  console.warn('⚠️ project.json 读取/迁移失败，多轨导出将回退单素材: ' + e.message);
  timelineProject = null;
}

const projectSignature = crypto
  .createHash('sha256')
  .update(JSON.stringify({
    words: reviewWords.map(w => ({
      text: w.text || '',
      start: Number.isFinite(w.start) ? Number(w.start.toFixed(3)) : null,
      end: Number.isFinite(w.end) ? Number(w.end.toFixed(3)) : null,
      isGap: !!w.isGap,
    })),
    aiSelectedIdx,
  }))
  .digest('hex');

const exportJobs = new Map();

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
};

function safeFileName(name) {
  const base = path.basename(String(name || 'media'));
  const cleaned = base.replace(/[^\w.\- \u4e00-\u9fff]/g, '_').replace(/\s+/g, '_');
  return cleaned || 'media';
}

function inferKind(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return ['.mp4', '.mov', '.m4v', '.webm'].includes(ext) ? 'video' : 'audio';
}

function toProjectRelative(filePath) {
  return path.relative(process.cwd(), filePath).split(path.sep).join('/');
}

function resolveMediaPath(filePath) {
  if (!filePath) return '';
  return path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
}

function getExportBaseName() {
  if (timelineProject && timelineProject.name) return safeFileName(timelineProject.name);
  if (VIDEO_FILE) return safeFileName(path.basename(VIDEO_FILE, path.extname(VIDEO_FILE)));
  return safeFileName(path.basename(process.cwd()) || 'review');
}

function parseExportPayload(body) {
  const parsed = JSON.parse(body || '{}');
  return {
    parsed,
    deleteList: Array.isArray(parsed) ? parsed : (parsed.deleteList || []),
    cutOpts: (parsed && !Array.isArray(parsed) && parsed.opts) ? parsed.opts : undefined,
    finalSelected: (parsed && !Array.isArray(parsed) && Array.isArray(parsed.finalSelected)) ? parsed.finalSelected : null,
  };
}

function getReviewAudioDuration() {
  let duration = reviewDuration;
  try {
    const probed = parseFloat(execFileSync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'csv=p=0',
      path.resolve('audio.mp3'),
    ]).toString().trim());
    if (Number.isFinite(probed) && probed > 0) duration = probed;
  } catch (err) {
    if (!duration) throw err;
  }
  return duration;
}

function computeReviewKeeps(deleteList, cutOpts) {
  const duration = getReviewAudioDuration();
  return {
    duration,
    finalKeeps: computeFinalKeeps(deleteList || [], silencePeriods || [], duration, cutOpts || {}),
  };
}

function publicExportJob(job) {
  const elapsedSeconds = Math.max(0, (Date.now() - job.startedAt) / 1000);
  const etaSeconds = job.status === 'running' && job.progress > 0.01
    ? Math.max(0, elapsedSeconds * (1 - job.progress) / job.progress)
    : null;
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    progress: Math.max(0, Math.min(1, job.progress || 0)),
    outTime: job.outTime || 0,
    duration: job.duration || 0,
    etaSeconds,
    elapsedSeconds,
    output: job.output,
    segments: job.segments,
    bitrate: job.bitrate,
    error: job.error || null,
    fileSize: job.fileSize || null,
  };
}

function rememberExportJob(job) {
  exportJobs.set(job.id, job);
  const timer = setTimeout(() => exportJobs.delete(job.id), 60 * 60 * 1000);
  if (timer.unref) timer.unref();
}

function streamFile(req, res, filePath, contentType) {
  const stat = fs.statSync(filePath);
  if (req.headers.range) {
    const range = req.headers.range.replace('bytes=', '').split('-');
    const start = parseInt(range[0], 10);
    const end = range[1] ? parseInt(range[1], 10) : stat.size - 1;
    res.writeHead(206, {
      'Content-Type': contentType,
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': stat.size,
    'Accept-Ranges': 'bytes',
  });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer((req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // 共享前端模块：从 scripts/lib 单一来源直供前端，避免拷贝漂移
  const libRequest = req.method === 'GET' ? req.url.split('?')[0] : '';
  if (libRequest === '/lib/compute_keeps.js' || libRequest === '/lib/review_timeline_view.js') {
    const libPath = path.join(__dirname, 'lib', path.basename(libRequest));
    if (fs.existsSync(libPath)) {
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      fs.createReadStream(libPath).pipe(res);
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
    return;
  }

  if (req.method === 'GET' && req.url === '/api/project') {
    try {
      timelineProject = readProject();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        project: timelineProject,
        reviewDuration,
        reviewReady: reviewReady(),
        projectFile: PROJECT_FILE,
        reviewDir: process.cwd(),
      }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  if (req.method === 'GET' && req.url.startsWith('/media/')) {
    try {
      timelineProject = readProject();
      const assetId = decodeURIComponent(req.url.replace('/media/', '').split('?')[0]);
      const asset = timelineProject.assets.find(a => a.id === assetId);
      const mediaPath = asset ? resolveMediaPath(asset.path) : '';
      if (!asset || !mediaPath || !fs.existsSync(mediaPath)) {
        res.writeHead(404);
        res.end('Media not found');
        return;
      }
      const ext = path.extname(mediaPath).toLowerCase();
      streamFile(req, res, mediaPath, MIME_TYPES[ext] || 'application/octet-stream');
    } catch (err) {
      res.writeHead(500);
      res.end(err.message);
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/api/project') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body || '{}');
        const previousProject = timelineProject || (fs.existsSync(PROJECT_FILE) ? readProject() : null);
        const beforeSignature = previousProject ? timelineAudioSignature(previousProject) : '';
        let nextProject = normalizeProject(parsed.project || parsed);
        const nextSignature = timelineAudioSignature(nextProject);
        const transcriptStale = reviewReady() && beforeSignature && beforeSignature !== nextSignature;
        if (transcriptStale) nextProject = markTranscriptStale(nextProject);
        timelineProject = writeProject(nextProject);
        const savedSignature = timelineAudioSignature(timelineProject);
        const reviewAudio = refreshReviewAudioIfNeeded(timelineProject, savedSignature);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          project: timelineProject,
          reviewReady: reviewReady(),
          reviewAudio,
          transcriptStale,
          projectFile: PROJECT_FILE,
          reviewDir: process.cwd(),
        }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url.startsWith('/api/upload')) {
    const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);
    const originalName = safeFileName(parsedUrl.searchParams.get('name') || 'media');
    const kind = parsedUrl.searchParams.get('kind') || inferKind(originalName);

    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      try {
        const buffer = Buffer.concat(chunks);
        const contentHash = hashBuffer(buffer);
        const fileSize = buffer.length;
        const currentProject = readProject();
        const duplicate = findDuplicateAsset(currentProject, {
          originalName,
          fileSize,
          contentHash,
        }, resolveMediaPath);

        if (duplicate) {
          timelineProject = writeProject({
            ...currentProject,
            assets: currentProject.assets.map(asset => (
              asset.id === duplicate.id
                ? { ...asset, originalName: asset.originalName || originalName, fileSize, contentHash }
                : asset
            )),
          });
          const existingAsset = timelineProject.assets.find(asset => asset.id === duplicate.id) || duplicate;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, reused: true, asset: existingAsset, project: timelineProject, reviewReady: reviewReady() }));
          return;
        }

        const mediaDir = path.resolve('media');
        fs.mkdirSync(mediaDir, { recursive: true });
        let fileName = originalName;
        let outputPath = path.join(mediaDir, fileName);
        const ext = path.extname(originalName);
        const stem = path.basename(originalName, ext);
        let n = 1;
        while (fs.existsSync(outputPath)) {
          fileName = `${stem}_${n}${ext}`;
          outputPath = path.join(mediaDir, fileName);
          n++;
        }

        fs.writeFileSync(outputPath, buffer);
        const asset = {
          id: crypto.randomUUID ? crypto.randomUUID() : `asset-${Date.now()}`,
          name: path.basename(fileName, path.extname(fileName)),
          path: toProjectRelative(outputPath),
          kind,
          hasAudio: true,
          hasVideo: kind === 'video',
          duration: 0,
          originalName,
          fileSize,
          contentHash,
          uploadedAt: new Date().toISOString(),
        };
        timelineProject = writeProject({
          ...currentProject,
          assets: currentProject.assets.concat(asset),
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, asset, project: timelineProject, reviewReady: reviewReady() }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // 视频文件代理（原始视频不在当前目录时使用）
  if (req.method === 'GET' && req.url.startsWith('/video')) {
    const playbackFile = resolveReviewPlaybackFile({ cwd: process.cwd(), videoFile: VIDEO_FILE });
    if (!playbackFile) {
      res.writeHead(404);
      res.end('Video not found');
      return;
    }
    const ext = path.extname(playbackFile).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'video/mp4';
    streamFile(req, res, playbackFile, contentType);
    return;
  }

  // API: 导出 FCPXML
  if (req.method === 'POST' && req.url === '/api/fcpxml') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        // 兼容两种请求体：旧版直接传删除段数组；新版传 { deleteList, opts }
        const { deleteList, cutOpts, finalSelected } = parseExportPayload(body);

        // FCPXML 生成（含 ffprobe 探测 + 切割算法）抽到 lib/fcpxml.js，便于单测。
        // 有 project.json 时导出原始多轨素材；没有/失败时保持旧单素材导出。
        const built = timelineProject
          ? buildTimelineFcpxml({
              project: timelineProject,
              deleteList,
              silencePeriods,
              cutOpts,
              durationHint: reviewDuration,
            })
          : buildFcpxml({
              videoFile: VIDEO_FILE,
              deleteList,
              silencePeriods,
              cutOpts,
              durationHint: reviewDuration,
            });
        const { xml, outputPath: outputFcpxml, finalKeeps, baseName } = built;

        fs.writeFileSync(outputFcpxml, xml);
        console.log(`✅ 导出 FCPXML: ${outputFcpxml} (${finalKeeps.length} 片段)`);

        // ── 自进化学习日志 review_log.json ──────────────────────────
        // 与导出 FCPXML 同一次点击产出。AI 初选(aiSelectedIdx) vs 你最终(finalSelected)
        // 的词级 diff，带文字+句子上下文，供「学习」步抽象成 经验规则.md。
        // 只比对词，不比对静音段(isGap)——静音去留由切割参数 opts 管，不进规则学习。
        // 整段包 try/catch：日志失败绝不能影响导出本身。
        try {
          if (finalSelected) {
            const isWord = (i) => reviewWords[i] && !reviewWords[i].isGap;
            // 把某个 idx 还原成「所在句中标出该词」的可读上下文（两侧扩到静音边界或最多 12 词）
            const contextFor = (idx) => {
              let l = idx, r = idx;
              for (let k = 0; k < 12 && l - 1 >= 0 && reviewWords[l - 1] && !reviewWords[l - 1].isGap; k++) l--;
              for (let k = 0; k < 12 && r + 1 < reviewWords.length && reviewWords[r + 1] && !reviewWords[r + 1].isGap; k++) r++;
              let s = '';
              for (let i = l; i <= r; i++) {
                if (reviewWords[i].isGap) continue;
                s += (i === idx) ? '【' + reviewWords[i].text + '】' : reviewWords[i].text;
              }
              return s;
            };
            const entry = (i) => ({
              idx: i,
              text: reviewWords[i] ? reviewWords[i].text : '',
              start: reviewWords[i] ? reviewWords[i].start : null,
              end: reviewWords[i] ? reviewWords[i].end : null,
              context: contextFor(i),
            });
            const aiSet = new Set(aiSelectedIdx);
            const finalSet = new Set(finalSelected);
            const aiOnly = aiSelectedIdx.filter(i => !finalSet.has(i) && isWord(i)).sort((a, b) => a - b);
            const userOnly = finalSelected.filter(i => !aiSet.has(i) && isWord(i)).sort((a, b) => a - b);
            const log = {
              video: baseName,
              exportedAt: new Date().toISOString(),
              opts: cutOpts || null,
              aiSelected: aiSelectedIdx,
              finalSelected,
              segments: finalKeeps.length,
              diff: {
                说明: 'aiOnly=AI想删但你保留了(可能AI过删，该收敛规则)；userOnly=你删了但AI没想到(可能AI漏删，该补规则)',
                aiOnly: aiOnly.map(entry),
                userOnly: userOnly.map(entry),
              },
            };
            const logPath = path.resolve('review_log.json');
            fs.writeFileSync(logPath, JSON.stringify(log, null, 2));
            console.log(`🧠 学习日志: ${logPath} (AI过删 ${aiOnly.length} / 漏删 ${userOnly.length})`);
          } else {
            console.warn('⚠️ 请求未带 finalSelected（旧版前端？），跳过 review_log.json');
          }
        } catch (logErr) {
          console.warn('⚠️ 生成 review_log.json 失败（不影响导出）: ' + logErr.message);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, output: outputFcpxml, segments: finalKeeps.length }));
      } catch (err) {
        console.error('❌ FCPXML 导出失败:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // API: 导出按审核结果剪好的音频
  if (req.method === 'POST' && req.url === '/api/audio') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { parsed, deleteList, cutOpts } = parseExportPayload(body);
        const bitrate = normalizeBitrate(parsed.bitrate || '128k');
        const sourceAudio = path.resolve('audio.mp3');
        if (!fs.existsSync(sourceAudio)) {
          throw new Error('找不到 audio.mp3，请先生成审核数据');
        }

        const { finalKeeps } = computeReviewKeeps(deleteList, cutOpts);
        const baseName = getExportBaseName();
        const outputPath = path.resolve(`${baseName}_cut_${bitrate}.mp3`);
        if (!finalKeeps.length) {
          throw new Error('没有可导出的音频片段');
        }

        const job = {
          id: crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex'),
          type: 'audio',
          status: 'running',
          progress: 0,
          outTime: 0,
          duration: totalKeepDuration(finalKeeps),
          output: outputPath,
          segments: finalKeeps.length,
          bitrate,
          startedAt: Date.now(),
        };
        rememberExportJob(job);

        runEditedAudioExport({
          sourceAudio,
          outputPath,
          finalKeeps,
          bitrate,
          onProgress: (progress) => {
            job.progress = progress.progress;
            job.outTime = progress.outTime;
          },
        }).then((rendered) => {
          job.status = 'done';
          job.progress = 1;
          job.outTime = rendered.duration || job.duration;
          job.fileSize = fs.existsSync(outputPath) ? fs.statSync(outputPath).size : null;
          console.log(`✅ 导出音频: ${rendered.outputPath} (${rendered.segments} 片段 / ${rendered.bitrate})`);
        }).catch((err) => {
          job.status = 'error';
          job.error = err.message;
          console.error('❌ 音频导出失败:', err.message);
        });

        console.log(`🎧 开始导出音频: ${outputPath} (${job.segments} 片段 / ${job.bitrate})`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          jobId: job.id,
          job: publicExportJob(job),
          output: job.output,
          segments: job.segments,
          bitrate: job.bitrate,
        }));
      } catch (err) {
        console.error('❌ 音频导出失败:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // API: 查询导出任务进度
  if (req.method === 'GET' && req.url.startsWith('/api/export-progress/')) {
    const jobId = decodeURIComponent(req.url.replace('/api/export-progress/', '').split('?')[0]);
    const job = exportJobs.get(jobId);
    if (!job) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: '导出任务不存在或已过期' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, job: publicExportJob(job) }));
    return;
  }

  // API: 导出按审核结果重排时间轴的 SRT
  if (req.method === 'POST' && req.url === '/api/srt') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { deleteList, cutOpts } = parseExportPayload(body);
        const { finalKeeps } = computeReviewKeeps(deleteList, cutOpts);
        const { srt, cues } = buildEditedSrt({ words: reviewWords, finalKeeps });
        if (!cues.length) {
          throw new Error('没有可导出的字幕内容');
        }

        const outputPath = path.resolve(`${getExportBaseName()}_cut.srt`);
        fs.writeFileSync(outputPath, srt, 'utf8');
        console.log(`✅ 导出 SRT: ${outputPath} (${cues.length} 条字幕)`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          output: outputPath,
          cues: cues.length,
          segments: finalKeeps.length,
        }));
      } catch (err) {
        console.error('❌ SRT 导出失败:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // API: 保存 / 读取审核草稿（中途退出后继续）
  if (req.method === 'GET' && req.url === '/api/draft') {
    const draftPath = path.resolve('review_draft.json');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (!fs.existsSync(draftPath)) {
      res.end(JSON.stringify({ success: true, draft: null, projectSignature }));
      return;
    }
    try {
      const draft = JSON.parse(fs.readFileSync(draftPath, 'utf8'));
      res.end(JSON.stringify({ success: true, draft, projectSignature }));
    } catch (err) {
      res.end(JSON.stringify({ success: false, error: err.message, draft: null, projectSignature }));
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/api/draft') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body || '{}');
        if (parsed.projectSignature && parsed.projectSignature !== projectSignature) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            error: '进度文件和当前剪辑内容不一致，已停止导入',
          }));
          return;
        }
        const selectedIdx = Array.isArray(parsed.selectedIdx)
          ? parsed.selectedIdx
              .map(n => Number(n))
              .filter(n => Number.isInteger(n) && n >= 0 && n < reviewWords.length)
              .sort((a, b) => a - b)
          : [];
        const draft = {
          version: 2,
          projectSignature,
          savedAt: new Date().toISOString(),
          selectedIdx,
          cutOpts: parsed.cutOpts && typeof parsed.cutOpts === 'object' ? parsed.cutOpts : null,
          currentTime: Number.isFinite(Number(parsed.currentTime)) ? Number(parsed.currentTime) : 0,
        };
        fs.writeFileSync(path.resolve('review_draft.json'), JSON.stringify(draft, null, 2));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, savedAt: draft.savedAt, count: selectedIdx.length }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // API: 下载文件
  if (req.method === 'GET' && req.url.startsWith('/api/download/')) {
    const encodedFileName = req.url.replace('/api/download/', '');
    const fileName = decodeURIComponent(encodedFileName);
    const filePath = path.resolve(fileName);
    if (!fs.existsSync(filePath)) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    const stat = fs.statSync(filePath);
    // RFC 5987 编码（非 ASCII 字符必须编码）
    const rawName = path.basename(filePath);
    const encodedName = encodeURIComponent(rawName);
    const displayName = /[^\x00-\x7F]/.test(rawName)
      ? `UTF-8''${encodedName}`  // RFC 5987 格式
      : `"${rawName}"`;

    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodedName}`,
      'Content-Length': stat.size,
    });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  // 静态文件服务（从当前目录读取）
  const defaultPage = fs.existsSync('data.json') && fs.existsSync('review.html') ? '/review.html' : '/editor.html';
  let filePath = req.url === '/' ? defaultPage : req.url;
  filePath = '.' + filePath;

  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  // 检查文件是否存在
  if (!fs.existsSync(filePath)) {
    res.writeHead(404);
    res.end('Not Found');
    return;
  }

  // 支持 Range 请求（音频/视频拖动）
  if (req.headers.range && ['.mp3', '.mp4', '.m4a', '.mov', '.wav', '.aac'].includes(ext)) {
    streamFile(req, res, filePath, contentType);
    return;
  }

  // 普通请求
  streamFile(req, res, filePath, contentType);
});

server.listen(PORT, () => {
  // 落地两个文件到当前目录（3_审核/），让 agent / 用户随时能找到地址并重启：
  //   server_url.txt      — 浏览器要打开的地址
  //   .review_server.pid  — 进程号，用于停止/排障（kill $(cat .review_server.pid)）
  const url = `http://localhost:${PORT}`;
  try {
    fs.writeFileSync('server_url.txt', url + '\n');
    fs.writeFileSync('.review_server.pid', String(process.pid) + '\n');
  } catch (e) { /* 写不进不致命，地址下面也会打印 */ }

  // 输出机器可读的端口号，供 shell 捕获
  const playbackFile = resolveReviewPlaybackFile({ cwd: process.cwd(), videoFile: VIDEO_FILE });
  console.log('READY_PORT=' + PORT);
  console.log(`
🎬 审核服务器已启动
📍 地址: http://localhost:${PORT}
📹 播放源: ${playbackFile || '(尚未生成审核音频)'}
🎞️ 启动素材: ${VIDEO_FILE || '(无)'}

操作说明:
1. 在网页中审核 AI 预选的删除片段
2. 点击「导出 FCPXML」按钮
3. 把生成的 .fcpxml 文件拖入剪映 / Final Cut Pro
  `);
});
