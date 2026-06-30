let project = { version: 1, name: 'multitrack_project', assets: [], clips: [], timeline: { trackCount: 4 } };
let reviewDuration = 0;
let dirty = false;
let selectedClipId = null;
let selectedAssetId = null;
let playheadTime = 0;
let pxPerSec = 34;
let isPlaying = false;
let rafId = null;
let lastTick = 0;
let snapEnabled = true;
let currentTool = 'select';
let pendingMetadataProbe = null;
let reviewReady = false;
let waveformDrawRaf = null;

const labelWidth = 112;
const trackHeight = 76;
const minClipDuration = 0.1;
const waveformPointTarget = 4096;
const maxZoom = 120;
const hiddenPlayers = new Map();
const $ = id => document.getElementById(id);
const uid = prefix => prefix + '-' + Math.random().toString(16).slice(2, 10);
const num = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const assetById = () => new Map(project.assets.map(asset => [asset.id, asset]));

function setStatus(text) {
  $('status').textContent = text;
}

function setDirty(value) {
  dirty = value;
  setStatus(dirty ? '有未保存修改' : savedStatusText());
}

function savedStatusText() {
  return reviewReady ? '已保存' : '已保存，可回到聊天框开始创建审核';
}

function ensureTimeline() {
  project = project && typeof project === 'object' ? project : {};
  project.assets = Array.isArray(project.assets) ? project.assets : [];
  project.clips = Array.isArray(project.clips) ? project.clips : [];
  project.timeline = project.timeline && typeof project.timeline === 'object' ? project.timeline : {};
  const needed = project.clips.reduce((max, clip) => Math.max(max, Math.floor(num(clip.trackIndex, num(clip.lane, 0))) + 1), 0);
  const requested = Math.floor(num(project.timeline.trackCount, 4));
  project.timeline.trackCount = Math.max(4, requested, needed);
  const existingTracks = Array.isArray(project.timeline.tracks) ? project.timeline.tracks : [];
  project.timeline.tracks = Array.from({ length: project.timeline.trackCount }, (_, index) => {
    const current = existingTracks[index] && typeof existingTracks[index] === 'object' ? existingTracks[index] : {};
    return {
      disabled: current.disabled === true,
      solo: current.solo === true,
    };
  });
  project.version = project.version || 1;
  project.name = project.name || 'multitrack_project';
}

function normalizeClientProject(nextProject) {
  project = nextProject && typeof nextProject === 'object' ? nextProject : project;
  ensureTimeline();
  const assets = assetById();
  project.clips = project.clips
    .filter(clip => assets.has(String(clip.assetId)))
    .map((clip, index) => {
      const trackIndex = Math.max(0, Math.floor(num(clip.trackIndex, num(clip.lane, 0))));
      return {
        id: String(clip.id || uid('clip')),
        assetId: String(clip.assetId),
        timelineStart: Math.max(0, num(clip.timelineStart, num(clip.offset, 0))),
        sourceStart: Math.max(0, num(clip.sourceStart, num(clip.start, 0))),
        duration: Math.max(0.1, num(clip.duration, Math.max(0.1, num(clip.end, 0) - num(clip.start, 0)))),
        trackIndex,
        lane: trackIndex,
        audioRole: clip.audioRole || 'dialogue',
        enabled: clip.enabled !== false,
        name: clip.name || `片段 ${index + 1}`,
      };
    });
  ensureTimeline();
  repairTimelineConstraints();
}

function projectDuration() {
  ensureTimeline();
  return Math.max(20, reviewDuration, ...project.clips.map(c => num(c.timelineStart) + num(c.duration)));
}

function mediaDurationForClip(clip) {
  const asset = project.assets.find(item => item.id === clip.assetId);
  return Math.max(minClipDuration, num(asset && asset.duration, clip.duration || minClipDuration));
}

function maxDurationForClip(clip) {
  return Math.max(minClipDuration, mediaDurationForClip(clip) - num(clip.sourceStart));
}

function trackState(index) {
  ensureTimeline();
  return project.timeline.tracks[index] || { disabled: false, solo: false };
}

function hasSoloTracks() {
  ensureTimeline();
  return project.timeline.tracks.some(track => track && track.solo);
}

function isTrackActive(index) {
  const state = trackState(index);
  if (state.disabled) return false;
  const soloMode = hasSoloTracks();
  return !soloMode || state.solo;
}

function clipsOnTrack(trackIndex, exceptClipId) {
  return project.clips
    .filter(clip => clip.trackIndex === trackIndex && clip.id !== exceptClipId)
    .sort((a, b) => a.timelineStart - b.timelineStart);
}

function availableStartOnTrack(clipId, trackIndex, desiredStart, duration) {
  const safeDuration = Math.max(minClipDuration, num(duration, minClipDuration));
  const clips = clipsOnTrack(trackIndex, clipId);
  const intervals = [];
  let cursor = 0;
  clips.forEach(clip => {
    const end = Math.max(0, num(clip.timelineStart));
    if (end - cursor >= safeDuration) intervals.push({ start: cursor, end: end - safeDuration });
    cursor = Math.max(cursor, num(clip.timelineStart) + num(clip.duration));
  });
  intervals.push({ start: cursor, end: Infinity });
  const target = Math.max(0, snapTime(desiredStart));
  let best = intervals[0].start;
  let bestDistance = Infinity;
  intervals.forEach(interval => {
    const candidate = clamp(target, interval.start, interval.end);
    const distance = Math.abs(candidate - target);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  });
  return snapTime(best);
}

function maxEndOnTrack(clip) {
  const next = clipsOnTrack(clip.trackIndex, clip.id)
    .find(other => other.timelineStart >= clip.timelineStart);
  return next ? Math.max(clip.timelineStart + minClipDuration, next.timelineStart) : Infinity;
}

function minStartOnTrack(clip) {
  const previous = clipsOnTrack(clip.trackIndex, clip.id)
    .filter(other => other.timelineStart + other.duration <= clip.timelineStart + clip.duration)
    .pop();
  return previous ? previous.timelineStart + previous.duration : 0;
}

function normalizeClipToBounds(clip) {
  const mediaDuration = mediaDurationForClip(clip);
  clip.sourceStart = clamp(num(clip.sourceStart), 0, Math.max(0, mediaDuration - minClipDuration));
  clip.duration = clamp(num(clip.duration, minClipDuration), minClipDuration, mediaDuration - clip.sourceStart);
  clip.trackIndex = clamp(Math.floor(num(clip.trackIndex)), 0, project.timeline.trackCount - 1);
  clip.lane = clip.trackIndex;
  clip.timelineStart = availableStartOnTrack(clip.id, clip.trackIndex, num(clip.timelineStart), clip.duration);
  return clip;
}

