const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const editorHtml = read('scripts/templates/editor.html');
const editorCss = read('scripts/templates/editor.css');
const editorJs = read('scripts/templates/editor.js');
const reviewHtml = read('scripts/templates/review.html');
const reviewJs = read('scripts/templates/review.js');
const serverJs = read('scripts/review_server.js');
const serveProject = read('scripts/serve_project.sh');

for (const id of ['importProjectBtn', 'exportProjectBtn', 'reviewBtn', 'staleBtn', 'saveBtn']) {
  const button = editorHtml.match(new RegExp(`<button[^>]+id="${id}"[\\s\\S]*?</button>`));
  assert(button, `${id} should exist`);
  assert(button[0].includes('<svg class="ui-icon"'), `${id} should use a self-contained SVG icon`);
}
assert(editorCss.includes('.ui-icon {'));
assert(editorHtml.includes('id="handoffModal"'));
assert(editorHtml.includes('id="handoffPrompt"'));
assert(editorJs.includes('创建“${action}与智能裁切”任务'));
assert(editorJs.includes('staleBtn.disabled = !project.clips.length'));
assert(!editorJs.includes('staleBtn.disabled = !reviewReady'));

assert(reviewHtml.includes('id="distributionModal"'));
assert(reviewHtml.includes('id="distributionPrompt"'));
assert(reviewHtml.includes('<div class="brand">剪<em>播客</em></div>'));
assert(!reviewHtml.includes('class="brand-mark"'));
assert(!reviewHtml.includes('fonts.googleapis.com'));
assert.strictEqual((reviewHtml.match(/class="ui-icon/g) || []).length >= 9, true);
assert(reviewJs.includes('创建“打包并分发审核页”任务'));
assert(reviewJs.includes('package_review.sh'));
assert(reviewJs.includes("classList.toggle('is-playing', playing)"));
assert(reviewJs.includes('bindReviewTooltips()'));

assert(serverJs.includes('projectFile: PROJECT_FILE'));
assert(serverJs.includes('reviewDir: process.cwd()'));
assert(serveProject.includes('sync_template'));
assert(!serveProject.includes('copy_if_missing'));

console.log('workflow handoff tests passed');
