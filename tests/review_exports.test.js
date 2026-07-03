const assert = require('assert');

const {
  buildAudioExportArgs,
  buildConcatScript,
  buildEditedSrt,
  normalizeBitrate,
  parseFfmpegProgressLine,
  renderEditedAudio,
} = require('../scripts/lib/review_exports');

{
  const words = [
    { text: '你', start: 0.0, end: 0.2 },
    { text: '好', start: 0.2, end: 0.4 },
    { text: '嗯', start: 0.4, end: 0.6 },
    { text: '世', start: 1.0, end: 1.2 },
    { text: '界', start: 1.2, end: 1.4 },
    { text: '。', start: 1.4, end: 1.5 },
  ];
  const result = buildEditedSrt({
    words,
    finalKeeps: [
      { start: 0.0, end: 0.4 },
      { start: 1.0, end: 1.5 },
    ],
  });

  assert.strictEqual(result.cues.length, 1, 'continuous edited speech should become one cue');
  assert(result.srt.includes('00:00:00,000 --> 00:00:00,900'), 'cue time should be collapsed through deleted ranges');
  assert(result.srt.includes('你好世界。'), 'kept words should be preserved');
  assert(!result.srt.includes('嗯'), 'deleted words should not appear in SRT');
}

{
  assert.strictEqual(normalizeBitrate('128k'), '128k');
  assert.strictEqual(normalizeBitrate(192), '192k');
  assert.throws(() => normalizeBitrate('320k'), /Unsupported bitrate/);
}

{
  const concatScript = buildConcatScript({
    sourceAudio: '/tmp/source file.mp3',
    finalKeeps: [
      { start: 0.0, end: 0.5 },
      { start: 1.0, end: 1.4 },
    ],
  });
  assert(concatScript.includes('ffconcat version 1.0'), 'concat demuxer script should declare ffconcat format');
  assert(concatScript.includes("file '/tmp/source file.mp3'"), 'concat script should reference source audio');
  assert(concatScript.includes('inpoint 1.000'), 'concat script should include segment inpoints');
  assert(concatScript.includes('outpoint 1.400'), 'concat script should include segment outpoints');
}

{
  const args = buildAudioExportArgs({
    concatFile: '/tmp/keep.ffconcat',
    outputPath: '/tmp/out.mp3',
    bitrate: '128k',
    includeProgress: true,
  });
  assert(args.includes('-f') && args.includes('concat'), 'audio export should use concat demuxer');
  assert(args.includes('-progress') && args.includes('pipe:2'), 'audio export should emit machine-readable progress');
  assert(!args.includes('-filter_complex'), 'audio export should not create a giant per-segment filter graph');
  assert(args.includes('aselect=concatdec_select,asetpts=N/SR/TB'), 'concat demuxer boundaries should be cleaned and collapsed');
}

{
  const progress = parseFfmpegProgressLine('out_time_ms=2500000', 10);
  assert.strictEqual(progress.outTime, 2.5, 'ffmpeg out_time_ms should be parsed as seconds');
  assert.strictEqual(progress.progress, 0.25, 'progress should be relative to expected output duration');
}

{
  const calls = [];
  const spawnSync = (cmd, args) => {
    calls.push({ cmd, args });
    return { status: 0 };
  };
  renderEditedAudio({
    sourceAudio: '/tmp/source.mp3',
    outputPath: '/tmp/out.mp3',
    finalKeeps: [
      { start: 0.0, end: 0.5 },
      { start: 1.0, end: 1.4 },
    ],
    bitrate: '128k',
    spawnSync,
  });

  assert.strictEqual(calls.length, 1, 'ffmpeg should be invoked once');
  assert.strictEqual(calls[0].cmd, 'ffmpeg');
  assert(calls[0].args.includes('-b:a'), 'target bitrate flag should be present');
  assert(calls[0].args.includes('128k'), 'target bitrate should be passed to ffmpeg');
  assert(calls[0].args.includes('-f') && calls[0].args.includes('concat'), 'ffmpeg should read a concat script');
  assert(!calls[0].args.includes('-filter_complex'), 'ffmpeg should avoid a giant filter graph');
}
