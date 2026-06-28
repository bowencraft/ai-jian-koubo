const assert = require('assert');
const childProcess = require('child_process');

const originalExecSync = childProcess.execSync;
childProcess.execSync = (cmd) => {
  if (cmd.includes('format=duration')) return Buffer.from('12\n');
  throw new Error('video probing unavailable in test');
};

try {
  const { buildTimelineFcpxml } = require('../scripts/lib/fcpxml');

  const project = {
    version: 1,
    name: 'multitrack-demo',
    assets: [
      { id: 'host', name: 'Host Mic', path: '/tmp/host.m4a', kind: 'audio' },
      { id: 'guest', name: 'Guest Mic', path: '/tmp/guest.m4a', kind: 'audio' },
    ],
    clips: [
      {
        id: 'clip-host',
        assetId: 'host',
        trackIndex: 0,
        lane: 0,
        timelineStart: 0,
        sourceStart: 0,
        duration: 10,
        audioRole: 'dialogue.host',
      },
      {
        id: 'clip-guest',
        assetId: 'guest',
        trackIndex: 1,
        lane: 1,
        timelineStart: 2,
        sourceStart: 1,
        duration: 8,
        audioRole: 'dialogue.guest',
      },
    ],
  };

  const result = buildTimelineFcpxml({
    project,
    deleteList: [{ start: 3, end: 4 }],
    silencePeriods: [],
    cutOpts: {},
    durationHint: 12,
    outputPath: '/tmp/multitrack-demo_cut.fcpxml',
  });

  assert(result.xml.includes('asset id="r1"'), 'first source asset should be declared');
  assert(result.xml.includes('asset id="r2"'), 'second source asset should be declared');
  assert(result.xml.includes('src="file:///tmp/host.m4a"'), 'host source should be referenced');
  assert(result.xml.includes('src="file:///tmp/guest.m4a"'), 'guest source should be referenced');
  assert(result.xml.includes('lane="1"'), 'second track clip should export on a non-primary lane');
  assert(result.xml.includes('audioRole="dialogue.guest"'), 'clip audio role should be preserved');
  assert(result.finalClips.length === 4, 'delete range should split two timeline clips into four exported clips');
  assert(result.finalClips.every(c => c.duration > 0), 'exported clips should all have positive duration');
} finally {
  childProcess.execSync = originalExecSync;
}
