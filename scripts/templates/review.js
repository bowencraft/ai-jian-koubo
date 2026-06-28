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

    // 波形 / 切割预览数据
    let peaksData = null;          // { duration, sampleRate, peaks:[0..1] }
    let silencePeriods = [];       // ffmpeg 检测的静音段
    let cutOpts = {                // 切割参数（与 lib/compute_keeps.js 默认一致，可被滑块覆盖）
      lookBack: 0.6, padStart: 2 / 30, padEnd: 2 / 30, minInternalSilence: 0.2
    };

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
        currentProjectSignature = draftResp && draftResp.projectSignature ? draftResp.projectSignature : null;
        renderProjectSummary(projectResp && projectResp.project);
        const restored = applyDraft(draftResp && draftResp.draft);

        initWave();

        // 顶栏文件元信息
        document.getElementById('fileSub').innerHTML =
          `REVIEW <span class="dot">●</span> ${aiSelectedIds.size} 处 AI 预选${restored ? ' <span class="dot">●</span> 已恢复草稿' : ''}`;

        loadingOverlay.classList.remove('show');
        clearInterval(msgTimer);
        render();
        initKnobs();
        initThemeSwitcher();
      })
      .catch(err => {
        clearInterval(msgTimer);
        document.getElementById('loadingLabel').textContent = '数据加载失败';
        document.getElementById('loadingTime').textContent = err.message;
      });

    function renderProjectSummary(project) {
      const el = document.getElementById('projectSummary');
      if (!el || !project || !Array.isArray(project.assets) || !Array.isArray(project.clips)) return;
      const trackCount = project.clips.reduce((max, clip) => Math.max(max, Number(clip.trackIndex || clip.lane || 0) + 1), 0);
      el.textContent = `多轨 ${project.assets.length} 素材 / ${trackCount || 1} 轨`;
      renderProjectTracks(project, trackCount || 1);
    }

    function renderProjectTracks(project, trackCount) {
      const root = document.getElementById('projectTracks');
      if (!root) return;
      const duration = Math.max(
        words.reduce((max, w) => Math.max(max, Number(w.end) || 0), 0),
        project.clips.reduce((max, clip) => Math.max(max, Number(clip.timelineStart || 0) + Number(clip.duration || 0)), 0),
        1
      );
      const assets = new Map(project.assets.map(asset => [asset.id, asset]));
      const rows = [];
      for (let t = 0; t < trackCount; t++) {
        const clips = project.clips
          .filter(clip => Number(clip.trackIndex || clip.lane || 0) === t)
          .map(clip => {
            const asset = assets.get(clip.assetId) || { name: 'missing', kind: 'audio' };
            const leftPct = (Number(clip.timelineStart || 0) / duration) * 100;
            const widthPct = Math.max(1, (Number(clip.duration || 0) / duration) * 100);
            const kind = asset.kind === 'video' || asset.hasVideo ? 'video' : 'audio';
            return `<div class="project-clip ${kind}" style="left:calc(68px + ${leftPct}%);width:calc(${widthPct}% - 2px)">${asset.name || asset.id}</div>`;
          }).join('');
        rows.push(`<div class="project-track"><div class="project-track-label">轨 ${t + 1}</div>${clips}</div>`);
      }
      root.innerHTML = rows.join('');
      root.style.display = rows.length ? 'block' : 'none';
    }

    function togglePlay()  { clearPreview(); video.paused ? video.play() : video.pause(); }
    function setSpeed(v)   { video.playbackRate = v; }
    function seekRel(d)    { clearPreview(); video.currentTime = Math.max(0, video.currentTime + d); }

    // ============================================================
    // 波形渲染器（自绘 canvas）：视口窗口化渲染，长视频也顺滑
    // 叠加三色带：灰=静音 / 红=选中删除 / 黄=算法额外切掉（吸附+内部静音二次切）
    // ============================================================
    // 波形配色主题（可在时间线右下角实时切换，选择存 localStorage）
    const WAVE_THEMES = {
      cool: {
        name: '冷调蓝白',
        bg: '#0E0E13', wave: '#8CA0C8', center: '#23252E', silence: 'rgba(44,46,54,0.9)',
        del: 'rgba(248,113,113,0.40)', delEdge: 'rgba(248,113,113,0.95)',
        cut: 'rgba(255,193,7,0.40)', cutEdge: 'rgba(255,193,7,0.98)', head: '#FF7A4D'
      },
      mint: {
        name: '薄荷青',
        bg: '#0D0F0E', wave: '#5EEAD4', center: '#1F2826', silence: 'rgba(40,48,46,0.9)',
        del: 'rgba(251,113,133,0.40)', delEdge: 'rgba(251,113,133,0.95)',
        cut: 'rgba(251,146,60,0.42)', cutEdge: 'rgba(251,146,60,0.98)', head: '#FB7185'
      },
      recut: {
        name: 'Recut 暖灰',
        bg: '#1A1917', wave: '#A89F90', center: '#2A2823', silence: 'rgba(52,50,46,0.92)',
        del: 'rgba(248,113,113,0.42)', delEdge: 'rgba(248,113,113,0.92)',
        cut: 'rgba(251,191,36,0.42)', cutEdge: 'rgba(251,191,36,0.96)', head: '#FF7A4D'
      },
      outline: {
        name: '石墨霓虹·描边',
        bg: '#101014', wave: '#B7BCC9', center: '#26262C', silence: 'rgba(42,42,48,0.9)',
        del: 'rgba(248,113,113,0.16)', delEdge: 'rgba(248,113,113,1)',
        cut: 'rgba(255,212,59,0.16)', cutEdge: 'rgba(255,212,59,1)', head: '#FF7A4D'
      }
    };
    const WAVE_THEME_KEY = 'reviewWaveTheme';
    let COL = WAVE_THEMES.cool;
    (function () {
      const saved = localStorage.getItem(WAVE_THEME_KEY);
      if (saved && WAVE_THEMES[saved]) COL = WAVE_THEMES[saved];
    })();

    const wave = (function () {
      let cv, ctx, buf, bctx, rcv, rctx, dpr = 1;
      let cssW = 0, cssH = 132, rulerH = 20;
      let duration = 0;
      let pxPerSec = 1, viewStart = 0;
      let staticDirty = true, lastKey = '';
      let cutsDirty = true; // 切割几何（选段/参数）是否需要重算；与视口平移/缩放无关
      let deleteSegs = [], extraCuts = [];
      let drag = null;
      let gain = 1; // 波形归一化增益：把全局峰值拉到接近满高（像剪映/FCP 那样自适应填满）
      const ZOOM_MAX = 400; // 相对 fit 的最大放大倍数

      // 计算归一化增益：全局最大峰值映射到 ~0.92 半高；安静录音也能填满面板
      function computeGain() {
        const pk = peaksData ? peaksData.peaks : null;
        let mx = 0;
        if (pk) for (let i = 0; i < pk.length; i++) if (pk[i] > mx) mx = pk[i];
        gain = mx > 0.0001 ? 0.92 / mx : 1;
      }

      const timeToX = (t) => (t - viewStart) * pxPerSec;
      const xToTime = (x) => viewStart + x / pxPerSec;
      const viewDur = () => cssW / pxPerSec;
      const fitPxPerSec = () => (duration > 0 ? cssW / duration : 1);

      function clampView() {
        const vd = viewDur();
        if (vd >= duration) { viewStart = 0; return; }
        viewStart = Math.max(0, Math.min(viewStart, duration - vd));
      }

      function recompute() {
        deleteSegs = getDeleteSegments();
        if (typeof ComputeKeeps !== 'undefined') {
          const keeps = ComputeKeeps.computeFinalKeeps(deleteSegs, silencePeriods, duration, cutOpts);
          const cuts = ComputeKeeps.keepsToCuts(keeps, duration);
          extraCuts = ComputeKeeps.intervalSubtract(cuts, deleteSegs); // 用户没选、却被算法切掉的部分
          // 状态栏：总时长 / 剪后
          let finalDur = 0;
          for (const k of keeps) finalDur += (k.end - k.start);
          const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
          set('tl-total', formatTime(duration));
          set('tl-final', formatTime(finalDur));
        } else { extraCuts = []; }
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

      function peakAt(i0, i1, peaks, n) {
        let m = 0;
        const a = Math.max(0, i0 | 0), b = Math.min(n - 1, i1 | 0);
        for (let i = a; i <= b; i++) if (peaks[i] > m) m = peaks[i];
        return m;
      }

      function buildStatic() {
        bctx.clearRect(0, 0, cssW, cssH);
        bctx.fillStyle = COL.bg; bctx.fillRect(0, 0, cssW, cssH);
        const mid = cssH / 2;

        // 静音带（最底层）
        bctx.fillStyle = COL.silence;
        for (const sp of silencePeriods) {
          const x0 = timeToX(sp.start), x1 = timeToX(sp.end);
          if (x1 < 0 || x0 > cssW) continue;
          bctx.fillRect(x0, 0, Math.max(1, x1 - x0), cssH);
        }

        // 波形：填充镜像包络（替代逐像素硬竖条，贴近剪映/FCP 观感）
        const peaks = peaksData ? peaksData.peaks : null;
        const n = peaks ? peaks.length : 0;
        if (peaks && n > 1 && duration > 0) {
          const samplesPerSec = n / duration;
          const maxH = cssH - 6;
          // 1) 逐像素求幅值：样本多→取峰（包络）；样本少→线性插值（消除放大时的阶梯）
          const amp = new Float32Array(cssW);
          for (let x = 0; x < cssW; x++) {
            const sa = xToTime(x) * samplesPerSec, sb = xToTime(x + 1) * samplesPerSec;
            if (sb - sa >= 1) {
              amp[x] = peakAt(sa, sb, peaks, n);
            } else {
              const f = Math.max(0, Math.min(n - 1, (sa + sb) / 2));
              const i = f | 0, fr = f - i;
              amp[x] = (peaks[i] || 0) * (1 - fr) + (peaks[Math.min(n - 1, i + 1)] || 0) * fr;
            }
          }
          // 2) 描出上沿（左→右）再回描下沿（右→左），填成镜像包络。
          //    hAt(x) 现算 3-tap 平滑（消尖刺）+ 全局增益归一化再限幅，省掉一条整长数组和一趟循环。
          const hAt = (x) => {
            const a = x > 0 ? amp[x - 1] : amp[x];
            const c = x < cssW - 1 ? amp[x + 1] : amp[x];
            const v = (a + amp[x] * 2 + c) / 4;
            return Math.max(0.6, Math.min(1, v * gain) * maxH / 2);
          };
          bctx.fillStyle = COL.wave;
          bctx.beginPath();
          bctx.moveTo(0, mid - hAt(0));
          for (let x = 1; x < cssW; x++) bctx.lineTo(x, mid - hAt(x));
          for (let x = cssW - 1; x >= 0; x--) bctx.lineTo(x, mid + hAt(x));
          bctx.closePath();
          bctx.fill();
        } else {
          bctx.fillStyle = COL.center;
          bctx.fillRect(0, mid - 0.5, cssW, 1);
        }

        // 删除带（红）
        drawBand(deleteSegs, COL.del, COL.delEdge);
        // 额外切掉（黄）—— 这正是「把你该说的话切掉」的高危区
        drawBand(extraCuts, COL.cut, COL.cutEdge);
      }

      function drawBand(segs, fill, edge) {
        for (const s of segs) {
          const x0 = timeToX(s.start), x1 = timeToX(s.end);
          if (x1 < 0 || x0 > cssW) continue;
          const w = Math.max(1.5, x1 - x0);
          bctx.fillStyle = fill; bctx.fillRect(x0, 0, w, cssH);
          bctx.fillStyle = edge;
          bctx.fillRect(x0, 0, 1.5, cssH);
          bctx.fillRect(x0 + w - 1.5, 0, 1.5, cssH);
        }
      }

      function draw(t) {
        if (!ctx) return;
        // 播放跟随：playhead 越过右侧 85% 时把视图前移到 15% 处（仅放大时）
        if (!video.paused && pxPerSec > fitPxPerSec() + 1e-6) {
          const x = timeToX(t);
          if (x > cssW * 0.85 || x < 0) { viewStart = t - viewDur() * 0.15; clampView(); staticDirty = true; }
        }
        // 切割几何只在选段/参数变化时重算；平移缩放只需重画静态层
        if (cutsDirty) { recompute(); cutsDirty = false; }
        const key = viewStart.toFixed(3) + '|' + pxPerSec.toFixed(3);
        if (staticDirty || key !== lastKey) { buildStatic(); drawRuler(); syncZoomSlider(); lastKey = key; staticDirty = false; }

        ctx.clearRect(0, 0, cssW, cssH);
        ctx.drawImage(buf, 0, 0, cssW, cssH);

        // 播放头
        const hx = timeToX(t);
        if (hx >= 0 && hx <= cssW) {
          ctx.fillStyle = COL.head;
          ctx.fillRect(hx - 0.5, 0, 1.5, cssH);
          ctx.beginPath(); ctx.arc(hx, 4, 3, 0, Math.PI * 2); ctx.fill();
        }
      }

      function markDirty() { staticDirty = true; cutsDirty = true; if (ctx && video.paused) draw(video.currentTime); }
      function redraw() { staticDirty = true; cutsDirty = true; draw(video.currentTime); }

      function zoom(factor, anchorT) {
        const at = (anchorT == null) ? video.currentTime : anchorT;
        const fit = fitPxPerSec();
        const next = Math.max(fit, Math.min(pxPerSec * factor, fit * 400));
        if (next === pxPerSec) return;
        const ax = timeToX(at);
        pxPerSec = next;
        viewStart = at - ax / pxPerSec; // 锚点时间保持在原屏幕位置
        clampView(); redraw();
      }
      function fit() { pxPerSec = fitPxPerSec(); viewStart = 0; redraw(); }

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
        const ax = timeToX(at);
        pxPerSec = next;
        viewStart = at - ax / pxPerSec;
        clampView(); redraw();
      }

      function init() {
        cv = document.getElementById('waveCanvas');
        rcv = document.getElementById('rulerCanvas');
        buf = document.createElement('canvas');
        ctx = cv.getContext('2d');
        bctx = buf.getContext('2d');
        rctx = rcv ? rcv.getContext('2d') : null;
        duration = (peaksData && peaksData.duration) || video.duration || 0;
        computeGain();
        layout();
        pxPerSec = fitPxPerSec();
        viewStart = 0;

        new ResizeObserver(() => { layout(); clampView(); draw(video.currentTime); }).observe(cv);
        video.addEventListener('loadedmetadata', () => {
          if (!duration) { duration = video.duration || 0; fit(); }
        });

        // 滚轮缩放（以光标处时间为锚点）
        cv.addEventListener('wheel', (e) => {
          e.preventDefault();
          const r = cv.getBoundingClientRect();
          zoom(e.deltaY < 0 ? 1.15 : 1 / 1.15, xToTime(e.clientX - r.left));
        }, { passive: false });

        // 按下：拖动平移；未移动则点击跳转
        cv.addEventListener('mousedown', (e) => {
          const r = cv.getBoundingClientRect();
          drag = { x0: e.clientX - r.left, vs0: viewStart, moved: false };
          e.preventDefault();
        });
        window.addEventListener('mousemove', (e) => {
          if (!drag) return;
          const r = cv.getBoundingClientRect();
          const dx = (e.clientX - r.left) - drag.x0;
          if (Math.abs(dx) > 3) drag.moved = true;
          if (drag.moved && pxPerSec > fitPxPerSec() + 1e-6) {
            viewStart = drag.vs0 - dx / pxPerSec; clampView(); redraw();
          }
        });
        window.addEventListener('mouseup', (e) => {
          if (!drag) return;
          if (!drag.moved) {
            const r = cv.getBoundingClientRect();
            const t = Math.max(0, Math.min(duration, xToTime(e.clientX - r.left)));
            clearPreview();
            video.currentTime = t;
          }
          drag = null;
        });

        // 缩放滑块
        const sl = slider();
        if (sl) sl.addEventListener('input', () => setZoomFrac(parseInt(sl.value, 10) / 1000));

        draw(0);
      }

      return { init, draw, markDirty, redraw, zoom, fit };
    })();

    function initWave() { wave.init(); }
    function waveZoom(f) { wave.zoom(f); }
    function waveZoomFit() { wave.fit(); }

    // 波形配色：实时切换 + 同步图例色块 + 持久化
    function applyWaveTheme(key, persist) {
      if (!WAVE_THEMES[key]) return;
      COL = WAVE_THEMES[key];
      const setSw = (id, c) => { const el = document.getElementById(id); if (el) el.style.background = c; };
      setSw('lg-silence', COL.silence);
      setSw('lg-del', COL.delEdge);
      setSw('lg-cut', COL.cutEdge);
      if (persist) { try { localStorage.setItem(WAVE_THEME_KEY, key); } catch (e) {} }
      if (typeof wave !== 'undefined') wave.redraw(); // redraw 已重建静态层，无需再 markDirty
    }
    function initThemeSwitcher() {
      const sel = document.getElementById('themeSelect');
      if (!sel) return;
      const current = localStorage.getItem(WAVE_THEME_KEY) || 'cool';
      sel.innerHTML = Object.keys(WAVE_THEMES)
        .map(k => `<option value="${k}"${k === current ? ' selected' : ''}>${WAVE_THEMES[k].name}</option>`)
        .join('');
      sel.addEventListener('change', () => applyWaveTheme(sel.value, true));
      applyWaveTheme(current, false); // 同步图例色块到当前主题
    }

    // 切割参数滑块：实时重算波形上的「额外切掉」预览，并在导出时一并发给 server
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

    async function exportFCPXML() {
      const segments = getDeleteSegments();
      if (!segments.length) { alert('没有选中任何片段'); return; }
      // 把「你最终选中的词级 idx」一并送给服务器，供自进化学习写 review_log.json。
      // selected 里是 'word-<idx>'，提取数字、升序；服务器再 diff AI 初选 vs 你最终。
      const finalSelected = getSelectedIdx();
      try {
        const res = await fetch('/api/fcpxml', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ deleteList: segments, opts: cutOpts, finalSelected })
        });
        const data = await res.json();
        if (data.success) {
          const fileName = data.output.split('/').pop();
          const dlRes = await fetch('/api/download/' + encodeURIComponent(data.output));
          const blob = await dlRes.blob();
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = fileName;
          a.click();
          URL.revokeObjectURL(url);
          alert(`✅ FCPXML 已导出\n\n📁 文件: ${fileName}\n🎬 保留片段: ${data.segments} 个\n\n直接拖入 Final Cut Pro 即可`);
        } else {
          alert('❌ 导出失败: ' + data.error);
        }
      } catch (err) {
        alert('❌ 请求失败: ' + err.message + '\n\n请确保使用 review_server.js 启动服务');
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
  