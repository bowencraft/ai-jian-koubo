# Review Timeline Dual Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fuse the review page waveform and multitrack project tracks into a single readable dual-mode timeline, fix waveform theme switching, and use stable colors for normal/delete/breath states.

**Architecture:** Add a small UMD helper for testable timeline view logic, then wire `review.html/css/js` to use one shared time coordinate system for ruler, tracks, clip waveforms, overlay/status canvas, and playhead. Keep the existing review data model, delete selection model, playback skip logic, and FCPXML export behavior intact.

**Tech Stack:** Plain browser HTML/CSS/JavaScript templates, Node.js `assert` tests, existing Node review server, existing `compute_keeps.js`, existing editor waveform drawing pattern.

---

### Task 1: Testable Timeline View Logic

**Files:**
- Create: `scripts/lib/review_timeline_view.js`
- Create: `tests/review_timeline_view.test.js`
- Modify: `scripts/review_server.js`
- Modify: `scripts/package_review.sh`

- [ ] **Step 1: Write the failing helper tests**

Create `tests/review_timeline_view.test.js` with these assertions:

```js
const assert = require('assert');
const {
  REVIEW_STATUS_COLORS,
  WAVE_THEMES,
  buildStatusBands,
  clampViewStart,
  clipVisibleSourceWindow,
  normalizeTimelineMode,
  resolveWaveTheme,
  timelineDuration,
  trackCountForProject,
} = require('../scripts/lib/review_timeline_view');

assert.strictEqual(normalizeTimelineMode('overlay'), 'overlay');
assert.strictEqual(normalizeTimelineMode('strip'), 'strip');
assert.strictEqual(normalizeTimelineMode('bad-value'), 'overlay');

assert.strictEqual(resolveWaveTheme('mint').key, 'mint');
assert.strictEqual(resolveWaveTheme('missing').key, 'cool');
assert.notStrictEqual(WAVE_THEMES.cool.wave, WAVE_THEMES.mint.wave);
assert.strictEqual(REVIEW_STATUS_COLORS.delete, 'rgba(239, 68, 68, 0.42)');
assert.strictEqual(REVIEW_STATUS_COLORS.breath, 'rgba(6, 182, 212, 0.34)');
assert.strictEqual(REVIEW_STATUS_COLORS.playhead, '#f97316');

const bands = buildStatusBands({
  deleteSegs: [{ start: 2, end: 3 }],
  silencePeriods: [{ start: 1, end: 1.5 }, { start: 2.2, end: 2.8 }],
});
assert.deepStrictEqual(bands.map(band => band.kind), ['breath', 'breath', 'delete']);
assert(!bands.some(band => band.kind === 'keep'));
assert(!bands.some(band => band.kind === 'extra-cut'));

assert.strictEqual(clampViewStart({ viewStart: 50, viewDuration: 20, duration: 60 }), 40);
assert.strictEqual(clampViewStart({ viewStart: -5, viewDuration: 20, duration: 60 }), 0);
assert.strictEqual(clampViewStart({ viewStart: 10, viewDuration: 80, duration: 60 }), 0);

assert.strictEqual(timelineDuration({
  words: [{ end: 4.5 }],
  project: { clips: [{ timelineStart: 10, duration: 3 }] },
}), 13);

assert.strictEqual(trackCountForProject({
  timeline: { trackCount: 2 },
  clips: [{ trackIndex: 3, duration: 1, timelineStart: 0 }],
}), 4);

assert.deepStrictEqual(clipVisibleSourceWindow({
  clip: { sourceStart: 5, timelineStart: 10, duration: 8 },
  viewStart: 12,
  viewEnd: 16,
}), { sourceStart: 7, timelineStart: 12, duration: 4 });
```

- [ ] **Step 2: Run the test and verify it fails because the helper does not exist**

Run:

```bash
node tests/review_timeline_view.test.js
```

Expected: `Cannot find module '../scripts/lib/review_timeline_view'`.

- [ ] **Step 3: Implement the minimal UMD helper**

