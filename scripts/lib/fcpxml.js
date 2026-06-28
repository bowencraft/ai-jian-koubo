'use strict';
/*
 * FCPXML 1.8 生成（从 review_server.js 抽出，便于单测）。
 *
 * 一句话职责：拿到「删除段 + 静音段 + 视频文件」，算出真正保留的片段（复用
 * compute_keeps.js 这一份切割算法），再渲染成可被剪映 / Final Cut Pro 导入的 FCPXML。
 *
 * 设计约束（改动前必读）：
 *   - FCPXML 1.8 DTD 不支持 fade 元素，淡入淡出留给剪辑软件自己加
 *   - 媒体引用用绝对路径的 file:// URI（百分号编码），剪映和 FCP 都靠它定位源视频
 *   - 时间一律用 FCP ticks（帧号 × fpsDen），不要改成秒——浮点累积会导致 ±1 帧漂移
 */

const path = require('path');
const { execSync } = require('child_process');
const { computeFinalKeeps } = require('./compute_keeps');
const {
  normalizeProject,
  createLegacyProject,
  applyTimelineDeletes,
  getProjectDuration,
} = require('./timeline_project');

// 把绝对路径编码成 file:// URI（保留路径分隔符与安全字符，其余百分号编码）
function fileUri(absPath) {
  return 'file://' + absPath.split('').map(c => (
    /[a-zA-Z0-9\-_.~/]/.test(c) ? c : encodeURIComponent(c)
  )).join('');
}

// FCP 要求的 UUID 格式
function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

