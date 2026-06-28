#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { normalizeProject } = require('./lib/timeline_project');

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

const project = normalizeProject(JSON.parse(fs.readFileSync(projectFile, 'utf8')));
const clips = project.clips.filter((clip) => {
  const asset = project.assets.find(a => a.id === clip.assetId);
  return clip.enabled !== false && asset && asset.hasAudio !== false;
});

if (!clips.length) {
  console.error('❌ project.json 中没有可混音的音频片段');
  process.exit(1);
}

const args = ['-y'];
const filters = [];
const labels = [];

clips.forEach((clip, index) => {
  const asset = project.assets.find(a => a.id === clip.assetId);
  args.push('-i', asset.path);
  const delayMs = Math.max(0, Math.round(clip.timelineStart * 1000));
  const sourceStart = Math.max(0, clip.sourceStart);
  const duration = Math.max(0.001, clip.duration);
  const label = `a${index}`;
  filters.push(
    `[${index}:a]atrim=start=${sourceStart.toFixed(3)}:duration=${duration.toFixed(3)},` +
    `asetpts=PTS-STARTPTS,adelay=${delayMs}:all=1[${label}]`
  );
  labels.push(`[${label}]`);
});

filters.push(`${labels.join('')}amix=inputs=${labels.length}:normalize=0:dropout_transition=0[out]`);
args.push('-filter_complex', filters.join(';'), '-map', '[out]', '-ac', '2', '-ar', '48000', '-codec:a', 'libmp3lame', outputFile);

const result = spawnSync('ffmpeg', args, { stdio: 'inherit' });
if (result.status !== 0) {
  process.exit(result.status || 1);
}

console.log('✅ 多轨审核音频已生成: ' + path.resolve(outputFile));
