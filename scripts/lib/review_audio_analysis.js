'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SILENCE_MIN_DUR = 0.2;
const SILENCE_PEAK_OFFSET_DB = 35;
const SILENCE_DB_MIN = -55;
const SILENCE_DB_MAX = -20;
const PEAK_SAMPLE_RATE = 8000;

function parseMaxVolume(log) {
  const match = String(log || '').match(/max_volume:\s*([-\d.]+)\s*dB/);
  return match ? Number(match[1]) : null;
}

function silenceThresholdForMaxVolume(maxVolume) {
  if (!Number.isFinite(maxVolume)) return -35;
  const threshold = Math.max(SILENCE_DB_MIN, Math.min(SILENCE_DB_MAX, maxVolume - SILENCE_PEAK_OFFSET_DB));
  return Number(threshold.toFixed(1));
}

function parseSilencePeriods(log, duration = 0) {
  const starts = [...String(log || '').matchAll(/silence_start:\s*([\d.]+)/g)];
  const ends = [...String(log || '').matchAll(/silence_end:\s*([\d.]+)/g)];
  return starts
    .map((match, index) => ({
      start: Number(match[1]),
      end: ends[index] ? Number(ends[index][1]) : Number(duration) || 0,
    }))
    .filter(period => Number.isFinite(period.start) && Number.isFinite(period.end) && period.end > period.start)
    .sort((a, b) => a.start - b.start);
}

function runLoggedCommand(command, args, { spawn = spawnSync, encoding = 'utf8' } = {}) {
  const result = spawn(command, args, { encoding, maxBuffer: 1 << 28 });
  if (result.status !== 0) {
    const detail = result.stderr ? String(result.stderr).trim().split('\n').slice(-6).join('\n') : '';
    throw new Error(`${command} 失败${detail ? ': ' + detail : ''}`);
  }
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    log: `${result.stdout || ''}${result.stderr || ''}`,
  };
}

function probeAudioDuration(audioFile, { spawn = spawnSync } = {}) {
  const result = runLoggedCommand('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'csv=p=0',
    audioFile,
  ], { spawn });
  const duration = Number(String(result.stdout).trim());
  return Number.isFinite(duration) && duration > 0 ? duration : 0;
}

function buildPeaksFromPcm(pcm, duration, { maxPoints = 60000, minPoints = 2000 } = {}) {
  const sampleCount = Math.floor(pcm.length / 2);
  const targetPoints = Math.min(maxPoints, Math.max(minPoints, Math.round((Number(duration) || 0) * 150)));
  const bucket = Math.max(1, Math.ceil(sampleCount / targetPoints));
  const peaks = [];
  for (let i = 0; i < sampleCount; i += bucket) {
    let max = 0;
    const end = Math.min(sampleCount, i + bucket);
    for (let j = i; j < end; j++) {
      const value = Math.abs(pcm.readInt16LE(j * 2));
      if (value > max) max = value;
    }
    peaks.push(Number((max / 32768).toFixed(4)));
  }
  return peaks;
}

function writeReviewAudioAnalysis({ audioFile, outputDir = process.cwd(), spawn = spawnSync } = {}) {
  if (!audioFile || !fs.existsSync(audioFile)) {
    throw new Error('找不到审核音频: ' + audioFile);
  }
  const duration = probeAudioDuration(audioFile, { spawn });
  const silenceOut = path.join(outputDir, 'silence_periods.json');
  const peaksOut = path.join(outputDir, 'peaks.json');
  const result = {
    duration,
    silencePeriods: [],
    peaksCount: 0,
    silenceError: null,
    peaksError: null,
  };

  try {
    const volume = runLoggedCommand('ffmpeg', [
      '-i',
      audioFile,
      '-af',
      'volumedetect',
      '-f',
      'null',
      '-',
    ], { spawn }).log;
    const threshold = silenceThresholdForMaxVolume(parseMaxVolume(volume));
    const silence = runLoggedCommand('ffmpeg', [
      '-i',
      audioFile,
      '-af',
      `silencedetect=noise=${threshold.toFixed(1)}dB:d=${SILENCE_MIN_DUR}`,
      '-f',
      'null',
      '-',
    ], { spawn }).log;
    result.silencePeriods = parseSilencePeriods(silence, duration);
    fs.writeFileSync(silenceOut, JSON.stringify(result.silencePeriods));
  } catch (err) {
    result.silenceError = err.message;
    fs.writeFileSync(silenceOut, '[]');
  }

  try {
    const pcm = runLoggedCommand('ffmpeg', [
      '-i',
      audioFile,
      '-ac',
      '1',
      '-ar',
      String(PEAK_SAMPLE_RATE),
      '-f',
      's16le',
      '-',
    ], { spawn, encoding: null }).stdout;
    const peaks = buildPeaksFromPcm(pcm, duration);
    result.peaksCount = peaks.length;
    fs.writeFileSync(peaksOut, JSON.stringify({ duration, sampleRate: PEAK_SAMPLE_RATE, peaks }));
  } catch (err) {
    result.peaksError = err.message;
    fs.writeFileSync(peaksOut, '[]');
  }

  return result;
}

module.exports = {
  buildPeaksFromPcm,
  parseMaxVolume,
  parseSilencePeriods,
  probeAudioDuration,
  silenceThresholdForMaxVolume,
  writeReviewAudioAnalysis,
};
