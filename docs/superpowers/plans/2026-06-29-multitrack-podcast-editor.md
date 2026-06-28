# Multitrack Podcast Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade AI剪口播 from a single-source review pipeline into a multitrack podcast editor with a human assembly page, mixed-audio transcription, AI review, legacy compatibility, and FCPXML export against original media.

**Architecture:** `project.json` becomes the canonical timeline model with `assets[]` and `clips[]`. The editor page mutates that model; transcription renders a mixed review audio from audible clips; the review page consumes the transcript in read-only timeline mode; export applies deletion ranges back to original clips and writes multi-asset FCPXML.

**Tech Stack:** Node.js scripts and HTTP server, plain HTML/CSS/JS templates, ffmpeg/ffprobe, existing Volcengine ASR scripts, existing `compute_keeps.js`, Node `assert` tests.

---

### Task 1: Timeline Model And Multitrack Export

**Files:**
- Create: `scripts/lib/timeline_project.js`
- Modify: `scripts/lib/fcpxml.js`
- Test: `tests/fcpxml_multitrack.test.js`

- [x] Write a failing test for two audio assets on separate lanes.
- [x] Normalize `assets[]` and `clips[]`.
- [x] Migrate legacy single-source sessions into one asset and one clip.
- [x] Apply global review deletion ranges to every clip.
- [x] Add `buildTimelineFcpxml()` while keeping `buildFcpxml()` intact.

### Task 2: Human Assembly Page

**Files:**
- Create: `scripts/templates/editor.html`
- Modify: `scripts/review_server.js`
- Modify: `scripts/generate_review.js`

- [x] Add `GET/POST /api/project`.
- [x] Add an editor page for assets and clips.
- [x] Support direct numeric edits plus basic timeline drag/trim.
- [x] Add a review-page entry back to the editor.
- [ ] Add richer in-browser preview where topmost video clip is visible and all audio clips play together.

### Task 3: Mixed Audio Transcription

**Files:**
- Create: `scripts/render_timeline_audio.js`
- Create: `scripts/run_multitrack_transcribe.sh`
- Modify: `SKILL.md`
- Modify: `README.md`

- [x] Render audible clips into `review_mix.mp3` with ffmpeg.
- [x] Reuse existing Volcengine ASR scripts on the mixed audio.
- [x] Document single-source and multitrack transcription paths.
- [ ] Add a first-class pre-transcription project server command for starting page 1 before `data.json` exists.

### Task 4: Read-Only Review Timeline

**Files:**
- Modify: `scripts/templates/review.html`
- Modify: `scripts/review_server.js`

- [x] Load `project.json` from the review server.
- [x] Show a compact multitrack project summary in the review page.
- [x] Export multi-asset FCPXML when `project.json` exists.
- [x] Render a full read-only multitrack strip in the review page.

### Task 5: Packaging And Docs

**Files:**
- Modify: `scripts/package_review.sh`
- Modify: `SKILL.md`
- Modify: `README.md`

- [x] Package `project.json`, `editor.html`, and timeline helpers.
- [x] Update the workflow docs from “AI upload source -> AI cut -> human review” to “human assemble -> mixed ASR/AI cut -> human review”.
- [x] Document legacy migration.

### Task 6: Verification

**Commands:**
- [x] `node tests/fcpxml_audio.test.js`
- [x] `node tests/fcpxml_multitrack.test.js`
- [x] `node --check scripts/lib/timeline_project.js`
- [x] `node --check scripts/lib/fcpxml.js`
- [x] `node --check scripts/review_server.js`
- [x] `node --check scripts/generate_review.js`
- [x] `node --check scripts/render_timeline_audio.js`
- [x] `bash -n scripts/run_multitrack_transcribe.sh`
