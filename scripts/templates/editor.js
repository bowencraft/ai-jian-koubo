let project = { version: 1, name: 'multitrack_project', assets: [], clips: [] };
let reviewDuration = 0;
let dirty = false;
let selectedClipId = null;
let playheadTime = 0;
let pxPerSec = 34;
let isPlaying = false;
let rafId = null;
let lastTick = 0;

const labelWidth = 84;
const hiddenPlayers = new Map();
const $ = id => document.getElementById(id);
const uid = prefix => prefix + '-' + Math.random().toString(16).slice(2, 10);
const num = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const assetById = () => new Map(project.assets.map(asset => [asset.id, asset]));

function setStatus(text) { $('status').textContent = text; }

function setDirty(value) {
  dirty = value;
  $('staleNotice').style.display = dirty ? 'block' : 'none';
  setStatus(dirty ? '有未保存修改' : '已保存');
}

function projectDuration() {
  return Math.max(20, reviewDuration, ...project.clips.map(c => num(c.timelineStart) + num(c.duration)));
}

async function loadProject() {
  const res = await fetch('/api/project');
  const data = await res.json();
  if (!data.success) throw new Error(data.error || '读取项目失败');
  project = data.project;
  reviewDuration = data.reviewDuration || 0;
  render();
  setDirty(false);
}

async function saveProject() {
  const res = await fetch('/api/project', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project })
  });
  const data = await res.json();
  if (!data.success) {
    setStatus('保存失败: ' + data.error);
    return;
  }
  project = data.project;
  render();
  setDirty(false);
}

function markNeedsTranscript() {
  project.transcript = {
    status: 'stale',
    reason: 'timeline edited by human',
    markedAt: new Date().toISOString()
  };
  setDirty(true);
}

function addAssetFromModal() {
  const filePath = $('assetPath').value.trim();
  if (!filePath) return;
  const name = $('assetName').value.trim() || filePath.split('/').pop().replace(/\.[^.]+$/, '');
  const kind = $('assetKind').value;
  project.assets.push({
    id: uid('asset'),
    name,
    path: filePath,
    kind,
    hasAudio: true,
    hasVideo: kind === 'video',
    duration: 0
  });
  $('assetPath').value = '';
  $('assetName').value = '';
  $('assetModal').close();
  setDirty(true);
  render();
}

function removeAsset(id) {
  project.assets = project.assets.filter(asset => asset.id !== id);
  project.clips = project.clips.filter(clip => clip.assetId !== id);
  if (selectedClipId && !project.clips.some(clip => clip.id === selectedClipId)) selectedClipId = null;
  stopPreview();
  setDirty(true);
  render();
}

function addClipFromAsset(assetId, trackIndex, timelineStart) {
  const asset = project.assets.find(a => a.id === assetId);
  if (!asset) return;
  const duration = Math.max(2, Math.min(30, num(asset.duration, 10) || 10));
  const clip = {
    id: uid('clip'),
    assetId,
    timelineStart: Math.max(0, timelineStart),
    sourceStart: 0,
    duration,
    trackIndex,
    lane: trackIndex,
    audioRole: asset.kind === 'audio' ? 'dialogue' : 'video',
    enabled: true
  };
  project.clips.push(clip);
  selectedClipId = clip.id;
  setDirty(true);
  render();
}

function updateClip(id, patch) {
  project.clips = project.clips.map(clip => {
    if (clip.id !== id) return clip;
    const next = { ...clip, ...patch };
    next.timelineStart = Math.max(0, num(next.timelineStart));
    next.sourceStart = Math.max(0, num(next.sourceStart));
    next.duration = Math.max(0.1, num(next.duration, 0.1));
    next.trackIndex = Math.max(0, Math.floor(num(next.trackIndex)));
    next.lane = next.trackIndex;
    return next;
  });
  setDirty(true);
  render();
  syncPreview();
}

function deleteSelectedClip() {
  if (!selectedClipId) return;
  project.clips = project.clips.filter(clip => clip.id !== selectedClipId);
  selectedClipId = null;
  setDirty(true);
  render();
  syncPreview();
}

function render() {
  renderAssets();
  renderInspector();
  renderTimeline();
  renderTransport();
}