Create `scripts/lib/review_timeline_view.js` as a browser/Node compatible module exporting:

```js
'use strict';

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ReviewTimelineView = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const TIMELINE_MODE_KEY = 'reviewTimelineMode';
  const WAVE_THEME_KEY = 'reviewWaveTheme';
  const DEFAULT_TIMELINE_MODE = 'overlay';
  const TIMELINE_MODES = ['overlay', 'strip'];
  const REVIEW_STATUS_COLORS = {
    delete: 'rgba(239, 68, 68, 0.42)',
    deleteEdge: 'rgba(239, 68, 68, 0.95)',
    breath: 'rgba(6, 182, 212, 0.34)',
    breathEdge: 'rgba(6, 182, 212, 0.88)',
    playhead: '#f97316',
  };
  const WAVE_THEMES = {
    cool: { name: '冷调蓝白', bg: '#0E0E13', wave: '#8CA0C8', waveSoft: 'rgba(140,160,200,0.36)', center: '#23252E', clipWave: 'rgba(80,198,236,.78)', clipWaveEdge: 'rgba(180,226,244,.48)' },
    mint: { name: '薄荷青', bg: '#0D0F0E', wave: '#5EEAD4', waveSoft: 'rgba(94,234,212,0.32)', center: '#1F2826', clipWave: 'rgba(94,234,212,.78)', clipWaveEdge: 'rgba(181,245,236,.5)' },
    recut: { name: 'Recut 暖灰', bg: '#1A1917', wave: '#A89F90', waveSoft: 'rgba(168,159,144,0.34)', center: '#2A2823', clipWave: 'rgba(214,197,166,.74)', clipWaveEdge: 'rgba(245,231,199,.45)' },
    outline: { name: '石墨霓虹', bg: '#101014', wave: '#B7BCC9', waveSoft: 'rgba(183,188,201,0.30)', center: '#26262C', clipWave: 'rgba(183,188,201,.76)', clipWaveEdge: 'rgba(236,239,248,.42)' },
  };
  const num = (value, fallback = 0) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  };
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const normalizeTimelineMode = value => TIMELINE_MODES.includes(value) ? value : DEFAULT_TIMELINE_MODE;
  const resolveWaveTheme = key => {
    const safeKey = WAVE_THEMES[key] ? key : 'cool';
    return { key: safeKey, theme: WAVE_THEMES[safeKey] };
  };
  const clampViewStart = ({ viewStart, viewDuration, duration }) => {
    const dur = Math.max(0, num(duration));
    const vd = Math.max(0, num(viewDuration));
    if (vd >= dur || dur <= 0) return 0;
    return clamp(num(viewStart), 0, dur - vd);
  };
  const timelineDuration = ({ words = [], project = null } = {}) => Math.max(
    1,
    ...words.map(word => num(word && word.end)),
    ...((project && Array.isArray(project.clips)) ? project.clips.map(clip => num(clip.timelineStart) + num(clip.duration)) : [])
  );
  const trackCountForProject = project => {
    if (!project || !Array.isArray(project.clips)) return 0;
    const declared = Math.floor(num(project.timeline && project.timeline.trackCount, num(project.trackCount)));
    const needed = project.clips.reduce((max, clip) => Math.max(max, Math.floor(num(clip.trackIndex, num(clip.lane))) + 1), 0);
    return Math.max(declared, needed, project.clips.length ? 1 : 0);
  };
  const buildStatusBands = ({ deleteSegs = [], silencePeriods = [] } = {}) => {
    const normalize = (range, kind) => ({ kind, start: num(range.start), end: num(range.end) });
    return [
      ...silencePeriods.map(range => normalize(range, 'breath')).filter(range => range.end > range.start),
      ...deleteSegs.map(range => normalize(range, 'delete')).filter(range => range.end > range.start),
    ];
  };
  const clipVisibleSourceWindow = ({ clip, viewStart, viewEnd }) => {
    const start = Math.max(num(clip.timelineStart), num(viewStart));
    const end = Math.min(num(clip.timelineStart) + num(clip.duration), num(viewEnd));
    if (!(end > start)) return null;
    return {
      sourceStart: num(clip.sourceStart) + (start - num(clip.timelineStart)),
      timelineStart: start,
      duration: end - start,
    };
  };
  return {
    TIMELINE_MODE_KEY,
    WAVE_THEME_KEY,
    DEFAULT_TIMELINE_MODE,
    TIMELINE_MODES,
    REVIEW_STATUS_COLORS,
    WAVE_THEMES,
    buildStatusBands,
    clamp,
    clampViewStart,
    clipVisibleSourceWindow,
    normalizeTimelineMode,
    num,
    resolveWaveTheme,
    timelineDuration,
    trackCountForProject,
  };
});
```

