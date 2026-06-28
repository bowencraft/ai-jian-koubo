'use strict';

const path = require('path');

function numeric(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeProject(project) {
  const p = project && typeof project === 'object' ? project : {};
  const assets = Array.isArray(p.assets) ? p.assets : [];
  const clips = Array.isArray(p.clips) ? p.clips : [];
  const assetById = new Map();

  const normalizedAssets = assets.map((asset, index) => {
    const id = String(asset.id || `asset-${index + 1}`);
    const filePath = asset.path || asset.file || asset.src || '';
    const ext = path.extname(filePath).toLowerCase();
    const kind = asset.kind || (['.mp3', '.m4a', '.wav', '.aac', '.flac', '.ogg'].includes(ext) ? 'audio' : 'video');
    const normalized = {
      id,
      name: asset.name || path.basename(filePath, ext) || id,
      path: filePath,
      kind,
      hasAudio: asset.hasAudio !== false,
      hasVideo: asset.hasVideo != null ? !!asset.hasVideo : kind !== 'audio',
      duration: numeric(asset.duration, 0),
    };
    assetById.set(id, normalized);
    return normalized;
  });

  const normalizedClips = clips
    .map((clip, index) => {
      const assetId = String(clip.assetId || '');
      if (!assetById.has(assetId)) return null;
      const duration = numeric(clip.duration, numeric(clip.end, 0) - numeric(clip.start, 0));
      if (!(duration > 0)) return null;
      return {
        id: String(clip.id || `clip-${index + 1}`),
        assetId,
        timelineStart: numeric(clip.timelineStart, numeric(clip.offset, 0)),
        sourceStart: numeric(clip.sourceStart, numeric(clip.start, 0)),
        duration,
        trackIndex: Math.max(0, Math.floor(numeric(clip.trackIndex, numeric(clip.lane, 0)))),
        lane: Math.floor(numeric(clip.lane, numeric(clip.trackIndex, 0))),
        audioRole: clip.audioRole || 'dialogue',
        enabled: clip.enabled !== false,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.timelineStart - b.timelineStart || a.trackIndex - b.trackIndex);

  return {
    version: p.version || 1,
    name: p.name || 'multitrack_project',
    assets: normalizedAssets,
    clips: normalizedClips,
  };
}

function createLegacyProject({ videoFile, duration }) {
  const absPath = path.resolve(videoFile);
  const ext = path.extname(absPath);
  const baseName = path.basename(absPath, ext);
  const isAudio = ['.mp3', '.m4a', '.wav', '.aac', '.flac', '.ogg'].includes(ext.toLowerCase());
  return normalizeProject({
    version: 1,
    name: baseName,
    assets: [{
      id: 'asset-1',
      name: baseName,
      path: absPath,
      kind: isAudio ? 'audio' : 'video',
      hasAudio: true,
      hasVideo: !isAudio,
      duration,
    }],
    clips: [{
      id: 'clip-1',
      assetId: 'asset-1',
      timelineStart: 0,
      sourceStart: 0,
      duration,
      trackIndex: 0,
      lane: 0,
      audioRole: 'dialogue',
    }],
  });
}

function subtractRanges(start, end, ranges) {
  let pieces = [{ start, end }];
  ranges.forEach((range) => {
    const rStart = numeric(range.start, 0);
    const rEnd = numeric(range.end, 0);
    if (!(rEnd > rStart)) return;
    const next = [];
    pieces.forEach((piece) => {
      if (rEnd <= piece.start || rStart >= piece.end) {
        next.push(piece);
        return;
      }
      if (rStart > piece.start) next.push({ start: piece.start, end: Math.min(rStart, piece.end) });
      if (rEnd < piece.end) next.push({ start: Math.max(rEnd, piece.start), end: piece.end });
    });
    pieces = next;
  });
  return pieces.filter(piece => piece.end - piece.start > 0.001);
}

function applyTimelineDeletes(project, deleteRanges) {
  const normalized = normalizeProject(project);
  const ranges = Array.isArray(deleteRanges) ? deleteRanges : [];
  const assetById = new Map(normalized.assets.map(asset => [asset.id, asset]));
  const finalClips = [];

  normalized.clips.filter(clip => clip.enabled).forEach((clip) => {
    const timelineEnd = clip.timelineStart + clip.duration;
    subtractRanges(clip.timelineStart, timelineEnd, ranges).forEach((piece, pieceIndex) => {
      const sourceStart = clip.sourceStart + (piece.start - clip.timelineStart);
      finalClips.push({
        id: `${clip.id}-${pieceIndex + 1}`,
        assetId: clip.assetId,
        asset: assetById.get(clip.assetId),
        timelineStart: piece.start,
        sourceStart,
        duration: piece.end - piece.start,
        trackIndex: clip.trackIndex,
        lane: clip.lane,
        audioRole: clip.audioRole,
      });
    });
  });

  finalClips.sort((a, b) => a.timelineStart - b.timelineStart || a.lane - b.lane);
  return finalClips;
}

function getProjectDuration(project) {
  return normalizeProject(project).clips.reduce((max, clip) => (
    Math.max(max, clip.timelineStart + clip.duration)
  ), 0);
}

module.exports = {
  normalizeProject,
  createLegacyProject,
  applyTimelineDeletes,
  getProjectDuration,
};
