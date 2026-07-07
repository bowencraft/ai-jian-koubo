'use strict';

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ReviewTimelineView = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const TIMELINE_MODE_KEY = 'reviewTimelineMode';
  const WAVE_THEME_KEY = 'reviewWaveTheme';
  const DEFAULT_TIMELINE_MODE = 'overlay';
  const TIMELINE_MODES = ['overlay', 'strip'];
  const REVIEW_STATUS_COLORS = {
    delete: 'rgba(239, 68, 68, 0.42)',
    deleteEdge: 'rgba(239, 68, 68, 0.95)',
    breath: 'rgba(6, 182, 212, 0.34)',
    breathEdge: 'rgba(6, 182, 212, 0.88)',
    playhead: '#f97316',
  };
  const WAVE_THEMES = {
    cool: {
      name: '冷调蓝白',
      bg: '#0E0E13',
      wave: '#8CA0C8',
      waveSoft: 'rgba(140,160,200,0.36)',
      center: '#23252E',
      clipWave: 'rgba(80,198,236,.78)',
      clipWaveEdge: 'rgba(180,226,244,.48)',
    },
    mint: {
      name: '薄荷青',
      bg: '#0D0F0E',
      wave: '#5EEAD4',
      waveSoft: 'rgba(94,234,212,0.32)',
      center: '#1F2826',
      clipWave: 'rgba(94,234,212,.78)',
      clipWaveEdge: 'rgba(181,245,236,.5)',
    },
    recut: {
      name: 'Recut 暖灰',
      bg: '#1A1917',
      wave: '#A89F90',
      waveSoft: 'rgba(168,159,144,0.34)',
      center: '#2A2823',
      clipWave: 'rgba(214,197,166,.74)',
      clipWaveEdge: 'rgba(245,231,199,.45)',
    },
    outline: {
      name: '石墨霓虹',
      bg: '#101014',
      wave: '#B7BCC9',
      waveSoft: 'rgba(183,188,201,0.30)',
      center: '#26262C',
      clipWave: 'rgba(183,188,201,.76)',
      clipWaveEdge: 'rgba(236,239,248,.42)',
    },
  };

  const num = (value, fallback = 0) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  };
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const normalizeTimelineMode = value => TIMELINE_MODES.includes(value) ? value : DEFAULT_TIMELINE_MODE;
  const resolveWaveTheme = (key) => {
    const safeKey = WAVE_THEMES[key] ? key : 'cool';
    return { key: safeKey, theme: WAVE_THEMES[safeKey] };
  };
  const clampViewStart = ({ viewStart, viewDuration, duration }) => {
    const dur = Math.max(0, num(duration));
    const vd = Math.max(0, num(viewDuration));
    if (vd >= dur || dur <= 0) return 0;
    return clamp(num(viewStart), 0, dur - vd);
  };
  const timelineDuration = ({ words = [], project = null } = {}) => Math.max(
    1,
    ...words.map(word => num(word && word.end)),
    ...((project && Array.isArray(project.clips))
      ? project.clips.map(clip => num(clip.timelineStart) + num(clip.duration))
      : [])
  );
  const trackCountForProject = (project) => {
    if (!project || !Array.isArray(project.clips)) return 0;
    const declared = Math.floor(num(project.timeline && project.timeline.trackCount, num(project.trackCount)));
    const needed = project.clips.reduce((max, clip) => Math.max(
      max,
      Math.floor(num(clip.trackIndex, num(clip.lane))) + 1
    ), 0);
    return Math.max(declared, needed, project.clips.length ? 1 : 0);
  };
  const buildStatusBands = ({ deleteSegs = [], silencePeriods = [] } = {}) => {
    const normalize = (range, kind) => ({ kind, start: num(range.start), end: num(range.end) });
    return [
      ...silencePeriods.map(range => normalize(range, 'breath')).filter(range => range.end > range.start),
      ...deleteSegs.map(range => normalize(range, 'delete')).filter(range => range.end > range.start),
    ];
  };
  const clipVisibleSourceWindow = ({ clip, viewStart, viewEnd }) => {
    const start = Math.max(num(clip.timelineStart), num(viewStart));
    const end = Math.min(num(clip.timelineStart) + num(clip.duration), num(viewEnd));
    if (!(end > start)) return null;
    return {
      sourceStart: num(clip.sourceStart) + (start - num(clip.timelineStart)),
      timelineStart: start,
      duration: end - start,
    };
  };

  return {
    TIMELINE_MODE_KEY,
    WAVE_THEME_KEY,
    DEFAULT_TIMELINE_MODE,
    TIMELINE_MODES,
    REVIEW_STATUS_COLORS,
    WAVE_THEMES,
    buildStatusBands,
    clamp,
    clampViewStart,
    clipVisibleSourceWindow,
    normalizeTimelineMode,
    num,
    resolveWaveTheme,
    timelineDuration,
    trackCountForProject,
  };
});
