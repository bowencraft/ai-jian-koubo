'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn: defaultSpawn, spawnSync: defaultSpawnSync } = require('child_process');

const ALLOWED_BITRATES = new Set(['96k', '128k', '192k', '256k']);
const SENTENCE_END_RE = /[。！？!?；;]/;

function normalizeBitrate(value) {
  const raw = String(value == null ? '' : value).trim().toLowerCase();
  const bitrate = /^\d+$/.test(raw) ? `${raw}k` : raw;
  if (!ALLOWED_BITRATES.has(bitrate)) {
    throw new Error(`Unsupported bitrate: ${value}`);
  }
  return bitrate;
}

function cleanKeeps(finalKeeps) {
  return (Array.isArray(finalKeeps) ? finalKeeps : [])
    .map(keep => ({
      start: Number(keep.start),
      end: Number(keep.end),
    }))
    .filter(keep => Number.isFinite(keep.start) && Number.isFinite(keep.end) && keep.end > keep.start + 0.001)
    .sort((a, b) => a.start - b.start);
}

function seconds(n) {
  return Math.max(0, Number(n) || 0).toFixed(3);
}

function escapeConcatPath(filePath) {
  return String(filePath).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function buildConcatScript({ sourceAudio, finalKeeps }) {
  const keeps = cleanKeeps(finalKeeps);
  if (!keeps.length) throw new Error('No kept audio segments to export');
  const fileLine = `file '${escapeConcatPath(sourceAudio)}'`;
  return [
    'ffconcat version 1.0',
    ...keeps.flatMap(keep => [
      fileLine,
      `inpoint ${seconds(keep.start)}`,
      `outpoint ${seconds(keep.end)}`,
    ]),
    '',
  ].join('\n');
}

function writeConcatScript(sourceAudio, finalKeeps) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-jian-koubo-audio-'));
  const concatFile = path.join(tmpDir, 'keeps.ffconcat');
  fs.writeFileSync(concatFile, buildConcatScript({ sourceAudio, finalKeeps }));
  return {
    concatFile,
    cleanup: () => {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (err) {}
    },
  };
}

function buildAudioExportArgs({ concatFile, outputPath, bitrate, includeProgress = false }) {
  const targetBitrate = normalizeBitrate(bitrate);
  const args = [
    '-y',
  ];
  if (includeProgress) args.push('-nostats', '-progress', 'pipe:2');
  args.push(
    '-f', 'concat',
    '-safe', '0',
    '-segment_time_metadata', '1',
    '-i', concatFile,
    '-af', 'aselect=concatdec_select,asetpts=N/SR/TB',
    '-ac', '2',
    '-ar', '48000',
    '-codec:a', 'libmp3lame',
    '-b:a', targetBitrate,
    outputPath,
  );
  return args;
}

function totalKeepDuration(finalKeeps) {
  return cleanKeeps(finalKeeps).reduce((sum, keep) => sum + Math.max(0, keep.end - keep.start), 0);
}

function parseProgressTime(line) {
  const [key, value] = String(line || '').trim().split('=');
  if (!key || value == null) return null;
  if (key === 'out_time_us' || key === 'out_time_ms') {
    const raw = Number(value);
    return Number.isFinite(raw) ? raw / 1000000 : null;
  }
  if (key === 'out_time') {
    const match = value.match(/^(\d+):(\d+):(\d+(?:\.\d+)?)$/);
    if (!match) return null;
    return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  }
  return null;
}

function parseFfmpegProgressLine(line, totalDuration) {
  const outTime = parseProgressTime(line);
  if (outTime == null) return null;
  const total = Number(totalDuration) || 0;
  const progress = total > 0 ? Math.max(0, Math.min(1, outTime / total)) : 0;
  return { outTime, progress };
}

function keptTimeAt(time, keeps) {
  let out = 0;
  for (const keep of keeps) {
    if (time <= keep.start) return out;
    if (time < keep.end) return out + (time - keep.start);
    out += keep.end - keep.start;
  }
  return out;
}