function repairTimelineConstraints() {
  ensureTimeline();
  project.clips
    .sort((a, b) => a.trackIndex - b.trackIndex || a.timelineStart - b.timelineStart)
    .forEach(normalizeClipToBounds);
}

function snapTime(value) {
  return snapEnabled ? Math.round(value * 10) / 10 : value;
}

async function loadProject() {
  const res = await fetch('/api/project');
  const data = await res.json();
  if (!data.success) throw new Error(data.error || '读取项目失败');
  normalizeClientProject(data.project);
  reviewDuration = data.reviewDuration || 0;
  reviewReady = data.reviewReady === true;
  fitTimeline(false);
  render();
  setDirty(false);
  pendingMetadataProbe = probeProjectMedia();
  pendingMetadataProbe.catch(err => setStatus('素材读取失败: ' + err.message));
}

async function saveProject() {
  ensureTimeline();
  const res = await fetch('/api/project', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project })
  });
  const data = await res.json();
  if (!data.success) {
    setStatus('保存失败: ' + data.error);
    return false;
  }
  normalizeClientProject(data.project);
  if (typeof data.reviewReady === 'boolean') reviewReady = data.reviewReady;
  render();
  setDirty(false);
  return true;
}

async function markNeedsTranscript() {
  if (!reviewReady) return;
  project.transcript = {
    status: 'stale',
    reason: 'timeline edited by human',
    markedAt: new Date().toISOString()
  };
  setDirty(true);
  setStatus('已标记重转录，正在保存...');
  await saveProject();
}

function inferKindFromFile(file) {
  return (file.type || '').startsWith('video/') ? 'video' : 'audio';
}