- [ ] **Step 4: Serve and package the helper**

Modify `scripts/review_server.js` so `GET /lib/review_timeline_view.js` serves `scripts/lib/review_timeline_view.js`, using the same pattern as `/lib/compute_keeps.js`.

Modify `scripts/package_review.sh` to copy:

```bash
cp "$SCRIPT_DIR/lib/review_timeline_view.js" "$PACKAGE_DIR/server/lib/review_timeline_view.js"
```

- [ ] **Step 5: Verify Task 1**

Run:

```bash
node tests/review_timeline_view.test.js
node --check scripts/lib/review_timeline_view.js
node --check scripts/review_server.js
bash -n scripts/package_review.sh
```

Expected: all commands pass.

- [ ] **Step 6: Commit Task 1**

```bash
git add scripts/lib/review_timeline_view.js tests/review_timeline_view.test.js scripts/review_server.js scripts/package_review.sh
git commit -m "test: add review timeline view helpers"
```

### Task 2: Review Page Fused Timeline UI

**Files:**
- Modify: `scripts/templates/review.html`
- Modify: `scripts/templates/review.css`
- Modify: `scripts/templates/review.js`

- [ ] **Step 1: Add the helper script and timeline mode controls**

Modify `scripts/templates/review.html`:

```html
<script src="/lib/review_timeline_view.js"></script>
```

Place it after `/lib/compute_keeps.js`.

Replace the current three-item wave legend with:

```html
<span class="wl wl-normal"><span class="sw" id="lg-normal"></span>正常</span>
<span class="wl"><span class="sw" id="lg-del"></span>删减</span>
<span class="wl"><span class="sw" id="lg-breath"></span>气口</span>
<span class="wl" id="projectSummary"></span>
```

Add a segmented mode switch before `themeSelect`:

```html
<div class="timeline-mode-switch" id="timelineModeSwitch" role="group" aria-label="时间线显示模式">
  <button type="button" data-mode="overlay">叠加波形</button>
  <button type="button" data-mode="strip">裁切条</button>
</div>
```

- [ ] **Step 2: Style the fused timeline**

Modify `scripts/templates/review.css` so:

```css
#waveform {
  position: relative;
  border: 1px solid var(--line);
  border-radius: 6px;
  overflow: hidden;
  background: #0e0e13;
}
#waveform.timeline-mode-overlay #waveCanvas {
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  height: 100%;
  z-index: 5;
  pointer-events: auto;
  background: transparent;
}
#waveform.timeline-mode-strip #waveCanvas {
  display: block;
  height: 24px;
  border-bottom: 1px solid rgba(255,255,255,.1);
}
.project-tracks {
  display: block;
  max-height: none;
  border: 0;
  border-radius: 0;
  background: transparent;
}
.project-track {
  position: relative;
  height: 34px;
}
.project-clip {
  top: 5px;
  height: 24px;
  pointer-events: auto;
}
.clip-waveform {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 2px;
  width: 100%;
  height: 12px;
  opacity: .78;
  pointer-events: none;
}
.clip-title {
  position: relative;
  z-index: 2;
}
.timeline-mode-switch {
  display: inline-flex;
  border: 1px solid var(--line);
  border-radius: 6px;
  overflow: hidden;
}
.timeline-mode-switch button {
  height: 22px;
  padding: 0 8px;
  border: 0;
  border-right: 1px solid var(--line);
  background: var(--ink-3);
  color: var(--paper-400);
}
.timeline-mode-switch button:last-child { border-right: 0; }
.timeline-mode-switch button.active {
  color: var(--paper-100);
  background: rgba(108,160,255,.22);
}
```

