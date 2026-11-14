(function () {
  'use strict';
  const G = window.HigherDegreeGeometry;
  const $ = id => document.getElementById(id);
  const canvas = $('editor'), context = canvas.getContext('2d'), container = $('canvas-container');
  const storageKey = 'higher-degree-glyph.draft.v3';
  let doc = G.sampleDocument(), restored = false, storageAvailable = true;
  try {
    const draft = localStorage.getItem(storageKey) || localStorage.getItem('quartic-glyph.draft.v1');
    if (draft) { doc = G.validateDocument(JSON.parse(draft)); restored = true; }
  } catch (_) { storageAvailable = false; }
  const uiFontStack = 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif';
  const legacyNotoFontStack = '"Noto Sans Symbols 2", "Microsoft YaHei", sans-serif';
  const defaults = { theme: 'system', palette: 'violet', contrast: false, fontFamily: uiFontStack, historyLimit: 100, persistHistory: true, pageSize: '60', wheelMode: 'wheel', invertWheel: false, closedHistoryKeys: [], shortcuts: { select: 'v', component: 'a', pen: 'p', line: 'l', knife: 'k' } };
  let preferences = { ...defaults };
  try { preferences = { ...defaults, ...JSON.parse(localStorage.getItem('higher-degree-glyph.preferences.v4') || '{}') }; preferences.shortcuts = { ...defaults.shortcuts, ...(preferences.shortcuts || {}) }; } catch (_) {}
  const state = { tool: 'select', selected: new Set(), contourId: doc.contours[0]?.id || null,
    segment: null, components: new Set(), grid: true, snap: false, snapNodes: true, snapEdges: false, gridStep: 10, precision: 2, snapHint: null, handles: true, fill: false, space: false,
    view: { x: 0, y: 0, scale: 1 }, fitMode: true, width: 1, height: 1, dpr: 1, pointer: null,
    drawing: null, pending: [], maxControls: null, frameMode: 'scale', anchor: 'center', pivot: null, selectionSignature: '', lockAspect: false, constraintGuide: null, drag: null, history: [], future: [] };
  if (!restored && doc.contours[0]) {
    state.segment = { contourId: doc.contours[0].id, index: 4 };
    state.selected.add(doc.contours[0].segments[4].controls[1].id);
  }
  let scheduled = false, saveTimer = null, toastTimer = null, exportResult = null, clipboard = null, clickTimer = null;
  if (!['system', 'light', 'dark'].includes(preferences.theme)) preferences.theme = defaults.theme;
  if (!['violet', 'blue', 'amber', 'mint'].includes(preferences.palette)) preferences.palette = defaults.palette;
  if (!Number.isFinite(Number(preferences.historyLimit))) preferences.historyLimit = defaults.historyLimit;
  preferences.historyLimit = Math.max(10, Math.min(1000, Math.round(Number(preferences.historyLimit))));
  if (!['30', '60', '100', '200', 'all'].includes(String(preferences.pageSize))) preferences.pageSize = defaults.pageSize;
  if (!['wheel', 'ctrl'].includes(preferences.wheelMode)) preferences.wheelMode = defaults.wheelMode;
  preferences.invertWheel = !!preferences.invertWheel;
  if (typeof preferences.fontFamily !== 'string' || preferences.fontFamily.length > 240 || /[;{}<>]/.test(preferences.fontFamily)) preferences.fontFamily = defaults.fontFamily;
  if (preferences.fontFamily === legacyNotoFontStack) preferences.fontFamily = defaults.fontFamily;
  preferences.contrast = !!preferences.contrast; preferences.persistHistory = preferences.persistHistory !== false;
  if (!Array.isArray(preferences.closedHistoryKeys)) preferences.closedHistoryKeys = [];
  for (const key of Object.keys(defaults.shortcuts)) if (!/^[a-z]$/i.test(preferences.shortcuts[key] || '')) preferences.shortcuts[key] = defaults.shortcuts[key];
  let project = null, libraryPage = 0, pageSize = preferences.pageSize, switchToken = 0, cubicMode = 'cubic', cubicResult = null, projectExportBusy = false, standaloneSession = null;
  let standaloneHistoryId = 'draft:' + (doc.glyph.unicode || doc.glyph.name), timeline = null, historyDb = null, historyGeneration = 0, libraryHydrating = false;
  try { standaloneHistoryId = localStorage.getItem('higher-degree-glyph.history-key.v1') || standaloneHistoryId; } catch (_) {}
  function setStandaloneHistoryId(value) { standaloneHistoryId = value; try { localStorage.setItem('higher-degree-glyph.history-key.v1', value); } catch (_) {} }
  setStandaloneHistoryId(standaloneHistoryId);
  const historyDbPromise = new Promise(resolve => {
    if (!('indexedDB' in window)) { resolve(null); return; }
    const request = indexedDB.open('higher-degree-glyph-history', 1);
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains('files')) request.result.createObjectStore('files', { keyPath: 'key' }); };
    request.onsuccess = () => { historyDb = request.result; resolve(historyDb); };
    request.onerror = () => resolve(null);
  });
  function projectHistoryPrefix() {
    return project ? `folder:${project.name}/` : '';
  }
  const historyKey = () => project?.activeId ? projectHistoryPrefix() + project.activeId : standaloneHistoryId;
  function applyPreferences() {
    const root = document.documentElement;
    const dark = preferences.theme === 'dark' || preferences.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches;
    document.body.dataset.theme = dark ? 'dark' : 'light'; document.body.dataset.palette = preferences.palette || 'violet';
    document.body.dataset.contrast = preferences.contrast ? 'high' : 'normal';
    root.style.setProperty('--ui-font', preferences.fontFamily || defaults.fontFamily);
    $('library-page-size').value = pageSize; $('pref-page-size').value = pageSize;
    $('pref-wheel-mode').value = preferences.wheelMode; $('pref-wheel-invert').checked = preferences.invertWheel;
    const labels = { select: 'V', component: 'A', pen: 'P', line: 'L', knife: 'K' };
    document.querySelectorAll('[data-tool]').forEach(button => { const tool = button.dataset.tool, key = preferences.shortcuts[tool] || labels[tool]; const mark = button.querySelector('span'); if (mark && key) mark.textContent = key.toUpperCase(); });
    document.querySelectorAll('[data-help-shortcut]').forEach(mark => { const key = preferences.shortcuts[mark.dataset.helpShortcut]; if (key) mark.textContent = key.toUpperCase(); });
  }
  function storePreferences() {
    try { localStorage.setItem('higher-degree-glyph.preferences.v4', JSON.stringify(preferences)); } catch (_) {}
    savePreferences(); applyPreferences();
  }
  function dbRequest(mode, action) {
    return historyDbPromise.then(db => new Promise((resolve, reject) => {
      if (!db) return resolve(null);
      const tx = db.transaction('files', mode), store = tx.objectStore('files'); let request;
      try { request = action(store); } catch (error) { reject(error); return; }
      tx.oncomplete = () => resolve(request?.result ?? null); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
    }));
  }
  async function writeTimeline() {
    if (!timeline || !preferences.persistHistory || preferences.closedHistoryKeys.includes(timeline.key)) return;
    try { await dbRequest('readwrite', store => store.put(timeline)); } catch (_) { toast('本地历史写入失败；请检查浏览器存储空间', true); }
  }
  function loadTimelineIntoState() {
    if (!timeline) return;
    state.history = timeline.items.slice(0, timeline.cursor).map(item => G.clone(item.doc));
    state.future = timeline.items.slice(timeline.cursor + 1).map(item => G.clone(item.doc)).reverse();
    doc = G.clone(timeline.items[timeline.cursor].doc);
  }
  async function activateHistory(key, fallback = doc) {
    const owner = project, token = switchToken, generation = historyGeneration;
    let saved = null;
    if (preferences.persistHistory) { try { saved = await dbRequest('readonly', store => store.get(key)); } catch (_) {} }
    if (token !== switchToken || owner !== project || generation !== historyGeneration) return;
    timeline = saved?.items?.length ? saved : { key, label: key.split('/').at(-1), items: [{ doc: G.clone(fallback), label: '打开字形', time: Date.now() }], cursor: 0 };
    timeline.cursor = Math.max(0, Math.min(timeline.cursor, timeline.items.length - 1));
    loadTimelineIntoState();
    const entry = project?.activeId && project.byPath.get(project.activeId);
    if (entry) { entry.history = state.history; entry.future = state.future; entry.doc = G.clone(doc); entry.modified = G.serialize(doc) !== entry.baseline; }
    await writeTimeline(); update(); renderLibrary(); renderHistory();
  }
  try {
    const prefs = JSON.parse(localStorage.getItem('higher-degree-glyph.preferences.v3') || localStorage.getItem('quartic-glyph.preferences.v2') || '{}');
    if (Number.isFinite(prefs.gridStep) && prefs.gridStep >= .001 && prefs.gridStep <= 10000) state.gridStep = prefs.gridStep;
    if ([-1, 0, 1, 2, 3, 4, 6].includes(prefs.precision)) state.precision = prefs.precision;
    for (const key of ['snap', 'snapNodes', 'snapEdges']) if (typeof prefs[key] === 'boolean') state[key] = prefs[key];
    if (Number.isSafeInteger(prefs.maxControls) && prefs.maxControls >= 0) state.maxControls = prefs.maxControls;
    if (G.anchorPositions[prefs.anchor]) state.anchor = prefs.anchor;
  } catch (_) {}
  const activeContour = () => doc.contours.find(c => c.id === state.contourId);
  const selectedPoint = () => state.selected.size === 1 ? G.allPoints(doc).find(p => state.selected.has(p.point.id)) : null;
  function selectedSegment() {
    if (!state.segment) return null;
    const contour = doc.contours.find(c => c.id === state.segment.contourId);
    return contour?.segments[state.segment.index] ? { contour, index: state.segment.index, segment: contour.segments[state.segment.index] } : null;
  }
  const screen = p => ({ x: state.view.x + p.x * state.view.scale, y: state.view.y - p.y * state.view.scale });
  const fontPoint = p => ({ x: (p.x - state.view.x) / state.view.scale, y: (state.view.y - p.y) / state.view.scale });
  function selectionFrame() {
    if (!['select', 'component'].includes(state.tool)) return null;
    const entries = movablePoints(); if (entries.length < 2) return null;
    const bounds = G.pointBounds(entries.map(p => p.point));
    return { entries, bounds, reference: G.frameReference(bounds, state.anchor), origin: state.drag?.type === 'frame' ? state.drag.origin : state.pivot || G.frameReference(bounds, state.anchor) };
  }
  function frameHandles(frame) {
    return Object.entries(G.anchorPositions).filter(([key]) => key !== 'center').map(([key, [u, v]]) => {
      let p = G.frameReference(frame.bounds, key);
      if (state.drag?.type === 'frame' && state.drag.matrix) p = G.affinePoint(G.frameReference(state.drag.bounds, key), state.drag.matrix);
      const q = screen(p); return { key, point: p, screen: { x: q.x + (u - .5) * 20, y: q.y - (v - .5) * 20 } };
    });
  }
  function hitFrame(q) {
    const frame = selectionFrame(); if (!frame) return null;
    if (state.frameMode === 'rotate' && G.distance(screen(frame.origin), q) <= 8) return { frame, key: 'pivot' };
    const handle = frameHandles(frame).find(h => G.distance(h.screen, q) < 8);
    return handle ? { frame, ...handle } : null;
  }
  function insideFrame(q, frame = selectionFrame()) {
    if (!frame) return false;
    const p = fontPoint(q), b = frame.bounds, padding = 9 / state.view.scale;
    return p.x >= b.minX - padding && p.x <= b.maxX + padding && p.y >= b.minY - padding && p.y <= b.maxY + padding;
  }
  function changeFrameMode(mode) { state.frameMode = mode; update(); setStatus(mode === 'scale' ? '拉伸缩放：拖动角或边手柄；Shift 等比' : '旋转倾斜：角手柄旋转，边手柄倾斜；中心可拖动'); }
  function drawFrame() {
    const frame = selectionFrame(); if (!frame) return;
    const ctx = context, handles = frameHandles(frame), corners = ['nw', 'ne', 'se', 'sw'].map(k => handles.find(h => h.key === k).screen);
    ctx.save(); ctx.strokeStyle = state.frameMode === 'scale' ? '#9672c7' : '#c28a51'; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
    ctx.beginPath(); corners.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.closePath(); ctx.stroke(); ctx.setLineDash([]);
    for (const h of handles) {
      ctx.fillStyle = '#fff'; ctx.beginPath();
      if (state.frameMode === 'rotate') { ctx.arc(h.screen.x, h.screen.y, h.key.length === 2 ? 4.5 : 3.5, 0, Math.PI * 2); }
      else ctx.rect(h.screen.x - 3.5, h.screen.y - 3.5, 7, 7);
      ctx.fill(); ctx.stroke();
      if (state.frameMode === 'rotate' && h.key.length === 1) {
        const x = h.screen.x, y = h.screen.y, horizontal = h.key === 'n' || h.key === 's';
        line(ctx, { x: x - (horizontal ? 9 : 0), y: y - (horizontal ? 0 : 9) }, { x: x + (horizontal ? 9 : 0), y: y + (horizontal ? 0 : 9) });
      }
    }
    const center = screen(frame.origin); ctx.strokeStyle = '#b47a42'; ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(center.x, center.y, 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    line(ctx, { x: center.x - 9, y: center.y }, { x: center.x + 9, y: center.y }); line(ctx, { x: center.x, y: center.y - 9 }, { x: center.x, y: center.y + 9 });
    ctx.font = '10px sans-serif'; ctx.fillStyle = state.frameMode === 'scale' ? '#9672c7' : '#b4814f';
    ctx.fillText(state.frameMode === 'scale' ? '拉伸 / 缩放' : '角：旋转 · 边：倾斜', corners[0].x, corners[0].y - 12); ctx.restore();
  }
  const rounded = value => Number(value.toFixed(state.precision < 0 ? 8 : state.precision));
  function snapPoint(p, event = {}, exclude = new Set(), showHint = true) {
    const hit = G.snapPosition(doc, p, { nodes: state.snapNodes && !event.altKey, edges: state.snapEdges && !event.altKey, grid: state.snap && !event.altKey, gridStep: state.gridStep, precision: state.precision, radius: 8 / state.view.scale, exclude });
    if (showHint) state.snapHint = hit.hint;
    return hit.point;
  }
  function savePreferences() {
    try { localStorage.setItem('higher-degree-glyph.preferences.v3', JSON.stringify({ ...Object.fromEntries(['snap', 'snapNodes', 'snapEdges', 'gridStep', 'precision', 'maxControls', 'anchor'].map(k => [k, state[k]])), ...preferences })); } catch (_) {}
  }
  const members = contour => contour.component ? doc.contours.filter(c => c.component === contour.component) : [contour];
  function newComponentId() { let id; do { id = 'component-' + G.uid(); } while (doc.contours.some(c => c.component === id)); return id; }
  const selectedContours = () => doc.contours.filter(c => state.components.has(c.id) || c.nodes.length && c.nodes.every(p => state.selected.has(p.id)));
  function selectContours(contours, additive = false) {
    if (!additive) { state.components.clear(); state.selected.clear(); }
    for (const c of contours) { state.components.add(c.id); G.allPoints({ contours: [c] }).forEach(({ point: p }) => state.selected.add(p.id)); }
    state.contourId = contours[0]?.id || state.contourId; state.segment = null;
  }
  const eventPoint = event => { const r = canvas.getBoundingClientRect(); return { x: event.clientX - r.left, y: event.clientY - r.top }; };
  function toast(message, error = false) {
    $('toast').textContent = message; $('toast').classList.toggle('error', error); $('toast').hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, error ? 5500 : 3000);
  }
  function setStatus(message) { $('status-text').textContent = message; }
  function renderHistory() {
    if (!timeline || !$('history-list')) return;
    const list = $('history-list'), limit = Math.max(10, Number(preferences.historyLimit) || 100); list.replaceChildren();
    const first = Math.max(0, timeline.items.length - limit - 1);
    for (let i = timeline.items.length - 1; i >= first; i--) {
      const item = timeline.items[i], li = document.createElement('li'), button = document.createElement('button');
      button.className = i === timeline.cursor ? 'current' : ''; button.type = 'button';
      button.textContent = item.label + ' · ' + new Date(item.time).toLocaleTimeString();
      button.title = new Date(item.time).toLocaleString(); button.onclick = () => {
        if (i === timeline.cursor) return;
        timeline.cursor = i; loadTimelineIntoState(); finishDrawing(); state.selected.clear(); state.components.clear(); state.segment = null;
        state.history = timeline.items.slice(0, i).map(entry => G.clone(entry.doc));
        state.future = timeline.items.slice(i + 1).map(entry => G.clone(entry.doc)).reverse();
        persist(); renderHistory(); writeTimeline(); update(); setStatus('已跳转到历史步骤');
      };
      li.append(button); list.append(li);
    }
    $('history-limit').value = preferences.historyLimit;
  }
  async function renderHistoryManager() {
    const list = $('history-records'); list.replaceChildren();
    const entries = await dbRequest('readonly', store => store.getAll()) || [];
    for (const entry of entries) {
      const label = document.createElement('label'); label.className = 'history-record-row';
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.value = entry.key;
      const text = document.createElement('span'); text.textContent = `${entry.label || entry.key} · ${(entry.items || []).length} 步 · ${new Date(entry.items?.at(-1)?.time || 0).toLocaleDateString()}${preferences.closedHistoryKeys.includes(entry.key) ? ' · 已暂停' : ''}`;
      label.append(checkbox, text); list.append(label);
    }
    if (!entries.length) list.textContent = '没有已保存的历史记录';
  }
  function setPageSize(value, warn = true) {
    if (value === 'all' && project?.entries.length > 1000 && warn && !window.confirm(`此文件夹有 ${project.entries.length} 个字形。单列表可能影响性能，仍要显示全部吗？`)) {
      $('library-page-size').value = pageSize; $('pref-page-size').value = pageSize; return;
    }
    pageSize = value; preferences.pageSize = value; libraryPage = 0; storePreferences(); renderLibrary();
  }
  function persist() {
    captureProject(); renderLibrary();
    clearTimeout(saveTimer);
    $('save-status').innerHTML = '<span></span> 正在保存草稿…';
    saveTimer = setTimeout(() => {
      try { localStorage.setItem(storageKey, G.serialize(doc)); storageAvailable = true; }
      catch (_) { storageAvailable = false; }
      $('save-status').innerHTML = storageAvailable ? '<span></span> 本机草稿已保存' : '<span></span> 请下载 .glyph 保存';
    }, 300);
  }
  function normalizeSelection() {
    const ids = new Set(G.allPoints(doc).map(p => p.point.id));
    state.selected = new Set([...state.selected].filter(id => ids.has(id)));
    state.components = new Set([...state.components].filter(id => doc.contours.some(c => c.id === id)));
    if (!activeContour()) state.contourId = doc.contours[0]?.id || null;
    if (!selectedSegment()) state.segment = null;
  }
  function record(before, message) {
    if (JSON.stringify(before) === JSON.stringify(doc)) { update(); return; }
    try { G.validateDocument(doc); }
    catch (error) { doc = before; finishDrawing(); normalizeSelection(); update(); toast(error.message, true); return; }
    state.history.push(before); if (state.history.length > preferences.historyLimit) state.history.shift();
    state.future = []; normalizeSelection(); persist(); setStatus(message); update();
    historyGeneration++;
    const key = historyKey();
    if (!timeline || timeline.key !== key) timeline = { key, label: key.split('/').at(-1), items: [{ doc: G.clone(before), label: '打开字形', time: Date.now() }], cursor: 0 };
    timeline.items.splice(timeline.cursor + 1);
    timeline.items.push({ doc: G.clone(doc), label: message, time: Date.now() }); timeline.cursor = timeline.items.length - 1;
    if (timeline.items.length > preferences.historyLimit + 1) { timeline.items.shift(); timeline.cursor--; }
    renderHistory(); writeTimeline();
  }
  function edit(message, action) {
    const before = G.clone(doc);
    try { action(); record(before, message); }
    catch (error) { doc = before; normalizeSelection(); update(); toast(error.message, true); }
  }
  function undo() {
    if (state.pending.length) { state.pending.pop(); update(); return; }
    if (!state.history.length) return;
    state.future.push(G.clone(doc)); doc = state.history.pop(); finishDrawing(); state.selected.clear(); state.components.clear(); state.segment = null;
    historyGeneration++;
    if (timeline?.key === historyKey()) { timeline.cursor = Math.max(0, timeline.cursor - 1); writeTimeline(); renderHistory(); }
    normalizeSelection(); persist(); update(); setStatus('已撤销');
  }
  function redo() {
    if (!state.future.length) return;
    state.history.push(G.clone(doc)); doc = state.future.pop(); finishDrawing(); state.selected.clear(); state.components.clear(); state.segment = null;
    historyGeneration++;
    if (timeline?.key === historyKey()) { timeline.cursor = Math.min(timeline.items.length - 1, timeline.cursor + 1); writeTimeline(); renderHistory(); }
    normalizeSelection(); persist(); update(); setStatus('已重做');
  }
  function update() { updateUI(); requestDraw(); }
  function requestDraw() {
    if (scheduled) return; scheduled = true;
    requestAnimationFrame(() => { scheduled = false; draw(); drawPreview(); });
  }
  function fit() {
    state.fitMode = true;
    const b = G.bounds(doc), width = Math.max(b.maxX - b.minX, doc.glyph.advanceWidth), metricMin = Math.min(b.minY, doc.glyph.descender, 0), metricMax = Math.max(b.maxY, doc.glyph.ascender, 0), height = Math.max(b.maxY - b.minY, metricMax - metricMin, doc.glyph.upm * 0.64);
    const sx = Math.max(70, state.width - 150) / width, sy = Math.max(100, state.height - 150) / height;
    state.view.scale = Math.max(0.02, Math.min(6, sx, sy));
    state.view.x = state.width / 2 - (b.minX + b.maxX) / 2 * state.view.scale;
    state.view.y = state.height * 0.53 + (metricMin + metricMax) / 2 * state.view.scale;
    requestDraw(); updateZoom();
  }
  function zoom(factor, center = { x: state.width / 2, y: state.height / 2 }) {
    state.fitMode = false;
    const p = fontPoint(center), scale = Math.max(0.02, Math.min(12, state.view.scale * factor));
    state.view = { scale, x: center.x - p.x * scale, y: center.y + p.y * scale };
    requestDraw(); updateZoom();
  }
  function updateZoom() { $('zoom-label').textContent = Math.round(state.view.scale * 100) + '%'; }
  function resize() {
    const r = container.getBoundingClientRect(), oldW = state.width, oldH = state.height;
    state.width = r.width; state.height = r.height; state.dpr = Math.min(3, window.devicePixelRatio || 1);
    canvas.width = Math.round(r.width * state.dpr); canvas.height = Math.round(r.height * state.dpr);
    if (oldW === 1 || state.fitMode) fit();
    else { state.view.x += (r.width - oldW) / 2; state.view.y += (r.height - oldH) / 2; }
    requestDraw();
  }
  function line(ctx, a, b) { ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
  function traceSegment(ctx, points, type, tolerance) {
    if (type === 'line') ctx.lineTo(points.at(-1).x, points.at(-1).y);
    else for (const cubic of G.toCubics(points, tolerance)) {
      const p = cubic.points; ctx.bezierCurveTo(p[1].x, p[1].y, p[2].x, p[2].y, p[3].x, p[3].y);
    }
  }
  function traceContour(ctx, contour, tolerance) {
    ctx.moveTo(contour.nodes[0].x, contour.nodes[0].y);
    contour.segments.forEach((s, i) => traceSegment(ctx, G.segmentPoints(contour, i), s.type, tolerance));
    if (contour.closed) ctx.closePath();
  }
  function drawGrid() {
    const ctx = context, { width: w, height: h } = state, z = state.view.scale;
    let step = state.gridStep; while (step * z < 16) step *= 5;
    let rulerStep = step; while (rulerStep * z < 55) rulerStep *= 2;
    const first = fontPoint({ x: 24, y: h }), last = fontPoint({ x: w, y: 24 });
    if (state.grid && !state.fill) {
      ctx.strokeStyle = '#ebe8f0'; ctx.lineWidth = 0.6;
      ctx.beginPath();
      for (let x = Math.ceil(first.x / step) * step; x <= last.x; x += step) { const p = screen({ x, y: 0 }); ctx.moveTo(p.x, 24); ctx.lineTo(p.x, h); }
      for (let y = Math.ceil(first.y / step) * step; y <= last.y; y += step) { const p = screen({ x: 0, y }); ctx.moveTo(24, p.y); ctx.lineTo(w, p.y); }
      ctx.stroke();
    }
    if (!state.fill) {
      if (state.constraintGuide) {
        const { origin, direction } = state.constraintGuide, length = Math.hypot(direction.x, direction.y), span = 2000 / state.view.scale;
        if (length > 1e-10) { const a = screen({ x: origin.x - direction.x / length * span, y: origin.y - direction.y / length * span }), b = screen({ x: origin.x + direction.x / length * span, y: origin.y + direction.y / length * span }); ctx.strokeStyle = '#4b9f9a'; ctx.lineWidth = 1; ctx.setLineDash([6, 4]); line(ctx, a, b); ctx.setLineDash([]); }
      }
      const guideColors = preferences.contrast ? ['#0057b8', '#00875a', '#b3006b', '#111111', '#b34c00'] : ['#d9d2e4', '#dfd7e7', '#d5c8e8', '#bba4d8', '#d9d2e4'];
      const guides = [[doc.glyph.ascender, '升部', guideColors[0]], [doc.glyph.capHeight, '大写', guideColors[1]], [doc.glyph.xHeight, 'x高', guideColors[2]], [0, '基线', guideColors[3]], [doc.glyph.descender, '降部', guideColors[4]]];
      ctx.font = '9px Consolas, monospace';
      for (const [value, name, color] of guides) {
        const y = screen({ x: 0, y: value }).y;
        if (y < 30 || y > h - 15) continue;
        ctx.strokeStyle = color; ctx.lineWidth = value === 0 ? 1 : 0.7; ctx.setLineDash(value === 0 ? [] : [5, 6]);
        line(ctx, { x: 24, y }, { x: w, y }); ctx.setLineDash([]);
        ctx.fillStyle = color === '#bba4d8' ? '#ad91c8' : '#bdb0cb'; ctx.fillText(name + '  ' + value, 35, y - 6);
      }
      for (const [x, name, color] of [[G.bounds(doc).minX, '左边距', preferences.contrast ? '#0057b8' : '#b89dd5'], [doc.glyph.advanceWidth, '右边距', preferences.contrast ? '#b34c00' : '#d4c9e1']]) {
        ctx.strokeStyle = color; ctx.lineWidth = .9; ctx.setLineDash([3, 5]);
        const p = screen({ x, y: 0 }); line(ctx, { x: p.x, y: 24 }, { x: p.x, y: h }); ctx.setLineDash([]);
        ctx.font = '9px Consolas, monospace'; ctx.fillStyle = color; ctx.fillText(name, p.x + 3, 36);
      }
    }
    // Rulers stay in screen coordinates and remain legible at every zoom level.
    ctx.fillStyle = '#f1eff6'; ctx.fillRect(0, 0, w, 24); ctx.fillRect(0, 0, 24, h);
    ctx.strokeStyle = '#e3deeb'; ctx.lineWidth = 1;
    line(ctx, { x: 24, y: 24 }, { x: w, y: 24 }); line(ctx, { x: 24, y: 24 }, { x: 24, y: h });
    ctx.font = '8px Consolas, monospace'; ctx.fillStyle = '#b1a5bf'; ctx.strokeStyle = '#cec3d9';
    for (let x = Math.ceil(first.x / rulerStep) * rulerStep; x <= last.x; x += rulerStep) {
      const px = screen({ x, y: 0 }).x; line(ctx, { x: px, y: 19 }, { x: px, y: 24 }); ctx.fillText(String(Number(x.toFixed(3))), px + 4, 14);
    }
    for (let y = Math.ceil(first.y / rulerStep) * rulerStep; y <= last.y; y += rulerStep) {
      const py = screen({ x: 0, y }).y; line(ctx, { x: 19, y: py }, { x: 24, y: py });
      ctx.save(); ctx.translate(13, py - 4); ctx.rotate(-Math.PI / 2); ctx.fillText(String(Number(y.toFixed(3))), 0, 0); ctx.restore();
    }
    ctx.fillStyle = '#f1eff6'; ctx.fillRect(0, 0, 24, 24); ctx.fillStyle = '#b2a3c2'; ctx.fillText('u', 10, 15);
  }
  function drawPoint(p, kind, selected, label) {
    const ctx = context, q = screen(p), middle = kind === 'middle', node = kind === 'node';
    const size = selected ? 4.5 : node ? 3.3 : 2.8;
    ctx.save(); ctx.translate(q.x, q.y);
    ctx.strokeStyle = middle ? '#c89843' : selected ? '#7852c7' : node ? '#77678c' : '#a48bbf';
    ctx.fillStyle = selected ? middle ? '#d1a353' : '#8b66cd' : '#faf8fe'; ctx.lineWidth = selected ? 1.4 : 1;
    ctx.beginPath();
    if (middle) { ctx.moveTo(0, -size - 1); ctx.lineTo(size + 1, 0); ctx.lineTo(0, size + 1); ctx.lineTo(-size - 1, 0); ctx.closePath(); }
    else if (node && !p.smooth) ctx.rect(-size, -size, size * 2, size * 2);
    else ctx.arc(0, 0, size, 0, Math.PI * 2);
    ctx.fill(); ctx.stroke();
    if (selected) { ctx.strokeStyle = middle ? '#c8984338' : '#7852c733'; ctx.beginPath(); ctx.arc(0, 0, 9, 0, Math.PI * 2); ctx.stroke(); }
    if (label) { ctx.font = '9px Georgia, serif'; ctx.fillStyle = middle ? '#ba8d42' : '#aa91c1'; ctx.fillText(label, 8, -8); }
    ctx.restore();
  }
  function draw() {
    const ctx = context, d = state.dpr, z = state.view.scale;
    ctx.setTransform(d, 0, 0, d, 0, 0); ctx.clearRect(0, 0, state.width, state.height);
    drawGrid(); ctx.save(); ctx.beginPath(); ctx.rect(24, 24, state.width - 24, state.height - 24); ctx.clip();
    ctx.save(); ctx.translate(state.view.x, state.view.y); ctx.scale(z, -z);
    ctx.beginPath(); doc.contours.filter(c => c.closed).forEach(c => traceContour(ctx, c, .16 / z));
    ctx.fillStyle = state.fill ? '#27222e' : '#9981b510'; ctx.fill('evenodd');
    for (const contour of doc.contours) {
      if (state.fill && contour.closed) continue;
      ctx.beginPath(); traceContour(ctx, contour, .16 / z);
      ctx.lineWidth = (state.fill ? 1.3 : contour.id === state.contourId ? 1.35 : 1.05) / z;
      ctx.strokeStyle = state.fill ? '#27222e' : state.components.has(contour.id) ? '#8c60c7' : contour.id === state.contourId ? '#6d5e83' : '#aa9bbd'; ctx.stroke();
    }
    const selected = selectedSegment();
    if (selected && !state.fill) {
      const p = G.segmentPoints(selected.contour, selected.index);
      ctx.beginPath(); ctx.moveTo(p[0].x, p[0].y); traceSegment(ctx, p, selected.segment.type, .1 / z);
      ctx.lineWidth = 2 / z; ctx.strokeStyle = '#9971d6'; ctx.stroke();
    }
    ctx.restore();
    if (!state.fill) {
      if (state.handles) for (const c of doc.contours) {
        if (c.id !== state.contourId || state.tool === 'component') continue;
        c.segments.forEach((s, i) => {
          if (s.type === 'line') return;
          const points = G.segmentPoints(c, i), selected = state.segment?.contourId === c.id && state.segment.index === i;
          ctx.beginPath(); const a = screen(points[0]); ctx.moveTo(a.x, a.y);
          points.slice(1).forEach(p => { const q = screen(p); ctx.lineTo(q.x, q.y); });
          ctx.strokeStyle = selected ? '#b194d1' : '#d3c6e0'; ctx.lineWidth = .8; ctx.setLineDash([3, 3]); ctx.stroke(); ctx.setLineDash([]);
          s.controls.forEach((p, j) => drawPoint(p, j === 1 && s.controls.length === 3 ? 'middle' : 'control', state.selected.has(p.id), selected ? 'C' + (j + 1) : ''));
        });
      }
      for (const c of doc.contours) c.nodes.forEach((p, i) => {
        drawPoint(p, 'node', state.selected.has(p.id), '');
        if (i === 0 && c.id === state.contourId && c.segments.length) {
          const ps = G.segmentPoints(c, 0), a = screen(G.evaluate(ps, .06)), b = screen(G.evaluate(ps, .1));
          const angle = Math.atan2(b.y - a.y, b.x - a.x); ctx.save(); ctx.translate(a.x, a.y); ctx.rotate(angle); ctx.fillStyle = '#a18ab9'; ctx.beginPath(); ctx.moveTo(4, 0); ctx.lineTo(-3, -3); ctx.lineTo(-3, 3); ctx.closePath(); ctx.fill(); ctx.restore();
        }
      });
      drawPending();
      if (state.drag?.type === 'knife') { ctx.strokeStyle = '#d47d7d'; ctx.lineWidth = 1.5; ctx.setLineDash([6, 4]); line(ctx, state.drag.start, state.drag.current); ctx.setLineDash([]); }
      if (state.snapHint && (state.drag || state.drawing)) {
        const hint = state.snapHint, p = screen(hint.point); ctx.strokeStyle = '#43a391'; ctx.lineWidth = 1; ctx.setLineDash([3, 4]);
        if (hint.x !== undefined) line(ctx, { x: screen({ x: hint.x, y: 0 }).x, y: 24 }, { x: screen({ x: hint.x, y: 0 }).x, y: state.height });
        if (hint.y !== undefined) line(ctx, { x: 24, y: screen({ x: 0, y: hint.y }).y }, { x: state.width, y: screen({ x: 0, y: hint.y }).y });
        ctx.setLineDash([]); ctx.beginPath(); ctx.arc(p.x, p.y, 7, 0, Math.PI * 2); ctx.stroke();
        ctx.font = '10px sans-serif'; ctx.fillStyle = '#419784'; ctx.fillText({ node: '节点', edge: '边缘', alignment: '对齐', grid: '网格' }[hint.type], p.x + 11, p.y - 9);
      }
      if (state.drag?.type === 'box') {
        const { start, current } = state.drag; ctx.fillStyle = '#a982d417'; ctx.strokeStyle = '#ae8cd2'; ctx.lineWidth = 1;
        ctx.fillRect(start.x, start.y, current.x - start.x, current.y - start.y); ctx.strokeRect(start.x, start.y, current.x - start.x, current.y - start.y);
      }
      if (state.drag?.type === 'shape') {
        const { start, current } = state.drag; ctx.strokeStyle = '#9b73cb'; ctx.fillStyle = '#b196d41a'; ctx.setLineDash([4, 4]); ctx.beginPath();
        const x = Math.min(start.x, current.x), y = Math.min(start.y, current.y), w = Math.abs(start.x - current.x), h = Math.abs(start.y - current.y);
        if (state.tool === 'ellipse') ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2); else ctx.rect(x, y, w, h);
        ctx.fill(); ctx.stroke(); ctx.setLineDash([]);
      }
    }
    drawFrame(); ctx.restore();
  }
  function drawPending() {
    const c = doc.contours.find(c => c.id === state.drawing);
    if (!c || !state.pointer) return;
    const ctx = context, start = c.nodes.at(-1), cursor = snapPoint(fontPoint(state.pointer), {}, new Set(), false);
    const points = [start, ...state.pending, cursor];
    ctx.strokeStyle = '#b499d1'; ctx.lineWidth = 1; ctx.setLineDash([4, 4]); ctx.beginPath();
    points.forEach((p, i) => { const q = screen(p); if (i === 0) ctx.moveTo(q.x, q.y); else ctx.lineTo(q.x, q.y); }); ctx.stroke(); ctx.setLineDash([]);
    state.pending.forEach((p, i) => drawPoint(p, i === 1 ? 'middle' : 'control', false, 'C' + (i + 1)));
    if (points.length >= 2 && state.tool === 'pen') {
      ctx.save(); ctx.translate(state.view.x, state.view.y); ctx.scale(state.view.scale, -state.view.scale); ctx.beginPath(); ctx.moveTo(start.x, start.y);
      traceSegment(ctx, points, G.typeForControls(state.pending.length), .2 / state.view.scale); ctx.lineWidth = 1.6 / state.view.scale; ctx.strokeStyle = '#9970ca'; ctx.stroke(); ctx.restore();
    }
  }
  function drawPreview() {
    const preview = $('preview'), r = preview.getBoundingClientRect(); if (!r.width || !r.height) return;
    preview.width = r.width * state.dpr; preview.height = r.height * state.dpr;
    const ctx = preview.getContext('2d'), b = G.bounds(doc);
    const z = Math.min((r.width - 55) / Math.max(b.maxX - b.minX, 1), (r.height - 30) / Math.max(b.maxY - b.minY, 1));
    ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0); ctx.translate(r.width / 2 - (b.minX + b.maxX) * z / 2, (r.height - 12) / 2 + (b.minY + b.maxY) * z / 2); ctx.scale(z, -z);
    ctx.fillStyle = '#2d2736'; ctx.beginPath(); doc.contours.filter(c => c.closed).forEach(c => traceContour(ctx, c, .2 / Math.max(z, .001))); ctx.fill('evenodd');
    ctx.strokeStyle = '#7f6c91'; ctx.lineWidth = 1 / Math.max(z, .001); ctx.beginPath(); doc.contours.filter(c => !c.closed).forEach(c => traceContour(ctx, c, .2 / Math.max(z, .001))); ctx.stroke();
  }
  function setInput(id, value) { if (document.activeElement !== $(id)) $(id).value = value; }
  function updateUI() {
    const signature = [...state.selected].sort().join('|');
    if (signature !== state.selectionSignature) { state.selectionSignature = signature; state.pivot = null; state.frameMode = 'scale'; }
    const g = doc.glyph;
    $('document-name').textContent = g.name; $('canvas-glyph-name').textContent = g.name;
    $('canvas-unicode').textContent = g.unicode ? 'U+' + g.unicode.toUpperCase() : '未编码';
    $('preview-label').textContent = g.name + ' / Higher Degree';
    setInput('glyph-name', g.name); setInput('glyph-unicode', g.unicode);
    for (const key of ['upm', 'advanceWidth', 'ascender', 'descender', 'capHeight', 'xHeight']) setInput('metric-' + key, g[key]);
    $('undo-button').disabled = !state.history.length && !state.pending.length; $('redo-button').disabled = !state.future.length;
    $('empty-state').hidden = doc.contours.length > 0;
    $('contour-count').textContent = doc.contours.length;
    $('node-total').textContent = doc.contours.reduce((n, c) => n + c.nodes.length, 0) + ' 个节点';
    const p = selectedPoint(), segment = selectedSegment();
    $('selection-count').textContent = state.components.size ? state.components.size + ' 条轮廓已选' : state.selected.size ? state.selected.size + ' 个已选' : segment ? '曲线段已选' : '未选择';
    $('point-empty').hidden = !!p || !!segment || state.selected.size > 1;
    $('point-properties').hidden = !p;
    if (p) {
      setInput('point-x', rounded(p.point.x)); setInput('point-y', rounded(p.point.y));
      $('point-type').textContent = p.kind === 'node' ? p.point.smooth ? '平滑节点' : '角点' : p.control === 1 && p.contour.segments[p.index].controls.length === 3 ? '中间控制点' : '控制点';
      $('point-symbol').textContent = p.kind === 'node' ? 'P' + p.index : 'C' + (p.control + 1);
      const middle = p.kind === 'control' && p.control === 1 && p.contour.segments[p.index].controls.length === 3;
      $('point-type-dot').style.background = middle ? '#c58e38' : '#9476bf';
      $('point-type-dot').style.transform = middle ? 'rotate(45deg)' : 'none';
    }
    $('segment-properties').hidden = !segment;
    if (segment) {
      const count = segment.segment.controls.length;
      $('segment-type-label').textContent = ['直线段', '二次贝塞尔', '三次贝塞尔', '四次贝塞尔'][count] || (count + 1) + ' 次贝塞尔';
      $('segment-detail').textContent = '2 个端点 · ' + count + ' 个控制点';
      $('segment-degree').textContent = (count + 1) + '°';
      $('convert-button').textContent = count ? '转为直线' : '转为四次曲线';
      setInput('degree-select', count);
    }
    $('degree-field').hidden = !segment;
    setInput('max-control-points', state.maxControls ?? '');
    updateTransformFields();
    $('smooth-button').hidden = !p || p.kind !== 'node';
    $('corner-button').disabled = !G.allPoints(doc).some(p => p.kind === 'node' && state.selected.has(p.point.id));
    $('start-point').disabled = !p || p.kind !== 'node' || !p.contour.closed;
    $('round-selection').disabled = !state.selected.size;
    $('round-glyph').disabled = !doc.contours.length;
    const endpoints = G.allPoints(doc).filter(p => p.kind === 'node' && state.selected.has(p.point.id));
    $('join-points').disabled = endpoints.length !== 2 || endpoints.some(p => p.contour.closed || ![0, p.contour.nodes.length - 1].includes(p.index));
    const list = $('contour-list'); list.replaceChildren();
    doc.contours.forEach((c, i) => {
      const button = document.createElement('button'); button.className = 'contour-item' + (c.id === state.contourId || state.components.has(c.id) ? ' active' : '') + (c.component ? ' grouped' : '');
      button.setAttribute('aria-pressed', String(c.id === state.contourId || state.components.has(c.id)));
      const icon = document.createElement('span'); icon.className = 'contour-icon'; icon.style.borderRadius = c.closed ? '50%' : '2px';
      const label = document.createElement('span'); label.textContent = (c.name || '轮廓 ' + String(i + 1).padStart(2, '0')) + (c.component ? ' · 组合' : '');
      const detail = document.createElement('span'); detail.textContent = (c.closed ? '闭合' : '开放') + ' · ' + c.nodes.length;
      button.append(icon, label, detail); button.onclick = event => { finishDrawing(); selectContours(state.tool === 'component' ? members(c) : [c], event.shiftKey); update(); };
      list.append(button);
    });
    const active = activeContour();
    $('close-contour').disabled = !active || active.closed || active.nodes.length < 2;
    $('reverse-contour').disabled = !active || active.nodes.length < 2;
    $('delete-contour').disabled = !active;
    $('group-contours').disabled = selectedContours().length < 2;
    $('ungroup-contours').disabled = !selectedContours().some(c => c.component);
    $('copy-contours').disabled = !selectedContours().length;
    $('paste-contours').disabled = !clipboard;
    updateBooleanUI();
    $('snap-nodes').checked = state.snapNodes; $('snap-edges').checked = state.snapEdges;
    setInput('grid-step', state.gridStep); setInput('coordinate-precision', state.precision);
    $('snap-button').classList.toggle('is-on', state.snap); $('snap-button').setAttribute('aria-pressed', String(state.snap)); $('snap-button').title = `网格吸附：${state.gridStep} 单位 (S)`;
    for (const id of ['point-x', 'point-y']) $(id).step = state.precision < 0 ? 'any' : String(10 ** -state.precision);
    $('export-button').disabled = !doc.contours.some(c => c.segments.length);
    setInput('pref-theme', preferences.theme); setInput('pref-palette', preferences.palette); $('pref-contrast').checked = preferences.contrast;
    setInput('pref-font', preferences.fontFamily); setInput('pref-history-limit', preferences.historyLimit); $('pref-history-storage').checked = preferences.persistHistory;
    $('pref-wheel-mode').value = preferences.wheelMode; $('pref-wheel-invert').checked = preferences.invertWheel;
    $('pref-page-size').value = pageSize; $('library-page-size').value = pageSize;
    document.querySelectorAll('[data-shortcut]').forEach(input => { if (document.activeElement !== input) input.value = preferences.shortcuts[input.dataset.shortcut] || ''; });
    renderHistory();
    updateHint();
  }
  function updateTransformFields() {
    const frame = selectionFrame(); $('selection-transform').hidden = !frame;
    if (!frame) return;
    $('transform-selection-count').textContent = frame.entries.length + ' 个点';
    const reference = state.pivot || frame.reference;
    setInput('selection-x', rounded(reference.x)); setInput('selection-y', rounded(reference.y));
    setInput('selection-width', rounded(frame.bounds.maxX - frame.bounds.minX)); setInput('selection-height', rounded(frame.bounds.maxY - frame.bounds.minY));
    $('selection-width').disabled = frame.bounds.maxX - frame.bounds.minX < 1e-10; $('selection-height').disabled = frame.bounds.maxY - frame.bounds.minY < 1e-10;
    setInput('pivot-x', rounded(frame.origin.x)); setInput('pivot-y', rounded(frame.origin.y));
    const labels = { nw: '左上', n: '上中', ne: '右上', w: '左中', center: '中心', e: '右中', sw: '左下', s: '下中', se: '右下' };
    $('pivot-description').textContent = state.pivot ? '自定义中心' : '九宫格' + labels[state.anchor];
    document.querySelectorAll('[data-anchor]').forEach(b => { const active = !state.pivot && b.dataset.anchor === state.anchor; b.classList.toggle('active', active); b.setAttribute('aria-pressed', String(active)); });
    for (const [id, mode] of [['frame-scale', 'scale'], ['frame-rotate', 'rotate']]) { $(id).classList.toggle('active', state.frameMode === mode); $(id).setAttribute('aria-pressed', String(state.frameMode === mode)); }
    $('frame-hint').innerHTML = state.frameMode === 'scale' ? '拖动角 / 边手柄拉伸缩放 · 双击切换<br>Shift 等比 · 九宫格决定固定参考点' : '角手柄旋转 · 边手柄平行四边形倾斜<br>中心十字可拖动 · Shift 按 15° 旋转';
    $('selection-reverse').disabled = !selectedContours().length;
  }
  function updateHint() {
    const hints = { select: '左击边缘加平滑节点 · 右键加控制点 · 单柄 Shift / Ctrl+Alt 共轭', component: '点击内部 / 边缘选构件 · 双击切换变换 · Shift 多选 · Ctrl G 组合', knife: '单击节点或边缘切开 · 拖线剪切所有交点 · 可撤销', pen: '左键放节点，右键放控制点 · ' + (state.maxControls === null ? '控制点不限' : '每段上限 ' + state.maxControls), line: '左键绘制直线 · 点击起点闭合 · Enter 结束', rect: '拖动绘制矩形 · 按住 Shift 绘制正方形', ellipse: '拖动绘制椭圆 · 按住 Shift 绘制圆形', hand: '拖动画布平移 · 滚轮缩放 · 0 适应画布' };
    let hint = hints[state.tool];
    if (state.tool === 'pen' && state.drawing) hint = `已有 ${state.pending.length} 个控制点 · 左键放 ${state.pending.length + 1} 次曲线终点 · ${state.maxControls === null || state.pending.length < state.maxControls ? '右键加控制点' : '右键也可放终点'} · Enter 结束`;
    $('tool-hint').textContent = hint;
    canvas.style.cursor = state.space || state.tool === 'hand' ? state.drag ? 'grabbing' : 'grab' : state.tool === 'component' ? 'move' : state.tool === 'select' ? 'default' : 'crosshair';
  }
  function finishDrawing() { state.pending = []; state.drawing = null; state.snapHint = null; }
  function setTool(tool) {
    clearTimeout(clickTimer);
    finishDrawing(); state.tool = tool;
    if (tool !== 'hand' && tool !== 'component') setFill(false);
    if (tool === 'select') state.components.clear();
    document.querySelectorAll('[data-tool]').forEach(button => { const active = button.dataset.tool === tool; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); });
    update();
  }
  function setFill(fill) {
    state.fill = fill;
    $('outline-button').classList.toggle('selected', !fill); $('outline-button').setAttribute('aria-pressed', String(!fill));
    $('fill-button').classList.toggle('selected', fill); $('fill-button').setAttribute('aria-pressed', String(fill)); requestDraw();
  }
  function hitPoint(q) {
    if (state.fill) return null;
    const points = G.allPoints(doc).filter(p => p.kind === 'node' || state.handles && p.contour.id === state.contourId);
    let best = null, nearest = 9;
    for (const p of points) { const d = G.distance(screen(p.point), q); if (d < nearest) { nearest = d; best = p; } }
    return best;
  }
  function hitMetric(q) {
    if (state.fill || state.tool !== 'select') return null;
    const b = G.bounds(doc), candidates = [
      { key: 'leftBearing', distance: Math.abs(q.x - screen({ x: b.minX, y: 0 }).x) },
      { key: 'rightBearing', distance: Math.abs(q.x - screen({ x: doc.glyph.advanceWidth, y: 0 }).x) },
      ...['ascender', 'capHeight', 'xHeight', 'descender'].map(key => ({ key, distance: Math.abs(q.y - screen({ x: 0, y: doc.glyph[key] }).y) }))
    ].filter(item => item.distance <= 8 && (['ascender', 'capHeight', 'xHeight', 'descender'].includes(item.key) || q.y <= 42));
    if (!candidates.length) return null;
    return candidates.sort((a, b) => a.distance - b.distance)[0].key;
  }
  function hitSegment(q) {
    const p = fontPoint(q); let hit = null, nearest = 8 / state.view.scale;
    for (const contour of doc.contours) contour.segments.forEach((s, index) => {
      const candidate = G.nearestPoint(G.segmentPoints(contour, index), p);
      if (candidate.distance < nearest) { nearest = candidate.distance; hit = { contour, index, t: candidate.t, point: candidate.point }; }
    });
    return hit;
  }
  function hitContour(q) {
    const hit = hitSegment(q); if (hit) return hit.contour;
    const p = fontPoint(q);
    context.save(); context.setTransform(1, 0, 0, 1, 0, 0);
    try {
      for (const c of [...doc.contours].reverse()) {
        if (!c.closed) continue;
        const path = new Path2D(); traceContour(path, c, .1);
        if (context.isPointInPath(path, p.x, p.y, 'evenodd')) return c;
      }
    } finally { context.restore(); }
    return null;
  }
  function insertAtCurve(hit, control = false) {
    const canAdd = state.maxControls === null || hit.contour.segments[hit.index].controls.length < state.maxControls;
    if (control && canAdd && G.allPoints(doc).length >= 20000) { toast('文档总点数已达 20,000；请拆分为多个文件', true); return; }
    edit(control && canAdd ? '已精确升阶并添加控制点' : '已添加平滑节点，保持曲线形状', () => {
      state.components.clear(); state.contourId = hit.contour.id;
      if (control && canAdd) {
        const p = G.addControl(hit.contour, hit.index); state.selected = new Set([p.id]); state.segment = { contourId: hit.contour.id, index: hit.index };
      } else {
        const p = G.splitSegment(hit.contour, hit.index, Math.max(.00001, Math.min(.99999, hit.t)));
        state.selected = new Set([p.id]); state.segment = null;
      }
    });
  }
  function movablePoints() {
    // Explicit selection ownership: never silently include an unselected handle.
    return G.allPoints(doc).filter(p => state.selected.has(p.point.id)).map(p => ({ point: p.point, x: p.point.x, y: p.point.y }));
  }
  function penClick(q, event) {
    const pos = snapPoint(fontPoint(q), event);
    let contour = doc.contours.find(c => c.id === state.drawing);
    if (!contour) {
      if (event.button === 2) { toast('先用左键放置起点，再用右键放置控制点'); return; }
      const hit = hitPoint(q);
      if (hit?.kind === 'node' && !hit.contour.closed && [0, hit.contour.nodes.length - 1].includes(hit.index)) {
        if (hit.index === 0 && hit.contour.nodes.length > 1) edit('已反转路径并从此端点续画', () => G.reverseContour(hit.contour));
        contour = hit.contour; state.drawing = contour.id; state.contourId = contour.id; state.selected = new Set([hit.point.id]); update(); return;
      }
      edit('已创建轮廓', () => { contour = G.newContour(G.point(pos.x, pos.y)); doc.contours.push(contour); state.drawing = contour.id; state.contourId = contour.id; state.selected = new Set([contour.nodes[0].id]); state.segment = null; }); return;
    }
    if (event.button === 2 && state.tool === 'pen' && (state.maxControls === null || state.pending.length < state.maxControls)) {
      if (G.allPoints(doc).length + state.pending.length >= 19999) { toast('文档总点数已达容量限制', true); return; }
      state.pending.push(pos); update(); return;
    }
    const canClose = contour.nodes.length >= 2 && G.distance(screen(contour.nodes[0]), q) < 12;
    if (event.button === 0 || state.maxControls !== null && state.pending.length >= state.maxControls) {
      if (!canClose && G.distance(contour.nodes.at(-1), pos) * state.view.scale < 1) { toast('终点需要与上一节点分开'); return; }
      edit(canClose ? '轮廓已闭合' : '已添加曲线段', () => {
        const controls = state.tool === 'line' ? [] : state.pending, type = G.typeForControls(controls.length);
        if (canClose) G.closeContour(contour, type, controls);
        else G.append(contour, G.point(pos.x, pos.y), type, controls);
        state.segment = { contourId: contour.id, index: contour.segments.length - 1 };
        state.selected = new Set([canClose ? contour.nodes[0].id : contour.nodes.at(-1).id]);
        state.pending = []; if (canClose) state.drawing = null;
      });
    }
  }
  canvas.addEventListener('pointerdown', event => {
    if (![0, 1, 2].includes(event.button) || state.drag) return;
    event.preventDefault(); canvas.focus({ preventScroll: true }); const q = eventPoint(event); state.pointer = q;
    canvas.setPointerCapture(event.pointerId);
    if (state.space || state.tool === 'hand' || event.button === 1) { state.fitMode = false; state.drag = { type: 'pan', start: q, view: { ...state.view } }; updateHint(); return; }
    if (event.button === 0) {
      const hit = hitFrame(q);
      if (hit) {
        clearTimeout(clickTimer);
        state.drag = hit.key === 'pivot' ? { type: 'pivot', start: q, oldPivot: state.pivot && { ...state.pivot }, origin: { ...hit.frame.origin } }
          : { type: 'frame', start: q, handle: hit.key, mode: state.frameMode, bounds: { ...hit.frame.bounds }, origin: { ...hit.frame.origin }, handlePoint: { ...hit.point }, before: G.clone(doc), points: hit.frame.entries, matrix: null };
        return;
      }
    }
    if (state.fill && state.tool !== 'component') setFill(false);
    if (state.tool === 'pen' || state.tool === 'line') { penClick(q, event); return; }
    if (state.tool === 'knife' && event.button === 0) { state.drag = { type: 'knife', start: q, current: q }; return; }
    if (state.tool === 'component' && event.button === 0) {
      const c = hitContour(q);
      if (c) {
        const contours = members(c);
        if (event.shiftKey && state.components.has(c.id)) {
          contours.forEach(c => { state.components.delete(c.id); G.allPoints({ contours: [c] }).forEach(p => state.selected.delete(p.point.id)); }); update(); return;
        }
        selectContours(contours, event.shiftKey || state.components.has(c.id));
        const p = fontPoint(q), anchors = selectedContours().flatMap(c => c.nodes), anchor = anchors.reduce((best, candidate) => G.distance(candidate, p) < G.distance(best, p) ? candidate : best, anchors[0]);
      state.drag = { type: 'points', start: q, anchor: { x: anchor.x, y: anchor.y }, before: G.clone(doc), points: movablePoints(), oldPivot: state.pivot && { ...state.pivot } }; update(); return;
      }
      if (!event.shiftKey) { state.components.clear(); state.selected.clear(); }
      state.drag = { type: 'box', start: q, current: q, initial: new Set(state.selected), initialComponents: new Set(state.components) }; update(); return;
    }
    if (event.button === 2) {
      if (state.tool !== 'select') return;
      const hit = hitPoint(q);
      if (hit) { state.components.clear(); state.selected = new Set([hit.point.id]); state.contourId = hit.contour.id; state.segment = hit.kind === 'control' ? { contourId: hit.contour.id, index: hit.index } : null; update(); return; }
      const curve = hitSegment(q); if (curve) insertAtCurve(curve, true); return;
    }
    if (state.tool === 'rect' || state.tool === 'ellipse') { state.drag = { type: 'shape', start: q, current: q }; return; }
    if (event.button === 0) {
      const metric = !hitPoint(q) && !hitSegment(q) ? hitMetric(q) : null;
      if (metric) { state.drag = { type: 'metric', key: metric, start: fontPoint(q), before: G.clone(doc) }; return; }
    }
    const hit = hitPoint(q);
    if (event.button === 0 && hit && state.tool === 'select' && !state.components.size && state.selected.has(hit.point.id)) {
      const selectedNodes = G.allPoints(doc).filter(entry => state.selected.has(entry.point.id));
      if (selectedNodes.length > 1 && selectedNodes.every(entry => entry.kind === 'node')) { changeFrameMode(state.frameMode === 'scale' ? 'rotate' : 'scale'); return; }
    }
    if (hit) {
      state.components.clear();
      const shiftHandle = event.shiftKey && state.selected.size === 1 && state.selected.has(hit.point.id) && hit.kind === 'control' && G.smoothNeighborhood(doc, hit.point.id);
      if (event.shiftKey && state.selected.has(hit.point.id) && !shiftHandle) { state.selected.delete(hit.point.id); update(); return; }
      if (!event.shiftKey && !state.selected.has(hit.point.id)) state.selected.clear();
      state.selected.add(hit.point.id); state.contourId = hit.contour.id;
      state.segment = hit.kind === 'control' ? { contourId: hit.contour.id, index: hit.index } : null;
      state.drag = { type: 'points', start: q, anchor: { x: hit.point.x, y: hit.point.y }, primaryId: hit.point.id, before: G.clone(doc), points: movablePoints() };
      update(); return;
    }
    const curve = hitSegment(q);
    if (curve) {
      const keepFrame = !!selectionFrame() && insideFrame(q);
      if (!keepFrame) { state.components.clear(); state.selected.clear(); }
      state.contourId = curve.contour.id; state.segment = { contourId: curve.contour.id, index: curve.index };
      state.drag = { type: 'curve', start: q, hit: curve, before: G.clone(doc), moved: false, original: null, origin: G.evaluate(G.segmentPoints(curve.contour, curve.index), curve.t) }; update(); return;
    }
    if (!event.shiftKey && selectionFrame() && insideFrame(q)) {
      const frame = selectionFrame(); state.drag = { type: 'points', start: q, anchor: { ...frame.reference }, before: G.clone(doc), points: frame.entries }; return;
    }
    if (!event.shiftKey) { state.selected.clear(); state.components.clear(); state.segment = null; }
    state.drag = { type: 'box', start: q, current: q, initial: new Set(state.selected) }; update();
  });
  canvas.addEventListener('pointermove', event => {
    const q = eventPoint(event); state.pointer = q; const p = fontPoint(q);
    if (!state.drag) { const metric = hitMetric(q); canvas.style.cursor = metric ? metric.endsWith('Bearing') ? 'ew-resize' : 'ns-resize' : ''; }
    $('pointer-coordinate').textContent = 'X ' + rounded(p.x) + '   Y ' + rounded(p.y);
    const drag = state.drag;
    if (drag?.type === 'metric') {
      const target = fontPoint(q), dx = target.x - drag.start.x, dy = target.y - drag.start.y; doc = G.clone(drag.before);
      if (drag.key === 'leftBearing') {
        const shift = Math.max(-1e6, Math.min(1e6, dx));
        G.allPoints(doc).forEach(({ point: pt }) => { pt.x = Math.max(-1e6, Math.min(1e6, pt.x + shift)); });
        doc.glyph.advanceWidth = Math.max(0, Math.min(100000, doc.glyph.advanceWidth + shift));
      } else if (drag.key === 'rightBearing') doc.glyph.advanceWidth = Math.max(0, Math.min(100000, drag.before.glyph.advanceWidth + dx));
      else {
        let value = drag.before.glyph[drag.key] + dy;
        if (drag.key === 'ascender') value = Math.max(1, drag.before.glyph.capHeight, value);
        if (drag.key === 'capHeight') value = Math.max(drag.before.glyph.xHeight, Math.min(drag.before.glyph.ascender, value));
        if (drag.key === 'xHeight') value = Math.max(0, Math.min(drag.before.glyph.capHeight, value));
        if (drag.key === 'descender') value = Math.min(0, value);
        doc.glyph[drag.key] = Math.max(-100000, Math.min(100000, value));
      }
      updateUI(); setStatus('拖动调整字形度量');
    } else if (drag?.type === 'frame') {
      const delta = { x: (q.x - drag.start.x) / state.view.scale, y: -(q.y - drag.start.y) / state.view.scale };
      const target = { x: drag.handlePoint.x + delta.x, y: drag.handlePoint.y + delta.y };
      const result = G.frameTransform(drag.bounds, drag.origin, drag.mode, drag.handle, drag.handlePoint, target, { uniform: state.lockAspect || event.shiftKey, snapAngle: event.shiftKey });
      drag.matrix = result.matrix; G.applyAffine(drag.points.map(p => p.point), result.matrix, drag.points);
      updateTransformFields();
      if (result.angle !== undefined) setStatus('旋转 ' + rounded(result.angle) + '°');
      else if (result.shear !== undefined) setStatus('倾斜 ' + rounded(Math.atan(result.shear) * 180 / Math.PI) + '°');
      else setStatus(`缩放 ${rounded(result.scaleX * 100)}% × ${rounded(result.scaleY * 100)}%`);
    } else if (drag?.type === 'pivot') {
      state.pivot = snapPoint({ x: drag.origin.x + (q.x - drag.start.x) / state.view.scale, y: drag.origin.y - (q.y - drag.start.y) / state.view.scale }, event);
      updateTransformFields();
    } else if (drag?.type === 'pan') {
      state.view.x = drag.view.x + q.x - drag.start.x; state.view.y = drag.view.y + q.y - drag.start.y;
    } else if (drag?.type === 'points') {
      let dx = (q.x - drag.start.x) / state.view.scale, dy = -(q.y - drag.start.y) / state.view.scale;
      const ctrl = event.ctrlKey || event.metaKey, neighborhood = G.smoothNeighborhood(drag.before, drag.primaryId), tangent = event.altKey && neighborhood;
      const shiftConjugate = event.shiftKey && drag.points.length === 1 && neighborhood?.entry.kind === 'control';
      if (!ctrl && !tangent && !shiftConjugate) {
        const target = snapPoint({ x: drag.anchor.x + dx, y: drag.anchor.y + dy }, event, new Set(drag.points.map(p => p.point.id)));
        dx = target.x - drag.anchor.x; dy = target.y - drag.anchor.y;
      } else state.snapHint = null;
      const result = G.constrainMove(doc, drag.before, new Set(drag.points.map(p => p.point.id)), drag.primaryId, { x: dx, y: dy }, { ctrl, alt: event.altKey, shift: event.shiftKey });
      if (drag.oldPivot) state.pivot = { x: drag.oldPivot.x + result.delta.x, y: drag.oldPivot.y + result.delta.y };
      state.constraintGuide = result.guide;
      if (result.mode) setStatus({ conjugate: 'Shift / Ctrl+Alt：45° 切线 + 对侧柄共线保长', direction: 'Ctrl：水平 / 竖直 / 45°，解除共轭', tangent: 'Alt：沿原三点切线移动' }[result.mode]);
      updateTransformFields();
      const selected = selectedPoint(); if (selected) { setInput('point-x', rounded(selected.point.x)); setInput('point-y', rounded(selected.point.y)); }
    } else if (drag?.type === 'curve') {
      if (G.distance(q, drag.start) > 3 || drag.moved) {
        drag.moved = true; const c = drag.hit.contour, i = drag.hit.index;
        if (!drag.original) {
          if (!c.segments[i].controls.length) c.segments[i] = G.makeSegment(c.nodes[i], c.nodes[(i + 1) % c.nodes.length], 'quartic');
          drag.original = G.clone(c.segments[i].controls);
        }
        const target = snapPoint({ x: drag.origin.x + (q.x - drag.start.x) / state.view.scale, y: drag.origin.y - (q.y - drag.start.y) / state.view.scale }, event, new Set(G.segmentPoints(c, i).map(p => p.id)));
        G.reshapeSegment(c, i, drag.hit.t, { x: target.x - drag.origin.x, y: target.y - drag.origin.y }, drag.original);
      }
    } else if (drag?.type === 'box' || drag?.type === 'shape' || drag?.type === 'knife') {
      drag.current = q;
      if (drag.type === 'shape' && event.shiftKey) { const size = Math.max(Math.abs(q.x - drag.start.x), Math.abs(q.y - drag.start.y)); drag.current = { x: drag.start.x + Math.sign(q.x - drag.start.x || 1) * size, y: drag.start.y + Math.sign(q.y - drag.start.y || 1) * size }; }
    }
    if (!drag && state.drawing) snapPoint(p, event);
    if (drag || state.drawing) requestDraw();
  });
  function endPointer(event, cancelled = false) {
    const drag = state.drag; state.drag = null;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    if (!drag) return;
    state.constraintGuide = null;
    if (cancelled) { if (drag.before) doc = drag.before; if (drag.type === 'pivot') state.pivot = drag.oldPivot; update(); return; }
    if (drag.type === 'frame') record(drag.before, drag.mode === 'scale' ? '已拉伸 / 缩放选择' : '已旋转 / 倾斜选择');
    if (drag.type === 'metric') record(drag.before, '已调整字形度量');
    if (drag.type === 'points') record(drag.before, '已移动节点');
    if (drag.type === 'curve') {
      if (drag.moved) record(drag.before, '已拖动曲线边缘调整形状');
      else if (selectionFrame()) { clearTimeout(clickTimer); clickTimer = setTimeout(() => { if (doc.contours.includes(drag.hit.contour)) insertAtCurve(drag.hit); }, 300); }
      else insertAtCurve(drag.hit);
    }
    if (drag.type === 'knife') {
      if (G.distance(drag.start, drag.current) < 4) {
        const node = hitPoint(drag.start), curve = hitSegment(drag.start);
        if (node?.kind === 'node' || curve) edit('已剪开轮廓', () => {
          if (node?.kind === 'node') G.cutAtNode(doc, node.contour, node.index); else G.cutAtParameter(doc, curve.contour, curve.index, curve.t);
          state.selected.clear(); state.components.clear(); state.segment = null;
        });
      } else edit('已沿剪切线切开轮廓', () => {
        const count = G.cutWithLine(doc, fontPoint(drag.start), fontPoint(drag.current));
        state.selected.clear(); state.components.clear(); state.segment = null; toast(count ? `已剪开 ${count} 处交点` : '剪切线没有穿过可切开的轮廓');
      });
    }
    if (drag.type === 'box') {
      state.selected = drag.initial;
      const minX = Math.min(drag.start.x, drag.current.x), maxX = Math.max(drag.start.x, drag.current.x), minY = Math.min(drag.start.y, drag.current.y), maxY = Math.max(drag.start.y, drag.current.y);
      if (state.tool === 'component') {
        state.components = drag.initialComponents || new Set();
        const contours = doc.contours.filter(c => c.nodes.some(p => { const q = screen(p); return q.x >= minX && q.x <= maxX && q.y >= minY && q.y <= maxY; }));
        selectContours([...new Set(contours.flatMap(members))], true); update(); return;
      }
      if (maxX - minX > 3 || maxY - minY > 3) for (const entry of G.allPoints(doc)) {
        if (entry.kind !== 'node' && (!state.handles || entry.contour.id !== state.contourId)) continue;
        const p = screen(entry.point);
        if (p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY) state.selected.add(entry.point.id);
      }
    }
    if (drag.type === 'shape' && Math.abs(drag.current.x - drag.start.x) > 3 && Math.abs(drag.current.y - drag.start.y) > 3) {
      const a = snapPoint(fontPoint(drag.start), event), b = snapPoint(fontPoint(drag.current), event);
      if (Math.abs(a.x - b.x) > .01 && Math.abs(a.y - b.y) > .01) createShape(a, b, state.tool);
    }
    state.snapHint = null; update();
  }
  canvas.addEventListener('pointerup', event => endPointer(event));
  canvas.addEventListener('pointercancel', event => endPointer(event, true));
  canvas.addEventListener('lostpointercapture', event => { if (state.drag) endPointer(event, true); });
  canvas.addEventListener('dblclick', event => {
    if (selectionFrame() && insideFrame(eventPoint(event))) { clearTimeout(clickTimer); changeFrameMode(state.frameMode === 'scale' ? 'rotate' : 'scale'); return; }
    if (state.tool === 'pen' || state.tool === 'line') { finishDrawing(); update(); }
  });
  canvas.addEventListener('wheel', event => {
    if (preferences.wheelMode === 'ctrl' && !(event.ctrlKey || event.metaKey)) return;
    event.preventDefault(); if (!state.drag) zoom(Math.exp((preferences.invertWheel ? 1 : -1) * event.deltaY * .0015), eventPoint(event));
  }, { passive: false });
  canvas.addEventListener('contextmenu', event => event.preventDefault());
  function createShape(a, b, type) {
    edit(type === 'rect' ? '已绘制矩形' : '已绘制四次椭圆', () => {
      const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
      let c;
      if (type === 'rect') {
        c = G.newContour(G.point(x0, y0)); [[x1, y0], [x1, y1], [x0, y1]].forEach(p => G.append(c, G.point(...p), 'line')); G.closeContour(c);
      } else {
        const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rx = (x1 - x0) / 2, ry = (y1 - y0) / 2, k = 4 / 3 * Math.tan(Math.PI / 8);
        c = G.newContour(G.point(x1, cy));
        for (let i = 0; i < 4; i++) {
          const u = i * Math.PI / 2, v = (i + 1) * Math.PI / 2;
          const end = i === 3 ? c.nodes[0] : G.point(cx + rx * Math.cos(v), cy + ry * Math.sin(v));
          const p = G.elevateCubic([c.nodes.at(-1), { x: cx + rx * (Math.cos(u) - k * Math.sin(u)), y: cy + ry * (Math.sin(u) + k * Math.cos(u)) }, { x: cx + rx * (Math.cos(v) + k * Math.sin(v)), y: cy + ry * (Math.sin(v) - k * Math.cos(v)) }, end]);
          if (i === 3) G.closeContour(c, 'quartic', p.slice(1, -1)); else G.append(c, end, 'quartic', p.slice(1, -1));
        }
      }
      doc.contours.push(c); state.contourId = c.id; state.selected = new Set(c.nodes.map(p => p.id)); state.segment = null;
    });
    setTool('select');
  }
  function deleteSelected() {
    if (!state.selected.size) return;
    edit('已删除选中点；曲线阶数随控制点数量变化', () => {
      G.removeControls(doc, state.selected);
      for (const c of doc.contours) {
        G.removeNodes(c, state.selected);
      }
      doc.contours = doc.contours.filter(c => c.nodes.length); state.selected.clear(); state.components.clear(); state.segment = null; finishDrawing();
    });
  }
  function simplifySelectedControl() {
    const entry = selectedPoint(); if (!entry || entry.kind !== 'control') return false;
    const segment = entry.contour.segments[entry.index]; if (!segment || !segment.controls.includes(entry.point)) return false;
    let error = 0;
    edit('已删除控制点并降低曲线阶数', () => {
      const fit = G.reduceDegreeOne(G.segmentPoints(entry.contour, entry.index)); error = fit.error;
      const remaining = segment.controls.filter(point => point.id !== entry.point.id), controls = fit.points.slice(1, -1);
      if (remaining.length !== controls.length) throw new Error('曲线降阶失败：控制点结构不匹配');
      controls.forEach((point, index) => { remaining[index].x = point.x; remaining[index].y = point.y; });
      segment.controls = remaining; segment.type = G.typeForControls(remaining.length);
      state.selected.clear(); state.segment = { contourId: entry.contour.id, index: entry.index };
    });
    if (error > .000001) toast(`已拟合为低一阶曲线 · 最大控制多边形误差上界 ${Number(error.toFixed(3))}`);
    return true;
  }
  function smoothSelected() {
    const selected = selectedPoint(); if (!selected || selected.kind !== 'node') return;
    const c = selected.contour, i = selected.index, n = c.nodes.length, outgoing = c.segments[i], incoming = c.segments[(i - 1 + n) % n];
    if (!outgoing?.controls.length || !incoming?.controls.length) { toast('平滑节点需要两侧均有控制点'); return; }
    edit('已对齐节点两侧切线', () => {
      const a = incoming.controls.at(-1), b = outgoing.controls[0], p = selected.point;
      const lenA = G.distance(a, p), lenB = G.distance(b, p), len = G.distance(a, b);
      if (len < .0001) return;
      const dx = (b.x - a.x) / len, dy = (b.y - a.y) / len;
      a.x = p.x - dx * lenA; a.y = p.y - dy * lenA; b.x = p.x + dx * lenB; b.y = p.y + dy * lenB;
      p.smooth = true;
    });
  }
  function replaceDocument(next, message, historyId) {
    ++switchToken;
    captureProject(); if (project) project.activeId = null; renderLibrary();
    setStandaloneHistoryId(historyId || 'glyph:' + (next.glyph.unicode || next.glyph.name)); historyGeneration++;
    doc = G.validateDocument(next); state.history = []; state.future = []; timeline = null; finishDrawing();
    state.selected.clear(); state.components.clear(); state.segment = null; state.contourId = doc.contours[0]?.id || null;
    persist(); update(); setStatus(message);
    setTool('select'); fit(); activateHistory(standaloneHistoryId, doc);
  }
  function confirmReplace() { return !doc.contours.length || window.confirm('替换当前字形？可通过撤销恢复；建议先下载 .glyph 保存。'); }
  function download(content, name, mime) {
    const url = URL.createObjectURL(new Blob([content], { type: mime }));
    const a = document.createElement('a'); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }
  function filename(extension) { return (doc.glyph.name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/[. ]+$/g, '') || 'untitled') + extension; }
  function markActiveExported() { captureProject(); const entry = project?.byPath.get(project.activeId); if (entry) entry.exported = G.serialize(doc); renderLibrary(); }
  function saveGlyph() { download(G.serialize(doc), filename('.glyph'), 'application/json'); markActiveExported(); toast('已下载 .glyph v3 · 保留高阶曲线与构件分组'); }
  async function importFile(file) {
    if (!file) return;
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error('文件超过 5 MB 上限');
      const result = G.importText(await file.text(), file.name);
      if (confirmReplace()) { replaceDocument(result.doc, '已导入字形', `file:${file.name}:${file.size}:${file.lastModified || 0}`); toast('已导入 ' + result.doc.glyph.name + (result.warnings.length ? ' · ' + result.warnings.join('；') : ' · ' + result.doc.contours.length + ' 个轮廓')); }
    } catch (error) { toast(error.message, true); }
    $('file-input').value = '';
  }
  function refreshExport() {
    try {
      exportResult = G.svgExport(doc, Number($('export-tolerance').value));
      const curves = doc.contours.reduce((n, c) => n + c.segments.filter(s => s.controls.length).length, 0);
      $('export-summary').textContent = `${curves} 段混合曲线 → ${exportResult.cubicCount} 段三次曲线 · ${doc.contours.length} 个轮廓${exportResult.openCount ? '（' + exportResult.openCount + ' 个开放）' : ' · 全部闭合'}`;
      $('download-svg').disabled = false;
    } catch (error) { exportResult = null; $('export-summary').textContent = error.message; $('download-svg').disabled = true; }
  }
  document.querySelectorAll('[data-tool]').forEach(button => button.addEventListener('click', () => setTool(button.dataset.tool)));
  document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => $(button.dataset.close).close()));
  function updateBooleanUI() {
    const contours = selectedContours(), valid = contours.length >= 2 && contours.every(c => c.closed && c.segments.length >= 2);
    $('boolean-count').textContent = contours.length + ' 条完整轮廓';
    const groups = G.booleanOperands(contours), base = $('boolean-base'), selected = base.value;
    base.replaceChildren();
    groups.forEach((group, i) => { const option = document.createElement('option'); option.value = group[0].id; option.textContent = `${i + 1}. ${group[0].name || '轮廓 ' + (doc.contours.indexOf(group[0]) + 1)}${group.length > 1 ? '（构件 · ' + group.length + ' 轮廓）' : ''}`; base.append(option); });
    if ([...base.options].some(o => o.value === selected)) base.value = selected;
    document.querySelectorAll('[data-boolean]').forEach(button => { button.disabled = !valid || groups.length < 2; });
    base.disabled = groups.length < 2;
  }
  document.querySelectorAll('[data-boolean]').forEach(button => { button.onclick = () => {
    const contours = selectedContours(), ids = new Set(contours.map(c => c.id)), names = { unite: '并集', intersect: '交集', subtract: '差集', exclude: '异或' };
    if (state.drag) return;
    const op = button.dataset.boolean;
    edit('已完成' + names[op] + '布尔运算', () => {
      const result = G.booleanOperation(doc, ids, op, { tolerance: Number($('boolean-tolerance').value), baseId: $('boolean-base').value });
      doc = result.doc; finishDrawing(); state.selected.clear(); state.components.clear(); state.segment = null;
      selectContours(result.contours); toast(result.empty ? '运算结果为空；可撤销恢复' : `已完成${names[op]} · ${result.contours.length} 条结果轮廓`);
    });
  }; });
  function closeSaveMenu() { $('save-options').hidden = true; $('save-options-button').setAttribute('aria-expanded', 'false'); }
  $('save-options-button').onclick = event => { event.stopPropagation(); const open = $('save-options').hidden; $('save-options').hidden = !open; $('save-options-button').setAttribute('aria-expanded', String(open)); };
  document.addEventListener('click', event => { if (!event.target.closest('.save-split')) closeSaveMenu(); });
  function refreshCubicExport() {
    try {
      cubicResult = cubicMode === 'glif' ? G.glifExport(doc, Number($('cubic-tolerance').value)) : G.cubicGlyphExport(doc, Number($('cubic-tolerance').value));
      $('cubic-summary').textContent = `${cubicResult.cubicCount} 段三次 Bézier · ${cubicResult.doc.contours.length} 条轮廓 · 容差 ${$('cubic-tolerance').value} 单位`;
      $('download-cubic').disabled = false;
    } catch (error) { cubicResult = null; $('cubic-summary').textContent = error.message; $('download-cubic').disabled = true; }
  }
  function showCubicExport(mode) {
    closeSaveMenu(); cubicMode = mode; $('cubic-tolerance').value = $('export-tolerance').value;
    $('cubic-dialog-title').textContent = mode === 'glif' ? '保存 UFO .glif' : '保存三次 Bézier .glyph';
    $('cubic-description').textContent = mode === 'glif' ? '标准 GLIF 2 单字形 XML，包含轮廓、字宽与 Unicode；导入 UFO 工程时需由目标软件登记字形。' : '本工具原生 JSON 格式，曲线统一转为三次。它不等同于 Glyphs 软件的 .glyph 格式；跨软件交换请选择 GLIF 或 SVG。';
    $('download-cubic').textContent = mode === 'glif' ? '下载 .glif' : '下载三次 .glyph'; refreshCubicExport(); $('cubic-dialog').showModal();
  }
  $('save-cubic').onclick = () => showCubicExport('cubic'); $('save-glif').onclick = () => showCubicExport('glif'); $('cubic-tolerance').onchange = refreshCubicExport;
  $('download-cubic').onclick = () => { refreshCubicExport(); if (!cubicResult) return; download(cubicResult.text, filename(cubicMode === 'glif' ? '.glif' : '.cubic.glyph'), cubicMode === 'glif' ? 'application/xml' : 'application/json'); markActiveExported(); $('cubic-dialog').close(); toast('已下载三次曲线副本；原始高阶曲线保留在画布'); };
  function captureProject() {
    if (project?.activeId) project.capture(project.activeId, doc, state.history, state.future, state.view);
  }
  function setLibraryExpanded(expanded) {
    $('glyph-library').classList.toggle('collapsed', !expanded); $('library-toggle').setAttribute('aria-expanded', String(expanded));
    $('library-toggle').setAttribute('aria-label', expanded ? '收起字形文件夹' : '展开字形文件夹');
  }
  function renderLibrary() {
    $('library-export').disabled = !project?.entries.length || projectExportBusy;
    const list = $('library-list'); list.replaceChildren();
    $('library-title').textContent = project?.name || '字形文件夹';
    $('library-count').textContent = project ? `${project.entries.length} 个文件 · ${project.changedCount} 已修改` : '未导入';
    $('library-scratch').hidden = !standaloneSession || !project?.activeId;
    if (!project) {
      const empty = document.createElement('p'); empty.className = 'library-empty'; empty.textContent = '导入文件夹后，在这里浏览 .glyph / .glif / .svg / .json。'; list.append(empty);
      $('library-page-label').textContent = '0 / 0'; $('library-prev').disabled = $('library-next').disabled = true; return;
    }
    const search = $('library-search').value.trim().toLowerCase(), modifiedOnly = $('library-changed').checked;
    const entries = project.entries.filter(e => (!modifiedOnly || e.modified) && (!search || (e.path + ' ' + (e.doc?.glyph.name || '') + ' ' + (e.doc?.glyph.unicode || '')).toLowerCase().includes(search)));
    const limit = pageSize === 'all' ? entries.length || 1 : Math.max(1, Number(pageSize) || 60);
    const pages = Math.max(1, Math.ceil(entries.length / limit)); libraryPage = Math.max(0, Math.min(libraryPage, pages - 1));
    const visibleEntries = entries.slice(libraryPage * limit, (libraryPage + 1) * limit);
    for (const entry of visibleEntries) {
      const button = document.createElement('button'); button.className = 'glyph-file' + (entry.id === project.activeId ? ' active' : '') + (entry.error ? ' error' : ''); button.dataset.path = entry.path;
      button.setAttribute('role', 'option'); button.setAttribute('aria-selected', String(entry.id === project.activeId)); button.title = entry.path + (entry.error ? '\n' + entry.error : entry.warnings.length ? '\n' + entry.warnings.join('；') : '');
      const icon = document.createElement('span'); icon.className = 'glyph-file-thumb';
      icon.textContent = entry.error ? '!' : entry.doc?.glyph.unicode ? String.fromCodePoint(parseInt(entry.doc.glyph.unicode, 16)) : entry.doc?.glyph.name.length === 1 ? entry.doc.glyph.name : 'a';
      if (entry.doc && !entry.error) {
        try {
          const signature = G.serialize(entry.doc);
          if (entry.thumbnailKey !== signature) {
            const bounds = G.bounds(entry.doc), padding = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY, 1) * .08;
            const svg = G.svgExport(entry.doc, 1).svg.replace(/viewBox="[^"]*"/, `viewBox="${bounds.minX - padding} ${-bounds.maxY - padding} ${Math.max(1, bounds.maxX - bounds.minX + padding * 2)} ${Math.max(1, bounds.maxY - bounds.minY + padding * 2)}"`);
            entry.thumbnail = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg); entry.thumbnailKey = signature;
          }
          const image = document.createElement('img'); image.src = entry.thumbnail; image.alt = ''; icon.replaceChildren(image);
        } catch (_) { /* Keep the name/Unicode placeholder for extreme outlines. */ }
      }
      const info = document.createElement('span'); info.className = 'glyph-file-info';
      const name = document.createElement('span'); name.className = 'glyph-file-name'; name.textContent = entry.doc?.glyph.name || entry.path.split('/').at(-1);
      const path = document.createElement('span'); path.className = 'glyph-file-path'; path.textContent = entry.path;
      const status = document.createElement('span'); status.className = 'glyph-file-status'; status.textContent = entry.error ? '错误' : entry.modified ? entry.exported === G.serialize(entry.doc) ? '已导出' : '●' : G.fileExtension(entry.path).toUpperCase();
      info.append(name, path); button.append(icon, info, status); button.onclick = () => switchProjectGlyph(entry.id); list.append(button);
    }
    if (!entries.length) { const empty = document.createElement('p'); empty.className = 'library-empty'; empty.textContent = '没有匹配的字形'; list.append(empty); }
    $('library-page-label').textContent = `${libraryPage + 1} / ${pages}`;
    $('library-prev').disabled = libraryPage <= 0; $('library-next').disabled = libraryPage >= pages - 1;
    if (!libraryHydrating && visibleEntries.some(entry => !entry.doc && !entry.error)) {
      const owner = project, pending = visibleEntries.filter(entry => !entry.doc && !entry.error);
      libraryHydrating = true; $('library-progress').textContent = '缩略图…';
      setTimeout(() => Promise.all(pending.map(entry => owner.load(entry.id).catch(() => null))).finally(() => {
        libraryHydrating = false;
        if (owner === project) { $('library-progress').textContent = '本地文件'; renderLibrary(); }
      }), 0);
    }
  }
  async function switchProjectGlyph(id) {
    if (!project || id === project.activeId || projectExportBusy) return;
    const owner = project, token = ++switchToken; captureProject();
    $('library-progress').textContent = '正在读取…';
    try {
      const entry = await owner.load(id);
      if (owner !== project || token !== switchToken) return;
      captureProject();
      if (!project.activeId) standaloneSession = { doc: G.clone(doc), history: state.history, future: state.future, view: { ...state.view } };
      clearTimeout(clickTimer); clearTimeout(saveTimer); finishDrawing(); state.drag = null; state.selected.clear(); state.components.clear(); state.segment = null; state.pivot = null;
       project.activeId = id; doc = G.clone(entry.doc); state.history = entry.history; state.future = entry.future; timeline = null; historyGeneration++; state.contourId = doc.contours[0]?.id || null;
      setTool('select'); if (entry.view) { state.view = { ...entry.view }; state.fitMode = false; updateZoom(); requestDraw(); } else fit();
       persist(); renderLibrary(); setStatus('文件夹 · ' + entry.path); activateHistory(historyKey(), doc);
      if (entry.warnings.length) toast(entry.warnings.join('；'));
    } catch (error) { if (owner === project && token === switchToken) { renderLibrary(); toast('无法打开字形：' + error.message, true); } }
    finally { if (owner === project && token === switchToken) $('library-progress').textContent = '本地文件'; }
  }
  function restoreStandalone() {
    if (!standaloneSession || !project) return;
    ++switchToken; captureProject(); const session = standaloneSession;
    project.activeId = null; doc = G.clone(session.doc); state.history = session.history; state.future = session.future; state.view = { ...session.view }; setStandaloneHistoryId(session.historyId || standaloneHistoryId); timeline = null; historyGeneration++;
    finishDrawing(); state.selected.clear(); state.components.clear(); state.segment = null; state.contourId = doc.contours[0]?.id || null; state.fitMode = false;
    update(); updateZoom(); persist(); renderLibrary(); setStatus('独立字形');
  }
  async function importFolder(files) {
    if (!files?.length) return;
    if (projectExportBusy) { toast('请等待当前文件夹导出完成'); return; }
    captureProject();
    if (project?.pendingCount && !window.confirm(`当前文件夹还有 ${project.pendingCount} 个未导出的修改。替换文件夹将关闭这些工作区，是否继续？`)) { $('folder-input').value = ''; return; }
    try {
      const next = new G.GlyphProject(files);
      if (!next.entries.length) throw new Error('该文件夹没有 .glyph / .glif / .svg / .json 文件');
      ++switchToken;
      // Keep the currently visible glyph as a recoverable standalone session.
      standaloneSession = { doc: G.clone(doc), history: state.history, future: state.future, view: { ...state.view }, historyId: standaloneHistoryId };
      project = next; libraryPage = 0; $('library-search').value = ''; $('library-changed').checked = false;
      if (pageSize === 'all' && next.entries.length > 1000 && !window.confirm(`该文件夹有 ${next.entries.length} 个字形。显示全部可能影响性能，是否继续？`)) { pageSize = preferences.pageSize = '200'; storePreferences(); }
      setLibraryExpanded(true); renderLibrary(); toast(`已载入 ${next.entries.length} 个字形文件；当前页缩略图正在生成`);
    } catch (error) { toast(error.message, true); }
    $('folder-input').value = '';
  }
  const chooseFolder = () => $('folder-input').click();
  $('folder-button').onclick = $('library-replace').onclick = $('library-open-collapsed').onclick = chooseFolder;
  $('folder-input').onchange = () => importFolder([...$('folder-input').files]);
  $('library-toggle').onclick = () => setLibraryExpanded($('glyph-library').classList.contains('collapsed'));
  $('library-search').oninput = $('library-changed').onchange = () => { libraryPage = 0; renderLibrary(); };
  $('library-prev').onclick = () => { libraryPage--; renderLibrary(); }; $('library-next').onclick = () => { libraryPage++; renderLibrary(); };
  $('library-scratch').onclick = restoreStandalone;
  $('library-export').onclick = () => { captureProject(); $('project-export-summary').textContent = `${project.entries.length} 个文件，${project.changedCount} 个修改项`; $('project-export-dialog').showModal(); };
  $('download-project').onclick = async () => {
    if (!project || projectExportBusy) return;
    captureProject(); projectExportBusy = true; $('download-project').disabled = true;
    $('project-export-dialog').querySelectorAll('[data-close]').forEach(button => { button.disabled = true; });
    try {
      const mode = $('project-export-format').value, changedOnly = $('project-export-scope').value === 'changed', tolerance = Number($('project-export-tolerance').value);
      const batch = await project.exportFiles({ mode, changedOnly, tolerance, progress: (n, total) => { $('project-export-summary').textContent = `正在转换 ${n} / ${total}…`; } });
      const encoder = new TextEncoder(), files = Object.create(null);
      batch.files.forEach(file => { files[file.path] = encoder.encode(file.text); });
      const report = { application: 'higher-degree-glyph-designer', version: '0.3.1', mode, tolerance, exportedFiles: batch.files.map(f => f.path), skipped: batch.errors, note: '字形集合，不是完整 UFO 工程；修改原始高阶数据请保存 native .glyph。' };
      let reportPath = '_higher-degree-export-report.json'; while (files[reportPath]) reportPath = '_' + reportPath;
      files[reportPath] = encoder.encode(JSON.stringify(report, null, 2));
      const zipped = await new Promise((resolve, reject) => fflate.zip(files, { level: 6 }, (error, data) => error ? reject(error) : resolve(data)));
      download(zipped, project.name.replace(/[<>:"/\\|?*]/g, '_') + '-' + mode + '.zip', 'application/zip');
      batch.entries.forEach(entry => { entry.exported = G.serialize(entry.doc); });
      $('project-export-summary').textContent = `已导出 ${batch.files.length} 个字形${batch.errors.length ? `，跳过 ${batch.errors.length} 个错误文件（详见 ZIP 报告）` : ''}`;
      toast('文件夹 ZIP 已下载' + (batch.errors.length ? '；有跳过项，请检查导出报告' : ''));
    } catch (error) { $('project-export-summary').textContent = error.message; toast(error.message, true); }
    finally { projectExportBusy = false; $('download-project').disabled = false; $('project-export-dialog').querySelectorAll('[data-close]').forEach(button => { button.disabled = false; }); renderLibrary(); }
  };
  $('project-export-dialog').addEventListener('cancel', event => { if (projectExportBusy) event.preventDefault(); });
  document.querySelector('.brand').addEventListener('click', event => { event.preventDefault(); fit(); });
  $('undo-button').onclick = undo; $('redo-button').onclick = redo;
  $('new-button').onclick = () => { if (confirmReplace()) replaceDocument(G.emptyDocument(), '已新建字形', 'draft:' + G.uid()); };
  $('import-button').onclick = () => $('file-input').click(); $('save-button').onclick = saveGlyph;
  $('file-input').onchange = () => importFile($('file-input').files[0]);
  $('export-button').onclick = () => { refreshExport(); $('export-dialog').showModal(); };
  $('export-tolerance').onchange = refreshExport;
  $('download-svg').onclick = () => { refreshExport(); if (!exportResult) return; download(exportResult.svg, filename('.svg'), 'image/svg+xml'); $('export-dialog').close(); toast('已导出 ' + exportResult.cubicCount + ' 段三次曲线 SVG'); };
  $('help-button').onclick = $('shortcut-button').onclick = () => $('help-dialog').showModal();
  $('empty-pen').onclick = () => setTool('pen');
  $('load-sample').onclick = $('reset-sample').onclick = () => { if (confirmReplace()) { replaceDocument(G.sampleDocument(), '已载入示例', 'sample:a'); $('help-dialog').close(); } };
  $('fit-button').onclick = fit; $('zoom-in').onclick = () => zoom(1.2); $('zoom-out').onclick = () => zoom(1 / 1.2); $('zoom-label').onclick = () => zoom(1 / state.view.scale);
  $('outline-button').onclick = () => setFill(false); $('fill-button').onclick = () => setFill(true);
  $('grid-button').onclick = () => { state.grid = !state.grid; $('grid-button').classList.toggle('is-on', state.grid); $('grid-button').setAttribute('aria-pressed', String(state.grid)); requestDraw(); };
  $('snap-button').onclick = () => { state.snap = !state.snap; savePreferences(); update(); toast(state.snap ? `已开启 ${state.gridStep} 单位网格吸附 · Alt 临时关闭全部吸附` : '已关闭网格吸附'); };
  $('snap-nodes').onchange = () => { state.snapNodes = $('snap-nodes').checked; savePreferences(); update(); };
  $('snap-edges').onchange = () => { state.snapEdges = $('snap-edges').checked; savePreferences(); update(); };
  $('grid-step').onchange = () => {
    const n = Number($('grid-step').value);
    if (!Number.isFinite(n) || n < .001 || n > 10000) { $('grid-step').value = state.gridStep; toast('网格间距须为 0.001–10,000 单位', true); return; }
    state.gridStep = n; savePreferences(); update();
  };
  $('coordinate-precision').onchange = () => { state.precision = Number($('coordinate-precision').value); savePreferences(); update(); };
  $('max-control-points').onchange = () => {
    const raw = $('max-control-points').value.trim(), value = raw === '' ? null : Number(raw);
    if (value !== null && (!Number.isSafeInteger(value) || value < 0)) { $('max-control-points').value = state.maxControls ?? ''; toast('上限须为非负整数，或留空表示不限', true); return; }
    state.maxControls = value; savePreferences(); update(); toast(value === null ? '控制点上限：不限；右键始终加控制点' : `每段上限 ${value} 个；现有曲线不会自动降阶`);
  };
  $('handles-toggle').onchange = () => { state.handles = $('handles-toggle').checked; requestDraw(); };
  $('smooth-button').onclick = smoothSelected;
  $('split-button').onclick = () => { const selected = selectedSegment(); if (selected) edit('已精确分割曲线', () => { const p = G.splitSegment(selected.contour, selected.index, .5); state.selected = new Set([p.id]); state.segment = null; }); };
  $('convert-button').onclick = () => {
    const selected = selectedSegment(); if (!selected) return;
    setDegree(selected.segment.controls.length ? 0 : 3);
  };
  function setDegree(count) {
    const selected = selectedSegment(); if (!selected) return;
    if (!Number.isInteger(count) || count < 0 || count > 19998 || G.allPoints(doc).length + count - selected.segment.controls.length > 20000) { toast('控制点数量须为非负整数，并保持文档总点数不超过 20,000', true); $('degree-select').value = selected.segment.controls.length; return; }
    if (state.maxControls !== null && count > state.maxControls && count > selected.segment.controls.length) { toast('目标数量超过所设上限，请先提高或清空上限', true); $('degree-select').value = selected.segment.controls.length; return; }
    edit('已更改曲线阶数', () => {
      const s = selected.segment;
      while (s.controls.length < count) G.addControl(selected.contour, selected.index);
      while (s.controls.length > count) s.controls.splice(Math.floor(s.controls.length / 2), 1);
      s.type = G.typeForControls(count); state.selected.clear();
    });
  }
  $('degree-select').onchange = () => setDegree(Number($('degree-select').value));
  $('close-contour').onclick = () => { const c = activeContour(); if (c) edit('轮廓已闭合', () => { G.closeContour(c, G.typeForControls(state.pending.length), state.pending); finishDrawing(); }); };
  $('reverse-contour').onclick = () => { const contours = selectedContours().length ? selectedContours() : [activeContour()].filter(Boolean); if (contours.length) edit('已倒转所选构件曲线方向', () => { contours.forEach(G.reverseContour); finishDrawing(); state.segment = null; }); };
  $('delete-contour').onclick = () => {
    const contours = new Set(selectedContours().length ? selectedContours() : [activeContour()].filter(Boolean));
    if (contours.size) edit('已删除所选构件 / 轮廓', () => { doc.contours = doc.contours.filter(c => !contours.has(c)); state.selected.clear(); state.components.clear(); finishDrawing(); });
  };
  $('corner-button').onclick = () => edit('已设为角点，取消切线联动', () => G.allPoints(doc).filter(p => p.kind === 'node' && state.selected.has(p.point.id)).forEach(p => { p.point.smooth = false; }));
  $('start-point').onclick = () => { const p = selectedPoint(); if (p?.kind === 'node' && p.contour.closed) edit('已更改轮廓起点', () => { G.setStartPoint(p.contour, p.index); state.segment = null; }); };
  $('round-selection').onclick = () => roundPoints(false);
  $('round-glyph').onclick = () => roundPoints(true);
  $('add-extrema').onclick = () => edit('已添加极值点，保持曲线形状', () => { const count = G.addExtrema(selectedContours().length ? selectedContours() : doc.contours); state.segment = null; toast(count ? `已添加 ${count} 个极值节点` : '当前曲线不需要新增极值点'); });
  function roundPoints(all) {
    edit(all ? '已对整个字形的节点和控制点取整' : '已对选中节点 / 控制点取整', () => {
      for (const { point: p } of G.allPoints(doc)) if (all || state.selected.has(p.id)) { p.x = Math.round(p.x); p.y = Math.round(p.y); }
    });
  }
  $('join-points').onclick = () => {
    const points = G.allPoints(doc).filter(p => p.kind === 'node' && state.selected.has(p.point.id));
    if (points.length !== 2) return;
    try { edit('已连接端点', () => { const c = G.joinEndpoints(doc, ...points); state.contourId = c.id; state.selected.clear(); state.components.clear(); state.segment = null; }); }
    catch (error) { toast(error.message, true); }
  };
  function groupContours(ungroup = false) {
    const contours = selectedContours();
    if ((!ungroup && contours.length < 2) || !contours.length) return;
    edit(ungroup ? '已取消构件组合' : '已组合为一个构件', () => {
      const group = newComponentId();
      if (ungroup) { const groups = new Set(contours.map(c => c.component).filter(Boolean)); for (const c of doc.contours) if (groups.has(c.component)) delete c.component; }
      else contours.forEach(c => { c.component = group; });
      selectContours(contours);
    });
  }
  $('group-contours').onclick = () => groupContours(); $('ungroup-contours').onclick = () => groupContours(true);
  function copyContours() {
    const contours = selectedContours().length ? selectedContours() : [activeContour()].filter(Boolean);
    if (!contours.length) return;
    clipboard = G.clone(contours); update(); toast(`已复制 ${contours.length} 条轮廓到编辑器剪贴板`);
  }
  function pasteContours() {
    if (!clipboard) return;
    edit('已粘贴构件', () => {
      const copies = G.validateDocument({ ...doc, contours: clipboard }).contours, groups = new Map();
      for (const c of copies) if (c.component) { if (!groups.has(c.component)) groups.set(c.component, newComponentId()); c.component = groups.get(c.component); }
      G.allPoints({ contours: copies }).forEach(({ point: p }) => { p.x += 20; p.y += 20; });
      doc.contours.push(...copies); selectContours(copies);
    });
  }
  $('copy-contours').onclick = copyContours; $('paste-contours').onclick = pasteContours;
  function transformSelection(options) {
    const points = $('transform-scope').value === 'glyph' ? G.allPoints(doc).map(p => p.point) : movablePoints().map(p => p.point);
    if (!points.length) { toast('请先选择节点或构件，或将作用范围设为整个字形'); return; }
    const bounds = G.pointBounds(points), origin = $('transform-origin').value === 'zero' ? { x: 0, y: 0 } : state.pivot || G.frameReference(bounds, state.anchor);
    edit('已应用变换', () => G.applyAffine(points, G.affineMatrix(options, origin)));
    if (state.pivot && (options.dx || options.dy)) { state.pivot.x += options.dx || 0; state.pivot.y += options.dy || 0; update(); }
  }
  document.querySelectorAll('[data-anchor]').forEach(button => { button.onclick = () => { state.anchor = button.dataset.anchor; state.pivot = null; $('transform-origin').value = 'center'; savePreferences(); update(); }; });
  $('frame-scale').onclick = () => changeFrameMode('scale'); $('frame-rotate').onclick = () => changeFrameMode('rotate');
  $('lock-aspect').onchange = () => { state.lockAspect = $('lock-aspect').checked; };
  $('reset-pivot').onclick = () => { state.pivot = null; update(); };
  for (const axis of ['x', 'y']) {
    $('pivot-' + axis).onchange = () => {
      const frame = selectionFrame(), raw = $('pivot-' + axis).value.trim(), value = Number(raw);
      if (!frame) return;
      if (!raw || !Number.isFinite(value) || Math.abs(value) > 1e6) { toast('请输入有效的变换中心坐标', true); $('pivot-' + axis).value = rounded(frame.origin[axis]); return; }
      state.pivot = { ...frame.origin, [axis]: value }; update();
    };
    $('selection-' + axis).onchange = () => {
      const frame = selectionFrame(), raw = $('selection-' + axis).value.trim(), value = Number(raw);
      if (!frame) return;
      if (!raw || !Number.isFinite(value) || Math.abs(value) > 1e6) { toast('请输入有效的选择坐标', true); $('selection-' + axis).value = rounded(frame.origin[axis]); return; }
      const delta = value - frame.origin[axis];
      edit('已按参考点调整选择坐标', () => G.applyAffine(frame.entries.map(p => p.point), G.affineMatrix(axis === 'x' ? { dx: delta } : { dy: delta })));
      if (state.pivot) state.pivot[axis] += delta; update();
    };
  }
  for (const [id, axis] of [['selection-width', 'x'], ['selection-height', 'y']]) $(id).onchange = () => {
    const frame = selectionFrame(), raw = $(id).value.trim(), value = Number(raw); if (!frame) return;
    const size = axis === 'x' ? frame.bounds.maxX - frame.bounds.minX : frame.bounds.maxY - frame.bounds.minY;
    if (!raw || !Number.isFinite(value) || value < 0 || value > 2e6 || size < 1e-10) { toast('请输入有效的尺寸；零宽或零高方向不能比例拉伸', true); $(id).value = rounded(size); return; }
    const ratio = value / size, sx = axis === 'x' || state.lockAspect ? ratio : 1, sy = axis === 'y' || state.lockAspect ? ratio : 1;
    edit('已按参考点调整选择尺寸', () => G.applyAffine(frame.entries.map(p => p.point), G.affineMatrix({ scaleX: sx, scaleY: sy }, frame.origin)));
  };
  $('selection-reverse').onclick = () => $('reverse-contour').click();
  $('apply-transform').onclick = () => {
    const ids = ['scale-x', 'scale-y', 'rotate-angle', 'translate-x', 'translate-y'];
    const values = ids.map(id => $(id).value.trim() ? Number($(id).value) : NaN);
    if (values.some(v => !Number.isFinite(v)) || Math.abs(values[0]) > 10000 || Math.abs(values[1]) > 10000 || Math.abs(values[2]) > 36000) { toast('请输入有效的缩放、角度和位移数值', true); return; }
    transformSelection({ scaleX: values[0] / 100, scaleY: values[1] / 100, angle: values[2], dx: values[3], dy: values[4] });
  };
  $('flip-x').onclick = () => transformSelection({ scaleX: -1 }); $('flip-y').onclick = () => transformSelection({ scaleY: -1 });
  function alignSelection(mode) {
    const axis = /left|right|center-x|distribute-x/.test(mode) ? 'x' : 'y', distributed = mode.startsWith('distribute');
    const selectedNodes = G.allPoints(doc).filter(p => p.kind === 'node' && state.selected.has(p.point.id));
    let units;
    if (state.tool === 'component') {
      const groups = new Map(); for (const c of selectedContours()) { const key = c.component || c.id; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(c); }
      units = [...groups.values()].map(contours => ({ points: G.allPoints({ contours }).map(p => p.point) }));
    } else units = selectedNodes.map(p => ({ node: p.point, points: [p.point] }));
    if (units.length < (distributed ? 3 : 2)) { toast(distributed ? '等距分布至少需要 3 个节点或构件' : '对齐至少需要 2 个节点或构件'); return; }
    for (const unit of units) { const b = G.pointBounds(unit.points); unit.min = axis === 'x' ? b.minX : b.minY; unit.max = axis === 'x' ? b.maxX : b.maxY; unit.center = (unit.min + unit.max) / 2; }
    const min = Math.min(...units.map(u => u.min)), max = Math.max(...units.map(u => u.max));
    if (distributed) units.sort((a, b) => a.center - b.center);
    const first = units[0].center, last = units.at(-1).center;
    const deltas = new Map();
    edit(distributed ? '已等距分布选择' : '已对齐选择', () => {
      units.forEach((unit, i) => {
        const delta = distributed ? first + (last - first) * i / (units.length - 1) - unit.center : ['left', 'bottom'].includes(mode) ? min - unit.min : ['right', 'top'].includes(mode) ? max - unit.max : (min + max) / 2 - unit.center;
        if (unit.node) deltas.set(unit.node.id, delta); else unit.points.forEach(p => { p[axis] += delta; });
      });
      if (deltas.size) for (const c of doc.contours) {
        c.nodes.forEach(p => { if (deltas.has(p.id)) p[axis] += deltas.get(p.id); });
      }
    });
  }
  document.querySelectorAll('[data-align]').forEach(button => { button.onclick = () => alignSelection(button.dataset.align); });
  const metadataBindings = [['glyph-name', 'name'], ['glyph-unicode', 'unicode'], ...['upm', 'advanceWidth', 'ascender', 'descender', 'capHeight', 'xHeight'].map(key => ['metric-' + key, key])];
  metadataBindings.forEach(([id, key]) => $(id).addEventListener('change', () => {
    let value = $(id).value.trim();
    if (key === 'unicode') {
      const quoted = value.match(/^"([\s\S]*)"$/);
      if (quoted) {
        const chars = Array.from(quoted[1]);
        if (chars.length !== 1) { $(id).value = doc.glyph.unicode; toast('引号内请输入一个 Unicode 字符', true); return; }
        value = chars[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
      } else value = value.toUpperCase().replace(/^U\+/, '');
    }
    if (!['name', 'unicode'].includes(key)) value = value === '' ? NaN : Number(value);
    const next = G.clone(doc); next.glyph[key] = value;
    try { G.validateDocument(next); edit('已更新字形属性', () => { doc.glyph[key] = value; }); $(id).value = value; }
    catch (error) { $(id).value = doc.glyph[key]; toast(error.message, true); }
  }));
  ['x', 'y'].forEach(axis => $('point-' + axis).addEventListener('change', () => {
    const p = selectedPoint(); if (!p) return;
    const raw = $('point-' + axis).value.trim(), value = state.precision < 0 ? Number(raw) : rounded(Number(raw));
    if (!raw || !Number.isFinite(value) || Math.abs(value) > 1e6) { $('point-' + axis).value = rounded(p.point[axis]); toast('坐标必须在 ±1,000,000 以内', true); return; }
    edit('已精确调整坐标', () => { const delta = value - p.point[axis], moving = movablePoints(); moving.forEach(entry => { entry.point[axis] = Math.max(-1e6, Math.min(1e6, entry.point[axis] + delta)); }); }); $('point-' + axis).value = value;
  }));
  $('history-button').onclick = () => { $('history-panel').hidden = !$('history-panel').hidden; $('history-button').setAttribute('aria-pressed', String(!$('history-panel').hidden)); renderHistory(); };
  $('history-hide').onclick = () => { $('history-panel').hidden = true; $('history-button').setAttribute('aria-pressed', 'false'); };
  $('settings-button').onclick = () => { updateUI(); $('settings-dialog').showModal(); };
  $('pref-theme').onchange = event => { preferences.theme = event.target.value; storePreferences(); requestDraw(); };
  $('pref-palette').onchange = event => { preferences.palette = event.target.value; storePreferences(); requestDraw(); };
  $('pref-contrast').onchange = event => { preferences.contrast = event.target.checked; storePreferences(); requestDraw(); };
  $('pref-font').onchange = event => { const value = event.target.value.trim().replace(/[;{}<>]/g, '').slice(0, 240); preferences.fontFamily = value || defaults.fontFamily; event.target.value = preferences.fontFamily; storePreferences(); };
  $('pref-wheel-mode').onchange = event => { preferences.wheelMode = event.target.value; storePreferences(); };
  $('pref-wheel-invert').onchange = event => { preferences.invertWheel = event.target.checked; storePreferences(); };
  $('pref-history-limit').onchange = event => $('history-limit').value = event.target.value;
  function updateHistoryLimit(raw) {
    const value = Math.max(10, Math.min(1000, Math.round(Number(raw) || 100))); preferences.historyLimit = value;
    state.history = state.history.slice(-value); state.future = state.future.slice(0, value);
    $('pref-history-limit').value = value;
    if (timeline && timeline.items.length > value + 1) { const remove = timeline.items.length - value - 1; timeline.items.splice(0, remove); timeline.cursor = Math.max(0, timeline.cursor - remove); }
    storePreferences(); renderHistory(); writeTimeline();
  }
  $('history-limit').onchange = event => updateHistoryLimit(event.target.value);
  $('pref-history-limit').addEventListener('change', event => updateHistoryLimit(event.target.value));
  $('pref-page-size').onchange = event => setPageSize(event.target.value);
  $('library-page-size').onchange = event => setPageSize(event.target.value);
  $('pref-history-storage').onchange = async event => {
    if (!event.target.checked && !window.confirm('关闭本地历史会暂停保存所有文件与文件夹的新操作，已有记录会保留。是否继续？')) { event.target.checked = true; return; }
    preferences.persistHistory = event.target.checked;
    storePreferences();
    if (preferences.persistHistory) {
      const key = historyKey(), saved = await dbRequest('readonly', store => store.get(key));
      if ((!timeline || timeline.key !== key || timeline.items.length <= 1) && saved?.items?.length) timeline = saved;
      if (!timeline || timeline.key !== key) timeline = { key, label: doc.glyph.name, items: [], cursor: -1 };
      const recoveryStates = [...state.history, G.clone(doc)];
      for (const snapshot of recoveryStates) {
        const current = timeline.items[timeline.cursor]?.doc;
        if (current && G.serialize(current) === G.serialize(snapshot)) continue;
        timeline.items.splice(timeline.cursor + 1);
        timeline.items.push({ doc: G.clone(snapshot), label: '恢复编辑历史', time: Date.now() }); timeline.cursor = timeline.items.length - 1;
      }
      if (!timeline.items.length) { timeline.items.push({ doc: G.clone(doc), label: '当前状态', time: Date.now() }); timeline.cursor = 0; }
      if (timeline.items.length > preferences.historyLimit + 1) { const remove = timeline.items.length - preferences.historyLimit - 1; timeline.items.splice(0, remove); timeline.cursor = Math.max(0, timeline.cursor - remove); }
      state.history = timeline.items.slice(0, timeline.cursor).map(item => G.clone(item.doc));
      state.future = timeline.items.slice(timeline.cursor + 1).map(item => G.clone(item.doc)).reverse();
      writeTimeline(); renderHistory(); update();
    }
  };
  function changeHistoryStatus(keys, paused) {
    const next = new Set(preferences.closedHistoryKeys);
    keys.forEach(key => paused ? next.add(key) : next.delete(key)); preferences.closedHistoryKeys = [...next]; storePreferences();
    if (!paused) writeTimeline(); renderHistory(); renderHistoryManager();
  }
  $('history-manage').onclick = async () => { await renderHistoryManager(); $('history-manage-dialog').showModal(); };
  $('history-delete-selected').onclick = async () => {
    const keys = [...$('history-records').querySelectorAll('input:checked')].map(input => input.value);
    if (!keys.length) return toast('请先选择要删除的历史记录');
    if (!window.confirm(`将永久删除 ${keys.length} 个字形的本地历史，是否继续？`)) return;
    await dbRequest('readwrite', store => { keys.forEach(key => store.delete(key)); return null; });
    if (keys.includes(historyKey())) { timeline = { key: historyKey(), label: doc.glyph.name, items: [{ doc: G.clone(doc), label: '当前状态', time: Date.now() }], cursor: 0 }; state.history = []; state.future = []; }
    writeTimeline(); await renderHistoryManager(); renderHistory(); toast('已删除所选历史记录');
  };
  $('history-pause-current').onclick = () => {
    if (!window.confirm('暂停为当前字形保存后续编辑历史？已有记录会保留。')) return;
    changeHistoryStatus([historyKey()], true); toast('当前字形历史已暂停');
  };
  $('history-pause-selected').onclick = () => {
    const keys = [...$('history-records').querySelectorAll('input:checked')].map(input => input.value);
    if (!keys.length) return toast('请先选择历史记录');
    if (!window.confirm(`暂停为 ${keys.length} 个字形保存后续历史？已有记录会保留。`)) return;
    changeHistoryStatus(keys, true);
  };
  $('history-resume-selected').onclick = () => {
    const keys = [...$('history-records').querySelectorAll('input:checked')].map(input => input.value);
    if (!keys.length) return toast('请先选择历史记录'); changeHistoryStatus(keys, false); toast('已恢复所选历史记录');
  };
  async function changeFolderHistoryStatus(paused) {
    if (!project) return toast('请先导入字形文件夹');
    const keys = project.entries.map(entry => projectHistoryPrefix() + entry.id);
    if (!keys.length) return toast('当前文件夹没有字形');
    if (paused && !window.confirm(`暂停为当前文件夹 ${keys.length} 个字形保存后续历史？已有记录会保留。`)) return;
    changeHistoryStatus(keys, paused); toast(paused ? '已暂停当前文件夹历史' : '已恢复当前文件夹历史');
  }
  $('history-pause-folder').onclick = () => changeFolderHistoryStatus(true);
  $('history-resume-folder').onclick = () => changeFolderHistoryStatus(false);
  $('history-delete-folder').onclick = async () => {
    if (!project) return toast('请先导入字形文件夹');
    const prefix = projectHistoryPrefix(), entries = (await dbRequest('readonly', store => store.getAll()) || []).filter(entry => entry.key.startsWith(prefix));
    if (!entries.length) return toast('当前文件夹没有已保存的历史');
    if (!window.confirm(`将永久删除当前文件夹 ${entries.length} 个字形的本地历史，是否继续？`)) return;
    await dbRequest('readwrite', store => { entries.forEach(entry => store.delete(entry.key)); return null; });
    timeline = { key: historyKey(), label: doc.glyph.name, items: [{ doc: G.clone(doc), label: '当前状态', time: Date.now() }], cursor: 0 };
    state.history = []; state.future = []; writeTimeline(); await renderHistoryManager(); renderHistory(); update();
  };
  $('history-clear-current').onclick = async () => {
    if (!timeline || !window.confirm(`删除“${timeline.label}”的全部历史？该操作无法恢复。`)) return;
    await dbRequest('readwrite', store => store.delete(timeline.key));
    timeline = { key: historyKey(), label: doc.glyph.name, items: [{ doc: G.clone(doc), label: '当前状态', time: Date.now() }], cursor: 0 };
    state.history = []; state.future = []; writeTimeline(); renderHistory(); update();
  };
  $('settings-reset').onclick = () => { preferences = { ...defaults, shortcuts: { ...defaults.shortcuts } }; pageSize = defaults.pageSize; storePreferences(); update(); toast('已恢复默认设置'); };
  document.querySelectorAll('[data-shortcut]').forEach(input => input.addEventListener('change', () => {
    const key = input.dataset.shortcut, value = input.value.trim().toLowerCase();
    if (!/^[a-z]$/.test(value) || Object.entries(preferences.shortcuts).some(([other, assigned]) => other !== key && assigned === value)) { input.value = preferences.shortcuts[key]; toast('快捷键需为不重复的单个英文字母', true); return; }
    preferences.shortcuts[key] = value; storePreferences();
  }));
  function duplicateContour() {
    copyContours(); pasteContours();
  }
  window.addEventListener('keydown', event => {
    if (event.target.matches('input,select,textarea,[contenteditable=true]') || document.querySelector('dialog[open]')) return;
    const key = event.key.toLowerCase(), mod = event.ctrlKey || event.metaKey;
    if (mod && ['s', 'o', 'z', 'y', 'a', 'd', 'c', 'v', 'x', 'g', 'j'].includes(key)) {
      event.preventDefault(); if (state.drag) return;
      if (key === 's') saveGlyph();
      if (key === 'o') $('file-input').click();
      if (key === 'z') event.shiftKey ? redo() : undo();
      if (key === 'y') redo();
      if (key === 'a') { if (state.tool === 'component') selectContours(doc.contours); else { state.selected = new Set(G.allPoints(doc).map(p => p.point.id)); state.components.clear(); state.segment = null; } update(); }
      if (key === 'd') duplicateContour();
      if (key === 'c') copyContours(); if (key === 'v') pasteContours();
      if (key === 'x') { if (selectedContours().length) { copyContours(); $('delete-contour').click(); } else toast('剪切构件请先选择完整轮廓'); }
      if (key === 'g') groupContours(event.shiftKey);
      if (key === 'j') $('join-points').click();
      return;
    }
    if (event.key === ' ') { event.preventDefault(); state.space = true; updateHint(); return; }
    if (state.drag) {
      if (key === 'escape') { if (state.drag.before) doc = state.drag.before; if (state.drag.type === 'pivot') state.pivot = state.drag.oldPivot; state.constraintGuide = null; state.drag = null; update(); } return;
    }
    if (['arrowleft', 'arrowright', 'arrowup', 'arrowdown'].includes(key) && state.selected.size) {
      event.preventDefault(); const step = event.shiftKey ? 10 : 1, dx = key === 'arrowleft' ? -step : key === 'arrowright' ? step : 0, dy = key === 'arrowup' ? step : key === 'arrowdown' ? -step : 0;
      edit('已微移节点', () => { const moving = movablePoints(); moving.forEach(p => { p.point.x = Math.max(-1e6, Math.min(1e6, p.point.x + dx)); p.point.y = Math.max(-1e6, Math.min(1e6, p.point.y + dy)); }); }); return;
    }
    if (key === 'delete' && event.shiftKey && simplifySelectedControl()) { event.preventDefault(); return; }
    if (key === 'delete' || key === 'backspace') { event.preventDefault(); deleteSelected(); return; }
    if (key === 'escape' || key === 'enter') { finishDrawing(); update(); return; }
    if (key === 'tab' && !event.shiftKey && event.target === canvas) { event.preventDefault(); setFill(!state.fill); return; }
    if (key === '0') fit();
    if (key === '+' || key === '=') zoom(1.2); if (key === '-') zoom(1 / 1.2);
    if (key === 'g') $('grid-button').click(); if (key === 's') $('snap-button').click();
    if (key === '?') $('help-dialog').showModal();
    const tools = { [preferences.shortcuts.select]: 'select', [preferences.shortcuts.component]: 'component', [preferences.shortcuts.knife]: 'knife', [preferences.shortcuts.pen]: 'pen', [preferences.shortcuts.line]: 'line', r: 'rect', o: 'ellipse', h: 'hand' }; if (!mod && !event.shiftKey && !event.altKey && tools[key]) setTool(tools[key]);
  });
  window.addEventListener('keyup', event => { if (event.key === ' ') { state.space = false; updateHint(); } });
  window.addEventListener('blur', () => { state.space = false; if (state.drag?.before) doc = state.drag.before; if (state.drag?.type === 'pivot') state.pivot = state.drag.oldPivot; state.constraintGuide = null; state.drag = null; update(); });
  window.addEventListener('dragover', event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } });
  window.addEventListener('drop', event => { if (event.dataTransfer.files.length) { event.preventDefault(); importFile(event.dataTransfer.files[0]); } });
  window.addEventListener('beforeunload', event => { captureProject(); try { localStorage.setItem(storageKey, G.serialize(doc)); } catch (_) {} if (project?.pendingCount) { event.preventDefault(); event.returnValue = ''; } });
  applyPreferences();
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (preferences.theme === 'system') { applyPreferences(); requestDraw(); } });
  new ResizeObserver(resize).observe(container);
  window.HigherDegreeEditor = Object.freeze({ version: '0.4.0', getDocument: () => G.clone(doc) });
  window.QuarticEditor = window.HigherDegreeEditor;
  update();
  renderLibrary();
  activateHistory(standaloneHistoryId, doc);
  if (restored) setStatus('已恢复上次草稿');
  if (!storageAvailable) $('save-status').innerHTML = '<span></span> 请下载 .glyph 保存';
})();
