'use strict';

const fs = require('fs');
const crypto = require('crypto');

function hashBuffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function hashFile(filePath) {
  try {
    return hashBuffer(fs.readFileSync(filePath));
  } catch (err) {
    return '';
  }
}

function normalizeName(value) {
  return String(value || '').trim().toLowerCase();
}

function findDuplicateAsset(project, candidate, resolvePath = value => value) {
  const assets = Array.isArray(project && project.assets) ? project.assets : [];
  const contentHash = normalizeName(candidate && candidate.contentHash);
  const originalName = normalizeName(candidate && candidate.originalName);
  const fileSize = Number(candidate && candidate.fileSize);

  return assets.find((asset) => {
    const assetHash = normalizeName(asset.contentHash) || normalizeName(hashFile(resolvePath(asset.path)));
    if (contentHash && assetHash && contentHash === assetHash) return true;

    const sameName = originalName && (
      normalizeName(asset.originalName) === originalName ||
      normalizeName(asset.path && asset.path.split(/[\\/]/).pop()) === originalName
    );
    const sameSize = Number.isFinite(fileSize) && Number(asset.fileSize) === fileSize;
    return sameName && sameSize;
  }) || null;
}

module.exports = {
  hashBuffer,
  hashFile,
  findDuplicateAsset,
};