Then tune the final CSS to fit the existing dock dimensions without overlapping the toolbar.

- [ ] **Step 3: Replace review.js timeline constants with helper-backed state**

In `scripts/templates/review.js`, read constants from `window.ReviewTimelineView`:

```js
const TimelineView = window.ReviewTimelineView || {};
const STATUS_COL = TimelineView.REVIEW_STATUS_COLORS || {
  delete: 'rgba(239, 68, 68, 0.42)',
  deleteEdge: 'rgba(239, 68, 68, 0.95)',
  breath: 'rgba(6, 182, 212, 0.34)',
  breathEdge: 'rgba(6, 182, 212, 0.88)',
  playhead: '#f97316',
};
```

Use `TimelineView.WAVE_THEMES` instead of the old theme object. Keep semantic colors outside the theme.

- [ ] **Step 4: Render tracks in pixel coordinates and add clip waveform canvases**

Change `renderProjectSummary()` to store the current project in a module variable and call `wave.redraw()` after `initWave()` has run.

Change `renderProjectTracks(project, trackCount)` so each clip is rendered with pixel `left` and `width`:

```js
const left = 68 + (Number(clip.timelineStart || 0) - viewStart) * pxPerSec;
const width = Math.max(18, Number(clip.duration || 0) * pxPerSec);
return `<div class="project-clip ${kind}" data-clip-id="${clip.id}" data-asset-id="${asset.id}" title="${title}" style="left:${left}px;width:${width}px">
  <span class="clip-title">${asset.name || asset.id}</span>
  ${asset.hasAudio !== false ? `<canvas class="clip-waveform" data-clip-id="${clip.id}"></canvas>` : ''}
</div>`;
```

Expose `viewStart`, `pxPerSec`, and `viewDuration` from the `wave` closure through a small `getViewState()` method or by passing them into `renderProjectTracks()`.

- [ ] **Step 5: Add clip waveform drawing**

Copy the editor page waveform renderer shape into review.js as `ClipWaveformRenderer`, but make colors come from the current theme:

```js
ctx.fillStyle = COL.clipWave || COL.wave;
ctx.strokeStyle = COL.clipWaveEdge || COL.waveSoft || COL.wave;
```

Add `drawProjectClipWaveforms()` that:

1. Finds visible `.clip-waveform` canvases.
2. Looks up `clip` and `asset`.
3. Uses `TimelineView.clipVisibleSourceWindow()` to draw only the visible source window.
4. Hides the canvas if the clip is fully outside the current view or the asset has no waveform.

- [ ] **Step 6: Draw overlay and strip modes**

Change the wave renderer:

- Add `timelineMode` state from `localStorage.reviewTimelineMode`, defaulting to `overlay`.
- In overlay mode, size `waveCanvas` to the visible project track area and draw theme background transparent.
- In strip mode, size `waveCanvas` to 24px and skip mixed waveform drawing.
- Draw breath bands first, delete bands second, and playhead last.
- Remove normal UI drawing of `extraCuts`.
- Keep final duration calculation using `ComputeKeeps.computeFinalKeeps()` unchanged.

The draw order in `buildStatic()` should be:

```js
if (timelineMode !== 'strip') drawMixedWaveform();
drawStatusBands('breath');
drawStatusBands('delete');
drawPlayheadInDrawPass();
```

- [ ] **Step 7: Fix theme switching and mode switching**

Update `applyWaveTheme()` so it:

