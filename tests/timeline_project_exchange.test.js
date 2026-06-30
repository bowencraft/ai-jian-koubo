const assert = require('assert');
const { stripProjectWaveforms } = require('../scripts/lib/timeline_project');

const compact = stripProjectWaveforms({
  version: 1,
  name: 'exchange-demo',
  assets: [{
    id: 'asset-1',
    name: 'dialogue',
    path: 'media/dialogue.wav',
    kind: 'audio',
    duration: 12,
    waveform: [0, 0.5, 1],
  }],
  clips: [{
    id: 'clip-1',
    assetId: 'asset-1',
    timelineStart: 2,
    sourceStart: 1,
    duration: 8,
    trackIndex: 1,
    lane: 1,
    audioRole: 'dialogue',
  }],
  timeline: {
    trackCount: 2,
    tracks: [{ disabled: false }, { solo: true }],
  },
});

assert.strictEqual(compact.assets.length, 1);
assert.strictEqual(compact.assets[0].waveform, undefined);
assert.strictEqual(compact.assets[0].duration, 12);
assert.strictEqual(compact.clips[0].timelineStart, 2);
assert.strictEqual(compact.clips[0].sourceStart, 1);
assert.strictEqual(compact.timeline.trackCount, 4);
assert.strictEqual(compact.timeline.tracks[1].solo, true);
