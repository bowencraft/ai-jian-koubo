'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { normalizeProject } = require('./timeline_project');

function resolveAssetPath(assetPath, projectDir = process.cwd()) {
  if (!assetPath) return '';
  return path.isAbsolute(assetPath) ? assetPath : path.resolve(projectDir, assetPath);
}

function trackIsAudible(tracks, trackIndex) {
  const state = tracks[trackIndex] || {};
  if (state.disabled) return false;
  const soloMode = tracks.some(track => track && track.solo);
  return !soloMode || state.solo;
}

function listAudibleTimelineClips(project, { projectDir = process.cwd() } = {}) {
  const normalized = normalizeProject(project);
  const assetById = new Map(normalized.assets.map(asset => [asset.id, asset]));
  const tracks = normalized.timeline && Array.isArray(normalized.timeline.tracks)
    ? normalized.timeline.tracks
    : [];

  return normalized.clips
    .filter(clip => clip.enabled !== false && trackIsAudible(tracks, clip.trackIndex))
    .map(clip => ({ clip, asset: assetById.get(clip.assetId) }))
    .filter(item => item.asset && item.asset.hasAudio !== false)
    .map(item => ({
      ...item,
      mediaPath: resolveAssetPath(item.asset.path, projectDir),
    }));
}

function buildTimelineAudioArgs({ project, outputFile = 'review_mix.mp3', projectDir = process.cwd() }) {
  const audible = listAudibleTimelineClips(project, { projectDir });
  if (!audible.length) {
    throw new Error('project.json 中没有可混音的音频片段');
  }

  const args = ['-y'];
  const filters = [];
  const labels = [];

  audible.forEach(({ clip, mediaPath }, index) => {
    args.push('-i', mediaPath);
    const delayMs = Math.max(0, Math.round(clip.timelineStart * 1000));
    const sourceStart = Math.max(0, Number(clip.sourceStart) || 0);
    const duration = Math.max(0.001, Number(clip.duration) || 0);
    const label = `a${index}`;
    filters.push(
      `[${index}:a]atrim=start=${sourceStart.toFixed(3)}:duration=${duration.toFixed(3)},` +
      `asetpts=PTS-STARTPTS,adelay=${delayMs}:all=1[${label}]`
    );
    labels.push(`[${label}]`);
  });

  filters.push(`${labels.join('')}amix=inputs=${labels.length}:normalize=0:dropout_transition=0[out]`);
  args.push(
    '-filter_complex',
    filters.join(';'),
    '-map',
    '[out]',
    '-ac',
    '2',
    '-ar',
    '48000',
    '-codec:a',
    'libmp3lame',
    outputFile
  );

  return { args, clips: audible };
}

function renderTimelineAudio({
  project,
  projectFile,
  outputFile = 'review_mix.mp3',
  projectDir,
  spawn = spawnSync,
  stdio = 'inherit',
} = {}) {
  let sourceProject = project;
  let baseDir = projectDir;
  if (projectFile) {
    const resolvedProjectFile = path.resolve(projectFile);
    sourceProject = JSON.parse(fs.readFileSync(resolvedProjectFile, 'utf8'));
    baseDir = baseDir || path.dirname(resolvedProjectFile);
  }
  if (!sourceProject) throw new Error('project.json 不存在或未传入项目数据');
  baseDir = baseDir || process.cwd();

  const { args, clips } = buildTimelineAudioArgs({
    project: sourceProject,
    outputFile,
    projectDir: baseDir,
  });
  const result = spawn('ffmpeg', args, { stdio, encoding: stdio === 'pipe' ? 'utf8' : undefined });
  if (result.status !== 0) {
    const detail = result.stderr ? String(result.stderr).trim().split('\n').slice(-6).join('\n') : '';
    throw new Error(`ffmpeg 混音失败${detail ? ': ' + detail : ''}`);
  }
  return { outputFile: path.resolve(baseDir, outputFile), clips, args };
}

function timelineAudioSignature(project) {
  const normalized = normalizeProject(project);
  const assets = new Map(normalized.assets.map(asset => [asset.id, asset]));
  const tracks = normalized.timeline && Array.isArray(normalized.timeline.tracks)
    ? normalized.timeline.tracks
    : [];
  return JSON.stringify({
    tracks: tracks.map(track => ({
      disabled: track.disabled === true,
      solo: track.solo === true,
    })),
    clips: normalized.clips.map(clip => {
      const asset = assets.get(clip.assetId) || {};
      return {
        id: clip.id,
        assetId: clip.assetId,
        assetPath: asset.path || '',
        assetHash: asset.contentHash || '',
        hasAudio: asset.hasAudio !== false,
        enabled: clip.enabled !== false,
        timelineStart: Number(clip.timelineStart.toFixed(3)),
        sourceStart: Number(clip.sourceStart.toFixed(3)),
        duration: Number(clip.duration.toFixed(3)),
        trackIndex: clip.trackIndex,
      };
    }),
  });
}

module.exports = {
  buildTimelineAudioArgs,
  listAudibleTimelineClips,
  renderTimelineAudio,
  resolveAssetPath,
  timelineAudioSignature,
  trackIsAudible,
};
