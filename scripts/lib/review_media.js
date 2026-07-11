'use strict';

const fs = require('fs');
const path = require('path');

function resolveReviewPlaybackFile({ cwd = process.cwd(), videoFile = '', fsImpl = fs } = {}) {
  const reviewAudio = path.resolve(cwd, 'audio.mp3');
  if (fsImpl.existsSync(reviewAudio)) return reviewAudio;
  if (videoFile && fsImpl.existsSync(videoFile)) return videoFile;
  return '';
}

module.exports = {
  resolveReviewPlaybackFile,
};