function findContainingKeep(word, keeps) {
  const start = Number(word.start);
  const end = Number(word.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  const mid = (start + end) / 2;
  return keeps.find(keep => mid >= keep.start && mid <= keep.end) || null;
}

function formatSrtTime(time) {
  const totalMs = Math.max(0, Math.round((Number(time) || 0) * 1000));
  const ms = totalMs % 1000;
  const totalSeconds = Math.floor(totalMs / 1000);
  const s = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const m = totalMinutes % 60;
  const h = Math.floor(totalMinutes / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

function textLength(text) {
  return Array.from(String(text || '')).length;
}

function buildEditedSrt({ words, finalKeeps, maxCueChars = 32, maxCueDuration = 6, maxGap = 0.8 }) {
  const keeps = cleanKeeps(finalKeeps);
  const mapped = [];

  (Array.isArray(words) ? words : []).forEach((word) => {
    if (!word || word.isGap || !word.text) return;
    const keep = findContainingKeep(word, keeps);
    if (!keep) return;
    const clippedStart = Math.max(Number(word.start), keep.start);
    const clippedEnd = Math.min(Number(word.end), keep.end);
    if (!(clippedEnd > clippedStart)) return;
    mapped.push({
      text: String(word.text),
      start: keptTimeAt(clippedStart, keeps),
      end: keptTimeAt(clippedEnd, keeps),
    });
  });

  const cues = [];
  let cur = null;

  function flush() {
    if (!cur || !cur.text.trim()) {
      cur = null;
      return;
    }
    cues.push(cur);
    cur = null;
  }

  mapped.forEach((item) => {
    if (cur) {
      const nextText = cur.text + item.text;
      const gap = item.start - cur.end;
      const duration = item.end - cur.start;
      if (gap > maxGap || duration > maxCueDuration || textLength(nextText) > maxCueChars) {
        flush();
      }
    }

    if (!cur) cur = { start: item.start, end: item.end, text: '' };
    cur.text += item.text;
    cur.end = Math.max(cur.end, item.end);

    if (SENTENCE_END_RE.test(item.text)) flush();
  });
  flush();

  const srt = cues.map((cue, index) => [
    String(index + 1),
    `${formatSrtTime(cue.start)} --> ${formatSrtTime(cue.end)}`,
    cue.text,
    '',
  ].join('\n')).join('\n');

  return { srt, cues };
}

function renderEditedAudio({ sourceAudio, outputPath, finalKeeps, bitrate, spawnSync = defaultSpawnSync }) {
  const keeps = cleanKeeps(finalKeeps);
  if (!keeps.length) throw new Error('No kept audio segments to export');
  const targetBitrate = normalizeBitrate(bitrate);

  const { concatFile, cleanup } = writeConcatScript(sourceAudio, keeps);
  try {
    const args = buildAudioExportArgs({ concatFile, outputPath, bitrate: targetBitrate });
    const result = spawnSync('ffmpeg', args, { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`ffmpeg failed with exit code ${result.status}`);
  } finally {
    cleanup();
  }

  return { outputPath, bitrate: targetBitrate, segments: keeps.length };
}

function runEditedAudioExport({
  sourceAudio,
  outputPath,
  finalKeeps,
  bitrate,
  spawn = defaultSpawn,
  onProgress,
}) {
  const keeps = cleanKeeps(finalKeeps);
  if (!keeps.length) return Promise.reject(new Error('No kept audio segments to export'));
  const targetBitrate = normalizeBitrate(bitrate);
  const expectedDuration = totalKeepDuration(keeps);
  const { concatFile, cleanup } = writeConcatScript(sourceAudio, keeps);
  const args = buildAudioExportArgs({
    concatFile,
    outputPath,
    bitrate: targetBitrate,
    includeProgress: true,
  });

  return new Promise((resolve, reject) => {
    let stderr = '';
    let carry = '';
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      const lines = (carry + text).split(/\r?\n/);
      carry = lines.pop() || '';
      for (const line of lines) {
        const progress = parseFfmpegProgressLine(line, expectedDuration);
        if (progress && onProgress) onProgress(progress);
      }
    });

    child.on('error', (err) => {
      cleanup();
      reject(err);
    });

    child.on('close', (code) => {
      cleanup();
      if (code === 0) {
        if (onProgress) onProgress({ outTime: expectedDuration, progress: 1 });
        resolve({
          outputPath,
          bitrate: targetBitrate,
          segments: keeps.length,
          duration: expectedDuration,
        });
        return;
      }
      const tail = stderr.trim().split(/\r?\n/).slice(-8).join('\n');
      reject(new Error(`ffmpeg failed with exit code ${code}${tail ? `\n${tail}` : ''}`));
    });
  });
}

module.exports = {
  buildAudioExportArgs,
  buildConcatScript,
  buildEditedSrt,
  formatSrtTime,
  normalizeBitrate,
  parseFfmpegProgressLine,
  renderEditedAudio,
  runEditedAudioExport,
  totalKeepDuration,
};
