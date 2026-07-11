const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  REVIEW_STATUS_COLORS,
  buildStatusBands,
  clampViewStart,
  clipVisibleSourceWindow,
  normalizeTimelineMode,
  selectableBreathSegments,
  timelineDuration,
  trackCountForProject,
} = require('../scripts/lib/review_timeline_view');

assert.strictEqual(normalizeTimelineMode('overlay'), 'overlay');
assert.strictEqual(normalizeTimelineMode('strip'), 'strip');
assert.strictEqual(normalizeTimelineMode('bad-value'), 'overlay');

assert.strictEqual(REVIEW_STATUS_COLORS.delete, 'rgba(239, 68, 68, 0.42)');
assert.strictEqual(REVIEW_STATUS_COLORS.breath, 'rgba(6, 182, 212, 0.34)');
assert.strictEqual(REVIEW_STATUS_COLORS.playhead, 'rgba(249, 115, 22, 0.38)');
assert(!('deleteEdge' in REVIEW_STATUS_COLORS), 'delete status should not expose edge colors');
assert(!('breathEdge' in REVIEW_STATUS_COLORS), 'breath status should not expose edge colors');

const reviewHtml = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'templates', 'review.html'), 'utf8');
const reviewJs = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'templates', 'review.js'), 'utf8');
assert(!reviewHtml.includes('themeSelect'), 'review page should not render the removed waveform theme picker');
assert(reviewHtml.includes('叠加模式'), 'review page should label overlay mode as 叠加模式');
assert(reviewHtml.includes('独立模式'), 'review page should label strip mode as 独立模式');
assert(reviewJs.includes('class="clip-waveform"'), 'review page project tracks should render per-clip waveform canvases');
assert(reviewJs.includes('trimInternalSilence: false'), 'review playback/export should not auto-cut unselected breath regions');
assert(!reviewJs.includes('WAVE_THEMES'), 'review page should not keep removed waveform theme logic');
assert(!reviewJs.includes('resolveWaveTheme'), 'review page should not keep removed waveform theme resolver');

const breathSegs = selectableBreathSegments([
  { isGap: true, start: 1.0, end: 1.2 },
  { text: '你', start: 1.2, end: 1.4 },
  { isGap: true, start: 2.0, end: 2.1 },
  { isGap: true, start: 2.1, end: 2.5 },
  { isGap: true, start: 4.0, end: 4.01 },
]);
assert.deepStrictEqual(breathSegs, [
  { start: 1.0, end: 1.2 },
  { start: 2.0, end: 2.5 },
]);

const bands = buildStatusBands({
  deleteSegs: [{ start: 2, end: 3 }],
  breathSegs,
});
assert.deepStrictEqual(bands.map(band => band.kind), ['breath', 'breath', 'delete']);
assert.deepStrictEqual(bands.filter(band => band.kind === 'breath').map(({ start, end }) => ({ start, end })), breathSegs);
assert(!bands.some(band => band.kind === 'keep'));
assert(!bands.some(band => band.kind === 'extra-cut'));

assert.strictEqual(clampViewStart({ viewStart: 50, viewDuration: 20, duration: 60 }), 40);
assert.strictEqual(clampViewStart({ viewStart: -5, viewDuration: 20, duration: 60 }), 0);
assert.strictEqual(clampViewStart({ viewStart: 10, viewDuration: 80, duration: 60 }), 0);

assert.strictEqual(timelineDuration({
  words: [{ end: 4.5 }],
  project: { clips: [{ timelineStart: 10, duration: 3 }] },
}), 13);

assert.strictEqual(trackCountForProject({
  timeline: { trackCount: 2 },
  clips: [{ trackIndex: 3, duration: 1, timelineStart: 0 }],
}), 4);

assert.deepStrictEqual(clipVisibleSourceWindow({
  clip: { sourceStart: 5, timelineStart: 10, duration: 8 },
  viewStart: 12,
  viewEnd: 16,
}), { sourceStart: 7, timelineStart: 12, duration: 4 });
