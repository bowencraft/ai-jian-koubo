const assert = require('assert');
const {
  REVIEW_STATUS_COLORS,
  WAVE_THEMES,
  buildStatusBands,
  clampViewStart,
  clipVisibleSourceWindow,
  normalizeTimelineMode,
  resolveWaveTheme,
  timelineDuration,
  trackCountForProject,
} = require('../scripts/lib/review_timeline_view');

assert.strictEqual(normalizeTimelineMode('overlay'), 'overlay');
assert.strictEqual(normalizeTimelineMode('strip'), 'strip');
assert.strictEqual(normalizeTimelineMode('bad-value'), 'overlay');

assert.strictEqual(resolveWaveTheme('mint').key, 'mint');
assert.strictEqual(resolveWaveTheme('missing').key, 'cool');
assert.notStrictEqual(WAVE_THEMES.cool.wave, WAVE_THEMES.mint.wave);
assert.strictEqual(REVIEW_STATUS_COLORS.delete, 'rgba(239, 68, 68, 0.42)');
assert.strictEqual(REVIEW_STATUS_COLORS.breath, 'rgba(6, 182, 212, 0.34)');
assert.strictEqual(REVIEW_STATUS_COLORS.playhead, '#f97316');

const bands = buildStatusBands({
  deleteSegs: [{ start: 2, end: 3 }],
  silencePeriods: [{ start: 1, end: 1.5 }, { start: 2.2, end: 2.8 }],
});
assert.deepStrictEqual(bands.map(band => band.kind), ['breath', 'breath', 'delete']);
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
