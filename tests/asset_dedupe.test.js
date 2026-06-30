const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { hashBuffer, findDuplicateAsset } = require('../scripts/lib/asset_dedupe');
const { normalizeProject } = require('../scripts/lib/timeline_project');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-dedupe-'));
const mediaPath = path.join(tempDir, 'raw-combined.mp3');
const mediaBytes = Buffer.from('same audio bytes');
fs.writeFileSync(mediaPath, mediaBytes);

const normalized = normalizeProject({
  assets: [{
    id: 'asset-1',
    name: 'raw-combined',
    path: mediaPath,
    kind: 'audio',
    hasAudio: true,
    hasVideo: false,
    duration: 10,
    originalName: 'raw-combined.mp3',
    fileSize: mediaBytes.length,
    contentHash: hashBuffer(mediaBytes),
  }],
  clips: [],
});

assert.strictEqual(normalized.assets[0].originalName, 'raw-combined.mp3');
assert.strictEqual(normalized.assets[0].fileSize, mediaBytes.length);
assert.strictEqual(normalized.assets[0].contentHash, hashBuffer(mediaBytes));

const duplicate = findDuplicateAsset(normalized, {
  originalName: 'raw-combined.mp3',
  fileSize: mediaBytes.length,
  contentHash: hashBuffer(mediaBytes),
}, filePath => filePath);

assert(duplicate, 'same uploaded content should reuse the existing project asset');
assert.strictEqual(duplicate.id, 'asset-1');