async function uploadFiles(files) {
  const list = Array.from(files || []);
  if (!list.length) return;
  setStatus(`上传 ${list.length} 个素材...`);
  for (const file of list) {
    const kind = inferKindFromFile(file);
    const res = await fetch(`/api/upload?name=${encodeURIComponent(file.name)}&kind=${encodeURIComponent(kind)}`, {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || `上传失败: ${file.name}`);
    if (data.project) normalizeClientProject(data.project);
    if (typeof data.reviewReady === 'boolean') reviewReady = data.reviewReady;
    if (data.asset && data.asset.id) selectedAssetId = data.asset.id;
  }
  render();
  setStatus('正在读取素材时长和波形...');
  await probeProjectMedia();
  setDirty(false);
}

function selectAsset(id) {
  selectedAssetId = id;
  renderAssets();
}

function removeAsset(id) {
  project.assets = project.assets.filter(asset => asset.id !== id);
  project.clips = project.clips.filter(clip => clip.assetId !== id);
  if (selectedClipId && !project.clips.some(clip => clip.id === selectedClipId)) selectedClipId = null;
  if (selectedAssetId === id) selectedAssetId = null;
  stopPreview();
  setDirty(true);
  render();
}

function removeSelectedAsset() {
  if (!selectedAssetId) {
    setStatus('先在素材库选择一个素材');
    return;
  }
  removeAsset(selectedAssetId);
}

function addClipFromAsset(assetId, trackIndex, timelineStart) {
  ensureTimeline();
  const asset = project.assets.find(a => a.id === assetId);
  if (!asset) return;
  const duration = Math.max(minClipDuration, num(asset.duration, 10) || 10);
  const safeTrack = clamp(Math.floor(num(trackIndex, 0)), 0, project.timeline.trackCount - 1);
  const safeStart = availableStartOnTrack(null, safeTrack, timelineStart, duration);
  const clip = {
    id: uid('clip'),
    assetId,
    timelineStart: safeStart,
    sourceStart: 0,
    duration,
    trackIndex: safeTrack,
    lane: safeTrack,
    audioRole: asset.kind === 'audio' || asset.hasVideo === false ? 'dialogue' : 'video',
    enabled: true
  };
  project.clips.push(clip);
  selectedClipId = clip.id;
  selectedAssetId = assetId;
  setDirty(true);
  render();
}

function updateClip(id, patch, shouldRender = true) {
  ensureTimeline();
  project.clips = project.clips.map(clip => {
    if (clip.id !== id) return clip;
    const next = { ...clip, ...patch };
    next.sourceStart = Math.max(0, num(next.sourceStart));
    next.duration = Math.max(minClipDuration, num(next.duration, minClipDuration));
    next.trackIndex = clamp(Math.floor(num(next.trackIndex)), 0, project.timeline.trackCount - 1);
    next.lane = next.trackIndex;
    normalizeClipToBounds(next);
    return next;
  });
  setDirty(true);
  if (shouldRender) {
    render();
    syncPreview();
  }
}

function deleteSelectedClip() {
  if (!selectedClipId) return;
  project.clips = project.clips.filter(clip => clip.id !== selectedClipId);
  selectedClipId = null;
  setDirty(true);
  render();
  syncPreview();
}

function addTrack() {
  ensureTimeline();
  project.timeline.trackCount += 1;
  project.timeline.tracks.push({ disabled: false, solo: false });
  setDirty(true);
  renderTimeline();
}

function deleteTrack(trackIndex = project.timeline.trackCount - 1) {
  ensureTimeline();
  const index = Math.floor(num(trackIndex, project.timeline.trackCount - 1));
  if (project.timeline.trackCount <= 1) return;
  if (project.clips.some(clip => clip.trackIndex === index)) {
    setStatus('该轨道还有片段，先移动或删除片段');
    return;
  }
  project.clips.forEach(clip => {
    if (clip.trackIndex > index) {
      clip.trackIndex -= 1;
      clip.lane = clip.trackIndex;
    }
  });
  project.timeline.tracks.splice(index, 1);
  project.timeline.trackCount -= 1;
  setDirty(true);
  renderTimeline();
}

function toggleTrackDisabled(trackIndex) {
  ensureTimeline();
  const state = trackState(trackIndex);
  state.disabled = !state.disabled;
  if (state.disabled) state.solo = false;
  setDirty(true);
  renderTimeline();
  syncPreview();
}

function toggleTrackSolo(trackIndex) {
  ensureTimeline();
  const state = trackState(trackIndex);
  if (state.disabled) state.disabled = false;
  state.solo = !state.solo;
  setDirty(true);
  renderTimeline();
  syncPreview();
}

function splitClipAt(clipId, time) {
  const clip = project.clips.find(c => c.id === clipId);
  if (!clip) return false;
  const offset = time - clip.timelineStart;
  if (offset <= 0.1 || offset >= clip.duration - 0.1) {
    setStatus('播放头需要位于片段内部');
    return false;
  }
  const right = {
    ...clip,
    id: uid('clip'),
    timelineStart: snapTime(time),
    sourceStart: clip.sourceStart + offset,
    duration: clip.duration - offset,
  };
  clip.duration = offset;
  project.clips.push(right);
  selectedClipId = right.id;
  setDirty(true);
  render();
  syncPreview();
  return true;
}

function splitAtPlayhead() {
  const target = selectedClipId
    ? project.clips.find(c => c.id === selectedClipId && playheadTime > c.timelineStart && playheadTime < c.timelineStart + c.duration)
    : activeClipsAt(playheadTime)[0];
  if (!target) {
    setStatus('播放头下没有可切割片段');
    return;
  }
  splitClipAt(target.id, playheadTime);
}

function render() {
  ensureTimeline();
  renderFlowButtons();
  renderAssets();
  renderInspector();
  renderTimeline();
  renderTransport();
}

function renderFlowButtons() {
  const reviewBtn = $('reviewBtn');
  const staleBtn = $('staleBtn');
  if (!reviewBtn || !staleBtn) return;
  reviewBtn.disabled = !reviewReady;
  staleBtn.disabled = !reviewReady;
  reviewBtn.title = reviewReady ? '回到审核页' : '当前项目还未生成审核页。保存后回到聊天框，让 AI 开始创建审核';
  staleBtn.title = reviewReady ? '标记需要重新转文字和智能裁切' : '首次创建项目时还没有转文字结果，无需标记重转录';
}

function renderAssets() {
  $('removeSelectedAssetBtn').disabled = !selectedAssetId;
  $('assetList').innerHTML = project.assets.map(asset => {
    const isVideo = asset.kind === 'video' || asset.hasVideo;
    const durationText = asset.duration ? formatTime(asset.duration) : '读取中';
    return `
      <div class="asset-card ${asset.id === selectedAssetId ? 'selected' : ''}" draggable="true" data-asset-id="${asset.id}" title="拖到下方时间线添加片段">
        <div class="asset-title">
          <span><i class="fa-solid ${isVideo ? 'fa-film' : 'fa-wave-square'}"></i> ${escapeHtml(asset.name)}</span>
          <span class="asset-kind">${isVideo ? 'video' : 'audio'}</span>
        </div>
        <small class="asset-path">${escapeHtml(asset.path || '')}</small>
        <div class="asset-meta">
          <span>${durationText}</span>
          <span>${asset.hasAudio === false ? '无音频' : '含音频'}</span>
        </div>
        <div class="asset-actions">
          <button class="icon-btn mini primary" data-action="insert-asset" data-asset-id="${asset.id}" title="在播放头位置新增片段" aria-label="新增片段"><i class="fa-solid fa-plus"></i></button>
          <button class="icon-btn mini danger" data-action="remove-asset" data-asset-id="${asset.id}" title="删除素材及其所有片段" aria-label="删除素材"><i class="fa-solid fa-trash-can"></i></button>
        </div>
      </div>
    `;
  }).join('') || '<div class="asset-card empty"><small class="asset-path">点击上传按钮添加音频或视频</small></div>';

  document.querySelectorAll('.asset-card[draggable="true"]').forEach(card => {
    card.addEventListener('click', event => {
      if (card.dataset.suppressClick === '1' || event.target.closest('button')) return;
      selectAsset(card.dataset.assetId);
    });
    card.addEventListener('dragstart', event => {
      selectAsset(card.dataset.assetId);
      event.dataTransfer.setData('text/asset-id', card.dataset.assetId);
      event.dataTransfer.effectAllowed = 'copy';
    });
    bindAssetPointerDrag(card);
  });
  document.querySelectorAll('[data-action="remove-asset"]').forEach(btn => {
    btn.addEventListener('click', event => {
      event.stopPropagation();
      removeAsset(event.currentTarget.dataset.assetId);
    });
  });
  document.querySelectorAll('[data-action="insert-asset"]').forEach(btn => {
    btn.addEventListener('click', event => {
      event.stopPropagation();
      const assetId = event.currentTarget.dataset.assetId;
      const asset = project.assets.find(a => a.id === assetId);
      const defaultTrack = asset && (asset.kind === 'video' || asset.hasVideo) ? 0 : Math.min(1, project.timeline.trackCount - 1);
      addClipFromAsset(assetId, defaultTrack, playheadTime);
    });
  });
}

function bindAssetPointerDrag(card) {
  card.onpointerdown = event => {
    if (event.target.closest('button')) return;
    const assetId = card.dataset.assetId;
    const start = { x: event.clientX, y: event.clientY };
    let dragging = false;
    let ghost = null;
    let activeTrack = null;

    const cleanup = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.querySelectorAll('.track.drag-over').forEach(track => track.classList.remove('drag-over'));
      if (ghost) ghost.remove();
    };

    const onMove = moveEvent => {
      const distance = Math.hypot(moveEvent.clientX - start.x, moveEvent.clientY - start.y);
      if (!dragging && distance > 6) {
        dragging = true;
        selectAsset(assetId);
        ghost = document.createElement('div');
        ghost.className = 'asset-drag-ghost';
        ghost.textContent = project.assets.find(asset => asset.id === assetId)?.name || '素材';
        document.body.appendChild(ghost);
      }
      if (!dragging) return;
      moveEvent.preventDefault();
      if (ghost) {
        ghost.style.left = (moveEvent.clientX + 12) + 'px';
        ghost.style.top = (moveEvent.clientY + 12) + 'px';
      }
      const track = trackElementFromClientY(moveEvent.clientY);
      if (track !== activeTrack) {
        if (activeTrack) activeTrack.classList.remove('drag-over');
        activeTrack = track;
        if (activeTrack) activeTrack.classList.add('drag-over');
      }
    };

    const onUp = upEvent => {
      if (dragging) {
        card.dataset.suppressClick = '1';
        window.setTimeout(() => { delete card.dataset.suppressClick; }, 0);
        const track = trackElementFromClientY(upEvent.clientY);
        if (track) {
          addClipFromAsset(assetId, Number(track.dataset.track), timelineTimeFromClientX(upEvent.clientX));
        }
      }
      cleanup();
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };
}

function renderInspector() {
  const clip = project.clips.find(c => c.id === selectedClipId);
  const assets = assetById();
  if (!clip) {
    $('inspector').innerHTML = '<div class="empty-hint">在时间线上选择一个片段进行精调</div>';
    $('deleteClipBtn').disabled = true;
    return;
  }
  $('deleteClipBtn').disabled = false;
  const asset = assets.get(clip.assetId) || { name: 'missing' };
  $('inspector').innerHTML = `
    <div><label>素材</label><input value="${escapeHtml(asset.name)}" disabled></div>
    <div><label>时间线起点</label><input type="number" step="0.1" min="0" value="${round1(clip.timelineStart)}" data-field="timelineStart"></div>
    <div><label>素材入点</label><input type="number" step="0.1" min="0" value="${round1(clip.sourceStart)}" data-field="sourceStart"></div>
    <div><label>时长</label><input type="number" step="0.1" min="0.1" value="${round1(clip.duration)}" data-field="duration"></div>
    <div><label>轨道</label><input type="number" step="1" min="1" max="${project.timeline.trackCount}" value="${clip.trackIndex + 1}" data-field="trackIndex"></div>
    <div><label>音频角色</label><input value="${escapeHtml(clip.audioRole || 'dialogue')}" data-field="audioRole"></div>
  `;
  $('inspector').querySelectorAll('[data-field]').forEach(input => {
    input.addEventListener('change', event => {
      const field = event.currentTarget.dataset.field;
      const raw = event.currentTarget.value;
      const value = field === 'audioRole' ? raw : num(raw);
      updateClip(clip.id, { [field]: field === 'trackIndex' ? value - 1 : value });
    });
  });
}

function renderTimeline() {
  ensureTimeline();
  const duration = Math.ceil(projectDuration());
  const scroll = $('timelineScroll');
  const minWidth = scroll ? scroll.clientWidth : window.innerWidth;
  pxPerSec = clampZoom(pxPerSec);
  const width = Math.max(minWidth, labelWidth + duration * pxPerSec + 180);
  $('ruler').style.width = width + 'px';
  $('tracks').style.width = width + 'px';
  $('playhead').style.left = (labelWidth + playheadTime * pxPerSec) + 'px';
  $('playhead').style.height = (32 + project.timeline.trackCount * trackHeight) + 'px';
  $('tracks').style.height = (project.timeline.trackCount * trackHeight) + 'px';

  const ticks = [];
  const tickStep = tickStepForZoom();
  for (let t = 0; t <= duration; t += tickStep) {
    ticks.push(`<div class="tick" style="left:${labelWidth + t * pxPerSec}px">${formatTime(t)}</div>`);
  }
  $('ruler').innerHTML = ticks.join('');

  const assets = assetById();
  const rows = [];
  for (let trackIndex = 0; trackIndex < project.timeline.trackCount; trackIndex++) {
    const state = trackState(trackIndex);
    const clips = project.clips.filter(c => c.trackIndex === trackIndex).map(clip => {
      const asset = assets.get(clip.assetId) || { name: 'missing', kind: 'audio' };
      const isVideo = asset.kind === 'video' || asset.hasVideo;
      return `
        <div class="clip ${isVideo ? 'video' : 'audio'} ${clip.id === selectedClipId ? 'selected' : ''}" data-id="${clip.id}" style="left:${labelWidth + clip.timelineStart * pxPerSec}px;width:${Math.max(24, clip.duration * pxPerSec)}px">
          <div class="handle left" data-action="trim-left"></div>
          <div class="clip-content">
            <b><i class="fa-solid ${isVideo ? 'fa-film' : 'fa-wave-square'}"></i> ${escapeHtml(asset.name)}</b>
            <span>${formatTime(clip.timelineStart)} · ${round1(clip.duration)}s</span>
          </div>
          ${asset.hasAudio !== false ? renderWaveform(clip, asset) : ''}
          <div class="handle right" data-action="trim-right"></div>
        </div>
      `;
    }).join('');
    rows.push(`
      <div class="track ${state.disabled ? 'disabled' : ''} ${state.solo ? 'solo' : ''}" data-track="${trackIndex}">
        <div class="track-label">
          <div class="track-label-row">
            <span>轨 ${trackIndex + 1}</span>
            <button class="icon-btn mini" data-action="delete-track" data-track="${trackIndex}" title="删除这条空轨道" aria-label="删除这条空轨道"><i class="fa-solid fa-minus"></i></button>
          </div>
          <div class="track-controls">
            <button class="icon-btn mini ${state.disabled ? 'active' : ''}" data-action="toggle-track-disabled" data-track="${trackIndex}" title="禁用或启用本轨" aria-label="禁用或启用本轨"><i class="fa-solid ${state.disabled ? 'fa-volume-xmark' : 'fa-volume-high'}"></i></button>
            <button class="icon-btn mini ${state.solo ? 'active' : ''}" data-action="toggle-track-solo" data-track="${trackIndex}" title="Solo 本轨监听" aria-label="Solo 本轨监听"><i class="fa-solid fa-headphones"></i></button>
          </div>
        </div>
        ${clips}
      </div>
    `);
  }
  $('tracks').innerHTML = rows.join('');
  updateZoomControl();
  bindTimelineInteractions();
  drawTimelineWaveforms();
}

function tickStepForZoom() {
  if (pxPerSec >= 48) return 1;
  if (pxPerSec >= 24) return 2;
  if (pxPerSec >= 10) return 5;
  if (pxPerSec >= 5) return 10;
  if (pxPerSec >= 2) return 30;
  if (pxPerSec >= 0.8) return 60;
  if (pxPerSec >= 0.25) return 300;
  return 600;
}

function minZoomForFit() {
  const scroll = $('timelineScroll');
  const available = Math.max(240, (scroll ? scroll.clientWidth : window.innerWidth) - labelWidth - 80);
  return Math.min(maxZoom - 0.01, Math.max(0.05, available / Math.max(1, projectDuration())));
}

function clampZoom(value) {
  return clamp(Number(value) || minZoomForFit(), minZoomForFit(), maxZoom);
}

function updateZoomControl() {
  const slider = $('zoomSlider');
  if (!slider) return;
  const min = minZoomForFit();
  slider.min = String(Math.round(min * 100) / 100);
  slider.max = String(maxZoom);
  slider.step = '0.05';
  slider.value = String(Math.round(pxPerSec * 100) / 100);
}

function renderWaveform(clip, asset) {
  return `<canvas class="clip-waveform" data-clip-id="${clip.id}" data-asset-id="${asset.id}"></canvas>`;
}

const WaveformRenderer = {
  draw(canvas, peaks, clip, assetDuration) {
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.floor(width * ratio);
    canvas.height = Math.floor(height * ratio);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const baseline = height - 1;
    ctx.strokeStyle = 'rgba(242,235,221,.16)';
    ctx.beginPath();
    ctx.moveTo(0, 0.5);
    ctx.lineTo(width, 0.5);
    ctx.stroke();
    if (!Array.isArray(peaks) || peaks.length < 2 || !(assetDuration > 0)) {
      ctx.strokeStyle = 'rgba(24,160,210,.5)';
      ctx.beginPath();
      ctx.moveTo(0, baseline);
      ctx.lineTo(width, baseline);
      ctx.stroke();
      return;
    }

    const sourceStart = clamp(num(clip.sourceStart), 0, assetDuration);
    const sourceEnd = clamp(sourceStart + num(clip.duration), sourceStart, assetDuration);
    const startIndex = (sourceStart / assetDuration) * peaks.length;
    const endIndex = Math.max(startIndex + 1, (sourceEnd / assetDuration) * peaks.length);
    const sourceLength = Math.max(1, endIndex - startIndex);
    const envelope = new Float32Array(width);

    for (let x = 0; x < width; x++) {
      const bucketStart = startIndex + (x / width) * sourceLength;
      const bucketEnd = startIndex + ((x + 1) / width) * sourceLength;
      const from = clamp(Math.floor(bucketStart), 0, peaks.length - 1);
      const to = clamp(Math.ceil(bucketEnd), from + 1, peaks.length);
      let peak = 0;
      if (to - from <= 1) {
        const left = Math.max(0, Math.min(peaks.length - 1, from));
        const right = Math.max(0, Math.min(peaks.length - 1, left + 1));
        const mix = bucketStart - Math.floor(bucketStart);
        peak = (Math.abs(Number(peaks[left]) || 0) * (1 - mix)) + (Math.abs(Number(peaks[right]) || 0) * mix);
      } else {
        for (let i = from; i < to; i++) peak = Math.max(peak, Math.abs(Number(peaks[i]) || 0));
      }
      envelope[x] = Math.pow(Math.min(1, peak), 0.72);
    }

    ctx.fillStyle = 'rgba(18,151,204,.94)';
    ctx.beginPath();
    ctx.moveTo(0, baseline);
    for (let x = 0; x < width; x++) {
      const y = baseline - Math.max(0, envelope[x] * (height - 2));
      ctx.lineTo(x, y);
    }
    ctx.lineTo(width, baseline);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = 'rgba(80,198,236,.66)';
    ctx.beginPath();
    for (let x = 0; x < width; x++) {
      const y = baseline - Math.max(0, envelope[x] * (height - 2));
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
};

function drawTimelineWaveforms() {
  const assets = assetById();
  const scroll = $('timelineScroll');
  const viewportStart = scroll ? scroll.scrollLeft + labelWidth : 0;
  const viewportEnd = scroll ? scroll.scrollLeft + scroll.clientWidth : Infinity;
  document.querySelectorAll('canvas.clip-waveform').forEach(canvas => {
    const clip = project.clips.find(item => item.id === canvas.dataset.clipId);
    const asset = clip ? assets.get(clip.assetId) : null;
    if (!clip || !asset) return;
    const clipLeft = labelWidth + num(clip.timelineStart) * pxPerSec;
    const clipWidth = Math.max(24, num(clip.duration) * pxPerSec);
    const visibleStart = Math.max(clipLeft, viewportStart);
    const visibleEnd = Math.min(clipLeft + clipWidth, viewportEnd);
    const visibleWidth = Math.max(0, Math.ceil(visibleEnd - visibleStart));

    if (visibleWidth <= 0) {
      canvas.style.display = 'none';
      return;
    }

    const visibleOffsetPx = visibleStart - clipLeft;
    const visibleOffsetSec = Math.max(0, visibleOffsetPx / pxPerSec);
    const visibleDuration = Math.min(
      Math.max(0.001, visibleWidth / pxPerSec),
      Math.max(0.001, num(clip.duration) - visibleOffsetSec)
    );
    canvas.style.display = 'block';
    canvas.style.left = Math.max(0, visibleOffsetPx) + 'px';
    canvas.style.right = 'auto';
    canvas.style.width = visibleWidth + 'px';
    WaveformRenderer.draw(canvas, asset.waveform, {
      ...clip,
      sourceStart: num(clip.sourceStart) + visibleOffsetSec,
      duration: visibleDuration,
    }, num(asset.duration, clip.duration));
  });
}

function scheduleTimelineWaveformDraw() {
  if (waveformDrawRaf) return;
  waveformDrawRaf = requestAnimationFrame(() => {
    waveformDrawRaf = null;
    drawTimelineWaveforms();
  });
}

function bindTimelineInteractions() {
  const timelineScroll = $('timelineScroll');
  timelineScroll.onscroll = scheduleTimelineWaveformDraw;
  timelineScroll.onpointerdown = event => {
    if (event.button !== 0) return;
    if (event.target.closest('.clip, .handle, button, input, textarea, select, .track-label')) return;

    event.preventDefault();
    seekPreview(timelineTimeFromClientX(event.clientX));
    timelineScroll.classList.add('scrubbing');
    timelineScroll.setPointerCapture(event.pointerId);

    const onScrubMove = moveEvent => {
      if ((moveEvent.buttons & 1) !== 1) return;
      moveEvent.preventDefault();
      seekPreview(timelineTimeFromClientX(moveEvent.clientX));
    };
    const onScrubEnd = endEvent => {
      timelineScroll.classList.remove('scrubbing');
      timelineScroll.removeEventListener('pointermove', onScrubMove);
      timelineScroll.removeEventListener('pointerup', onScrubEnd);
      timelineScroll.removeEventListener('pointercancel', onScrubEnd);
      try { timelineScroll.releasePointerCapture(event.pointerId); } catch (err) {}
      if (typeof endEvent.clientX === 'number') seekPreview(timelineTimeFromClientX(endEvent.clientX));
    };

    timelineScroll.addEventListener('pointermove', onScrubMove);
    timelineScroll.addEventListener('pointerup', onScrubEnd);
    timelineScroll.addEventListener('pointercancel', onScrubEnd);
  };
  document.querySelectorAll('.track').forEach(track => {
    track.addEventListener('dragover', event => {
      event.preventDefault();
      track.classList.add('drag-over');
    });
    track.addEventListener('dragleave', () => track.classList.remove('drag-over'));
    track.addEventListener('drop', event => {
      event.preventDefault();
      track.classList.remove('drag-over');
      const assetId = event.dataTransfer.getData('text/asset-id');
      const timelineStart = timelineTimeFromClientX(event.clientX);
      addClipFromAsset(assetId, Number(track.dataset.track), timelineStart);
    });
  });

  document.querySelectorAll('[data-action="delete-track"]').forEach(btn => {
    btn.addEventListener('click', event => {
      event.stopPropagation();
      deleteTrack(Number(event.currentTarget.dataset.track));
    });
  });
  document.querySelectorAll('[data-action="toggle-track-disabled"]').forEach(btn => {
    btn.addEventListener('click', event => {
      event.stopPropagation();
      toggleTrackDisabled(Number(event.currentTarget.dataset.track));
    });
  });
  document.querySelectorAll('[data-action="toggle-track-solo"]').forEach(btn => {
    btn.addEventListener('click', event => {
      event.stopPropagation();
      toggleTrackSolo(Number(event.currentTarget.dataset.track));
    });
  });

  document.querySelectorAll('.clip').forEach(el => {
    el.onpointerdown = event => {
      const id = el.dataset.id;
      const clip = project.clips.find(c => c.id === id);
      if (!clip) return;
      selectedClipId = id;
      selectClipElement(id);
      renderInspector();
      const timeAtPointer = timelineTimeFromClientX(event.clientX);
      if (currentTool === 'razor') {
        splitClipAt(id, timeAtPointer);
        return;
      }
      const action = event.target.dataset.action || 'move';
      const startX = event.clientX;
      const original = { ...clip };
      el.classList.add('dragging');
      el.setPointerCapture(event.pointerId);
      event.preventDefault();

      const onClipMove = moveEvent => {
        const delta = (moveEvent.clientX - startX) / pxPerSec;
        if (action === 'trim-left') {
          const sourceEnd = original.sourceStart + original.duration;
          const mediaLeftLimit = original.timelineStart - original.sourceStart;
          const maxStart = original.timelineStart + original.duration - minClipDuration;
          const minStart = Math.max(mediaLeftLimit, minStartOnTrack(original));
          const newStart = clamp(snapTime(original.timelineStart + delta), minStart, maxStart);
          const consumed = newStart - original.timelineStart;
          Object.assign(clip, {
            timelineStart: newStart,
            sourceStart: clamp(original.sourceStart + consumed, 0, sourceEnd - minClipDuration),
            duration: Math.max(minClipDuration, sourceEnd - clamp(original.sourceStart + consumed, 0, sourceEnd - minClipDuration))
          });
        } else if (action === 'trim-right') {
          const nextEnd = maxEndOnTrack(original);
          const mediaMax = mediaDurationForClip(original) - original.sourceStart;
          const overlapMax = nextEnd === Infinity ? mediaMax : nextEnd - original.timelineStart;
          clip.duration = clamp(snapTime(original.duration + delta), minClipDuration, Math.max(minClipDuration, Math.min(mediaMax, overlapMax)));
        } else {
          const newTrack = trackIndexFromClientY(moveEvent.clientY);
          if (newTrack != null) {
            clip.trackIndex = newTrack;
            clip.lane = newTrack;
          }
          clip.timelineStart = availableStartOnTrack(clip.id, clip.trackIndex, original.timelineStart + delta, clip.duration);
        }
        positionClipElement(el, clip);
        drawTimelineWaveforms();
        $('playhead').style.left = (labelWidth + playheadTime * pxPerSec) + 'px';
      };
      const onClipUp = () => {
        el.classList.remove('dragging');
        window.removeEventListener('pointermove', onClipMove);
        window.removeEventListener('pointerup', onClipUp);
        setDirty(true);
        render();
        syncPreview();
      };
      window.addEventListener('pointermove', onClipMove);
      window.addEventListener('pointerup', onClipUp);
    };
  });
}

function selectClipElement(id) {
  document.querySelectorAll('.clip').forEach(c => c.classList.toggle('selected', c.dataset.id === id));
}

function positionClipElement(el, clip) {
  el.style.left = (labelWidth + clip.timelineStart * pxPerSec) + 'px';
  el.style.width = Math.max(24, clip.duration * pxPerSec) + 'px';
  if (Number(el.closest('.track')?.dataset.track) !== clip.trackIndex) {
    const nextTrack = document.querySelector(`.track[data-track="${clip.trackIndex}"]`);
    if (nextTrack) nextTrack.appendChild(el);
  }
}

function timelineTimeFromClientX(clientX) {
  const scroll = $('timelineScroll');
  const rect = scroll.getBoundingClientRect();
  return Math.max(0, snapTime((clientX - rect.left + scroll.scrollLeft - labelWidth) / pxPerSec));
}

function trackIndexFromClientY(clientY) {
  const found = trackElementFromClientY(clientY);
  return found ? Number(found.dataset.track) : null;
}

function trackElementFromClientY(clientY) {
  return Array.from(document.querySelectorAll('.track')).find(track => {
    const rect = track.getBoundingClientRect();
    return clientY >= rect.top && clientY <= rect.bottom;
  }) || null;
}

function activeClipsAt(time) {
  return project.clips
    .filter(clip => clip.enabled !== false && isTrackActive(clip.trackIndex) && time >= clip.timelineStart && time < clip.timelineStart + clip.duration)
    .sort((a, b) => b.trackIndex - a.trackIndex);
}

function mediaUrl(assetId) {
  return '/media/' + encodeURIComponent(assetId);
}

function ensureHiddenPlayer(asset) {
  if (hiddenPlayers.has(asset.id)) return hiddenPlayers.get(asset.id);
  const media = document.createElement(asset.kind === 'video' || asset.hasVideo ? 'video' : 'audio');
  media.src = mediaUrl(asset.id);
  media.preload = 'auto';
  media.playsInline = true;
  media.style.display = 'none';
  document.body.appendChild(media);
  hiddenPlayers.set(asset.id, media);
  return media;
}

function syncPreview() {
  const assets = assetById();
  const active = activeClipsAt(playheadTime);
  const topVideoClip = active.find(clip => {
    const asset = assets.get(clip.assetId);
    return asset && (asset.kind === 'video' || asset.hasVideo);
  });
  const previewVideo = $('previewVideo');
  if (topVideoClip) {
    const asset = assets.get(topVideoClip.assetId);
    const src = mediaUrl(asset.id);
    if (previewVideo.getAttribute('src') !== src) previewVideo.src = src;
    previewVideo.style.display = 'block';
    $('viewerEmpty').style.display = 'none';
    previewVideo.currentTime = topVideoClip.sourceStart + (playheadTime - topVideoClip.timelineStart);
    if (isPlaying) previewVideo.play().catch(() => {});
  } else {
    previewVideo.pause();
    previewVideo.removeAttribute('src');
    previewVideo.load();
    previewVideo.style.display = 'none';
    $('viewerEmpty').style.display = 'block';
  }

  hiddenPlayers.forEach(player => player.pause());
  active.forEach(clip => {
    const asset = assets.get(clip.assetId);
    if (!asset || asset.hasAudio === false) return;
    if (topVideoClip && clip.assetId === topVideoClip.assetId) return;
    const player = ensureHiddenPlayer(asset);
    player.currentTime = clip.sourceStart + (playheadTime - clip.timelineStart);
    if (isPlaying) player.play().catch(() => {});
  });
  renderTransport();
}

function playPreview() {
  isPlaying = true;
  lastTick = performance.now();
  $('playBtn').innerHTML = '<i class="fa-solid fa-pause"></i>';
  syncPreview();
  rafId = requestAnimationFrame(tickPreview);
}

function pausePreview() {
  isPlaying = false;
  $('playBtn').innerHTML = '<i class="fa-solid fa-play"></i>';
  $('previewVideo').pause();
  hiddenPlayers.forEach(player => player.pause());
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
}

function stopPreview() {
  pausePreview();
  seekPreview(0);
}

function seekPreview(time) {
  playheadTime = Math.min(Math.max(0, time), projectDuration());
  $('playhead').style.left = (labelWidth + playheadTime * pxPerSec) + 'px';
  keepPlayheadInView(false);
  syncPreview();
}

function tickPreview(now) {
  if (!isPlaying) return;
  const delta = (now - lastTick) / 1000;
  lastTick = now;
  playheadTime += delta;
  if (playheadTime >= projectDuration()) {
    stopPreview();
    return;
  }
  $('playhead').style.left = (labelWidth + playheadTime * pxPerSec) + 'px';
  renderTransport();
  keepPlayheadInView(true);
  const active = activeClipsAt(playheadTime);
  if (!active.length || Math.abs(delta) > 0.25) syncPreview();
  rafId = requestAnimationFrame(tickPreview);
}

function keepPlayheadInView(smooth) {
  const scroll = $('timelineScroll');
  if (!scroll) return;
  const playheadX = labelWidth + playheadTime * pxPerSec;
  const leftEdge = scroll.scrollLeft + labelWidth;
  const rightEdge = scroll.scrollLeft + scroll.clientWidth - 120;
  if (playheadX < leftEdge || playheadX > rightEdge) {
    scroll.scrollTo({
      left: Math.max(0, playheadX - Math.floor(scroll.clientWidth * 0.35)),
      behavior: smooth ? 'smooth' : 'auto',
    });
  }
}

function renderTransport() {
  $('timeCur').textContent = formatTime(playheadTime);
  $('timeTot').textContent = formatTime(projectDuration());
  $('viewerTimecode').textContent = formatTimecode(playheadTime);
}

function fitTimeline(shouldRender = true) {
  const scroll = $('timelineScroll');
  const available = Math.max(320, (scroll ? scroll.clientWidth : window.innerWidth) - labelWidth - 120);
  const next = Math.min(maxZoom, available / Math.max(1, projectDuration()));
  pxPerSec = Math.round(clampZoom(next) * 100) / 100;
  if ($('zoomSlider')) $('zoomSlider').value = String(pxPerSec);
  if (shouldRender) renderTimeline();
}

async function probeProjectMedia() {
  const assets = [...project.assets];
  let changed = false;
  for (const asset of assets) {
    changed = await probeAssetMetadata(asset) || changed;
    if (asset.hasAudio !== false && (!Array.isArray(asset.waveform) || asset.waveform.length < waveformPointTarget)) {
      const waveform = await computeWaveform(asset);
      if (waveform.length) {
        asset.waveform = waveform;
        changed = true;
      }
    }
  }
  const before = JSON.stringify(project.clips.map(clip => [clip.id, clip.timelineStart, clip.sourceStart, clip.duration, clip.trackIndex]));
  repairTimelineConstraints();
  changed = changed || before !== JSON.stringify(project.clips.map(clip => [clip.id, clip.timelineStart, clip.sourceStart, clip.duration, clip.trackIndex]));
  if (changed) {
    render();
    await saveProject();
  }
}

function probeAssetMetadata(asset) {
  return new Promise(resolve => {
    if (!asset || !asset.id) {
      resolve(false);
      return;
    }
    const isVideo = asset.kind === 'video' || asset.hasVideo;
    const media = document.createElement(isVideo ? 'video' : 'audio');
    let settled = false;
    const finish = changed => {
      if (settled) return;
      settled = true;
      media.removeAttribute('src');
      media.load();
      resolve(changed);
    };
    media.preload = 'metadata';
    media.muted = true;
    media.src = mediaUrl(asset.id);
    media.onloadedmetadata = () => {
      let changed = false;
      if (Number.isFinite(media.duration) && media.duration > 0 && Math.abs(num(asset.duration) - media.duration) > 0.05) {
        asset.duration = +media.duration.toFixed(3);
        changed = true;
      }
      if (isVideo && asset.hasVideo !== true) {
        asset.hasVideo = true;
        changed = true;
      }
      finish(changed);
    };
    media.onerror = () => finish(false);
    window.setTimeout(() => finish(false), 5000);
  });
}

async function computeWaveform(asset) {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return [];
  try {
    const res = await fetch(mediaUrl(asset.id));
    const arrayBuffer = await res.arrayBuffer();
    const audioContext = new AudioContextClass();
    const buffer = await audioContext.decodeAudioData(arrayBuffer.slice(0));
    const channel = buffer.getChannelData(0);
    const targetPoints = waveformPointTarget;
    const bucket = Math.max(1, Math.floor(channel.length / targetPoints));
    const peaks = [];
    for (let i = 0; i < channel.length; i += bucket) {
      let max = 0;
      const end = Math.min(channel.length, i + bucket);
      for (let j = i; j < end; j++) {
        const v = Math.abs(channel[j]);
        if (v > max) max = v;
      }
      peaks.push(+max.toFixed(3));
      if (peaks.length >= targetPoints) break;
    }
    if (audioContext.close) audioContext.close();
    return peaks;
  } catch (err) {
    return [];
  }
}

function importProjectJson(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      normalizeClientProject(JSON.parse(reader.result));
      selectedClipId = null;
      selectedAssetId = null;
      setDirty(true);
      render();
      setStatus('项目已导入，请保存');
      probeProjectMedia().catch(err => setStatus('素材读取失败: ' + err.message));
    } catch (err) {
      setStatus('导入失败: ' + err.message);
    }
  };
  reader.readAsText(file);
}

function exportProjectJson() {
  ensureTimeline();
  const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${project.name || 'multitrack_project'}.project.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function formatTime(sec) {
  const safe = Math.max(0, Number(sec) || 0);
  const m = Math.floor(safe / 60);
  const s = Math.floor(safe % 60);
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

function formatTimecode(sec) {
  const safe = Math.max(0, Number(sec) || 0);
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = Math.floor(safe % 60);
  return [h, m, s].map(v => String(v).padStart(2, '0')).join(':');
}

function round1(value) {
  return Math.round(num(value) * 10) / 10;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

function bindChrome() {
  $('uploadAssetBtn').onclick = () => $('uploadInput').click();
  $('uploadInput').onchange = event => {
    uploadFiles(event.target.files)
      .then(() => { event.target.value = ''; })
      .catch(err => setStatus(err.message));
  };
  $('removeSelectedAssetBtn').onclick = removeSelectedAsset;
  $('importProjectBtn').onclick = () => $('projectImportInput').click();
  $('projectImportInput').onchange = event => {
    importProjectJson(event.target.files && event.target.files[0]);
    event.target.value = '';
  };
  $('exportProjectBtn').onclick = exportProjectJson;
  $('saveBtn').onclick = saveProject;
  $('reviewBtn').onclick = () => { if (reviewReady) location.href = '/review.html'; };
  $('staleBtn').onclick = () => markNeedsTranscript().catch(err => setStatus('标记失败: ' + err.message));
  $('deleteClipBtn').onclick = deleteSelectedClip;
  $('playBtn').onclick = () => isPlaying ? pausePreview() : playPreview();
  $('stopBtn').onclick = stopPreview;
  $('jumpStartBtn').onclick = () => seekPreview(0);
  $('zoomSlider').oninput = event => {
    pxPerSec = clampZoom(Number(event.target.value));
    renderTimeline();
  };
  $('zoomOutBtn').onclick = () => {
    pxPerSec = clampZoom(pxPerSec * 0.72);
    $('zoomSlider').value = String(pxPerSec);
    renderTimeline();
  };
  $('zoomInBtn').onclick = () => {
    pxPerSec = clampZoom(pxPerSec * 1.28);
    $('zoomSlider').value = String(pxPerSec);
    renderTimeline();
  };
  $('fitTimelineBtn').onclick = () => fitTimeline(true);
  $('selectToolBtn').onclick = () => setTool('select');
  $('razorToolBtn').onclick = () => setTool('razor');
  $('razorToolBtn').ondblclick = splitAtPlayhead;
  $('addTrackBtn').onclick = addTrack;
  $('deleteTrackBtn').onclick = () => deleteTrack(project.timeline.trackCount - 1);
  $('snapBtn').classList.toggle('active', snapEnabled);
  $('snapBtn').onclick = () => {
    snapEnabled = !snapEnabled;
    $('snapBtn').classList.toggle('active', snapEnabled);
  };
  bindMediaBinDrop();
  bindPanelResizers();
  bindGlobalTooltips();
  window.addEventListener('keydown', event => {
    if (event.target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(event.target.tagName)) return;
    if (event.code === 'Space') { event.preventDefault(); isPlaying ? pausePreview() : playPreview(); }
    if (event.key === 'v') setTool('select');
    if (event.key === 'c') setTool('razor');
    if (event.key === 'Backspace' || event.key === 'Delete') {
      event.preventDefault();
      deleteSelectedClip();
    }
    if (event.key === '+') { pxPerSec = clampZoom(pxPerSec * 1.18); $('zoomSlider').value = String(pxPerSec); renderTimeline(); }
    if (event.key === '-') { pxPerSec = clampZoom(pxPerSec * 0.82); $('zoomSlider').value = String(pxPerSec); renderTimeline(); }
  }, true);
}

function setTool(tool) {
  currentTool = tool;
  $('selectToolBtn').classList.toggle('active', tool === 'select');
  $('razorToolBtn').classList.toggle('active', tool === 'razor');
}

function bindMediaBinDrop() {
  const bin = document.querySelector('.media-bin');
  bin.addEventListener('dragover', event => {
    if (event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files.length) {
      event.preventDefault();
      bin.classList.add('drag-over');
    }
  });
  bin.addEventListener('dragleave', () => bin.classList.remove('drag-over'));
  bin.addEventListener('drop', event => {
    if (!event.dataTransfer || !event.dataTransfer.files.length) return;
    event.preventDefault();
    bin.classList.remove('drag-over');
    uploadFiles(event.dataTransfer.files).catch(err => setStatus(err.message));
  });
}

function bindPanelResizers() {
  const root = document.documentElement;
  const grid = document.querySelector('.editor-grid');
  let drag = null;
  $('colResizer').addEventListener('pointerdown', event => {
    drag = { type: 'col', startX: event.clientX, start: parseFloat(getComputedStyle(root).getPropertyValue('--bin-w')) || 360 };
    event.currentTarget.setPointerCapture(event.pointerId);
  });
  $('rowResizer').addEventListener('pointerdown', event => {
    const rect = grid.getBoundingClientRect();
    drag = { type: 'row', gridTop: rect.top };
    event.currentTarget.setPointerCapture(event.pointerId);
  });
  window.addEventListener('pointermove', event => {
    if (!drag) return;
    if (drag.type === 'col') {
      const width = clamp(drag.start + event.clientX - drag.startX, 260, 560);
      root.style.setProperty('--bin-w', width + 'px');
    } else {
      const topHeight = clamp(event.clientY - drag.gridTop, 320, window.innerHeight * 0.62);
      root.style.setProperty('--top-h', topHeight + 'px');
    }
  });
  window.addEventListener('pointerup', () => { drag = null; });
}

function bindGlobalTooltips() {
  let target = null;
  let tooltip = null;
  const selector = '[title], [data-tooltip]';

  const ensureTooltip = () => {
    if (tooltip) return tooltip;
    tooltip = document.createElement('div');
    tooltip.className = 'app-tooltip';
    tooltip.hidden = true;
    document.body.appendChild(tooltip);
    return tooltip;
  };

  const textFor = element => element.getAttribute('title') || element.dataset.tooltip || element.getAttribute('aria-label') || '';

  const positionTooltip = () => {
    if (!target || !tooltip || tooltip.hidden) return;
    const rect = target.getBoundingClientRect();
    const tipRect = tooltip.getBoundingClientRect();
    const left = clamp(rect.left + rect.width / 2 - tipRect.width / 2, 8, window.innerWidth - tipRect.width - 8);
    const above = rect.top >= tipRect.height + 10;
    const top = above
      ? rect.top - tipRect.height - 8
      : Math.min(window.innerHeight - tipRect.height - 8, rect.bottom + 8);
    tooltip.style.left = left + 'px';
    tooltip.style.top = Math.max(8, top) + 'px';
  };

  const showTooltip = element => {
    if (!element || element.disabled) return;
    const text = textFor(element);
    if (!text) return;
    if (element.hasAttribute('title')) {
      element.dataset.tooltip = element.getAttribute('title');
      element.removeAttribute('title');
    }
    target = element;
    const tip = ensureTooltip();
    tip.textContent = text;
    tip.hidden = false;
    positionTooltip();
  };

  const hideTooltip = () => {
    if (tooltip) tooltip.hidden = true;
    if (target && target.dataset.tooltip && !target.hasAttribute('title')) target.setAttribute('title', target.dataset.tooltip);
    target = null;
  };

  document.addEventListener('pointerover', event => {
    const element = event.target.closest(selector);
    if (element) showTooltip(element);
  });
  document.addEventListener('pointermove', positionTooltip);
  document.addEventListener('pointerout', event => {
    if (target && (!event.relatedTarget || !target.contains(event.relatedTarget))) hideTooltip();
  });
  document.addEventListener('mouseover', event => {
    const element = event.target.closest(selector);
    if (element) showTooltip(element);
  });
  document.addEventListener('mousemove', event => {
    const element = event.target.closest(selector);
    if (element && element !== target) showTooltip(element);
    if (!element && target) hideTooltip();
    positionTooltip();
  });
  document.addEventListener('mouseout', event => {
    if (target && (!event.relatedTarget || !target.contains(event.relatedTarget))) hideTooltip();
  });
  document.addEventListener('focusin', event => showTooltip(event.target.closest(selector)));
  document.addEventListener('focusout', hideTooltip);
  window.addEventListener('scroll', positionTooltip, true);
  window.addEventListener('resize', positionTooltip);
}

bindChrome();
loadProject().catch(err => setStatus('加载失败: ' + err.message));