1. Resolves invalid keys to `cool`.
2. Persists the resolved key when requested or when correcting invalid stored state.
3. Updates `#lg-normal`, `#lg-del`, and `#lg-breath`.
4. Calls `wave.redraw()`, `renderProjectTracks()`, and `drawProjectClipWaveforms()`.

Add `initTimelineModeSwitcher()`:

```js
function initTimelineModeSwitcher() {
  const root = document.getElementById('waveform');
  const switcher = document.getElementById('timelineModeSwitch');
  const stored = localStorage.getItem(TimelineView.TIMELINE_MODE_KEY || 'reviewTimelineMode');
  setTimelineMode(TimelineView.normalizeTimelineMode(stored), false);
  switcher.querySelectorAll('[data-mode]').forEach(button => {
    button.addEventListener('click', () => setTimelineMode(button.dataset.mode, true));
  });
}
```

Call `initTimelineModeSwitcher()` during page setup before the first `wave.redraw()`.

- [ ] **Step 8: Verify Task 2**

Run:

```bash
node --check scripts/templates/review.js
```

Expected: syntax check passes.

- [ ] **Step 9: Commit Task 2**

```bash
git add scripts/templates/review.html scripts/templates/review.css scripts/templates/review.js
git commit -m "feat: fuse review timeline waveform and tracks"
```

### Task 3: End-to-End Verification And Regression Checks

**Files:**
- Inspect: `scripts/templates/review.js`
- Inspect: `scripts/templates/review.css`
- Inspect: `scripts/templates/review.html`
- Modify only when a verification failure identifies a concrete defect: `scripts/templates/review.js`
- Modify only when a verification failure identifies a concrete defect: `scripts/templates/review.css`
- Modify only when a verification failure identifies a concrete defect: `scripts/templates/review.html`

- [ ] **Step 1: Run the focused automated checks**

```bash
node tests/review_timeline_view.test.js
node tests/fcpxml_multitrack.test.js
node tests/timeline_project_exchange.test.js
node tests/review_exports.test.js
node tests/editor_preview_mix.test.js
node --check scripts/templates/review.js
node --check scripts/review_server.js
node --check scripts/generate_review.js
bash -n scripts/package_review.sh
```

Expected: all commands pass.

- [ ] **Step 2: Start a review page fixture or existing review server**

If an existing local review page is already open, use it. Otherwise, generate or serve a local review directory with existing project sample data if available. The browser check needs only the review UI to load, not a real export.

- [ ] **Step 3: Browser-check the visible timeline**

In the in-app browser verify:

- Overlay mode shows tracks, clip waveforms, red delete ranges, cyan breath ranges, and orange playhead in the same time coordinate space.
- Strip mode shows a narrow canvas with red/cyan status bands and no mixed waveform.
- Every `.project-clip` containing audio has a `.clip-waveform` canvas.
- Changing `themeSelect` changes normal waveform/clip waveform colors without changing red/cyan/orange semantic colors.
- Switching modes preserves current time and zoom.

- [ ] **Step 4: Fix any verification failures with a new failing test first when the failure is behavioral**

For a behavioral failure, add an assertion to `tests/review_timeline_view.test.js` before changing production code. For a CSS-only layout failure, patch CSS and rerun the browser check.

- [ ] **Step 5: Commit verification fixes if any**

```bash
git add scripts/templates/review.html scripts/templates/review.css scripts/templates/review.js scripts/lib/review_timeline_view.js tests/review_timeline_view.test.js scripts/review_server.js scripts/package_review.sh
git commit -m "fix: polish review timeline dual modes"
```

Skip this commit if there are no changes after Task 2.

### Task 4: Final Review

**Files:**
- Inspect all changed files.

- [ ] **Step 1: Check final git state**

```bash
git status --short
git log --oneline -5
```

Expected: only intentionally untracked `.superpowers/` remains, plus committed implementation files.

- [ ] **Step 2: Summarize changed behavior**

Prepare the final response with:

- Dual-mode timeline behavior.
- Theme switching fix.
- Verification commands run.
- Note that `.superpowers/` mockup artifacts remain untracked.