function renderAssets() {
  $('assetList').innerHTML = project.assets.map(asset => `
    <div class="asset-card" draggable="true" data-asset-id="${asset.id}">
      <div class="asset-title">
        <span>${escapeHtml(asset.name)}</span>
        <span class="asset-kind">${asset.kind || 'audio'}</span>
      </div>
      <small class="asset-path">${escapeHtml(asset.path)}</small>
      <div style="margin-top:8px;display:flex;gap:6px">
        <button data-action="select-asset" data-asset-id="${asset.id}">选中</button>
        <button data-action="remove-asset" data-asset-id="${asset.id}">删除</button>
      </div>
    </div>
  `).join('') || '<div class="asset-card"><small class="asset-path">点击“添加素材”开始</small></div>';

  document.querySelectorAll('.asset-card[draggable="true"]').forEach(card => {
    card.addEventListener('dragstart', event => {
      event.dataTransfer.setData('text/asset-id', card.dataset.assetId);
      event.dataTransfer.effectAllowed = 'copy';
    });
  });
  document.querySelectorAll('[data-action="remove-asset"]').forEach(btn => {
    btn.addEventListener('click', event => removeAsset(event.currentTarget.dataset.assetId));
  });
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
    <div><label>时间线起点</label><input type="number" step="0.1" value="${clip.timelineStart}" data-field="timelineStart"></div>
    <div><label>素材入点</label><input type="number" step="0.1" value="${clip.sourceStart}" data-field="sourceStart"></div>
    <div><label>时长</label><input type="number" step="0.1" value="${clip.duration}" data-field="duration"></div>
    <div><label>轨道</label><input type="number" step="1" value="${clip.trackIndex}" data-field="trackIndex"></div>
    <div><label>音频角色</label><input value="${escapeHtml(clip.audioRole || 'dialogue')}" data-field="audioRole"></div>
  `;
  $('inspector').querySelectorAll('[data-field]').forEach(input => {
    input.addEventListener('change', event => {
      const field = event.currentTarget.dataset.field;
      const raw = event.currentTarget.value;
      updateClip(clip.id, { [field]: field === 'audioRole' ? raw : num(raw) });
    });
  });
}

function renderTimeline() {
  const duration = Math.ceil(projectDuration());
  const width = labelWidth + duration * pxPerSec + 180;
  $('ruler').style.width = width + 'px';
  $('tracks').style.width = width + 'px';
  $('playhead').style.left = (labelWidth + playheadTime * pxPerSec) + 'px';

  const ticks = [];
  for (let t = 0; t <= duration; t += 5) {
    ticks.push(`<div class="tick" style="left:${labelWidth + t * pxPerSec}px">${formatTime(t)}</div>`);
  }
  $('ruler').innerHTML = ticks.join('');

  const trackCount = Math.max(4, ...project.clips.map(c => c.trackIndex + 1));
  const assets = assetById();
  const rows = [];
  for (let trackIndex = 0; trackIndex < trackCount; trackIndex++) {
    const clips = project.clips.filter(c => c.trackIndex === trackIndex).map(clip => {
      const asset = assets.get(clip.assetId) || { name: 'missing', kind: 'audio' };
      const kind = asset.kind === 'video' || asset.hasVideo ? 'video' : 'audio';
      return `
        <div class="clip ${kind} ${clip.id === selectedClipId ? 'selected' : ''}" data-id="${clip.id}" style="left:${labelWidth + clip.timelineStart * pxPerSec}px;width:${Math.max(24, clip.duration * pxPerSec)}px">
          <div class="handle left" data-action="trim-left"></div>
          <b>${escapeHtml(asset.name)}</b>
          <span>${formatTime(clip.timelineStart)} · ${clip.duration.toFixed(1)}s</span>
          <div class="handle right" data-action="trim-right"></div>
        </div>
      `;
    }).join('');
    rows.push(`<div class="track" data-track="${trackIndex}"><div class="track-label">轨道 ${trackIndex + 1}</div>${clips}</div>`);
  }
  $('tracks').innerHTML = rows.join('');
  bindTimelineInteractions();
}

function bindTimelineInteractions() {
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
      const rect = track.getBoundingClientRect();
      const scrollLeft = $('timelineScroll').scrollLeft;
      const x = event.clientX - rect.left + scrollLeft - labelWidth;
      const timelineStart = Math.max(0, x / pxPerSec);
      addClipFromAsset(assetId, Number(track.dataset.track), timelineStart);
    });
  });

  $('ruler').onclick = event => {
    const rect = $('ruler').getBoundingClientRect();
    const t = Math.max(0, (event.clientX - rect.left + $('timelineScroll').scrollLeft - labelWidth) / pxPerSec);
    seekPreview(t);
  };

  document.querySelectorAll('.clip').forEach(el => {
    el.onpointerdown = event => {
      const id = el.dataset.id;
      const clip = project.clips.find(c => c.id === id);
      if (!clip) return;
      selectedClipId = id;
      renderInspector();
      document.querySelectorAll('.clip').forEach(c => c.classList.toggle('selected', c.dataset.id === id));
      const action = event.target.dataset.action || 'move';
      const startX = event.clientX;
      const original = { ...clip };
      el.setPointerCapture(event.pointerId);
      el.onpointermove = moveEvent => {
        const delta = (moveEvent.clientX - startX) / pxPerSec;
        if (action === 'trim-left') {
          const newStart = Math.max(0, original.timelineStart + delta);
          const consumed = newStart - original.timelineStart;
          Object.assign(clip, {
            timelineStart: newStart,
            sourceStart: Math.max(0, original.sourceStart + consumed),
            duration: Math.max(0.1, original.duration - consumed)
          });
        } else if (action === 'trim-right') {
          clip.duration = Math.max(0.1, original.duration + delta);
        } else {
          clip.timelineStart = Math.max(0, original.timelineStart + delta);
        }
        renderTimeline();
      };
      el.onpointerup = () => {
        el.onpointermove = null;
        el.onpointerup = null;
        setDirty(true);
        render();
        syncPreview();
      };
    };
  });
}

function activeClipsAt(time) {
  return project.clips
    .filter(clip => clip.enabled !== false && time >= clip.timelineStart && time < clip.timelineStart + clip.duration)
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
  $('playBtn').textContent = '⏸ 暂停';
  syncPreview();
  rafId = requestAnimationFrame(tickPreview);
}

function pausePreview() {
  isPlaying = false;
  $('playBtn').textContent = '▶ 播放';
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
  const active = activeClipsAt(playheadTime);
  if (!active.length || Math.abs(delta) > 0.25) syncPreview();
  rafId = requestAnimationFrame(tickPreview);
}

function renderTransport() {
  $('timeCur').textContent = formatTime(playheadTime);
  $('timeTot').textContent = formatTime(projectDuration());
}

function formatTime(sec) {
  const safe = Math.max(0, Number(sec) || 0);
  const m = Math.floor(safe / 60);
  const s = Math.floor(safe % 60);
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

function bindChrome() {
  $('openAssetModalBtn').onclick = () => $('assetModal').showModal();
  $('addAssetBtn').onclick = event => {
    event.preventDefault();
    addAssetFromModal();
  };
  $('saveBtn').onclick = saveProject;
  $('reviewBtn').onclick = () => { location.href = '/'; };
  $('staleBtn').onclick = markNeedsTranscript;
  $('deleteClipBtn').onclick = deleteSelectedClip;
  $('playBtn').onclick = () => isPlaying ? pausePreview() : playPreview();
  $('stopBtn').onclick = stopPreview;
  $('jumpStartBtn').onclick = () => seekPreview(0);
  $('zoomSlider').oninput = event => {
    pxPerSec = Number(event.target.value);
    renderTimeline();
  };
  $('zoomOutBtn').onclick = () => {
    pxPerSec = Math.max(18, pxPerSec - 8);
    $('zoomSlider').value = pxPerSec;
    renderTimeline();
  };
  $('zoomInBtn').onclick = () => {
    pxPerSec = Math.min(90, pxPerSec + 8);
    $('zoomSlider').value = pxPerSec;
    renderTimeline();
  };
}

bindChrome();
loadProject().catch(err => setStatus('加载失败: ' + err.message));
