#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { renderTimelineAudio } = require('./lib/timeline_audio');

const projectFile = process.argv[2];
const outputFile = process.argv[3] || 'review_mix.mp3';

if (!projectFile) {
  console.error('用法: node render_timeline_audio.js <project.json> [review_mix.mp3]');
  process.exit(1);
}

if (!fs.existsSync(projectFile)) {
  console.error('❌ project.json 不存在: ' + projectFile);
  process.exit(1);
}

try {
  renderTimelineAudio({
    projectFile,
    outputFile,
    projectDir: path.dirname(path.resolve(projectFile)),
  });
} catch (err) {
  console.error('❌ ' + err.message);
  process.exit(1);
}

console.log('✅ 多轨审核音频已生成: ' + path.resolve(outputFile));
