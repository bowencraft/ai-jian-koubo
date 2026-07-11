const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { resolveReviewPlaybackFile } = require('../scripts/lib/review_media');
const { computeFinalKeeps, keepsToCuts } = require('../scripts/lib/compute_keeps');
const {
  buildTimelineAudioArgs,
  listAudibleTimelineClips,
  timelineAudioSignature,
} = require('../scripts/lib/timeline_audio');
const {
  parseMaxVolume,
  parseSilencePeriods,
  silenceThresholdForMaxVolume,
} = require('../scripts/lib/review_audio_analysis');

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-playback-'));
  const reviewAudio = path.join(dir, 'audio.mp3');
  const legacyAudio = path.join(dir, 'legacy.mp3');
  fs.writeFileSync(reviewAudio, 'review');
  fs.writeFileSync(legacyAudio, 'legacy');

  assert.strictEqual(
    resolveReviewPlaybackFile({ cwd: dir, videoFile: legacyAudio }),
    reviewAudio,
    'review audio should be the primary /video source when present'
  );

  fs.unlinkSync(reviewAudio);
  assert.strictEqual(
    resolveReviewPlaybackFile({ cwd: dir, videoFile: legacyAudio }),
    legacyAudio,
    'legacy video argument should remain the fallback when review audio is absent'
  );
}

{
  const project = {
    version: 1,
    name: 'mix-demo',
    assets: [
      { id: 'a', name: 'A', path: 'media/a.wav', kind: 'audio', hasAudio: true },
      { id: 'b', name: 'B', path: 'media/b.wav', kind: 'audio', hasAudio: true },
      { id: 'c', name: 'C', path: 'media/c.wav', kind: 'audio', hasAudio: true },
    ],
    clips: [
      { id: 'clip-a', assetId: 'a', timelineStart: 0, sourceStart: 1, duration: 3, trackIndex: 0 },
      { id: 'clip-b', assetId: 'b', timelineStart: 1, sourceStart: 2, duration: 4, trackIndex: 1 },
      { id: 'clip-c', assetId: 'c', timelineStart: 2, sourceStart: 0, duration: 5, trackIndex: 2 },
    ],
    timeline: {
      trackCount: 3,
      tracks: [
        { disabled: false },
        { disabled: true },
        { solo: true },
      ],
    },
  };

  const audible = listAudibleTimelineClips(project);
  assert.deepStrictEqual(
    audible.map(item => item.clip.id),
    ['clip-c'],
    'solo tracks should be the only audible tracks, and disabled tracks should stay muted'
  );

  const { args } = buildTimelineAudioArgs({
    project,
    outputFile: 'audio.mp3',
    projectDir: '/tmp/review-dir',
  });
  assert.deepStrictEqual(
    args.filter((value, index) => args[index - 1] === '-i'),
    ['/tmp/review-dir/media/c.wav'],
    'relative asset paths should resolve against the project file directory'
  );
  assert(args.includes('audio.mp3'), 'ffmpeg args should target the requested output file');
  assert(args.some(value => value.includes('amix=inputs=1')), 'one audible clip should produce a one-input mix');
}

{
  const baseProject = {
    assets: [{ id: 'a', path: 'media/a.wav', hasAudio: true, waveform: [0, 1, 0] }],
    clips: [{ id: 'clip-a', assetId: 'a', timelineStart: 0, sourceStart: 0, duration: 10, trackIndex: 0 }],
    timeline: { tracks: [{ disabled: false }] },
  };
  const sameAudio = {
    ...baseProject,
    assets: [{ id: 'a', path: 'media/a.wav', hasAudio: true, waveform: [1, 0, 1] }],
  };
  const movedClip = {
    ...baseProject,
    clips: [{ id: 'clip-a', assetId: 'a', timelineStart: 1, sourceStart: 0, duration: 10, trackIndex: 0 }],
  };

  assert.strictEqual(
    timelineAudioSignature(baseProject),
    timelineAudioSignature(sameAudio),
    'waveform cache changes should not make review audio stale'
  );
  assert.notStrictEqual(
    timelineAudioSignature(baseProject),
    timelineAudioSignature(movedClip),
    'clip timing changes should make review audio stale'
  );
}

{
  const log = [
    '[Parsed_volumedetect_0 @ 0x0] max_volume: -3.4 dB',
    '[silencedetect @ 0x0] silence_start: 1.25',
    '[silencedetect @ 0x0] silence_end: 2.50 | silence_duration: 1.25',
    '[silencedetect @ 0x0] silence_start: 9.00',
  ].join('\n');

  assert.strictEqual(parseMaxVolume(log), -3.4);
  assert.strictEqual(silenceThresholdForMaxVolume(-3.4), -38.4);
  assert.deepStrictEqual(parseSilencePeriods(log, 12), [
    { start: 1.25, end: 2.5 },
    { start: 9, end: 12 },
  ]);
}

{
  const silencePeriods = [
    { start: 1.0, end: 1.4 },
    { start: 2.0, end: 2.4 },
  ];
  const keeps = computeFinalKeeps([], silencePeriods, 4, { trimInternalSilence: false });
  assert.deepStrictEqual(
    keeps,
    [{ start: 0, end: 4 }],
    'unselected breath regions should not be cut when internal silence trimming is disabled'
  );
  assert.deepStrictEqual(keepsToCuts(keeps, 4), []);
}
