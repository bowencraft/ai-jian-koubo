const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-jian-koubo-package-'));

try {
  const projectRoot = path.join(tempRoot, 'episode-demo');
  const reviewDir = path.join(projectRoot, '剪口播', '3_审核');
  const shareDir = path.join(tempRoot, 'share');
  const externalAsset = path.join(tempRoot, 'dialogue.wav');
  fs.mkdirSync(reviewDir, { recursive: true });
  fs.mkdirSync(shareDir, { recursive: true });
  fs.writeFileSync(externalAsset, Buffer.from('portable-audio-fixture'));
  fs.writeFileSync(path.join(reviewDir, 'review.html'), '<!doctype html><title>review</title>');
  fs.writeFileSync(path.join(reviewDir, 'review.css'), 'body{}');
  fs.writeFileSync(path.join(reviewDir, 'review.js'), '');
  fs.writeFileSync(path.join(reviewDir, 'audio.mp3'), Buffer.from('review-audio-fixture'));

  const project = {
    version: 1,
    name: 'episode-demo',
    assets: [{ id: 'host', name: 'Host', path: externalAsset, kind: 'audio', waveform: [0, 0.5, 1] }],
    clips: [{ id: 'host-1', assetId: 'host', timelineStart: 0, sourceStart: 0, duration: 1, trackIndex: 0 }],
    timeline: { trackCount: 4 },
  };
  const data = {
    words: [],
    autoSelected: [],
    project,
    timeline: { assets: project.assets, clips: project.clips, trackCount: 4 },
  };
  fs.writeFileSync(path.join(reviewDir, 'project.json'), JSON.stringify(project));
  fs.writeFileSync(path.join(reviewDir, 'data.json'), JSON.stringify(data));

  const output = execFileSync('bash', [path.join(root, 'scripts', 'package_review.sh'), reviewDir, shareDir], {
    encoding: 'utf8',
  });
  const packageDir = output.match(/^PACKAGE_DIR=(.+)$/m)?.[1];
  const archive = output.match(/^PACKAGE_ARCHIVE=(.+)$/m)?.[1];
  assert(packageDir && fs.existsSync(packageDir), 'package directory should be created');
  assert(archive && fs.existsSync(archive), 'zip archive should be created');
  assert(path.basename(packageDir).startsWith('episode-demo_review_package_'));

  const packagedProject = JSON.parse(fs.readFileSync(path.join(packageDir, 'review', 'project.json'), 'utf8'));
  const portablePath = packagedProject.assets[0].path;
  assert(portablePath.startsWith('media/'));
  assert(!path.isAbsolute(portablePath));
  assert(fs.existsSync(path.join(packageDir, 'review', portablePath)));
  assert.strictEqual(packagedProject.assets[0].waveform, undefined);

  const packagedData = JSON.parse(fs.readFileSync(path.join(packageDir, 'review', 'data.json'), 'utf8'));
  assert.strictEqual(packagedData.project.assets[0].path, portablePath);
  assert.strictEqual(packagedData.timeline.assets[0].path, portablePath);
  assert(!JSON.stringify(packagedData).includes('waveform'));

  const listing = execFileSync('python3', ['-m', 'zipfile', '-l', archive], { encoding: 'utf8' });
  assert(listing.includes('start.sh'));
  assert(listing.includes(path.basename(portablePath)));

  console.log('review package tests passed');
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
