const assert = require('assert');
const childProcess = require('child_process');

const originalExecSync = childProcess.execSync;
childProcess.execSync = () => {
  throw new Error('ffprobe unavailable');
};

try {
  const { buildFcpxml } = require('../scripts/lib/fcpxml');

  const result = buildFcpxml({
    videoFile: '/tmp/example.mp3',
    deleteList: [{ start: 1, end: 2 }],
    silencePeriods: [],
    cutOpts: { crossfadeMs: 100 },
    durationHint: 10,
  });

  assert(result.xml.includes('hasAudio="1"'), 'audio asset should declare audio');
  assert(result.xml.includes('hasVideo="0"'), 'audio asset should not declare video');
  assert(result.xml.includes('src="file:///tmp/example.mp3"'), 'asset should reference the mp3 file');
  assert(result.finalKeeps.length > 0, 'audio-only export should still compute keep ranges');
  assert(result.xml.includes('<gap name="Crossfade Timeline"'), 'crossfade export should use an overlap-capable timeline container');
  assert(result.xml.includes('<fadeIn type="easeIn"'), 'incoming clip should carry a volume fade-in');
  assert(result.xml.includes('<fadeOut type="easeOut"'), 'outgoing clip should carry a volume fade-out');
} finally {
  childProcess.execSync = originalExecSync;
}