function xmlAttr(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const AUDIO_EXTS = new Set(['.mp3', '.m4a', '.wav', '.aac', '.flac', '.ogg']);

// 用 ffprobe 探测媒体元数据；音频文件没有视频流，使用默认时间基准即可。
function probeMedia(mediaFile, durationHint) {
  const ext = path.extname(mediaFile).toLowerCase();
  const isAudioOnly = AUDIO_EXTS.has(ext);
  let duration = Number(durationHint) || 0;

  try {
    const probedDuration = parseFloat(
      execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "file:${mediaFile}"`).toString().trim()
    );
    if (Number.isFinite(probedDuration) && probedDuration > 0) duration = probedDuration;
  } catch (err) {
    if (!duration) throw err;
  }

  if (isAudioOnly) {
    return { duration, fpsNum: 30, fpsDen: 1, width: 1920, height: 1080, hasVideo: false };
  }

  // 帧率为有理数，如 "30000/1001" = 29.97fps
  let fpsNum = 30;
  let fpsDen = 1;
  let width = 1920;
  let height = 1080;

  try {
    const fpsRaw = execSync(
      `ffprobe -v error -select_streams v:0 -show_entries stream=r_frame_rate -of csv=p=0 "file:${mediaFile}"`
    ).toString().trim().replace(/,+$/, '');
    const fpsParts = fpsRaw.split('/').map(Number);
    [fpsNum, fpsDen] = fpsParts.length === 2 ? fpsParts : [fpsParts[0], 1];

    const sizeRaw = execSync(
      `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "file:${mediaFile}"`
    ).toString().trim().split(',');
    width = parseInt(sizeRaw[0]) || width;
    height = parseInt(sizeRaw[1]) || height;
  } catch (err) {
    if (!durationHint) throw err;
  }

  return { duration, fpsNum, fpsDen, width, height, hasVideo: true };
}

function inverseKeeps(finalKeeps, duration) {
  const deletes = [];
  let cursor = 0;
  finalKeeps
    .slice()
    .sort((a, b) => a.start - b.start)
    .forEach((keep) => {
      if (keep.start > cursor) deletes.push({ start: cursor, end: keep.start });
      cursor = Math.max(cursor, keep.end);
    });
  if (cursor < duration) deletes.push({ start: cursor, end: duration });
  return deletes;
}

function collapsedTime(time, deletes) {
  let removed = 0;
  deletes.forEach((range) => {
    if (range.end <= time) removed += range.end - range.start;
    else if (range.start < time) removed += time - range.start;
  });
  return Math.max(0, time - removed);
}

function buildTimelineFcpxml({ project, deleteList, silencePeriods, cutOpts, durationHint, outputPath }) {
  const normalized = normalizeProject(project);
  const projectDuration = Math.max(getProjectDuration(normalized), Number(durationHint) || 0);
  const finalKeeps = computeFinalKeeps(deleteList || [], silencePeriods || [], projectDuration, cutOpts || {});
  const effectiveDeletes = inverseKeeps(finalKeeps, projectDuration);

  const assetMetas = normalized.assets.map((asset, index) => {
    const media = probeMedia(asset.path, asset.duration || durationHint || projectDuration);
    return {
      ...asset,
      resourceId: `r${index + 1}`,
      media,
    };
  });
  const assetById = new Map(assetMetas.map(asset => [asset.id, asset]));
  const firstVideo = assetMetas.find(asset => asset.media.hasVideo);
  const formatMedia = firstVideo ? firstVideo.media : { fpsNum: 30, fpsDen: 1, width: 1920, height: 1080 };
  const fpsNum = formatMedia.fpsNum;
  const fpsDen = formatMedia.fpsDen;
  const toFCPTicks = (sec) => Math.round(sec * fpsNum / fpsDen) * fpsDen;
  const frameDuration = `${fpsDen}/${fpsNum}s`;
  const audioRate = 48000;

  const finalClips = applyTimelineDeletes(normalized, effectiveDeletes)
    .map(clip => ({
      ...clip,
      asset: assetById.get(clip.assetId),
      timelineStart: collapsedTime(clip.timelineStart, effectiveDeletes),
    }))
    .filter(clip => clip.asset && clip.duration > 0);

  const resources = assetMetas.map((asset) => {
    const assetDuration = Math.max(asset.media.duration || 0, asset.duration || 0, projectDuration);
    const assetDurationNum = Math.round(assetDuration * audioRate);
    const formatAttr = asset.media.hasVideo ? ' format="rfmt"' : '';
    const videoAttrs = asset.media.hasVideo ? ' hasVideo="1"' : ' hasVideo="0"';
    return `    <asset id="${asset.resourceId}" name="${xmlAttr(asset.name)}" src="${xmlAttr(fileUri(path.resolve(asset.path)))}" start="0/1s" duration="${assetDurationNum}/${audioRate}s"${formatAttr}${videoAttrs} hasAudio="${asset.hasAudio ? '1' : '0'}" audioSources="1" audioChannels="2" audioRate="48k" />`;
  }).join('\n');

  const clips = finalClips.map((clip) => {
    const asset = clip.asset;
    const offsetTicks = toFCPTicks(clip.timelineStart);
    const startTicks = toFCPTicks(clip.sourceStart);
    const durTicks = toFCPTicks(clip.duration);
    const laneAttr = clip.lane ? ` lane="${clip.lane}"` : '';
    const formatAttr = asset.media.hasVideo ? ' format="rfmt"' : '';
    return `            <asset-clip name="${xmlAttr(asset.name)}" offset="${offsetTicks}/${fpsNum}s"${laneAttr} ref="${asset.resourceId}" start="${startTicks}/${fpsNum}s" duration="${durTicks}/${fpsNum}s" audioRole="${xmlAttr(clip.audioRole)}"${formatAttr} tcFormat="NDF" />`;
  }).join('\n');

  const baseName = normalized.name || 'multitrack_project';
  const resolvedOutput = path.resolve(outputPath || `${baseName}_cut.fcpxml`);
  const totalTicks = toFCPTicks(finalKeeps.reduce((sum, keep) => sum + Math.max(0, keep.end - keep.start), 0));

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<fcpxml version="1.8">
  <resources>
    <format id="rfmt" frameDuration="${frameDuration}" width="${formatMedia.width}" height="${formatMedia.height}" colorSpace="1-1-1 (Rec. 709)" />
${resources}
  </resources>
  <library location="${xmlAttr(fileUri(resolvedOutput))}">
    <event name="${xmlAttr(baseName)}_剪辑" uid="${uuid()}">
      <project name="${xmlAttr(baseName)}_cut" uid="${uuid()}">
        <sequence duration="${totalTicks}/${fpsNum}s" format="rfmt" tcStart="0/1s" tcFormat="NDF" audioLayout="stereo" audioRate="48k">
          <spine>
${clips}
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>`;

  return { xml, outputPath: resolvedOutput, finalKeeps, finalClips, baseName };
}

/**
 * 生成 FCPXML。
 * @param {object} o
 * @param {string} o.videoFile        源视频路径
 * @param {number[]} o.deleteList      删除段（秒区间，见 compute_keeps）
 * @param {Array} o.silencePeriods     预计算静音段
 * @param {object} [o.cutOpts]         切割参数（padStart/padEnd 等）
 * @param {number} [o.durationHint]    ffprobe 不可用时的媒体时长兜底
 * @returns {{ xml:string, outputPath:string, finalKeeps:Array, baseName:string }}
 */
function buildFcpxml({ videoFile, deleteList, silencePeriods, cutOpts, durationHint }) {
  const { duration, fpsNum, fpsDen, width, height, hasVideo } = probeMedia(videoFile, durationHint);

  // ticks = 帧号 × fpsDen，分母为 fpsNum：对 29.97/30/24 等所有帧率都成立
  const toFCPTicks = (sec) => Math.round(sec * fpsNum / fpsDen) * fpsDen;
  const frameDuration = `${fpsDen}/${fpsNum}s`;

  // 切割算法单一来源：合并删除段 → 取反 → 边界吸附静音 → 内部长静音二次切
  const finalKeeps = computeFinalKeeps(deleteList, silencePeriods, duration, cutOpts);

  const baseName = path.basename(videoFile, path.extname(videoFile));
  const outputPath = path.resolve(`${baseName}_cut.fcpxml`);

  const mediaSrc = fileUri(path.resolve(videoFile));
  const fcpxmlSrc = fileUri(outputPath);

  // asset 时长用音频采样率（48000）做分母
  const audioRate = 48000;
  const assetDurationNum = Math.round(duration * audioRate);

  // 每个保留片段一个 asset-clip，引用同一个 asset r1；
  // offset 在 tick 空间累加，避免浮点秒累积误差导致 ±1 帧偏移
  let timelineOffsetTicks = 0;
  const clips = finalKeeps.map((seg) => {
    const startTicks = toFCPTicks(seg.start);
    const durTicks = toFCPTicks(seg.end - seg.start);
    const offsetTicks = timelineOffsetTicks;
    timelineOffsetTicks += durTicks;
    const formatAttr = hasVideo ? ' format="r2"' : '';
    return `            <asset-clip name="${baseName}" offset="${offsetTicks}/${fpsNum}s" ref="r1" start="${startTicks}/${fpsNum}s" duration="${durTicks}/${fpsNum}s" audioRole="dialogue"${formatAttr} tcFormat="NDF" />`;
  }).join('\n');

  const totalTicks = timelineOffsetTicks;

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<fcpxml version="1.8">
  <resources>
    <format id="r2" frameDuration="${frameDuration}" width="${width}" height="${height}" colorSpace="1-1-1 (Rec. 709)" />
    <asset id="r1" name="${baseName}" src="${mediaSrc}" start="0/1s" duration="${assetDurationNum}/${audioRate}s"${hasVideo ? ' format="r2" hasVideo="1"' : ' hasVideo="0"'} hasAudio="1" audioSources="1" audioChannels="2" audioRate="48k" />
  </resources>
  <library location="${fcpxmlSrc}">
    <event name="${baseName}_剪辑" uid="${uuid()}">
      <project name="${baseName}_cut" uid="${uuid()}">
        <sequence duration="${totalTicks}/${fpsNum}s" format="r2" tcStart="0/1s" tcFormat="NDF" audioLayout="stereo" audioRate="48k">
          <spine>
${clips}
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>`;

  return { xml, outputPath, finalKeeps, baseName };
}

module.exports = { buildFcpxml, buildTimelineFcpxml };
