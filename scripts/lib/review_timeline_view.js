'use strict';

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ReviewTimelineView = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const TIMELINE_MODE_KEY = 'reviewTimelineMode';
  const DEFAULT_TIMELINE_MODE = 'overlay';
  const TIMELINE_MODES = ['overlay', 'strip'];
  const REVIEW_STATUS_COLORS = {
    delete: 'rgba(239, 68, 68, 0.42)',
    breath: 'rgba(6, 182, 212, 0.34)',
    playhead: 'rgba(249, 115, 22, 0.38)',
  };

  const num = (value, fallback = 0) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  };
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const normalizeTimelineMode = value => TIMELINE_MODES.includes(value) ? value : DEFAULT_TIMELINE_MODE;
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
  const selectableBreathSegments = (words = [], { minDuration = 0.02 } = {}) => {
    const segments = [];
    let current = null;
    words.forEach((word) => {
      if (!word || !word.isGap) {
        if (current) {
          if (current.end - current.start >= minDuration) segments.push(current);
          current = null;
        }
        return;
      }
      const start = num(word.start);
      const end = num(word.end);
      if (!(end > start)) return;
      if (current && start <= current.end + 1e-6) {
        current.end = Math.max(current.end, end);
      } else {
        if (current && current.end - current.start >= minDuration) segments.push(current);
        current = { start, end };
      }
    });
    if (current && current.end - current.start >= minDuration) segments.push(current);
    return segments;
  };
  const buildStatusBands = ({ deleteSegs = [], breathSegs = [], silencePeriods = [] } = {}) => {
    const normalize = (range, kind) => ({ kind, start: num(range.start), end: num(range.end) });
    const breaths = breathSegs.length ? breathSegs : silencePeriods;
    return [
      ...breaths.map(range => normalize(range, 'breath')).filter(range => range.end > range.start),
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
    DEFAULT_TIMELINE_MODE,
    TIMELINE_MODES,
    REVIEW_STATUS_COLORS,
    buildStatusBands,
    clamp,
    clampViewStart,
    clipVisibleSourceWindow,
    normalizeTimelineMode,
    num,
    selectableBreathSegments,
    timelineDuration,
    trackCountForProject,
  };
});
