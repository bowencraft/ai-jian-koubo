let words = [];
    let autoSelected = new Set();
    const selected = new Set();
    const aiSelectedIds = new Set();

    const video = document.getElementById('player');
    const timeCur = document.getElementById('timeCur');
    const timeTot = document.getElementById('timeTot');
    const content = document.getElementById('content');
    const loadingOverlay = document.getElementById('loadingOverlay');

    let elements = [];
    let gapGroups = [];
    // 交互模型「点=定位，划=删/恢复」：
    // pendingDown 记录按下信息，移动超过阈值才升级为划选；否则松手算单击。
    let isSelecting = false;
    let selectStart = -1;
    let selectMode = 'add';            // 'add'=标删 / 'remove'=恢复，由起点状态决定
    let pendingDown = null;            // { startId, x, y, isGap, target, started }
    let dragSpan = null;              // 本次划选覆盖的时间范围 {start,end}，供「试听这段」
    const DRAG_THRESHOLD = 4;          // px，超过才算「划」，否则算「点」
    const undoStack = [];             // 每次编辑前的 selected 快照
    let previewUntil = null;          // 「试听这段」时播放到此秒数即停（且期间不跳删除段）
    let currentProjectSignature = null;
    let reviewDir = '';

    // 波形 / 切割预览数据
    let peaksData = null;          // { duration, sampleRate, peaks:[0..1] }
    let silencePeriods = [];       // ffmpeg/能量检测的静音段，仅用于切点吸附
    let breathSegments = [];       // transcript 中可点击的气口段，用于青蓝标注
    let cutOpts = {                // 切割参数（与 lib/compute_keeps.js 默认一致，可被滑块覆盖）
      lookBack: 0.6, padStart: 2 / 30, padEnd: 2 / 30, minInternalSilence: 0.2, trimInternalSilence: false
    };
    const TimelineView = window.ReviewTimelineView || {};
    const STATUS_COL = TimelineView.REVIEW_STATUS_COLORS || {
      delete: 'rgba(239, 68, 68, 0.42)',
      breath: 'rgba(6, 182, 212, 0.34)',
      playhead: 'rgba(249, 115, 22, 0.38)',
    };
    const normalizeTimelineMode = TimelineView.normalizeTimelineMode || (value => value === 'strip' ? 'strip' : 'overlay');
    const timelineModeKey = TimelineView.TIMELINE_MODE_KEY || 'reviewTimelineMode';
    let timelineMode = normalizeTimelineMode(localStorage.getItem(timelineModeKey));
    let currentProject = null;
    let currentTrackCount = 0;
    let projectAssetsById = new Map();
    let waveReady = false;

    loadingOverlay.classList.add('show');
    const loadingMessages = ['正在加载字幕数据...', '正在解析音频波形...', '正在准备播放器...', '即将就绪...'];
    let msgIdx = 0;
    const labelEl = document.getElementById('loadingLabel');
    const msgTimer = setInterval(() => {
      msgIdx = (msgIdx + 1) % loadingMessages.length;
      labelEl.textContent = loadingMessages[msgIdx];
    }, 1500);
    labelEl.textContent = loadingMessages[0];

    const fetchJSON = (url) => fetch(url).then(r => r.ok ? r.json() : null).catch(() => null);
    const PROJECT_LABEL_W = 68;
    const WAVE_COL = {
      bg: '#0E0E13',
      wave: '#8CA0C8',
      waveSoft: 'rgba(140,160,200,0.36)',
      center: '#23252E',
      clipWave: 'rgba(80,198,236,.70)',
      clipWaveEdge: 'rgba(180,226,244,.42)',
    };
    let clipWaveformRaf = 0;

    function escapeHtml(value) {
      return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function numValue(value, fallback = 0) {
      const n = Number(value);
      return Number.isFinite(n) ? n : fallback;
    }

    function clampValue(value, min, max) {
      return Math.max(min, Math.min(max, value));
    }

    function percentile(values, ratio) {
      if (!values.length) return 0;
      const sorted = Array.from(values).sort((a, b) => a - b);
      const index = clampValue(Math.floor((sorted.length - 1) * ratio), 0, sorted.length - 1);
      return sorted[index] || 0;
    }

    function envelopeForPeaks(peaks, assetDuration, sourceStart, sourceDuration, width) {
      const size = Math.max(1, Math.floor(width));
      const envelope = new Float32Array(size);
      if (!Array.isArray(peaks) || peaks.length < 2 || !(assetDuration > 0) || !(sourceDuration > 0)) return envelope;

      const safeStart = clampValue(numValue(sourceStart), 0, assetDuration);
      const safeEnd = clampValue(safeStart + numValue(sourceDuration), safeStart, assetDuration);
      const startIndex = (safeStart / assetDuration) * peaks.length;
      const endIndex = Math.max(startIndex + 1, (safeEnd / assetDuration) * peaks.length);
      const sourceLength = Math.max(1, endIndex - startIndex);

      for (let x = 0; x < size; x++) {
        const bucketStart = startIndex + (x / size) * sourceLength;
        const bucketEnd = startIndex + ((x + 1) / size) * sourceLength;
        const from = clampValue(Math.floor(bucketStart), 0, peaks.length - 1);
        const to = clampValue(Math.ceil(bucketEnd), from + 1, peaks.length);
        let peak = 0;
        if (to - from <= 1) {
          const left = clampValue(from, 0, peaks.length - 1);
          const right = clampValue(left + 1, 0, peaks.length - 1);
          const mix = bucketStart - Math.floor(bucketStart);
          peak = (Math.abs(numValue(peaks[left])) * (1 - mix)) + (Math.abs(numValue(peaks[right])) * mix);
        } else {
          for (let i = from; i < to; i++) peak = Math.max(peak, Math.abs(numValue(peaks[i])));
        }
        envelope[x] = Math.min(1, peak);
      }

      const floor = percentile(envelope, 0.08);
      const ceiling = Math.max(percentile(envelope, 0.985), floor + 0.01);
      for (let x = 0; x < envelope.length; x++) {
        const normalized = clampValue((envelope[x] - floor) / (ceiling - floor), 0, 1);
        envelope[x] = Math.pow(normalized, 1.18);
      }
      return envelope;
    }

    function paintUpperWaveform(ctx, opts) {
      const x = numValue(opts.x);
      const y = numValue(opts.y);
      const width = Math.max(1, Math.floor(numValue(opts.width)));
      const height = Math.max(1, Math.floor(numValue(opts.height)));
      const peaks = opts.peaks || [];
      const assetDuration = numValue(opts.assetDuration);
      const sourceStart = numValue(opts.sourceStart);
      const sourceDuration = numValue(opts.sourceDuration, assetDuration);
      const baseline = y + height - 1;

      if (!Array.isArray(peaks) || peaks.length < 2 || !(assetDuration > 0) || !(sourceDuration > 0)) {
        ctx.fillStyle = opts.center || WAVE_COL.center;
        ctx.fillRect(x, baseline - 0.5, width, 1);
        return;
      }

      const envelope = envelopeForPeaks(peaks, assetDuration, sourceStart, sourceDuration, width);
      ctx.fillStyle = opts.fill || WAVE_COL.waveSoft;
      ctx.beginPath();
      ctx.moveTo(x, baseline);
      for (let i = 0; i < envelope.length; i++) {
        const h = Math.max(0.8, envelope[i] * Math.max(1, height - 2));
        ctx.lineTo(x + i, baseline - h);
      }
      ctx.lineTo(x + width, baseline);
      ctx.closePath();
      ctx.fill();

      if (opts.stroke) {
        ctx.strokeStyle = opts.stroke;
        ctx.beginPath();
        for (let i = 0; i < envelope.length; i++) {
          const h = Math.max(0.8, envelope[i] * Math.max(1, height - 2));
          const py = baseline - h;
          if (i === 0) ctx.moveTo(x + i, py);
          else ctx.lineTo(x + i, py);
        }
        ctx.stroke();
      }
    }

    function drawWaveformCanvas(canvas, peaks, sourceStart, sourceDuration, assetDuration, colors = {}) {
      const rect = canvas.getBoundingClientRect();
      const width = Math.max(1, Math.floor(rect.width));
      const height = Math.max(1, Math.floor(rect.height));
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.floor(width * ratio);
      canvas.height = Math.floor(height * ratio);
      const ctx = canvas.getContext('2d');
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, width, height);
      paintUpperWaveform(ctx, {
        peaks,
        assetDuration,
        sourceStart,
        sourceDuration,
        x: 0,
        y: 1,
        width,
        height: Math.max(1, height - 2),
        fill: colors.fill || WAVE_COL.clipWave,
        stroke: colors.stroke || WAVE_COL.clipWaveEdge,
        center: colors.center || 'rgba(180,226,244,.34)',
      });
    }

    function drawProjectClipWaveforms() {
      clipWaveformRaf = 0;
      document.querySelectorAll('#projectTracks canvas.clip-waveform').forEach((canvas) => {
        const asset = projectAssetsById.get(canvas.dataset.assetId);
        if (!asset || asset.hasAudio === false) return;
        const visibleDuration = numValue(canvas.dataset.duration);
        const assetDuration = numValue(asset.duration) > 0 ? numValue(asset.duration) : visibleDuration;
        drawWaveformCanvas(
          canvas,
          asset.waveform,
          numValue(canvas.dataset.sourceStart),
          visibleDuration,
          assetDuration
        );
      });
    }

    function scheduleProjectClipWaveforms() {
      if (clipWaveformRaf) return;
      clipWaveformRaf = requestAnimationFrame(drawProjectClipWaveforms);
    }

    function syncLegendColors() {
      const setSw = (id, color) => {
        const el = document.getElementById(id);
        if (el) el.style.background = color;
      };
      setSw('lg-normal', WAVE_COL.wave);
      setSw('lg-del', STATUS_COL.delete);
      setSw('lg-breath', STATUS_COL.breath);
    }

    fetch('./data.json')
      .then(r => {
        if (!r.ok) throw new Error('data.json 未找到 (HTTP ' + r.status + ')，请确认步骤 6 已完成');
        return r.json();
      })
      .then(async (data) => {
        words = data.words || [];
        autoSelected = new Set(data.autoSelected || []);
        autoSelected.forEach(idx => {
          const id = 'word-' + idx;
          selected.add(id);
          aiSelectedIds.add(id);
        });
        markSegsDirty();

        // 并行加载波形包络 + 静音段（任一缺失都不阻塞主流程）
        const [pk, sp, draftResp, projectResp] = await Promise.all([
          fetchJSON('./peaks.json'),
          fetchJSON('./silence_periods.json'),
          fetchJSON('/api/draft'),
          fetchJSON('/api/project')
        ]);
        peaksData = (pk && Array.isArray(pk.peaks)) ? pk : null;
        silencePeriods = Array.isArray(sp) ? sp.slice().sort((a, b) => a.start - b.start) : [];
        breathSegments = TimelineView.selectableBreathSegments
          ? TimelineView.selectableBreathSegments(words)
          : words.filter(w => w && w.isGap && w.end > w.start).map(w => ({ start: w.start, end: w.end }));
        currentProjectSignature = draftResp && draftResp.projectSignature ? draftResp.projectSignature : null;
        reviewDir = projectResp && projectResp.reviewDir ? projectResp.reviewDir : '';
        renderProjectSummary((projectResp && projectResp.project) || data.project || data.timeline);
        const restored = applyDraft(draftResp && draftResp.draft);

        initTimelineModeSwitcher();
        initWave();

        // 顶栏文件元信息
        document.getElementById('fileSub').innerHTML =
          `REVIEW <span class="dot">●</span> ${aiSelectedIds.size} 处 AI 预选${restored ? ' <span class="dot">●</span> 已恢复草稿' : ''}`;

        loadingOverlay.classList.remove('show');
        clearInterval(msgTimer);
        render();
        initKnobs();
        syncLegendColors();
      })
      .catch(err => {
        clearInterval(msgTimer);
        document.getElementById('loadingLabel').textContent = '数据加载失败';
        document.getElementById('loadingTime').textContent = err.message;
      });

    function renderProjectSummary(project) {
      const el = document.getElementById('projectSummary');
      if (!el || !project || !Array.isArray(project.assets) || !Array.isArray(project.clips)) return;
      currentProject = project;
      projectAssetsById = new Map(project.assets.map(asset => [asset.id, asset]));
      currentTrackCount = Math.max(
        (TimelineView.trackCountForProject ? TimelineView.trackCountForProject(project) : 0),
        1
      );
      const transcriptStale = project.transcript && project.transcript.status === 'stale';
      el.textContent = `多轨 ${project.assets.length} 素材 / ${currentTrackCount || 1} 轨${transcriptStale ? ' · 需重转录' : ''}`;
      el.classList.toggle('stale', transcriptStale);
      renderProjectTracks();
    }

    function projectTimelineDuration() {
      if (TimelineView.timelineDuration) return TimelineView.timelineDuration({ words, project: currentProject });
      return Math.max(
        1,
        words.reduce((max, w) => Math.max(max, Number(w.end) || 0), 0),
        currentProject && Array.isArray(currentProject.clips)
          ? currentProject.clips.reduce((max, clip) => Math.max(max, Number(clip.timelineStart || 0) + Number(clip.duration || 0)), 0)
          : 0
      );
    }

    function projectViewState() {
      const root = document.getElementById('projectTracks');
      const view = waveReady && typeof wave !== 'undefined' && wave.getViewState ? wave.getViewState() : null;
      if (view && view.pxPerSec > 0) return view;
      const width = Math.max(1, root ? root.clientWidth : window.innerWidth);
      const duration = projectTimelineDuration();
      const timelineWidth = Math.max(1, width - PROJECT_LABEL_W);
      const pxPerSec = timelineWidth / Math.max(1, duration);
      return { viewStart: 0, pxPerSec, viewDuration: timelineWidth / pxPerSec, duration, labelWidth: PROJECT_LABEL_W, width };
    }

    function renderProjectTracks() {
      const root = document.getElementById('projectTracks');
      if (!root || !currentProject) return;
      const view = projectViewState();
      const viewEnd = view.viewStart + view.viewDuration;
      const rootWidth = Math.max(1, root.clientWidth || view.width || 1);
      const rows = [];
      root.style.setProperty('--track-count', String(Math.max(1, currentTrackCount || 1)));
      for (let t = 0; t < currentTrackCount; t++) {
        const clips = currentProject.clips
          .filter(clip => Number(clip.trackIndex != null ? clip.trackIndex : clip.lane || 0) === t)
          .map(clip => {
            const clipStart = Number(clip.timelineStart || 0);
            const clipEnd = clipStart + Number(clip.duration || 0);
            if (clipEnd <= view.viewStart || clipStart >= viewEnd) return '';
            const asset = projectAssetsById.get(clip.assetId) || { id: clip.assetId, name: 'missing', kind: 'audio' };
            const visibleStart = Math.max(clipStart, view.viewStart);
            const visibleEnd = Math.min(clipEnd, viewEnd);
            const left = view.labelWidth + (visibleStart - view.viewStart) * view.pxPerSec;
            const right = view.labelWidth + (visibleEnd - view.viewStart) * view.pxPerSec;
            const width = Math.max(18, Math.min(rootWidth - left + 4, right - left));
            const kind = asset.kind === 'video' || asset.hasVideo ? 'video' : 'audio';
            const sourceStart = Number(clip.sourceStart || 0) + (visibleStart - clipStart);
            const visibleDuration = Math.max(0.001, visibleEnd - visibleStart);
            const title = `${asset.name || asset.id} · ${formatTime(clipStart)}-${formatTime(clipEnd)} · 源 ${formatTime(Number(clip.sourceStart || 0))}`;
            const waveformCanvas = asset.hasAudio === false ? '' : `<canvas class="clip-waveform" data-clip-id="${escapeHtml(clip.id)}" data-asset-id="${escapeHtml(asset.id)}" data-source-start="${sourceStart}" data-duration="${visibleDuration}"></canvas>`;
            return `<div class="project-clip ${kind}" data-clip-id="${escapeHtml(clip.id)}" data-asset-id="${escapeHtml(asset.id)}" title="${escapeHtml(title)}" style="left:${left}px;width:${width}px">
              ${waveformCanvas}
              <span class="clip-title">${escapeHtml(asset.name || asset.id)}</span>
            </div>`;
          }).join('');
        rows.push(`<div class="project-track"><div class="project-track-label">轨 ${t + 1}</div>${clips}</div>`);
      }
      root.innerHTML = rows.join('');
      root.style.display = rows.length ? 'block' : 'none';
      scheduleProjectClipWaveforms();
    }

    function togglePlay()  { clearPreview(); video.paused ? video.play() : video.pause(); }
    function setSpeed(v)   { video.playbackRate = v; }
    function seekRel(d)    { clearPreview(); video.currentTime = Math.max(0, video.currentTime + d); }

    // ============================================================
    // 波形渲染器（自绘 canvas）：视口窗口化渲染，长视频也顺滑
    // 状态带：青蓝=气口 / 红=删减；正常内容保持 clip 与波形原色
    // ============================================================
    const wave = (function () {
      let root, cv, ctx, buf, bctx, rcv, rctx, dpr = 1;
      let cssW = 0, cssH = 132, rulerH = 20;
      let duration = 0;
      let pxPerSec = 1, viewStart = 0;
      let staticDirty = true, lastKey = '';
      let cutsDirty = true; // 切割几何（选段/参数）是否需要重算；与视口平移/缩放无关
      let deleteSegs = [];
      let drag = null;
      const ZOOM_MAX = 400; // 相对 fit 的最大放大倍数

      const timelineWidth = () => Math.max(1, cssW - PROJECT_LABEL_W);
      const timeToX = (t) => PROJECT_LABEL_W + (t - viewStart) * pxPerSec;
      const xToTime = (x) => viewStart + Math.max(0, x - PROJECT_LABEL_W) / pxPerSec;
      const viewDur = () => timelineWidth() / pxPerSec;
      const fitPxPerSec = () => (duration > 0 ? timelineWidth() / duration : 1);

      function clampView() {
        const vd = viewDur();
        if (vd >= duration) { viewStart = 0; return; }
        viewStart = Math.max(0, Math.min(viewStart, duration - vd));
      }

      function recompute() {
        deleteSegs = getDeleteSegments();
        if (typeof ComputeKeeps !== 'undefined') {
          const keeps = ComputeKeeps.computeFinalKeeps(deleteSegs, silencePeriods, duration, cutOpts);
          // 状态栏：总时长 / 剪后
          let finalDur = 0;
          for (const k of keeps) finalDur += (k.end - k.start);
          const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
          set('tl-total', formatTime(duration));
          set('tl-final', formatTime(finalDur));
        }
      }

      function layout() {
        cssW = cv.clientWidth || 1;
        cssH = cv.clientHeight || 132; // 由 CSS --wave-h 驱动，可拖拽调整
        dpr = window.devicePixelRatio || 1;
        for (const c of [cv, buf]) { c.width = Math.round(cssW * dpr); c.height = Math.round(cssH * dpr); }
        if (rcv) { rcv.width = Math.round(cssW * dpr); rcv.height = Math.round(rulerH * dpr); rctx.setTransform(dpr, 0, 0, dpr, 0, 0); }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        staticDirty = true;
      }

      // 时间标尺：根据 pxPerSec 自适应选刻度间隔
      function drawRuler() {
        if (!rctx) return;
        rctx.clearRect(0, 0, cssW, rulerH);
        rctx.fillStyle = '#1A1A1F'; rctx.fillRect(0, 0, cssW, rulerH);
        rctx.fillStyle = 'rgba(14,14,19,.9)';
        rctx.fillRect(0, 0, PROJECT_LABEL_W, rulerH);
        rctx.fillStyle = 'rgba(255,255,255,.1)';
        rctx.fillRect(PROJECT_LABEL_W - 0.5, 0, 1, rulerH);
        const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
        const minPx = 70; // 相邻主刻度最小像素间距
        let step = steps[steps.length - 1];
        for (const s of steps) { if (s * pxPerSec >= minPx) { step = s; break; } }
        rctx.fillStyle = '#6B6557';
        rctx.font = '10px "JetBrains Mono", monospace';
        rctx.textBaseline = 'middle';
        const t0 = Math.floor(viewStart / step) * step;
        for (let t = t0; t <= viewStart + viewDur(); t += step) {
          const x = timeToX(t);
          if (x < -1 || x > cssW + 1) continue;
          rctx.fillRect(x, rulerH - 7, 1, 7);
          const m = Math.floor(t / 60), s = Math.floor(t % 60);
          const label = m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`;
          rctx.fillText(label, x + 4, rulerH / 2 - 1);
        }
      }

      function buildStatic() {
        bctx.clearRect(0, 0, cssW, cssH);
        if (timelineMode === 'strip') {
          bctx.fillStyle = WAVE_COL.bg;
          bctx.fillRect(0, 0, cssW, cssH);
          bctx.fillStyle = 'rgba(14,14,19,.9)';
          bctx.fillRect(0, 0, PROJECT_LABEL_W, cssH);
          bctx.fillStyle = 'rgba(255,255,255,.1)';
          bctx.fillRect(PROJECT_LABEL_W - 0.5, 0, 1, cssH);
          drawMixedWaveform();
        }

        drawBand(breathSegments, STATUS_COL.breath);
        drawBand(deleteSegs, STATUS_COL.delete);
      }

      function drawMixedWaveform() {
        const peaks = peaksData ? peaksData.peaks : null;
        paintUpperWaveform(bctx, {
          peaks,
          assetDuration: duration,
          sourceStart: viewStart,
          sourceDuration: viewDur(),
          x: PROJECT_LABEL_W,
          y: 4,
          width: Math.max(1, cssW - PROJECT_LABEL_W),
          height: Math.max(1, cssH - 8),
          fill: WAVE_COL.waveSoft,
          stroke: WAVE_COL.wave,
          center: WAVE_COL.center,
        });
      }

      function drawBand(segs, fill) {
        for (const s of segs) {
          const x0Raw = timeToX(s.start), x1 = timeToX(s.end);
          if (x1 < PROJECT_LABEL_W || x0Raw > cssW) continue;
          const x0 = Math.max(PROJECT_LABEL_W, x0Raw);
          const w = Math.max(1.5, x1 - x0);
          bctx.fillStyle = fill; bctx.fillRect(x0, 0, w, cssH);
        }
      }

      function draw(t) {
        if (!ctx) return;
        // 播放跟随：playhead 越过右侧 85% 时把视图前移到 15% 处（仅放大时）
        if (!video.paused && pxPerSec > fitPxPerSec() + 1e-6) {
          const x = timeToX(t);
          if (x > cssW * 0.85 || x < PROJECT_LABEL_W) { viewStart = t - viewDur() * 0.15; clampView(); staticDirty = true; }
        }
        // 切割几何只在选段/参数变化时重算；平移缩放只需重画静态层
        if (cutsDirty) { recompute(); cutsDirty = false; }
        const key = timelineMode + '|' + cssW + '|' + cssH + '|' + viewStart.toFixed(3) + '|' + pxPerSec.toFixed(3);
        if (staticDirty || key !== lastKey) {
          buildStatic();
          drawRuler();
          syncZoomSlider();
          renderProjectTracks();
          lastKey = key;
          staticDirty = false;
        }

        ctx.clearRect(0, 0, cssW, cssH);
        ctx.drawImage(buf, 0, 0, cssW, cssH);

        // 播放头
        const hx = timeToX(t);
        if (hx >= PROJECT_LABEL_W && hx <= cssW) {
          ctx.fillStyle = STATUS_COL.playhead;
          ctx.fillRect(hx - 0.5, 0, 1.5, cssH);
        }
      }

      function markDirty() { staticDirty = true; cutsDirty = true; if (ctx && video.paused) draw(video.currentTime); }
      function redraw() { staticDirty = true; cutsDirty = true; draw(video.currentTime); }

      function zoom(factor, anchorT) {
        const at = (anchorT == null) ? video.currentTime : anchorT;
        const fit = fitPxPerSec();
        const next = Math.max(fit, Math.min(pxPerSec * factor, fit * 400));
        if (next === pxPerSec) return;
        const ax = timeToX(at) - PROJECT_LABEL_W;
        pxPerSec = next;
        viewStart = at - ax / pxPerSec; // 锚点时间保持在原屏幕位置
        clampView(); redraw();
      }
      function fit() { pxPerSec = fitPxPerSec(); viewStart = 0; redraw(); }

      function getViewState() {
        return {
          viewStart,
          pxPerSec,
          viewDuration: viewDur(),
          duration,
          labelWidth: PROJECT_LABEL_W,
          width: cssW,
        };
      }

      function resize() {
        layout();
        clampView();
        redraw();
      }

      // 缩放滑块 0..1000 ↔ pxPerSec（对数，0=fit，1000=最大）
      const slider = () => document.getElementById('zoomSlider');
      function syncZoomSlider() {
        const sl = slider(); if (!sl) return;
        const fit = fitPxPerSec();
        const frac = Math.log(pxPerSec / fit) / Math.log(ZOOM_MAX);
        sl.value = Math.round(Math.max(0, Math.min(1, frac)) * 1000);
      }
      function setZoomFrac(frac01) {
        const fit = fitPxPerSec();
        const next = fit * Math.pow(ZOOM_MAX, Math.max(0, Math.min(1, frac01)));
        const at = video.currentTime;
        const ax = timeToX(at) - PROJECT_LABEL_W;
        pxPerSec = next;
        viewStart = at - ax / pxPerSec;
        clampView(); redraw();
      }

      function init() {
        root = document.getElementById('waveform');
        cv = document.getElementById('waveCanvas');
        rcv = document.getElementById('rulerCanvas');
        buf = document.createElement('canvas');
        ctx = cv.getContext('2d');
        bctx = buf.getContext('2d');
        rctx = rcv ? rcv.getContext('2d') : null;
        duration = Math.max((peaksData && peaksData.duration) || 0, video.duration || 0, projectTimelineDuration());
        layout();
        pxPerSec = fitPxPerSec();
        viewStart = 0;

        new ResizeObserver(() => { layout(); clampView(); draw(video.currentTime); }).observe(root || cv);
        video.addEventListener('loadedmetadata', () => {
          const nextDuration = Math.max(duration || 0, video.duration || 0, projectTimelineDuration());
          if (!duration || nextDuration !== duration) { duration = nextDuration; fit(); }
        });

        // 滚轮缩放（以光标处时间为锚点）
        (root || cv).addEventListener('wheel', (e) => {
          e.preventDefault();
          const r = (root || cv).getBoundingClientRect();
          zoom(e.deltaY < 0 ? 1.15 : 1 / 1.15, xToTime(e.clientX - r.left));
        }, { passive: false });

        // 按下：拖动平移；未移动则点击跳转
        (root || cv).addEventListener('mousedown', (e) => {
          if (e.button !== 0) return;
          const r = (root || cv).getBoundingClientRect();
          drag = { x0: e.clientX - r.left, vs0: viewStart, moved: false };
          e.preventDefault();
        });
        window.addEventListener('mousemove', (e) => {
          if (!drag) return;
          const r = (root || cv).getBoundingClientRect();
          const dx = (e.clientX - r.left) - drag.x0;
          if (Math.abs(dx) > 3) drag.moved = true;
          if (drag.moved && pxPerSec > fitPxPerSec() + 1e-6) {
            viewStart = drag.vs0 - dx / pxPerSec; clampView(); redraw();
          }
        });
        window.addEventListener('mouseup', (e) => {
          if (!drag) return;
          if (!drag.moved) {
            const r = (root || cv).getBoundingClientRect();
            const t = Math.max(0, Math.min(duration, xToTime(e.clientX - r.left)));
            clearPreview();
            video.currentTime = t;
          }
          drag = null;
        });

        // 缩放滑块
        const sl = slider();
        if (sl) sl.addEventListener('input', () => setZoomFrac(parseInt(sl.value, 10) / 1000));

        waveReady = true;
        draw(0);
      }

      return { init, draw, getViewState, markDirty, redraw, resize, zoom, fit };
    })();

    function initWave() { wave.init(); }
    function waveZoom(f) { wave.zoom(f); }
    function waveZoomFit() { wave.fit(); }

    function setTimelineMode(mode, persist) {
      timelineMode = normalizeTimelineMode(mode);
      const root = document.getElementById('waveform');
      if (root) {
        root.classList.toggle('timeline-mode-overlay', timelineMode === 'overlay');
        root.classList.toggle('timeline-mode-strip', timelineMode === 'strip');
      }
      const switcher = document.getElementById('timelineModeSwitch');
      if (switcher) {
        switcher.querySelectorAll('[data-mode]').forEach((button) => {
          button.classList.toggle('active', button.dataset.mode === timelineMode);
          button.setAttribute('aria-pressed', button.dataset.mode === timelineMode ? 'true' : 'false');
        });
      }
      if (persist) {
        try { localStorage.setItem(timelineModeKey, timelineMode); } catch (e) {}
      }
      if (waveReady && wave.resize) wave.resize();
    }

    function initTimelineModeSwitcher() {
      const switcher = document.getElementById('timelineModeSwitch');
      const stored = localStorage.getItem(timelineModeKey);
      const resolved = normalizeTimelineMode(stored);
      setTimelineMode(resolved, !!stored && stored !== resolved);
      if (!switcher) return;
      switcher.querySelectorAll('[data-mode]').forEach((button) => {
        button.addEventListener('click', () => setTimelineMode(button.dataset.mode, true));
      });
    }

    // 切割参数滑块：导出时一并发给 server，预览和导出使用同一套切点参数
    function initKnobs() {
      // 吸附窗口(lookBack)与内部静音切割(minInternalSilence)已固定为默认值（见 cutOpts），
      // 不再暴露为滑块——它们是「工具自动做对的事」，面板用静态说明讲清机制即可。
      const padS = document.getElementById('knob-padstart');
      const padE = document.getElementById('knob-padend');
      const padSV = document.getElementById('knob-padstart-val');
      const padEV = document.getElementById('knob-padend-val');
      const sync = () => {
        const fs = parseInt(padS.value, 10), fe = parseInt(padE.value, 10);
        cutOpts.padStart = fs / 30;
        cutOpts.padEnd = fe / 30;
        padSV.textContent = fs + ' 帧';
        padEV.textContent = fe + ' 帧';
        playbackCutsDirty = true;   // 切割参数变了，播放跳段也要跟着重算
        wave.redraw();
      };
      [padS, padE].forEach(el => el.addEventListener('input', sync));
      sync();
    }

    // === 选段缓存：只在 selected 变化时重算 ===
    let cachedDeleteSegs = [];
    let segsDirty = true;
    // 播放跳段用的「实际切点」缓存：与波形 / 导出 FCPXML 同源（computeFinalKeeps），
    // 这样预览听到的就是真正会被剪掉的内容，且切点已吸附到静音。选段或切割参数变化时失效。
    let cachedPlaybackCuts = [];
    let playbackCutsDirty = true;
    function markSegsDirty() { segsDirty = true; playbackCutsDirty = true; if (typeof wave !== 'undefined') wave.markDirty(); }
    function getPlaybackCuts() {
      if (!playbackCutsDirty) return cachedPlaybackCuts;
      const del = getDeleteSegments();
      const dur = (peaksData && peaksData.duration) || video.duration || 0;
      if (typeof ComputeKeeps === 'undefined' || dur <= 0) {
        // 算法未就绪或时长未知：退回原始选段，且不缓存（保持 dirty，等就绪后重算）
        return del;
      }
      const keeps = ComputeKeeps.computeFinalKeeps(del, silencePeriods, dur, cutOpts);
      cachedPlaybackCuts = ComputeKeeps.keepsToCuts(keeps, dur);
      playbackCutsDirty = false;
      return cachedPlaybackCuts;
    }
    function getDeleteSegments() {
      if (!segsDirty) return cachedDeleteSegs;
      // 按词序扫一遍，把「连续删除」连成整刀：两个选中词之间只要没夹着「你保留的真词」
      // （中间只有静音段 isGap 或字间时间戳零头），就贯穿成一刀，吞掉中间的缝——
      // 避免连续删除里残留没字可点的声音/空隙（旧版用固定 0.15s 阈值会漏掉 >0.15s 的缝）。
      // 一旦夹着你保留的真词，才断开成两段，绝不误删要留的内容。
      const out = [];
      let cur = null;          // 当前正在累积的删除段
      let sawKeptWord = false;  // 自上一个选中词以来，中间是否夹了「保留的真词」
      for (let i = 0; i < words.length; i++) {
        const w = words[i];
        if (selected.has('word-' + i)) {
          if (cur && !sawKeptWord) cur.end = w.end;            // 只隔静音/零头 → 连成一刀
          else { if (cur) out.push(cur); cur = { start: w.start, end: w.end }; }
          sawKeptWord = false;
        } else if (!w.isGap) {
          sawKeptWord = true;   // 保留的真词 → 会切断删除段，不能被吞
        }
        // 未选中的 isGap（静音/缝）：不切断 run，留给下一个选中词决定是否吞
      }
      if (cur) out.push(cur);
      cachedDeleteSegs = out;
      segsDirty = false;
      return out;
    }

    // === 当前词二分查找（按 start 升序，跳过 isGap=false 的 word 时间轴用全数组即可）===
    function findWordIndexAt(t) {
      let lo = 0, hi = words.length - 1, ans = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (words[mid].start <= t) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
      }
      return ans;
    }
    function formatTime(s) {
      const m = Math.floor(s / 60);
      const sec = Math.floor(s % 60);
      return `${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
    }

    function buildGapGroups() {
      gapGroups = [];
      let cur = null;
      words.forEach((w, idx) => {
        if (w.isGap) {
          if (cur && cur.indices[cur.indices.length - 1] === idx - 1) {
            cur.indices.push(idx); cur.end = w.end; cur.duration += (w.end - w.start);
          } else {
            if (cur) gapGroups.push(cur);
            cur = { indices: [idx], start: w.start, end: w.end, duration: w.end - w.start };
          }
        } else {
          if (cur) { gapGroups.push(cur); cur = null; }
        }
      });
      if (cur) gapGroups.push(cur);
    }

    // 段落切分：长静音（≥0.4s）作为段落分界
    function buildParagraphs() {
      const PARA_THRESHOLD = 0.4;
      const paras = [];
      let cur = { startTime: 0, items: [] };
      let firstWord = true;
      words.forEach((w, idx) => {
        if (w.isGap && (w.end - w.start) >= PARA_THRESHOLD && cur.items.length > 0) {
          cur.items.push({ word: w, idx });
          paras.push(cur);
          cur = { startTime: w.end, items: [] };
        } else {
          if (firstWord && !w.isGap) { cur.startTime = w.start; firstWord = false; }
          cur.items.push({ word: w, idx });
        }
      });
      if (cur.items.length) paras.push(cur);
      return paras;
    }

    function render() {
      content.innerHTML = '';
      elements = [];
      buildGapGroups();
      const gapIdxToGroup = new Map();
      gapGroups.forEach(g => g.indices.forEach(i => gapIdxToGroup.set(i, g)));
      const renderedGroups = new Set();

      const paragraphs = buildParagraphs();

      paragraphs.forEach(para => {
        const pDiv = document.createElement('div');
        pDiv.className = 'paragraph';
        const tc = document.createElement('div');
        tc.className = 'tc';
        tc.innerHTML = `<span class="tc-bar"></span>${formatTime(para.startTime)}`;
        pDiv.appendChild(tc);
        const body = document.createElement('div');
        body.className = 'paragraph-body';
        pDiv.appendChild(body);

        para.items.forEach(({ word, idx }) => {
          if (word.isGap) {
            const group = gapIdxToGroup.get(idx);
            if (!group || renderedGroups.has(group)) {
              if (group && renderedGroups.has(group)) {
                const existingEl = document.querySelector(`[data-gap-group-id="${group.indices[0]}"]`);
                if (existingEl) elements.push({ el: existingEl, word, idx });
              }
              return;
            }
            renderedGroups.add(group);

            const div = document.createElement('div');
            div.className = 'gap';
            div.textContent = `${group.duration.toFixed(1)}s`;
            div.dataset.gapGroupId = group.indices[0];
            div.dataset.gapGroup = JSON.stringify(group.indices);
            div.dataset.start = group.start;
            div.dataset.end = group.end;
            div.title = `${formatTime(group.start)} – ${formatTime(group.end)}`;

            const allIds = group.indices.map(i => 'word-' + i);
            const allSelected = allIds.every(id => selected.has(id));
            const isAi = allIds.some(id => aiSelectedIds.has(id));
            if (allSelected) div.classList.add('selected');
            if (isAi && !allSelected) div.classList.add('ai-selected');
            if (allSelected && isAi) { div.classList.add('selected'); div.classList.add('ai-selected'); }

            // 静音 chip：单击直接切删除（见委托 mousedown/up），划过也参与
            body.appendChild(div);
            group.indices.forEach(i => elements.push({ el: div, word: words[i], idx: i }));
          } else {
            const div = document.createElement('div');
            const id = 'word-' + idx;
            div.dataset.id = id;
            div.dataset.start = word.start;
            div.dataset.end = word.end;
            div.className = 'word';
            div.textContent = word.text;
            if (selected.has(id)) div.classList.add('selected');
            if (aiSelectedIds.has(id)) div.classList.add('ai-selected');
            // 交互统一由 content 上的委托处理（见 mousedown/move/up），此处不再绑事件
            body.appendChild(div);
            elements.push({ el: div, word, idx });
          }
        });

        content.appendChild(pDiv);
      });
    }

    // ===== 撤销栈：每次编辑前快照 selected =====
    function pushUndo() {
      undoStack.push(new Set(selected));
      if (undoStack.length > 100) undoStack.shift();
    }
    function undo() {
      if (!undoStack.length) return;
      const prev = undoStack.pop();
      selected.clear();
      prev.forEach(id => selected.add(id));
      markSegsDirty();
      refreshSelectionStyles();
    }

    // 只更新词/气口的 selected/ai-selected class，不重建 DOM
    function refreshSelectionStyles() {
      const seenGroups = new Set();
      for (const { el, idx } of elements) {
        if (el.dataset.gapGroup) {
          if (seenGroups.has(el)) continue;
          seenGroups.add(el);
          const groupIds = JSON.parse(el.dataset.gapGroup).map(i => 'word-' + i);
          const allOn = groupIds.every(gid => selected.has(gid));
          const isAi = groupIds.some(gid => aiSelectedIds.has(gid));
          el.classList.toggle('selected', allOn);
          el.classList.toggle('ai-selected', isAi && !allOn);
        } else {
          const id = 'word-' + idx;
          const on = selected.has(id);
          el.classList.toggle('selected', on);
          el.classList.toggle('ai-selected', !on && aiSelectedIds.has(id));
        }
      }
    }

    // ===== 交互：点=定位，划=删/恢复（统一委托，不再逐元素绑事件）=====
    const elIndexOfId = id => elements.findIndex(el => 'word-' + el.idx === id);

    // 把 [startId..endId] 这段词统一设为 add(删) 或 remove(恢复)，并记录时间范围
    function applyRange(startId, endId, mode) {
      const a = elIndexOfId(startId), b = elIndexOfId(endId);
      if (a < 0 || b < 0) return;
      const [lo, hi] = a <= b ? [a, b] : [b, a];
      let tMin = Infinity, tMax = -Infinity;
      for (let j = lo; j <= hi; j++) {
        const id = 'word-' + elements[j].idx;
        mode === 'add' ? selected.add(id) : selected.delete(id);
        const w = elements[j].word;
        if (w.start < tMin) tMin = w.start;
        if (w.end > tMax) tMax = w.end;
      }
      dragSpan = tMin <= tMax ? { start: tMin, end: tMax } : null;
      markSegsDirty();
      refreshSelectionStyles();
    }

    content.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      const target = e.target.closest('[data-id], [data-gap-group]');
      if (!target) return;
      const isGap = !!target.dataset.gapGroup;
      const startId = isGap ? ('word-' + JSON.parse(target.dataset.gapGroup)[0]) : target.dataset.id;
      // 划选方向由「按下的第一个元素」当前状态决定：已删→恢复，未删→删
      const startDeleted = isGap
        ? JSON.parse(target.dataset.gapGroup).every(i => selected.has('word-' + i))
        : selected.has(startId);
      selectMode = startDeleted ? 'remove' : 'add';
      selectStart = startId;
      dragSpan = null;
      pendingDown = { startId, x: e.clientX, y: e.clientY, isGap, target, started: false };
      hideToolbar();
      e.preventDefault(); // 阻止原生文本选择
    });

    document.addEventListener('mousemove', e => {
      if (!pendingDown) return;
      if (!pendingDown.started) {
        if (Math.abs(e.clientX - pendingDown.x) < DRAG_THRESHOLD &&
            Math.abs(e.clientY - pendingDown.y) < DRAG_THRESHOLD) return;
        pendingDown.started = true;   // 越过阈值 → 升级为「划」
        isSelecting = true;
        pushUndo();
      }
      const target = e.target.closest('[data-id], [data-gap-group]');
      if (!target) return;
      const endId = target.dataset.gapGroup
        ? ('word-' + JSON.parse(target.dataset.gapGroup)[0])
        : target.dataset.id;
      applyRange(selectStart, endId, selectMode);
    });

    document.addEventListener('mouseup', e => {
      if (!pendingDown) { isSelecting = false; return; }
      const pd = pendingDown;
      pendingDown = null;
      isSelecting = false;
      if (pd.started) {
        // 仅「标删」划选后弹工具条（试听/撤销）；「恢复」不需要，恢复就是恢复
        if (selectMode === 'add') showSelectionToolbar(e.clientX, e.clientY);
        return;
      }
      // 没移动 = 单击
      if (pd.isGap) {
        // 静音 chip：单击直接切删除
        pushUndo();
        const ids = JSON.parse(pd.target.dataset.gapGroup).map(i => 'word-' + i);
        const add = !ids.every(id => selected.has(id));
        ids.forEach(id => add ? selected.add(id) : selected.delete(id));
        markSegsDirty();
        refreshSelectionStyles();
      } else {
        // 词：定位并播放（去那听）
        const wi = parseInt(pd.startId.replace('word-', ''), 10);
        const w = words[wi];
        if (w) {
          clearPreview();
          const run = deletedRunAround(wi);
          // 点到红词 → 试听这整段被删的内容（否则跳段逻辑会立刻把它跳过去）
          if (run) previewSpan(run);
          else { video.currentTime = w.start; video.play().catch(() => {}); }
        }
      }
    });

    // 给定词 idx，若它在某段连续删除里，返回这段的时间范围（用于点红词试听）
    function deletedRunAround(idx) {
      if (!selected.has('word-' + idx)) return null;
      let lo = idx, hi = idx;
      while (lo - 1 >= 0 && selected.has('word-' + (lo - 1))) lo--;
      while (hi + 1 < words.length && selected.has('word-' + (hi + 1))) hi++;
      return { start: words[lo].start, end: words[hi].end };
    }

    // ===== 划选后的浮动工具条：试听这段 / 撤销 =====
    let toolbarEl = null, toolbarDismiss = null;
    function hideToolbar() {
      if (toolbarDismiss) { toolbarDismiss(); toolbarDismiss = null; }
      if (toolbarEl) { toolbarEl.remove(); toolbarEl = null; }
    }
    function showSelectionToolbar(x, y) {
      hideToolbar();
      if (!dragSpan) return;
      const span = dragSpan;
      const bar = document.createElement('div');
      bar.className = 'sel-toolbar';
      const d = Math.max(0, span.end - span.start);
      bar.innerHTML =
        `<button data-act="preview">▶ 试听 <em>${d.toFixed(1)}s</em></button>` +
        `<button data-act="undo">↺ 撤销</button>`;
      document.body.appendChild(bar);
      toolbarEl = bar;
      const bw = bar.offsetWidth, bh = bar.offsetHeight;
      const left = Math.min(Math.max(8, x - bw / 2), window.innerWidth - bw - 8);
      const top = (y - bh - 12 < 8) ? y + 16 : y - bh - 12;
      bar.style.left = left + 'px';
      bar.style.top = top + 'px';
      bar.addEventListener('mousedown', ev => ev.stopPropagation());
      bar.querySelector('[data-act="preview"]').onclick = () => previewSpan(span);
      bar.querySelector('[data-act="undo"]').onclick = () => { undo(); hideToolbar(); };
      // 点工具条以外任意位置即消失（工具条自身的 mousedown 已 stopPropagation，不会触发）
      const onOutside = ev => { if (toolbarEl && !toolbarEl.contains(ev.target)) hideToolbar(); };
      document.addEventListener('mousedown', onOutside, true);
      toolbarDismiss = () => document.removeEventListener('mousedown', onOutside, true);
    }

    // 试听这段：从段首播到段尾即停；期间不跳删除段（否则红段会被直接跳过听不到）
    function clearPreview() { previewUntil = null; }
    function previewSpan(span) {
      hideToolbar();
      previewUntil = span.end;
      video.currentTime = span.start;
      video.play().catch(() => {});
    }

    // === rAF 主循环：60Hz 检测跳段 + 当前词高亮，远比 timeupdate 的 ~4Hz 可靠 ===
    let rafId = 0;
    let currentEl = null;        // 当前高亮的 DOM 元素
    let currentWordIdx = -1;
    let lastSeekTarget = -1;     // 防止反复 seek 到同一个段尾

    function tick() {
      rafId = 0;
      if (video.paused) return;
      const t = video.currentTime;
      const dur = video.duration || 0;

      // 0) 「试听这段」预览模式：播到段尾即停，期间不跳删除段（要听被剪掉的内容）
      if (previewUntil != null) {
        if (t >= previewUntil) { previewUntil = null; video.pause(); return; }
        updatePlayheadUI(t, dur);
        rafId = requestAnimationFrame(tick);
        return;
      }

      // 1) 跳过切点：用二分定位当前段，O(log n)。
      //    用 getPlaybackCuts()（= 波形 / 导出同源的 computeFinalKeeps 结果），保证
      //    预览听到的就是真正会剪掉的内容。SEEK_EPS 容差吸收 seek 欠冲（落点常比目标
      //    早几毫秒），避免落点仍判定在段内而反复 seek 到同一段尾，造成卡顿 / 重放。
      const SEEK_EPS = 0.03;
      const segs = getPlaybackCuts();
      if (segs.length) {
        let lo = 0, hi = segs.length - 1, hit = -1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (segs[mid].start <= t) {
            if (segs[mid].end > t + SEEK_EPS) { hit = mid; break; }
            lo = mid + 1;
          } else { hi = mid - 1; }
        }
        if (hit >= 0) {
          const target = segs[hit].end;
          if (Math.abs(target - lastSeekTarget) > 0.001) {
            lastSeekTarget = target;
            video.currentTime = target;
          }
          rafId = requestAnimationFrame(tick);
          return;
        }
        lastSeekTarget = -1;
      }

      updatePlayheadUI(t, dur);
      rafId = requestAnimationFrame(tick);
    }

    // 时间文本 + 当前词高亮 + 波形游标（正常播放与试听预览共用）
    function updatePlayheadUI(t, dur) {
      timeCur.textContent = formatTime(t);

      let idx = findWordIndexAt(t);
      if (idx >= 0 && t >= words[idx].end) idx = -1; // 在词与词之间的微间隙，不高亮
      if (idx !== currentWordIdx) {
        currentWordIdx = idx;
        const entry = idx >= 0 ? elements.find(e => e.idx === idx) : null;
        const el = entry ? entry.el : null;
        if (el !== currentEl) {
          if (currentEl) currentEl.classList.remove('current');
          if (el) {
            el.classList.add('current');
            scrollCurrentIntoView(el);
          }
          currentEl = el;
        }
      }

      wave.draw(t);
    }

    function startTick() { if (!rafId) rafId = requestAnimationFrame(tick); }

    // 只在元素滚出可视区时滚动，且不用 smooth（smooth 在频繁触发时会叠加成卡顿）
    function scrollCurrentIntoView(el) {
      const scroller = el.closest('.transcript-scroll') || el.parentElement;
      if (!scroller) return;
      const er = el.getBoundingClientRect();
      const sr = scroller.getBoundingClientRect();
      if (er.top < sr.top + 40 || er.bottom > sr.bottom - 40) {
        el.scrollIntoView({ block: 'center' });
      }
    }

    video.addEventListener('play', () => {
      document.getElementById('playBtn').textContent = '❚❚ 暂停';
      startTick();
    });
    video.addEventListener('pause', () => {
      document.getElementById('playBtn').textContent = '▶ 播放';
      // 暂停时刷新一次时间/波形，确保静止状态准确
      const t = video.currentTime, dur = video.duration || 0;
      timeCur.textContent = formatTime(t);
      timeTot.textContent = formatTime(dur);
      wave.draw(t);
    });
    video.addEventListener('seeked', () => {
      // 跳转后让下一帧 tick 重新检查（处理用户手动 seek 到删除段内）
      lastSeekTarget = -1;
      wave.draw(video.currentTime);
      if (!video.paused) startTick();
    });
    video.addEventListener('loadedmetadata', () => {
      timeTot.textContent = formatTime(video.duration || 0);
    });
    function clearAll() { pushUndo(); selected.clear(); markSegsDirty(); render(); }

    function getSelectedIdx() {
      return [...selected]
        .map(id => parseInt(id.replace('word-', ''), 10))
        .filter(n => !Number.isNaN(n))
        .sort((a, b) => a - b);
    }

    function applyDraft(draft) {
      if (!draft || !Array.isArray(draft.selectedIdx)) return false;
      if (draft.projectSignature && currentProjectSignature && draft.projectSignature !== currentProjectSignature) {
        console.warn('进度文件和当前剪辑内容不一致，已跳过自动恢复');
        return false;
      }
      selected.clear();
      draft.selectedIdx.forEach(idx => {
        if (Number.isInteger(idx) && words[idx]) selected.add('word-' + idx);
      });
      if (draft.cutOpts && typeof draft.cutOpts === 'object') {
        cutOpts = { ...cutOpts, ...draft.cutOpts };
      }
      if (Number.isFinite(draft.currentTime) && draft.currentTime > 0) {
        video.currentTime = draft.currentTime;
      }
      markSegsDirty();
      return true;
    }

    function buildDraftPayload() {
      return {
        version: 2,
        projectSignature: currentProjectSignature,
        savedAt: new Date().toISOString(),
        selectedIdx: getSelectedIdx(),
        cutOpts,
        currentTime: video.currentTime || 0
      };
    }

    async function saveDraft() {
      try {
        const res = await fetch('/api/draft', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(buildDraftPayload())
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error || '保存失败');
        alert(`✅ 进度已保存\n\n已保存 ${data.count} 个选中项\n文件: review_draft.json`);
      } catch (err) {
        alert('❌ 保存失败: ' + err.message);
      }
    }

    function exportDraft() {
      const draft = buildDraftPayload();
      const blob = new Blob([JSON.stringify(draft, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `review_draft_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      a.click();
      URL.revokeObjectURL(url);
    }

    async function importDraftFile(event) {
      const input = event.target;
      const file = input.files && input.files[0];
      input.value = '';
      if (!file) return;
      try {
        const draft = JSON.parse(await file.text());
        if (!draft || !Array.isArray(draft.selectedIdx)) {
          throw new Error('这不是有效的进度文件');
        }
        if (!draft.projectSignature) {
          throw new Error('进度文件缺少项目签名，无法确认是否匹配当前剪辑内容');
        }
        if (!currentProjectSignature || draft.projectSignature !== currentProjectSignature) {
          throw new Error('进度文件和当前剪辑内容不一致，已停止导入');
        }
        pushUndo();
        if (!applyDraft(draft)) throw new Error('进度文件无法应用到当前项目');
        refreshSelectionStyles();
        render();
        const res = await fetch('/api/draft', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(draft)
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error || '导入后保存失败');
        alert(`✅ 进度已导入\n\n已恢复 ${data.count} 个选中项，并保存为本地 review_draft.json`);
      } catch (err) {
        alert('❌ 导入失败: ' + err.message);
      }
    }

    function applySilenceThreshold(threshold) {
      pushUndo();
      words.forEach((w, idx) => { if (w.isGap) selected.delete('word-' + idx); });
      buildGapGroups();
      gapGroups.forEach(group => {
        if (group.duration >= threshold) {
          group.indices.forEach(idx => selected.add('word-' + idx));
        }
      });
      markSegsDirty();
      render();
    }

    function closeExportMenu() {
      const menu = document.getElementById('exportMenu');
      if (!menu) return;
      menu.classList.remove('open');
      const trigger = menu.querySelector('.export-trigger');
      if (trigger) trigger.setAttribute('aria-expanded', 'false');
    }

    function toggleExportMenu(event) {
      if (event) event.stopPropagation();
      const menu = document.getElementById('exportMenu');
      if (!menu) return;
      const open = !menu.classList.contains('open');
      menu.classList.toggle('open', open);
      const trigger = menu.querySelector('.export-trigger');
      if (trigger) trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
    }

    document.addEventListener('click', e => {
      const menu = document.getElementById('exportMenu');
      if (menu && !menu.contains(e.target)) closeExportMenu();
    });

    function buildExportPayload(extra) {
      return {
        deleteList: getDeleteSegments(),
        opts: cutOpts,
        finalSelected: getSelectedIdx(),
        ...(extra || {})
      };
    }

    async function downloadOutput(output) {
      const fileName = String(output || '').split(/[\\/]/).pop() || 'export';
      const dlRes = await fetch('/api/download/' + encodeURIComponent(output));
      if (!dlRes.ok) throw new Error('下载文件失败');
      const blob = await dlRes.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      a.click();
      URL.revokeObjectURL(url);
      return fileName;
    }

    async function postExport(endpoint, payload) {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || '导出失败');
      return data;
    }

    function distributionHandoffPrompt(fileName) {
      const targetDir = reviewDir || '当前审核目录（3_审核）';
      return `使用 AI剪口播 skill，完成这个项目的审核包交付：\n${targetDir}\n\n审核页已经导出 ${fileName}。请创建“打包并分发审核页”任务，运行 package_review.sh，生成轻量、自包含的审核包目录和 ZIP；确认多轨原始素材已归档、项目 JSON 不含 waveform 大数组，然后把审核包路径交付给我。`;
    }

    function showDistributionHandoff(title, summary, fileName) {
      document.getElementById('distributionTitle').textContent = title;
      document.getElementById('distributionSummary').textContent = summary;
      document.getElementById('distributionPrompt').value = distributionHandoffPrompt(fileName);
      document.getElementById('copyDistributionBtn').textContent = '复制提示词';
      document.getElementById('distributionModal').hidden = false;
      document.getElementById('copyDistributionBtn').focus();
    }

    function hideDistributionHandoff() {
      document.getElementById('distributionModal').hidden = true;
    }

    async function copyDistributionHandoff() {
      const field = document.getElementById('distributionPrompt');
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(field.value);
        } else {
          field.focus();
          field.select();
          document.execCommand('copy');
        }
        document.getElementById('copyDistributionBtn').textContent = '已复制';
      } catch (err) {
        field.focus();
        field.select();
      }
    }

    function formatDuration(seconds) {
      if (!Number.isFinite(Number(seconds))) return '--:--';
      const s = Math.max(0, Math.round(Number(seconds)));
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const sec = s % 60;
      return h > 0
        ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
        : `${m}:${String(sec).padStart(2, '0')}`;
    }

    let exportProgressEl = null;
    function ensureExportProgressEl() {
      if (exportProgressEl) return exportProgressEl;
      const el = document.createElement('div');
      el.className = 'export-progress';
      el.innerHTML = `
        <div class="export-progress-card">
          <div class="export-progress-title" data-role="title">正在导出</div>
          <div class="export-progress-track"><div class="export-progress-bar" data-role="bar"></div></div>
          <div class="export-progress-meta">
            <span data-role="percent">0%</span>
            <span data-role="eta">剩余时间估算中</span>
          </div>
        </div>`;
      document.body.appendChild(el);
      exportProgressEl = el;
      return el;
    }

    function updateExportProgress(job, title) {
      const el = ensureExportProgressEl();
      el.classList.add('show');
      const progress = Math.max(0, Math.min(1, Number(job && job.progress) || 0));
      const percent = Math.round(progress * 100);
      el.querySelector('[data-role="title"]').textContent = title || '正在导出音频';
      el.querySelector('[data-role="bar"]').style.width = `${percent}%`;
      el.querySelector('[data-role="percent"]').textContent =
        `${percent}% · ${formatDuration(job && job.outTime)} / ${formatDuration(job && job.duration)}`;
      const eta = job && Number.isFinite(Number(job.etaSeconds))
        ? `预计剩余 ${formatDuration(job.etaSeconds)}`
        : '剩余时间估算中';
      el.querySelector('[data-role="eta"]').textContent = eta;
    }

    function hideExportProgress() {
      if (exportProgressEl) exportProgressEl.classList.remove('show');
    }

    async function waitForExportJob(jobId, title) {
      while (true) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        const res = await fetch('/api/export-progress/' + encodeURIComponent(jobId));
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || '导出任务查询失败');
        const job = data.job;
        updateExportProgress(job, title);
        if (job.status === 'done') return job;
        if (job.status === 'error') throw new Error(job.error || '导出失败');
      }
    }

    async function exportFCPXML() {
      closeExportMenu();
      const segments = getDeleteSegments();
      if (!segments.length) { alert('没有选中任何片段'); return; }
      try {
        const data = await postExport('/api/fcpxml', buildExportPayload());
        const fileName = await downloadOutput(data.output);
        showDistributionHandoff('FCPXML 已导出', `文件：${fileName} · 保留片段：${data.segments} 个`, fileName);
      } catch (err) {
        alert('❌ 请求失败: ' + err.message + '\n\n请确保使用 review_server.js 启动服务');
      }
    }

    async function exportEditedAudio(bitrate) {
      closeExportMenu();
      try {
        const data = await postExport('/api/audio', buildExportPayload({ bitrate }));
        let job = data.job || null;
        if (data.jobId) {
          updateExportProgress(job || { progress: 0, outTime: 0, duration: 0 }, `正在导出 MP3 ${bitrate}`);
          job = await waitForExportJob(data.jobId, `正在导出 MP3 ${bitrate}`);
          hideExportProgress();
        }
        const output = (job && job.output) || data.output;
        const fileName = await downloadOutput(output);
        showDistributionHandoff('音频已导出', `文件：${fileName} · 码率：${(job && job.bitrate) || data.bitrate} · 保留片段：${(job && job.segments) || data.segments} 个`, fileName);
      } catch (err) {
        hideExportProgress();
        alert('❌ 音频导出失败: ' + err.message + '\n\n请确保已安装 ffmpeg，并使用 review_server.js 启动服务');
      }
    }

    async function exportSRT() {
      closeExportMenu();
      try {
        const data = await postExport('/api/srt', buildExportPayload());
        const fileName = await downloadOutput(data.output);
        showDistributionHandoff('SRT 已导出', `文件：${fileName} · 字幕：${data.cues} 条`, fileName);
      } catch (err) {
        alert('❌ SRT 导出失败: ' + err.message + '\n\n请确保使用 review_server.js 启动服务');
      }
    }

    document.addEventListener('keydown', e => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      if ((e.metaKey || e.ctrlKey) && e.code === 'KeyZ') { e.preventDefault(); undo(); return; }
      if (e.metaKey || e.ctrlKey) return;   // 不拦截其它系统快捷键
      if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
      else if (e.code === 'ArrowLeft')  { e.preventDefault(); seekRel(e.shiftKey ? -5 : -1); }
      else if (e.code === 'ArrowRight') { e.preventDefault(); seekRel(e.shiftKey ?  5 :  1); }
    });

    const resizer = document.getElementById('resizer');
    const sidePanel = document.querySelector('.side-panel');
    let isResizing = false;
    resizer.addEventListener('mousedown', e => {
      isResizing = true; resizer.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });
    document.addEventListener('mousemove', e => {
      if (!isResizing) return;
      // 拖动改右侧栏宽度（左侧逐字稿 flex 自适应）
      const rect = document.querySelector('.stage').getBoundingClientRect();
      const newWidth = Math.max(300, Math.min(rect.right - e.clientX, rect.width - 360));
      sidePanel.style.width = newWidth + 'px';
    });
    document.addEventListener('mouseup', () => {
      if (!isResizing) return;
      isResizing = false; resizer.classList.remove('dragging');
      document.body.style.cursor = ''; document.body.style.userSelect = '';
    });

    // ── 波形高度：可拖拽 + 随视口自适应（小屏也保证 stage 不被挤没）──
    const WAVE_H_MIN = 70;
    const WAVE_H_KEY = 'reviewWaveH';
    // dock 内除波形外的固定占用（标尺 + 状态栏 + padding）+ 顶栏 + stage 最小高度
    function waveHMax() {
      return Math.max(WAVE_H_MIN, window.innerHeight - 64 /*topbar*/ - 64 /*dock chrome*/ - 200 /*min stage*/);
    }
    function clampWaveH(h) {
      return Math.max(WAVE_H_MIN, Math.min(h, waveHMax()));
    }
    function setWaveH(h, persist) {
      const v = Math.round(clampWaveH(h));
      document.documentElement.style.setProperty('--wave-h', v + 'px');
      if (persist) { try { localStorage.setItem(WAVE_H_KEY, v); } catch (e) {} }
      // ResizeObserver(cv) 会接住高度变化并重绘，无需手动 redraw
    }
    const curWaveH = () => parseInt(getComputedStyle(document.documentElement).getPropertyValue('--wave-h'), 10) || 132;
    (function initWaveResize() {
      const stored = parseInt(localStorage.getItem(WAVE_H_KEY) || '', 10);
      setWaveH(Number.isFinite(stored) ? stored : 132, false);

      const handle = document.getElementById('dockResizer');
      let dragH = null;
      handle.addEventListener('mousedown', e => {
        dragH = { y0: e.clientY, h0: curWaveH() };
        handle.classList.add('dragging');
        document.body.style.cursor = 'row-resize';
        document.body.style.userSelect = 'none';
        e.preventDefault();
      });
      document.addEventListener('mousemove', e => {
        if (!dragH) return;
        // 手柄在 dock 顶部：往上拖 = 变高
        setWaveH(dragH.h0 + (dragH.y0 - e.clientY), false);
      });
      document.addEventListener('mouseup', () => {
        if (!dragH) return;
        dragH = null;
        handle.classList.remove('dragging');
        document.body.style.cursor = ''; document.body.style.userSelect = '';
        setWaveH(curWaveH(), true); // 落地时持久化
      });
      // 视口变化时重新夹紧（换显示器 / 缩放窗口都会触发）
      window.addEventListener('resize', () => setWaveH(curWaveH(), false));
    })();
  
