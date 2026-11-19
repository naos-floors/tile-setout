/* Naos Tile Set-out — app UI */
(function () {
  'use strict';
  const S = {
    settings: Store.getSettings(), job: null, viewId: null, selId: null, tab: 'shape', mode: 'move', view: null,
    cache: new Map(), bgImgs: new Map(), selOpening: -1, selVertex: -1, trace: null, calib: null, opTrace: null, opType: 'window',
    traceOrtho: true, best: null, dragging: false, showIds: false, showSetout: true, nudge: 10, aiBusy: false, bgPage: 1,
    undo: [], redo: [], dimHits: [],
  };
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const app = $('#app');
  const r1 = n => Math.round(n * 10) / 10;
  const fmt = (n, d = 0) => (n == null || !isFinite(n)) ? '-' : (+n).toLocaleString('en-GB', { maximumFractionDigits: d, minimumFractionDigits: d });
  const OP_TYPES = { door: 'Door', window: 'Window', niche: 'Niche', bath: 'Bath', tray: 'Shower tray', unit: 'Kitchen units', other: 'Not tiled' };
  const STRIP_GAP = 600;

  function toast(msg, ms = 2400) { $$('.toast').forEach(t => t.remove()); const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), ms); }
  function modal(html) {
    const m = document.createElement('div'); m.className = 'modal'; m.innerHTML = `<div class="box">${html}</div>`;
    document.body.appendChild(m);
    m.addEventListener('click', e => { if (e.target === m || e.target.closest('[data-close]')) m.remove(); });
    return m;
  }
  let saveT = null;
  function save() {
    if (syncLinks()) { requestDraw && setTimeout(() => { requestDraw(); if (S.viewId && ['shape', 'openings'].includes(S.tab)) renderPane(); }, 0); }
    clearTimeout(saveT); saveT = setTimeout(() => S.job && Store.put(S.job).catch(e => toast('Could not save: ' + e.message)), 350);
  }
  function netPill() { return navigator.onLine ? '' : '<span class="offline">Offline</span>'; }
  const onNet = () => { $$('.netslot').forEach(e => e.innerHTML = netPill()); if (S.tab === 'drawing' && S.viewId) renderPane(); };
  window.addEventListener('online', onNet); window.addEventListener('offline', onNet);

  // ---------- undo / redo ----------
  const snap = () => JSON.stringify(S.job, (k, v) => k === 'images' ? undefined : v);
  function checkpoint() {
    if (!S.job) return; const j = snap();
    if (S.undo[S.undo.length - 1] !== j) { S.undo.push(j); if (S.undo.length > 80) S.undo.shift(); S.redo = []; }
  }
  function restore(str) { const imgs = S.job.images; S.job = JSON.parse(str); S.job.images = imgs; S.cache.clear(); S.best = null; resetSigs(); save(); route(); }
  function undo() {
    if (!S.job) return; const cur = snap();
    while (S.undo.length && S.undo[S.undo.length - 1] === cur) S.undo.pop();
    if (!S.undo.length) return toast('Nothing to undo');
    S.redo.push(cur); restore(S.undo.pop()); toast('Undone');
  }
  function redo() { if (!S.redo.length) return toast('Nothing to redo'); S.undo.push(snap()); restore(S.redo.pop()); toast('Redone'); }
  document.addEventListener('pointerdown', e => { if (S.job && e.target.closest('#app button, #app select, .modal button') && !e.target.closest('[data-noundo], .tabs, .tools')) checkpoint(); }, true);
  document.addEventListener('focusin', e => { if (S.job && e.target.matches('input, textarea, select')) checkpoint(); });
  document.addEventListener('keydown', e => {
    if (!(e.ctrlKey || e.metaKey) || e.target.matches('input, textarea')) return;
    if (e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); } else if (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey)) { e.preventDefault(); redo(); }
  });

  // ---------- model helpers ----------
  function findSurface(id) { if (!S.job) return {}; for (const r of S.job.rooms) for (const s of r.surfaces) if (s.id === id) return { room: r, surface: s }; return {}; }
  function allSurfacesOf(job) { return job.rooms.flatMap(r => r.surfaces); }
  function allSurfaces() { return S.job.rooms.flatMap(r => r.surfaces.map(s => ({ room: r, surface: s }))); }
  function groupOf(s) { return (S.job.groups || []).find(g => g.members.includes(s.id)) || null; }
  function getGroup(id) { return (S.job.groups || []).find(g => g.id === id) || null; }
  function tileById(id) { return S.job.tiles.find(t => t.id === id) || S.job.tiles[0] || null; }
  function tileOf(s) { const g = groupOf(s); return tileById(g && g.tileMode !== 'separate' ? g.tileId : s.tileId); }
  function tileTarget(s) { const g = groupOf(s); return g && g.tileMode !== 'separate' ? g : s; }
  /* walls side by side without gaps: where each wall starts (in its own x), for tiles carrying round corners */
  function stripCum(g) { const m = new Map(); let x = 0; g.members.forEach(id => { const s = findSurface(id).surface; if (!s) return; const b = Geo.bbox(s.outline); m.set(id, x - b.x0); x += b.w; }); return m; }
  const cornerAllow = () => +S.settings.kerf || 3;
  function borderTileOf(s) { const b = s.settings.border; return b && b.on ? tileById(b.tileId) : null; }
  /* the surface as the engine should see it: group pattern applied in the area's own coordinates */
  function eff(s) {
    const g = groupOf(s); if (!g) return s;
    const pl = s.place || { x: 0, y: 0 };
    let pattern;
    if (g.mode === 'strip') {
      const ox = g.lockX ? (+g.pattern.ox || 0) - stripCum(g).get(s.id) - g.members.indexOf(s.id) * cornerAllow() : (+s.pattern.ox || 0);
      const oy = g.lockY !== false ? (+g.pattern.oy || 0) : (+s.pattern.oy || 0);
      pattern = { ...g.pattern, ox, oy };
    } else pattern = { ...g.pattern, ox: (+g.pattern.ox || 0) - pl.x, oy: (+g.pattern.oy || 0) - pl.y };
    return { ...s, pattern };
  }
  function geoSettings(s) {
    const g = S.settings;
    return { sliver: s.settings.sliver !== '' && s.settings.sliver != null ? +s.settings.sliver : +g.sliver, kerf: +g.kerf, minOffcut: +g.minOffcut, reuseOffcuts: s.settings.reuseOffcuts !== false };
  }
  /* all areas in a group are worked out together so offcuts are shared (round corners, across joined floors) */
  function calcGroup(g) {
    const mem = g.members.map(id => findSurface(id).surface).filter(Boolean);
    const effs = mem.map(eff);
    const key = JSON.stringify([effs.map(e => [e.outline, e.openings, e.doorways, e.pattern, e.settings, e.name]), mem.map(m => [tileOf(m), borderTileOf(m), geoSettings(m)]), S.settings.mat]);
    const hit = S.cache.get('grp:' + g.id); if (hit && hit.key === key) return;
    const rs = mem.map((m, i) => { const tile = tileOf(m); let res = null; if (tile) { try { res = Geo.layout(effs[i], tile, geoSettings(m), { borderTile: borderTileOf(m) }); } catch (err) { console.error(err); } } if (res) res.name = m.name; return { m, e: effs[i], tile, res }; });
    const rl = rs.filter(r => r.res).map(r => r.res);
    if (rl.length > 1) Geo.poolTiles(rl, geoSettings(mem[0]));
    rs.forEach(r => S.cache.set(r.m.id, { key: 'g:' + key, val: { surface: r.e, tile: r.tile, res: r.res, mat: r.res ? Geo.materials(r.e, r.tile, r.res, S.settings.mat) : null, cuts: r.res ? Geo.cutList(r.res) : [], ref: r.res ? Geo.setoutRef(r.e, r.tile) : null, pooled: rl.length > 1 } }));
    S.cache.set('grp:' + g.id, { key });
  }
  function calc(s) {
    const grp = groupOf(s); if (grp) { calcGroup(grp); return S.cache.get(s.id)?.val || {}; }
    const tile = tileOf(s); if (!tile) return {};
    const e = eff(s); const gs = geoSettings(s); const bt = borderTileOf(s);
    const key = JSON.stringify([e.outline, e.openings, e.doorways, e.pattern, e.settings, tile, bt, gs, S.settings.mat]);
    const hit = S.cache.get(s.id); if (hit && hit.key === key) return hit.val;
    let res = null; try { res = Geo.layout(e, tile, gs, { borderTile: bt }); } catch (err) { console.error(err); }
    const val = { surface: e, tile, res, mat: res ? Geo.materials(e, tile, res, S.settings.mat) : null, cuts: res ? Geo.cutList(res) : [], ref: res ? Geo.setoutRef(e, tile) : null };
    S.cache.set(s.id, { key, val });
    return val;
  }
  function jobTotals(job) {
    const all = []; const tiles = new Map();
    const adhByCov = new Map(); let groutKg = 0, primerL = 0, trimM = 0, spacers = 0, area = 0; const thresholds = []; let underM2 = 0;
    const mat = S.settings.mat;
    for (const room of job.rooms) for (const surface of room.surfaces) {
      const c = calc(surface); all.push({ room, ...c, real: surface });
      if (!c.res) continue;
      area += c.mat.m2;
      c.mat.tiles.forEach(t => {
        const key = t.tileId + '|' + (t.modular ? t.label : '');
        if (!tiles.has(key)) tiles.set(key, { tile: tileById(t.tileId), label: t.label, needed: 0, order: 0, m2: 0, modular: t.modular });
        const e = tiles.get(key); e.needed += t.needed; e.order += t.order; e.m2 += t.m2;
      });
      const cov = c.mat.adhesive.coverage; adhByCov.set(cov, (adhByCov.get(cov) || 0) + c.mat.m2);
      groutKg += c.mat.grout.kg; primerL += c.mat.primer.litres; trimM += c.mat.trim.m; spacers += c.mat.spacers.count;
      c.mat.thresholds.forEach(t => thresholds.push({ ...t, where: surface.name }));
      underM2 += c.mat.units.reduce((s, u) => s + u.m2, 0);
    }
    const rows = [];
    rows.push(['Total tiled area', `${fmt(area, 2)} m²`, '']);
    const modM2 = new Map();
    for (const e of tiles.values()) {
      let ord;
      if (e.modular) { modM2.set(e.tile.id, (modM2.get(e.tile.id) || 0) + e.m2); ord = `${fmt(e.m2, 2)} m²`; }
      else if (+e.tile.perBox > 0) ord = `${Math.ceil(e.order / +e.tile.perBox)} boxes`;
      else if (+e.tile.m2PerBox > 0) ord = `${Math.ceil(e.m2 / +e.tile.m2PerBox)} boxes`;
      else ord = `${fmt(e.m2, 2)} m²`;
      rows.push([`${e.tile.name}${e.modular ? ' ' + e.label : ''}`, `${e.needed} needed · ${e.order} incl. spare`, ord]);
    }
    for (const [tid, m2] of modM2) { const t = tileById(tid); if (+t.m2PerBox > 0) rows.push([`${t.name} modular packs`, `${fmt(m2, 2)} m²`, `${Math.ceil(m2 / +t.m2PerBox)} packs`]); }
    let bags = 0; for (const [cov, a] of adhByCov) bags += a / cov * (1 + (+mat.adhExtra || 0) / 100);
    if (area > 0) rows.push([mat.adhName, `${fmt(area, 1)} m²`, `${Math.ceil(bags - 1e-9)} × ${mat.adhBagKg} kg`]);
    if (groutKg > 0) rows.push([mat.groutName, `${fmt(groutKg, 1)} kg`, `${Math.ceil(groutKg / (+mat.groutBagKg || 5) - 1e-9)} × ${mat.groutBagKg} kg`]);
    if (primerL > 0) rows.push([mat.primerName, `${fmt(primerL, 1)} L`, `${Math.ceil(primerL / (+mat.primerUnitL || 5) - 1e-9)} × ${mat.primerUnitL} L`]);
    if (trimM > 0) rows.push(['Trim', `${fmt(trimM, 1)} m`, `${Math.ceil(trimM / (+mat.trimLengthM || 2.5) - 1e-9)} × ${mat.trimLengthM} m`]);
    if (spacers > 0) rows.push(['Spacers / levelling clips', `${Math.ceil(spacers)}`, `${Math.ceil(spacers / (+mat.spacerPack || 100))} packs`]);
    thresholds.forEach(t => rows.push([`Threshold: ${t.name}`, `${t.where}`, `${t.w} mm`]));
    if (underM2 > 0) rows.push(['Of which under units', `${fmt(underM2, 2)} m²`, '']);
    return { all, rows, area };
  }

  // ---------- views (one area, or a combined view) ----------
  function curView() {
    if (!S.job || !S.viewId) return null;
    if (S.viewId.startsWith('fold-')) {
      const f = findSurface(S.viewId.slice(5)); if (!f.surface) return null;
      const walls = allSurfaces().filter(x => x.surface.kind === 'wall' && x.surface.link && x.surface.link.floorId === f.surface.id && x.surface.link.edge < f.surface.outline.length);
      return { group: null, members: [f, ...walls], mode: 'folded', floor: f.surface };
    }
    const g = getGroup(S.viewId);
    if (g) {
      const members = g.members.map(id => findSurface(id)).filter(x => x.surface);
      return { group: g, members, mode: g.mode };
    }
    const f = findSurface(S.viewId); if (!f.surface) return null;
    return { group: null, members: [f], mode: 'single' };
  }
  function offsets(v) {
    const m = new Map();
    if (v.mode === 'strip') { let x = 0; v.members.forEach(({ surface }) => { const b = Geo.bbox(surface.outline); m.set(surface.id, [x - b.x0, 0]); x += b.w + STRIP_GAP; }); }
    else if (v.mode === 'plan') v.members.forEach(({ surface }) => m.set(surface.id, [surface.place?.x || 0, surface.place?.y || 0]));
    else if (v.mode === 'folded') v.members.forEach(({ surface }) => { if (surface === v.floor) m.set(surface.id, [0, 0]); else { const o = v.floor.outline; m.set(surface.id, o[(surface.link.edge + 1) % o.length].slice()); } });
    else v.members.forEach(({ surface }) => m.set(surface.id, [0, 0]));
    return m;
  }
  /* rotation of each area in the view (folded-out walls lie flat round their floor) */
  function rots(v) {
    const m = new Map();
    v.members.forEach(({ surface }) => {
      let r = 0;
      if (v.mode === 'folded' && surface !== v.floor) { const o = v.floor.outline, i = surface.link.edge; const A = o[i], B = o[(i + 1) % o.length]; r = Math.atan2(-(B[1] - A[1]), -(B[0] - A[0])); }
      m.set(surface.id, r);
    });
    return m;
  }
  function toLocal(v, s, w) { const o = offsets(v).get(s.id), r = rots(v).get(s.id) || 0; return Geo.rot([w[0] - o[0], w[1] - o[1]], -r); }
  function toWorld(v, s, p) { const o = offsets(v).get(s.id), r = rots(v).get(s.id) || 0; const q = Geo.rot(p, r); return [q[0] + o[0], q[1] + o[1]]; }
  function cur() { const v = curView(); if (!v) return {}; return v.members.find(m => m.surface.id === S.selId) || v.members[0] || {}; }
  function patternTarget(s) { const g = groupOf(s); return g || s; }

  // ---------- files ----------
  // iPhone/iPad home-screen apps can't save downloads, so they use the share sheet (Save to Files). Everything else downloads.
  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  async function shareOrDownload(blob, name) {
    const file = new File([blob], name, { type: blob.type });
    if (isIOS && navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === 'AbortError') return; }
    }
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }
  const safeName = s => (s || 'job').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'job';
  function pickFile(accept) { return new Promise(res => { const i = document.createElement('input'); i.type = 'file'; i.accept = accept; i.onchange = () => res(i.files[0] || null); i.click(); }); }
  async function fileToImage(file, page = 1) {
    if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
      const pdfjs = window.pdfjsLib; pdfjs.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
      const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
      const pg = await pdf.getPage(Math.min(Math.max(1, page), pdf.numPages));
      const v0 = pg.getViewport({ scale: 1 }); const sc = Math.min(4, 2600 / Math.max(v0.width, v0.height));
      const vp = pg.getViewport({ scale: sc });
      const cv = document.createElement('canvas'); cv.width = vp.width; cv.height = vp.height;
      const cx = cv.getContext('2d'); cx.fillStyle = '#fff'; cx.fillRect(0, 0, cv.width, cv.height);
      await pg.render({ canvasContext: cx, viewport: vp }).promise;
      return { dataUrl: cv.toDataURL('image/jpeg', 0.88), w: cv.width, h: cv.height, pages: pdf.numPages };
    }
    const src = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(file); });
    const img = await loadImg(src);
    const sc = Math.min(1, 2600 / Math.max(img.width, img.height));
    const cv = document.createElement('canvas'); cv.width = Math.round(img.width * sc); cv.height = Math.round(img.height * sc);
    const cx = cv.getContext('2d'); cx.fillStyle = '#fff'; cx.fillRect(0, 0, cv.width, cv.height); cx.drawImage(img, 0, 0, cv.width, cv.height);
    return { dataUrl: cv.toDataURL('image/jpeg', 0.88), w: cv.width, h: cv.height };
  }
  function loadImg(src) { return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; }); }
  function bgData(s) { return s.bg && s.bg.img ? S.job.images[s.bg.img] : null; }
  function bgImgFor(s) {
    const d = bgData(s); if (!d) return null;
    const k = s.bg.img;
    const e = S.bgImgs.get(k); if (e) return e.ready ? e.img : null;
    const img = new Image(); const ent = { img, ready: false }; S.bgImgs.set(k, ent);
    img.onload = () => { ent.ready = true; requestDraw(); }; img.src = d;
    return null;
  }

  // ---------- routing ----------
  window.addEventListener('hashchange', route);
  async function route() {
    const h = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
    if (h[0] === 'job') {
      if (!S.job || S.job.id !== h[1]) { S.job = await Store.get(h[1]); S.cache.clear(); S.view = null; S.undo = []; S.redo = []; resetSigs(); }
      if (!S.job) { location.hash = ''; return; }
      if ((h[2] === 'v' || h[2] === 's') && h[3]) {
        let vid = h[3], sel = h[4] || null;
        const f = vid.startsWith('fold-') ? {} : findSurface(vid);
        if (f.surface) { const g = groupOf(f.surface); if (g) { location.replace(`#/job/${S.job.id}/v/${g.id}/${vid}`); return; } sel = vid; }
        if (S.viewId !== vid) { S.viewId = vid; S.view = null; S.best = null; S.selOpening = -1; S.trace = S.calib = S.opTrace = null; S.mode = 'move'; }
        const v = curView(); if (!v) { location.hash = `#/job/${S.job.id}`; return; }
        if (sel && v.members.some(m => m.surface.id === sel)) S.selId = sel;
        else if (!v.members.some(m => m.surface.id === S.selId)) S.selId = v.members[0]?.surface.id;
        return renderEditor();
      }
      S.viewId = null; return renderJob();
    }
    S.viewId = null;
    if (h[0] === 'settings') return renderSettings();
    return renderHome();
  }
  const openView = (id, sel) => { location.hash = `#/job/${S.job.id}/v/${id}${sel ? '/' + sel : ''}`; };

  // ---------- home ----------
  async function renderHome() {
    S.job = null;
    const jobs = await Store.list();
    app.innerHTML = `
      <div class="top"><div class="brand">NAOS <span>FLOORS</span></div><h1 style="font-weight:400;opacity:.85">Tile Set-out</h1><span class="netslot">${netPill()}</span><button data-a="settings" aria-label="Settings">⚙︎</button></div>
      <div class="scroll"><div class="wrap">
        <div class="card"><h2>Jobs<span class="sp"></span><button class="btn sec sm" data-a="import">Open job file</button><button class="btn sec sm" data-a="pastejob">Paste job</button><button class="btn sm" data-a="new">+ New job</button></h2>
          <div class="list">${jobs.length ? jobs.map(j => `<div class="item click" data-open="${j.id}"><div class="main"><div class="t">${esc(j.name)}</div><div class="s">${esc(j.client || '')}${j.client ? ' · ' : ''}${j.rooms.length} room${j.rooms.length === 1 ? '' : 's'} · ${j.rooms.reduce((a, r) => a + r.surfaces.length, 0)} areas · ${new Date(j.updated).toLocaleDateString('en-GB')}</div></div><span class="muted">›</span></div>`).join('') : '<div class="empty">No jobs yet.<br>Tap <b>+ New job</b> to start, or open a job file.</div>'}</div>
        </div>
        <div class="note">Everything is saved on this device and works with no signal. To move a job between phone and computer, use <b>Save job file</b> on the job and open it on the other device.</div>
      </div></div>`;
    app.onclick = async e => {
      const o = e.target.closest('[data-open]'); if (o) { location.hash = `#/job/${o.dataset.open}`; return; }
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a === 'settings') location.hash = '#/settings';
      if (a === 'new') { const name = prompt('Job name', 'New job'); if (name == null) return; const j = Store.newJob(name || 'New job'); await Store.put(j); location.hash = `#/job/${j.id}`; }
      if (a === 'import') importJobFile();
      if (a === 'pastejob') { const m = modal(`<h3>Paste a job</h3><div class="muted">On the other device open the job and tap <b>Copy job</b>, then paste it here.</div><textarea class="code" id="pjob" placeholder='{"app":"naos-tile-setout",...}'></textarea><div class="row"><button class="btn" data-m="go">Open job</button><button class="btn sec" data-close>Cancel</button></div>`); m.querySelector('[data-m="go"]').onclick = () => { const t = $('#pjob', m).value; m.remove(); importJobText(t); }; }
    };
    app.oninput = null;
  }
  async function importJobFile() {
    const f = await pickFile(''); if (!f) return;
    importJobText(await f.text());
  }
  async function importJobText(text) {
    try {
      const st = text.indexOf('{'); if (st < 0) throw new Error('No job found in that text');
      const j = JSON.parse(text.slice(st, text.lastIndexOf('}') + 1)); let job = j.job || j;
      if (!job.rooms || !job.tiles) throw new Error('Not a tile set-out job file');
      job = Store.migrate(job);
      const existing = await Store.get(job.id);
      if (existing && !confirm(`"${existing.name}" is already on this device.\nOK = replace it with the file version\nCancel = keep both`)) { job.id = Store.uid(); job.name += ' (copy)'; }
      await Store.put(job); toast('Job opened'); S.job = null; location.hash = `#/job/${job.id}`;
    } catch (e) { toast('Could not open file: ' + e.message, 4000); }
  }

  // ---------- settings ----------
  function renderSettings() {
    const st = S.settings, m = st.mat;
    const f = (k, label, type = 'number', src = 'mat', extra = '') => `<label class="f">${label}<input type="${type}" ${type === 'number' ? 'inputmode="decimal" step="any"' : ''} data-s="${src}.${k}" value="${esc(src === 'mat' ? m[k] : st[k])}" ${extra}></label>`;
    app.innerHTML = `
      <div class="top"><button data-a="back">‹ Back</button><h1>Settings</h1></div>
      <div class="scroll"><div class="wrap">
        <div class="card"><h2>Set-out</h2><div class="grid">
          ${f('sliver', 'Warn on cuts under (mm)', 'number', 'g')}${f('kerf', 'Blade / cut allowance (mm)', 'number', 'g')}${f('minOffcut', 'Smallest usable offcut (mm)', 'number', 'g')}
        </div></div>
        <div class="card"><h2>Adhesive</h2><div class="grid">${f('adhName', 'Product', 'text')}${f('adhCoverage', 'Coverage m² per bag')}${f('adhBagKg', 'Bag size kg')}${f('adhExtra', 'Extra %')}</div>
          <div class="note">Default: Ardex X7R at about 2.2 m² per 20 kg bag. A tile can override this (e.g. large format with back-buttering).</div></div>
        <div class="card"><h2>Grout</h2><div class="grid">${f('groutName', 'Product', 'text')}${f('groutDensity', 'Density (kg/L)')}${f('groutBagKg', 'Bag size kg')}${f('groutExtra', 'Extra %')}</div>
          <div class="note">Worked out from joint length × joint width × tile thickness × density, so it follows every tile size and pattern. Check density and bag size against the Ardex data sheet for the grout you use.</div></div>
        <div class="card"><h2>Primer, trim and spacers</h2><div class="grid">${f('primerName', 'Primer', 'text')}${f('primerLPerM2', 'Primer litres per m²')}${f('primerUnitL', 'Primer container (L)')}${f('trimLengthM', 'Trim length (m)')}${f('spacersPerTile', 'Spacers/clips per tile')}${f('spacerPack', 'Spacers per pack')}</div></div>
        <div class="card"><h2>Automatic drawing reading (optional)</h2>
          <div class="grid">${f('apiKey', 'Anthropic API key', 'password', 'g', 'autocomplete="off" placeholder="sk-ant-…"')}${f('model', 'Model', 'text', 'g')}</div>
          <div class="note">Only needed for the in-app <b>Read drawing</b> button, which only works with signal. The key is stored on this device only. Without a key you can send a drawing to Claude with the ready-made prompt and paste the reply in.</div></div>
        <div class="note">Version 1.2 · Naos Floors internal tool. Quantities are a guide: always check on site and follow BS 5385 and manufacturers’ instructions.</div>
      </div></div>`;
    app.onclick = e => { if (e.target.closest('[data-a="back"]')) history.length > 1 ? history.back() : location.hash = ''; };
    app.oninput = e => {
      const k = e.target.dataset.s; if (!k) return;
      const [src, key] = k.split('.'); const v = e.target.type === 'number' ? (e.target.value === '' ? '' : +e.target.value) : e.target.value;
      if (src === 'mat') S.settings.mat[key] = v; else S.settings[key] = v;
      Store.saveSettings(S.settings); S.cache.clear();
    };
  }

  // ---------- job ----------
  function renderJob() {
    const job = S.job;
    const tot = jobTotals(job);
    const surfRow = (r, s) => {
      const c = tot.all.find(x => x.real.id === s.id); const g = groupOf(s);
      const st = c?.res?.stats;
      return `<div class="item click" data-surf="${s.id}"><div class="main"><div class="t">${esc(s.name)} <span class="pill">${s.kind}</span>${g ? ` <span class="pill" style="background:#E7EEF9;color:#1D4ED8">in ${esc(g.name)}</span>` : ''}</div>
        <div class="s">${c?.res ? `${fmt(c.mat.m2, 2)} m² · ${esc(c.tile?.name || '')} · ${esc(Geo.PATTERNS[c.surface.pattern.type]?.name || '')} · ${st.needed} tiles` : 'Not set up yet'}</div></div>
        ${st && st.slivers ? `<span class="pill red">${st.slivers} sliver${st.slivers > 1 ? 's' : ''}</span>` : ''}<button class="btn sec sm" data-smenu="${s.id}" aria-label="More">⋯</button></div>`;
    };
    app.innerHTML = `
      <div class="top"><button data-a="home">‹ Jobs</button><h1>${esc(job.name)}</h1><span class="netslot">${netPill()}</span><button data-noundo data-a="undo" title="Undo">↶</button><button data-noundo data-a="redo" title="Redo">↷</button><button data-a="export">Export</button></div>
      <div class="scroll"><div class="wrap">
        <details class="card" ${job.client || job.address ? "" : "open"}><summary style="font-weight:600;color:var(--gun-d);cursor:pointer">Job details${job.client ? " — " + esc(job.client) : ""}</summary><div class="grid" style="margin-top:10px">
          <label class="f">Job name<input data-j="name" value="${esc(job.name)}"></label>
          <label class="f">Client<input data-j="client" value="${esc(job.client)}"></label>
          <label class="f" style="grid-column:1/-1">Site address<input data-j="address" value="${esc(job.address)}"></label>
          <label class="f" style="grid-column:1/-1">Notes<textarea data-j="notes" rows="2">${esc(job.notes)}</textarea></label>
        </div></details>
        ${!job.rooms.length ? `<div class="card" style="border:2px dashed var(--bronze)"><h2>Start setting out</h2><div class="muted" style="margin-bottom:10px">Add the rooms for this job. A quick room gives you 4 walls (opened together) and a floor in one go.</div>
          <div class="row"><button class="btn" data-a="quickroom">+ Quick room</button><button class="btn sec" data-a="addroom">+ Empty room</button><button class="btn sec" data-a="paste">Paste room data</button></div></div>` : ''}
        ${(() => { const folds = allSurfaces().filter(x => x.surface.kind === 'floor' && allSurfaces().some(y => y.surface.link?.floorId === x.surface.id)); return job.groups.length || folds.length ? `<div class="card"><h2>Combined views</h2><div class="list">${folds.map(x => `<div class="item click" data-group="fold-${x.surface.id}"><div class="main"><div class="t">${esc(x.room.name)} — ${esc(x.surface.name)} <span class="pill" style="background:#E3F2E6;color:#15803D">folded out</span></div><div class="s">Floor with its walls laid flat round it</div></div><span class="muted">›</span></div>`).join('')}${job.groups.map(g => `<div class="item click" data-group="${g.id}"><div class="main"><div class="t">${esc(g.name)} <span class="pill" style="background:#E7EEF9;color:#1D4ED8">${g.mode === 'strip' ? 'walls unfolded' : 'floors joined'}</span></div><div class="s">${g.members.map(id => esc(findSurface(id).surface?.name || '?')).join(' · ')}</div></div><button class="btn sec sm" data-gmenu="${g.id}" aria-label="More">⋯</button></div>`).join('')}</div></div>` : ''; })()}
        ${job.rooms.map(r => `<div class="card"><h2>${esc(r.name)}<span class="sp"></span><button class="btn sec sm" data-rmenu="${r.id}" aria-label="Room options">⋯</button></h2>
          <div class="list">${r.surfaces.map(s => surfRow(r, s)).join('') || '<div class="muted">No areas yet — add a wall or floor.</div>'}</div>
          <div class="row" style="margin-top:8px"><button class="btn sec sm" data-add="wall" data-room="${r.id}">+ Wall</button><button class="btn sec sm" data-add="floor" data-room="${r.id}">+ Floor</button></div></div>`).join('')}
        ${job.rooms.length ? `<div class="row" style="margin-bottom:12px"><button class="btn" data-a="addroom">+ Room</button><button class="btn sec" data-a="quickroom">+ Quick room (4 walls + floor)</button><button class="btn sec" data-a="combine">⧉ Combine areas</button></div>` : ''}
        <div class="card"><h2>Tiles on this job<span class="sp"></span><button class="btn sec sm" data-a="addtile">+ Tile</button></h2>
          <div class="list">${!job.tiles.length ? '<div class="muted">No tiles yet. Tap <b>+ Tile</b> to pick a size.</div>' : ''}${job.tiles.map(t => `<div class="item click" data-tile="${t.id}"><div class="main"><div class="t">${esc(t.name)}</div><div class="s">${t.w} × ${t.h} × ${t.thick} mm · ${+t.perBox ? t.perBox + ' per box' : +t.m2PerBox ? t.m2PerBox + ' m² per box' : '<span style="color:var(--red)">box size not set</span>'}</div></div><span class="muted">Edit ›</span></div>`).join('')}</div></div>
        <div class="card"><h2>Order list — whole job</h2>
          <table class="t"><tr><th>Item</th><th>Quantity</th><th class="n">Order</th></tr>${tot.rows.map(r => `<tr><td>${esc(r[0])}</td><td>${esc(r[1])}</td><td class="n"><b>${esc(r[2])}</b></td></tr>`).join('')}</table></div>
        <div class="card"><h2>Drawings → rooms</h2>
          <div class="muted" style="margin-bottom:8px">Turn a floor plan or elevations into rooms, walls, doorways and units ready to set out. Several elevations of one room open together as an unfolded view.</div>
          <div class="row"><button class="btn" data-a="aifile" ${navigator.onLine && S.settings.apiKey ? '' : 'disabled'}>Read a drawing</button>
          <button class="btn sec" data-a="paste">Paste room data</button><button class="btn sec" data-a="prompt">Copy prompt for Claude</button></div>
          ${!navigator.onLine ? '<div class="note">Offline: automatic reading is switched off. You can still trace a drawing by hand in any area (Drawing tab).</div>' : !S.settings.apiKey ? '<div class="note">Automatic reading needs an API key in Settings. Or tap <b>Copy prompt for Claude</b>, send it to Claude with your drawing, then paste the reply here with <b>Paste room data</b>.</div>' : ''}
        </div>
        <div class="row" style="margin-bottom:20px"><button class="btn sec" data-a="savefile">Save job file</button><button class="btn sec" data-a="copyjob">Copy job</button><button class="btn danger" data-a="deljob">Delete job</button></div>
      </div></div>`;
    app.oninput = e => { const k = e.target.dataset.j; if (k) { job[k] = e.target.value; save(); if (k === 'name') $('.top h1').textContent = job.name; } };
    app.onclick = async e => {
      const t = e.target;
      if (t.closest('[data-smenu]')) { e.stopPropagation(); return surfaceMenu(t.closest('[data-smenu]').dataset.smenu); }
      if (t.closest('[data-gmenu]')) { e.stopPropagation(); return groupMenu(t.closest('[data-gmenu]').dataset.gmenu); }
      if (t.closest('[data-rmenu]')) return roomMenu(t.closest('[data-rmenu]').dataset.rmenu);
      const gv = t.closest('[data-group]'); if (gv) return openView(gv.dataset.group);
      const sv = t.closest('[data-surf]'); if (sv) return openView(sv.dataset.surf);
      const tl = t.closest('[data-tile]'); if (tl) return tileModal(tl.dataset.tile);
      const ad = t.closest('[data-add]');
      if (ad) { const room = job.rooms.find(r => r.id === ad.dataset.room); const kind = ad.dataset.add; const n = room.surfaces.filter(s => s.kind === kind).length; const s = Store.newSurface(kind, { name: kind === 'wall' ? `Wall ${String.fromCharCode(65 + n)}` : (n ? `Floor ${n + 1}` : 'Floor'), tileId: (job.tiles[0]?.id || null) }); autoStart(s); room.surfaces.push(s); await Store.put(job); openView(s.id); return; }
      const a = t.closest('[data-a]')?.dataset.a; if (!a) return;
      if (a === 'home') location.hash = '';
      if (a === 'undo') undo(); if (a === 'redo') redo();
      if (a === 'addroom') { const n = prompt('Room or area name', 'Room'); if (!n) return; job.rooms.push(Store.newRoom(n)); save(); renderJob(); }
      if (a === 'quickroom') quickRoomModal();
      if (a === 'combine') combineModal();
      if (a === 'addtile') addTileModal();
      if (a === 'export') exportModal(null);
      if (a === 'copyjob') {
        const hasImg = Object.keys(job.images || {}).length;
        const m = modal(`<h3>Copy job</h3><div class="muted">Copies the whole job as text. On the other device tap <b>Paste job</b> on the jobs screen.</div>${hasImg ? '<label class="chk"><input type="checkbox" id="cjImg"> Include imported drawings (makes it much bigger)</label>' : ''}<div class="row" style="margin-top:8px"><button class="btn" data-m="go">Copy</button><button class="btn sec" data-close>Cancel</button></div>`);
        m.querySelector('[data-m="go"]').onclick = async () => {
          const withImg = $('#cjImg', m)?.checked; const j2 = JSON.parse(JSON.stringify(job)); if (!withImg) { j2.images = {}; allSurfacesOf(j2).forEach(s => { s.bg = null; }); }
          const txt = JSON.stringify({ app: 'naos-tile-setout', v: 3, job: j2 });
          try { await navigator.clipboard.writeText(txt); toast('Job copied — paste it on the other device'); m.remove(); }
          catch (e) { m.querySelector('.box').insertAdjacentHTML('beforeend', `<div class="note">Couldn't copy automatically. Select all of this and copy it:</div><textarea class="code" readonly>${esc(txt)}</textarea>`); }
        };
        return;
      }
      if (a === 'savefile') { await Store.put(job); shareOrDownload(new Blob([JSON.stringify({ app: 'naos-tile-setout', v: 3, job })], { type: 'application/json' }), `${safeName(job.name)}.json`); }
      if (a === 'deljob') { if (confirm(`Delete "${job.name}" from this device?\nSave a job file first if you want a copy.`)) { await Store.del(job.id); S.job = null; location.hash = ''; } }
      if (a === 'paste') pasteModal(null);
      if (a === 'prompt') copyPrompt();
      if (a === 'aifile') { const f = await pickFile('image/*,application/pdf'); if (!f) return; let page = 1; if (/pdf/.test(f.type)) page = +prompt('Which page of the PDF?', '1') || 1; toast('Reading drawing… this can take up to a minute', 60000); try { const im = await fileToImage(f, page); const data = await AI.readWithApi(im.dataUrl, S.settings); $$('.toast').forEach(x => x.remove()); previewImport(data, null, im); } catch (err) { toast(err.message, 5000); } }
    };
  }

  function surfaceMenu(id) {
    const { room, surface } = findSurface(id); const g = groupOf(surface);
    const m = modal(`<h3>${esc(surface.name)}</h3><div class="row" style="flex-direction:column;align-items:stretch">
      <button class="btn sec" data-m="rename">Rename</button><button class="btn sec" data-m="dup">Duplicate</button>
      ${g ? `<button class="btn sec" data-m="ungroup">Take out of “${esc(g.name)}”</button>` : ''}
      ${S.job.rooms.length > 1 ? `<label class="f">Move to room<select data-m-move><option value="">—</option>${S.job.rooms.filter(r => r !== room).map(r => `<option value="${r.id}">${esc(r.name)}</option>`).join('')}</select></label>` : ''}
      <button class="btn danger" data-m="del">Delete</button><button class="btn sec" data-close>Close</button></div>`);
    m.onclick = e => {
      const a = e.target.closest('[data-m]')?.dataset.m; if (!a) { if (e.target === m) m.remove(); return; }
      if (a === 'rename') { const n = prompt('Name', surface.name); if (n) surface.name = n; }
      if (a === 'dup') { const c = JSON.parse(JSON.stringify(eff(surface))); c.id = Store.uid(); c.name += ' copy'; c.openings.forEach(o => o.id = Store.uid()); room.surfaces.splice(room.surfaces.indexOf(surface) + 1, 0, c); }
      if (a === 'ungroup') removeFromGroup(surface);
      if (a === 'del') { if (!confirm(`Delete ${surface.name}?`)) return; if (g) removeFromGroup(surface); room.surfaces.splice(room.surfaces.indexOf(surface), 1); }
      save(); m.remove(); renderJob();
    };
    m.querySelector('[data-m-move]')?.addEventListener('change', e => { const to = S.job.rooms.find(r => r.id === e.target.value); if (!to) return; checkpoint(); room.surfaces.splice(room.surfaces.indexOf(surface), 1); to.surfaces.push(surface); save(); m.remove(); renderJob(); });
  }
  function removeFromGroup(s) {
    const g = groupOf(s); if (!g) return;
    const e = eff(s); s.pattern = { ...e.pattern }; s.tileId = g.tileId;
    g.members = g.members.filter(id => id !== s.id);
    if (g.members.length < 2) { g.members.forEach(id => { const o = findSurface(id).surface; if (o) { const e2 = eff(o); o.pattern = { ...e2.pattern }; o.tileId = g.tileId; } }); S.job.groups = S.job.groups.filter(x => x !== g); }
    S.cache.clear();
  }
  function groupMenu(id) {
    const g = getGroup(id);
    const m = modal(`<h3>${esc(g.name)}</h3><div class="row" style="flex-direction:column;align-items:stretch">
      <button class="btn sec" data-m="open">Open</button><button class="btn sec" data-m="rename">Rename</button>
      <button class="btn danger" data-m="split">Separate the areas again</button><button class="btn sec" data-close>Close</button></div>
      <div class="note">Separating keeps each area’s current set-out; they just stop moving together.</div>`);
    m.onclick = e => {
      const a = e.target.closest('[data-m]')?.dataset.m; if (!a) { if (e.target === m) m.remove(); return; }
      if (a === 'open') { m.remove(); return openView(g.id); }
      if (a === 'rename') { const n = prompt('Name', g.name); if (n) g.name = n; }
      if (a === 'split') { [...g.members].forEach(mid => { const s = findSurface(mid).surface; if (s) { const e2 = eff(s); s.pattern = { ...e2.pattern }; s.tileId = g.tileId; } }); S.job.groups = S.job.groups.filter(x => x !== g); S.cache.clear(); }
      save(); m.remove(); renderJob();
    };
  }
  function roomMenu(id) {
    const room = S.job.rooms.find(r => r.id === id);
    const walls = room.surfaces.filter(s => s.kind === 'wall' && !groupOf(s));
    const m = modal(`<h3>${esc(room.name)}</h3><div class="row" style="flex-direction:column;align-items:stretch"><button class="btn sec" data-m="rename">Rename</button>
      ${walls.length > 1 ? '<button class="btn sec" data-m="unfold">Open all walls together (unfolded)</button>' : ''}
      <button class="btn sec" data-m="dup">Duplicate room</button><button class="btn danger" data-m="del">Delete room</button><button class="btn sec" data-close>Close</button></div>`);
    m.onclick = e => {
      const a = e.target.closest('[data-m]')?.dataset.m; if (!a) { if (e.target === m) m.remove(); return; }
      if (a === 'rename') { const n = prompt('Name', room.name); if (n) room.name = n; }
      if (a === 'unfold') { const g = makeGroup(`${room.name} — walls`, 'strip', walls); save(); m.remove(); return openView(g.id); }
      if (a === 'dup') { const c = JSON.parse(JSON.stringify(room)); c.id = Store.uid(); c.name += ' copy'; c.surfaces.forEach(s => { const e2 = eff(findSurface(s.id).surface || s); s.pattern = { ...e2.pattern }; s.id = Store.uid(); }); S.job.rooms.push(c); }
      if (a === 'del') { if (!confirm(`Delete ${room.name} and all its areas?`)) return; room.surfaces.forEach(s => removeFromGroup(s)); S.job.rooms.splice(S.job.rooms.indexOf(room), 1); }
      save(); m.remove(); renderJob();
    };
  }
  function makeGroup(name, mode, surfaces) {
    surfaces.forEach(s => removeFromGroup(s));
    const first = surfaces[0];
    const g = Store.newGroup(name, mode, surfaces.map(s => s.id), first.tileId, first.pattern);
    if (mode === 'plan') {
      // keep drawing positions if they look real, otherwise line them up side by side to arrange
      const placed = surfaces.filter(s => s.place && (s.place.x || s.place.y)).length;
      if (placed < surfaces.length - 1) { let x = 0; surfaces.forEach(s => { const b = Geo.bbox(s.outline); s.place = { x: x - b.x0, y: -b.y0 }; x += b.w + 500; }); g.needsArrange = true; }
      g.pattern.ox = (+first.pattern.ox || 0) + (first.place?.x || 0); g.pattern.oy = (+first.pattern.oy || 0) + (first.place?.y || 0);
    } else g.pattern.oy = +first.pattern.oy || 0;
    S.job.groups.push(g); S.cache.clear();
    return g;
  }
  function combineModal() {
    const rows = allSurfaces();
    const m = modal(`<h3>Combine areas</h3><div class="muted">Pick floors that the tile runs through (they join up in one plan), or walls to work on together (unfolded side by side with level courses).</div>
      <div class="list" style="margin:8px 0">${rows.map(({ room, surface }) => `<label class="chk"><input type="checkbox" value="${surface.id}" data-kind="${surface.kind}"> ${esc(room.name)} — ${esc(surface.name)} <span class="pill">${surface.kind}</span>${groupOf(surface) ? ' <span class="muted">(already combined)</span>' : ''}</label>`).join('')}</div>
      <label class="f">Name<input id="gName" placeholder="e.g. Hall, kitchen & dining"></label>
      <div class="row" style="margin-top:10px"><button class="btn" data-m="go">Combine</button><button class="btn sec" data-close>Cancel</button></div>`);
    m.querySelector('[data-m="go"]').onclick = () => {
      const picked = $$('input[type=checkbox]:checked', m).map(i => findSurface(i.value).surface);
      if (picked.length < 2) return toast('Pick at least two areas');
      const kinds = new Set(picked.map(s => s.kind)); if (kinds.size > 1) return toast('Pick only floors, or only walls');
      const mode = picked[0].kind === 'floor' ? 'plan' : 'strip';
      const g = makeGroup($('#gName', m).value || picked.map(s => s.name).join(' + '), mode, picked);
      save(); m.remove(); openView(g.id);
      if (g.needsArrange) setTimeout(() => toast('Use ⇄ Arrange to drag the areas together — they snap edge to edge', 5000), 400);
    };
  }
  const PRESETS = [
    ['Square', [[300, 300], [450, 450], [600, 600], [750, 750], [800, 800], [900, 900], [1000, 1000], [1200, 1200]]],
    ['Rectangle', [[600, 300], [900, 450], [1200, 600], [1600, 800], [1200, 300], [2400, 1200], [3200, 1600]]],
    ['Plank / wood effect', [[900, 150], [1200, 200], [1200, 300], [1500, 250], [1800, 300], [2000, 200]]],
    ['Herringbone / chevron', [[280, 70], [450, 90], [600, 120], [600, 150], [750, 150]]],
    ['Wall / metro', [[100, 100], [150, 150], [200, 200], [150, 75], [200, 100], [300, 100], [300, 75], [200, 65], [250, 60]]],
    ['Natural stone', [[610, 406], [610, 305], [600, 400], [400, 400], [800, 400]]],
  ];
  /* pick a tile: preset sizes or custom; cb(tile) */
  function addTileModal(cb) {
    const m = modal(`<h3>Add a tile</h3><div class="muted">Tap a common size, or enter your own. You can change everything afterwards.</div>
      ${PRESETS.map(([g, list]) => `<div style="margin-top:10px"><div class="muted" style="font-weight:600">${g}</div><div class="row" style="gap:6px;margin-top:4px">${list.map(([w, h]) => `<button class="btn sm sec" data-ps="${w}x${h}">${w}×${h}</button>`).join('')}</div></div>`).join('')}
      <div class="row" style="margin-top:14px"><button class="btn" data-ps="custom">Custom size</button><button class="btn sec" data-close>Cancel</button></div>`);
    m.addEventListener('click', e => {
      const b = e.target.closest('[data-ps]'); if (!b) return;
      checkpoint();
      let t;
      if (b.dataset.ps === 'custom') t = Store.newTile({ name: 'New tile', w: '', h: '', thick: 10, perBox: '' });
      else { const [w, h] = b.dataset.ps.split('x').map(Number); const slab = w * h >= 1600 * 800; t = Store.newTile({ name: `${w}×${h}`, w, h, thick: slab ? 6 : (w <= 300 && h <= 300 ? 8 : 10), perBox: '' }); }
      S.job.tiles.push(t);
      // areas that have no tile yet get this one
      allSurfaces().forEach(({ surface }) => { if (!surface.tileId || !S.job.tiles.some(x => x.id === surface.tileId)) surface.tileId = t.id; });
      S.job.groups.forEach(g => { if (!g.tileId || !S.job.tiles.some(x => x.id === g.tileId)) g.tileId = t.id; });
      S.cache.clear(); save(); m.remove(); cb && cb(t);
      tileModal(t.id, true);
    });
  }
  function tileFields(t) {
    const f = (k, l, type = 'number', ph = '') => `<label class="f">${l}<input data-t="${k}" type="${type}" ${type === 'number' ? 'inputmode="decimal" step="any"' : ''} value="${esc(t[k])}" placeholder="${ph}"></label>`;
    return `<div class="grid">${f('name', 'Name', 'text')}${f('w', 'Size 1 (across) mm')}${f('h', 'Size 2 (up) mm')}${f('thick', 'Thickness mm')}${f('perBox', 'Tiles per box')}${f('m2PerBox', 'or m² per box')}${f('adhCoverage', 'Adhesive m²/bag', 'number', 'default')}</div>`;
  }
  function tileModal(id, isNew) {
    const t = S.job.tiles.find(x => x.id === id);
    const used = allSurfaces().filter(({ surface }) => tileOf(surface).id === id).length;
    const m = modal(`<h3>${isNew ? 'New tile' : 'Edit tile'}</h3>${tileFields(t)}
      <div class="note">Used on ${used} area${used === 1 ? '' : 's'}. Changes apply everywhere this tile is used. On a straight lay, size 1 runs across.</div>
      <div class="row"><button class="btn" data-close>Done</button>${S.job.tiles.length > 1 ? '<button class="btn danger" data-m="del">Delete tile</button>' : ''}</div>`);
    m.oninput = e => { const k = e.target.dataset.t; if (!k) return; t[k] = e.target.type === 'number' && e.target.value !== '' ? +e.target.value : e.target.value; S.cache.clear(); save(); };
    m.addEventListener('click', e => {
      if (e.target.closest('[data-m="del"]')) {
        if (used && !confirm(`This tile is used on ${used} areas. They will switch to the first tile. Delete?`)) return;
        S.job.tiles.splice(S.job.tiles.indexOf(t), 1); const t0 = (S.job.tiles[0]?.id || null);
        allSurfaces().forEach(({ surface }) => { if (surface.tileId === id) surface.tileId = t0; if (surface.settings.border?.tileId === id) surface.settings.border.tileId = t0; });
        S.job.groups.forEach(g => { if (g.tileId === id) g.tileId = t0; }); save(); m.remove();
      }
      if (!document.body.contains(m)) { if (S.viewId) { renderPane(); requestDraw(); } else renderJob(); }
    });
  }
  function quickRoomModal() {
    const m = modal(`<h3>Quick room</h3><div class="grid">
      <label class="f">Room name<input id="qName" value="Bathroom"></label><label class="f">Length (mm)<input id="qL" type="number" inputmode="decimal" value="2400"></label>
      <label class="f">Width (mm)<input id="qW" type="number" inputmode="decimal" value="1800"></label><label class="f">Tiling height (mm)<input id="qH" type="number" inputmode="decimal" value="2400"></label></div>
      <label class="chk"><input type="checkbox" id="qWalls" checked> 4 walls (A, B, C, D going round the room), opened together</label><label class="chk"><input type="checkbox" id="qFloor" checked> Floor</label>
      <div class="row"><button class="btn" data-m="go">Create</button><button class="btn sec" data-close>Cancel</button></div>`);
    m.querySelector('[data-m="go"]').onclick = () => {
      const L = +$('#qL', m).value, W = +$('#qW', m).value, H = +$('#qH', m).value; if (!(L > 0 && W > 0)) return toast('Enter the room size');
      const room = Store.newRoom($('#qName', m).value || 'Room'); const tid = (S.job.tiles[0]?.id || null);
      const walls = [];
      if ($('#qWalls', m).checked) [['A', L], ['B', W], ['C', L], ['D', W]].forEach(([n, len]) => { const s = Store.newSurface('wall', { name: `Wall ${n}`, outline: [[0, 0], [len, 0], [len, H], [0, H]], tileId: tid }); room.surfaces.push(s); walls.push(s); });
      if ($('#qFloor', m).checked) { const fl = Store.newSurface('floor', { name: 'Floor', outline: [[0, 0], [L, 0], [L, W], [0, W]], tileId: tid }); room.surfaces.push(fl); walls.forEach((w, i) => { w.link = { floorId: fl.id, edge: i }; }); }
      room.surfaces.forEach(autoStart);
      S.job.rooms.push(room);
      if (walls.length > 1) { const g = makeGroup(`${room.name} — walls`, 'strip', walls); autoStartGroup(g); }
      save(); m.remove(); renderJob();
    };
  }
  function copyPrompt() {
    const txt = AI.PROMPT;
    const m = modal(`<h3>Prompt for Claude</h3><div class="muted">Send this to Claude along with a photo or PDF of the drawing. Copy the reply and use <b>Paste room data</b>.</div><textarea class="code" readonly>${esc(txt)}</textarea><div class="row"><button class="btn" data-m="copy">Copy</button><button class="btn sec" data-close>Close</button></div>`);
    m.querySelector('[data-m="copy"]').onclick = async () => { try { await navigator.clipboard.writeText(txt); toast('Prompt copied'); } catch (e) { m.querySelector('textarea').select(); document.execCommand('copy'); toast('Prompt copied'); } };
  }
  function pasteModal(targetSurface) {
    const m = modal(`<h3>Paste room data</h3><div class="muted">Paste the reply from Claude (the block that starts with {).</div><textarea class="code" id="pj" placeholder='{"rooms":[...]}'></textarea><div class="row"><button class="btn" data-m="go">Check</button><button class="btn sec" data-close>Cancel</button></div>`);
    m.querySelector('[data-m="go"]').onclick = () => { try { const d = AI.extractJSON($('#pj', m).value); m.remove(); previewImport(d, targetSurface); } catch (e) { toast('Could not read that: ' + e.message, 4000); } };
  }
  function previewImport(data, targetSurface) {
    let out; try { out = AI.toRooms(data, (S.job.tiles[0]?.id || null)); } catch (e) { return toast(e.message, 4000); }
    const list = out.rooms.map(r => `<div><b>${esc(r.name)}</b><ul style="margin:4px 0 8px;padding-left:18px">${r.surfaces.map(s => { const b = Geo.bbox(s.outline); const units = s.openings.filter(o => o.tiled).length; return `<li>${esc(s.name)} (${s.kind}) ${Math.round(b.w)} × ${Math.round(b.h)} mm · ${s.openings.length - units} openings${units ? ` · ${units} units tiled under` : ''}${s.doorways.length ? ` · ${s.doorways.length} doorway${s.doorways.length > 1 ? 's' : ''}` : ''}</li>`; }).join('')}</ul></div>`).join('');
    const floors = out.rooms.flatMap(r => r.surfaces.filter(s => s.kind === 'floor'));
    const first = out.rooms[0]?.surfaces[0];
    const m = modal(`<h3>Found in drawing</h3>${list || '<div class="muted">Nothing usable found.</div>'}
      ${out.groups.length ? `<div class="note">Walls will open together, unfolded: ${out.groups.map(g => esc(g.name)).join(', ')}.</div>` : ''}
      ${floors.length > 1 ? '<label class="chk"><input type="checkbox" id="joinFloors"> Join the floors into one set-out (tile runs through)</label>' : ''}
      ${out.notes ? `<div class="warn"><b>Check:</b> ${esc(out.notes)}</div>` : ''}${out.warnings.map(w => `<div class="err">${esc(w)}</div>`).join('')}
      <div class="note">Automatic readings are a first draft. Check every dimension before setting out.</div>
      <div class="row">${out.rooms.length ? '<button class="btn" data-m="add">Add to job</button>' : ''}${targetSurface && first ? '<button class="btn sec" data-m="replace">Use first area for this one</button>' : ''}<button class="btn sec" data-close>Cancel</button></div>`);
    m.onclick = e => {
      const a = e.target.closest('[data-m]')?.dataset.m;
      if (a === 'add') {
        checkpoint();
        const join = $('#joinFloors', m)?.checked;
        out.rooms.forEach(r => r.surfaces.forEach(autoStart)); S.job.rooms.push(...out.rooms); S.job.groups.push(...out.groups);
        out.groups.forEach(autoStartGroup);
        let open = null;
        if (join) { const g = makeGroup(floors.map(f => f.name).join(' + '), 'plan', floors); autoStartGroup(g); open = g.id; }
        save(); m.remove(); toast(`Added ${out.rooms.length} room${out.rooms.length > 1 ? 's' : ''}`);
        if (open) openView(open); else if (S.viewId) location.hash = `#/job/${S.job.id}`; else renderJob();
      }
      if (a === 'replace') { checkpoint(); targetSurface.outline = first.outline; targetSurface.openings = first.openings; targetSurface.doorways = first.doorways; targetSurface.kind = first.kind; autoStart(targetSurface); save(); m.remove(); S.view = null; renderPane(); requestDraw(); }
      if (e.target === m) m.remove();
    };
  }
  function autoStart(surface) {
    if (groupOf(surface)) return;
    try { const b = Geo.findBestStarts(surface, tileOf(surface), geoSettings(surface), 1)[0]; if (b) { surface.pattern.ox = Math.round(b.ox * 10) / 10; surface.pattern.oy = Math.round(b.oy * 10) / 10; surface.startLabel = b.label; } } catch (e) { console.warn(e); }
  }
  function groupItems(g) {
    const mem = g.members.map(id => findSurface(id)).filter(x => x.surface);
    const cum = g.mode === 'strip' ? stripCum(g) : null;
    const off = offsets({ mode: g.mode, members: mem });
    return mem.map(({ surface }, i) => ({
      surface: { ...surface, pattern: { ...g.pattern, ox: surface.pattern.ox, oy: g.pattern.oy } },
      off: g.mode === 'strip' && g.lockX ? [cum.get(surface.id) + i * cornerAllow(), 0] : off.get(surface.id), real: surface,
    }));
  }
  const r10 = v => Math.round(v * 10) / 10;
  function applyGroupBest(g, b) {
    const items = groupItems(g);
    if (b.walls) { b.walls.forEach((w, i) => { const s = items[i].real; if (g.lockX) { /* not used */ } s.pattern.ox = r10(w.ox); if (g.lockY !== false) g.pattern.oy = r10(w.oy); else s.pattern.oy = r10(w.oy); }); }
    else if (g.mode === 'strip') { g.pattern.ox = r10(b.ox); if (g.lockY !== false) g.pattern.oy = r10(b.oy); else items.forEach(it => { it.real.pattern.oy = r10(b.oy); }); }
    else { g.pattern.ox = r10(b.ox); g.pattern.oy = r10(b.oy); }
    g.startLabel = b.label; S.cache.clear();
  }
  function bestForGroup(g, top) {
    const items = groupItems(g); const t = tileOf(items[0].real); if (!t) return [];
    const gs = geoSettings(items[0].real);
    if (g.mode === 'strip' && g.lockX) return Geo.bestForSet(items, t, gs, 'plan', top);
    if (g.mode === 'strip' && g.lockY === false) { // each wall on its own
      const walls = items.map(it => { const b = Geo.findBestStarts({ ...it.real, pattern: eff(it.real).pattern }, tileOf(it.real), geoSettings(it.real), 1)[0]; return b ? { ox: b.ox, oy: b.oy, stats: b.stats } : null; });
      if (walls.some(w => !w)) return [];
      const st = walls.reduce((a, w) => ({ slivers: a.slivers + w.stats.slivers, needed: a.needed + w.stats.needed, cuts: a.cuts + w.stats.cuts, minCut: Math.min(a.minCut, w.stats.minCut ?? Infinity) }), { slivers: 0, needed: 0, cuts: 0, minCut: Infinity });
      if (!isFinite(st.minCut)) st.minCut = null;
      return [{ label: 'Best for each wall on its own', walls, stats: st }];
    }
    if (g.tileMode === 'separate' && g.mode === 'strip') return Geo.bestForSet(items.filter(it => tileOf(it.real)?.id === t.id), t, gs, g.mode, top);
    return Geo.bestForSet(items, t, gs, g.mode, top);
  }
  function autoStartGroup(g) { try { const b = bestForGroup(g, 1)[0]; if (b) applyGroupBest(g, b); } catch (e) { console.warn(e); } }

  // ---------- walls linked to floor sides ----------
  function edgeLen(f, i) { const o = f.outline, A = o[i], B = o[(i + 1) % o.length]; return A && B ? Math.hypot(B[0] - A[0], B[1] - A[1]) : 0; }
  function bottomEdge(w) { const o = w.outline, y0 = Math.min(...o.map(p => p[1])); let bi = -1, bl = 0; o.forEach((p, i) => { const q = o[(i + 1) % o.length]; if (Math.abs(p[1] - y0) < 0.5 && Math.abs(q[1] - y0) < 0.5) { const l = Math.abs(q[0] - p[0]); if (l > bl) { bl = l; bi = i; } } }); return bi; }
  const sigOf = s => JSON.stringify([s.outline, s.link || null, (s.openings || []).filter(o => o.type === 'door').map(o => [o.id, o.x, o.w])]);
  function resetSigs() { S.sigs = new Map(); S.prevOutlines = new Map(); if (S.job) allSurfaces().forEach(({ surface }) => { S.sigs.set(surface.id, sigOf(surface)); S.prevOutlines.set(surface.id, JSON.parse(JSON.stringify(surface.outline))); }); }
  /* after a floor's shape is replaced, keep each wall on the matching side (same direction, nearest) */
  function remapDoorways(f, old, mapPt = q => q) {
    (f.doorways || []).forEach(d => {
      const pts = Geo.doorwayPts({ outline: old }, d); if (!pts) return;
      const m = Geo.pointToDoorway(f.outline, mapPt(pts[0]), mapPt(pts[1])); if (m) { d.edge = m.edge; d.pos = m.pos; d.w = m.w || d.w; }
    });
  }
  function remapLinks(f, old) {
    remapDoorways(f, old);
    const walls = allSurfaces().map(x => x.surface).filter(w => w.kind === 'wall' && w.link && w.link.floorId === f.id);
    const o = f.outline;
    walls.forEach(w => {
      const A = old[w.link.edge], B = old[(w.link.edge + 1) % old.length]; if (!A || !B) return;
      const L = Math.hypot(B[0] - A[0], B[1] - A[1]) || 1; const u = [(B[0] - A[0]) / L, (B[1] - A[1]) / L]; const m = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2];
      let best = -1, bd = Infinity;
      o.forEach((P, i) => { const Q = o[(i + 1) % o.length]; const l = Math.hypot(Q[0] - P[0], Q[1] - P[1]); if (l < 1) return; const dot = ((Q[0] - P[0]) * u[0] + (Q[1] - P[1]) * u[1]) / l; if (dot < 0.99) return; const d = Math.hypot((P[0] + Q[0]) / 2 - m[0], (P[1] + Q[1]) / 2 - m[1]); if (d < bd) { bd = d; best = i; } });
      if (best >= 0) w.link.edge = best; else delete w.link;
    });
  }
  /* keep walls and the floor they stand on the same length; wall doors become floor doorways */
  function syncLinks() {
    if (!S.job || !S.sigs) return false;
    const surfs = allSurfaces().map(x => x.surface);
    const changed = surfs.filter(s => S.sigs.has(s.id) && S.sigs.get(s.id) !== sigOf(s));
    let did = false; const floors = new Set();
    changed.filter(s => s.kind === 'wall' && s.link).forEach(w => {
      const f = findSurface(w.link.floorId).surface; if (!f || w.link.edge >= f.outline.length) return;
      const L = edgeLen(f, w.link.edge), W = Geo.bbox(w.outline).w;
      if (Math.abs(L - W) > 0.5) { Geo.stretchEdge(f, w.link.edge, W); did = true; floors.add(f.id); }
      if (syncDoors(w, f)) did = true;
    });
    changed.filter(s => s.kind === 'floor').forEach(f => {
      const old = S.prevOutlines && S.prevOutlines.get(f.id);
      if (old && old.length !== f.outline.length) { remapLinks(f, old); did = true; }
      floors.add(f.id);
    });
    floors.forEach(fid => {
      const f = findSurface(fid).surface; if (!f) return;
      surfs.filter(w => w.kind === 'wall' && w.link && w.link.floorId === fid && !changed.includes(w) && w.link.edge < f.outline.length).forEach(w => {
        const L = edgeLen(f, w.link.edge), W = Geo.bbox(w.outline).w;
        if (Math.abs(L - W) > 0.5) { const bi = bottomEdge(w); if (bi >= 0) { Geo.stretchEdge(w, bi, edgeLen(w, bi) + (L - W)); did = true; } }
        if (syncDoors(w, f)) did = true;
      });
    });
    surfs.forEach(s => { S.sigs.set(s.id, sigOf(s)); S.prevOutlines.set(s.id, JSON.parse(JSON.stringify(s.outline))); });
    if (did) S.cache.clear();
    return did;
  }
  function syncDoors(w, f) {
    let did = false; const L = edgeLen(f, w.link.edge); f.doorways = f.doorways || [];
    const doors = (w.openings || []).filter(o => o.type === 'door');
    doors.forEach(o => {
      const pos = Math.round(L - (+o.x + +o.w)); let d = f.doorways.find(x => x.fromOp === o.id);
      if (!d) { d = { id: Store.uid(), name: `${o.name || 'Door'} (${w.name})`, edge: w.link.edge, pos, w: +o.w, fromOp: o.id, fromWall: w.id }; f.doorways.push(d); did = true; }
      else if (d.pos !== pos || d.w !== +o.w || d.edge !== w.link.edge) { d.pos = pos; d.w = +o.w; d.edge = w.link.edge; did = true; }
    });
    const before = f.doorways.length;
    f.doorways = f.doorways.filter(d => d.fromWall !== w.id || doors.some(o => o.id === d.fromOp));
    return did || before !== f.doorways.length;
  }
  function linkWall(w, floorId, edge) {
    if (!floorId) { delete w.link; return; }
    w.link = { floorId, edge: +edge };
    const f = findSurface(floorId).surface; const L = edgeLen(f, +edge), W = Geo.bbox(w.outline).w;
    if (Math.abs(L - W) > 0.5) { const bi = bottomEdge(w); if (bi >= 0) Geo.stretchEdge(w, bi, edgeLen(w, bi) + (L - W)); }
    syncDoors(w, f); resetSigs(); S.cache.clear();
  }

  // ---------- export ----------
  function exportModal(scope) {
    const v = scope ? curView() : null;
    const m = modal(`<h3>Export</h3>
      <label class="chk"><input type="checkbox" id="xIds" ${S.showIds ? 'checked' : ''}> Piece numbers on drawings</label>
      <label class="chk"><input type="checkbox" id="xSet" ${S.showSetout ? 'checked' : ''}> Set-out lines and dimensions for fitters</label>
      <label class="chk"><input type="checkbox" id="xBg"> Imported drawings behind the set-out</label>
      <div class="row" style="flex-direction:column;align-items:stretch;margin-top:8px">
        ${v ? `<button class="btn" data-x="viewpdf">PDF — this view (${esc(v.group ? v.group.name : v.members[0].surface.name)})</button><button class="btn sec" data-x="viewimg">Image — this view</button>` : ''}
        <button class="btn ${v ? 'sec' : ''}" data-x="jobpdf">PDF — whole job</button><button class="btn sec" data-close>Cancel</button></div>`);
    m.onclick = async e => {
      const x = e.target.closest('[data-x]')?.dataset.x; if (!x) { if (e.target === m) m.remove(); return; }
      const opts = { ids: $('#xIds', m).checked, setout: $('#xSet', m).checked, withBg: $('#xBg', m).checked };
      m.remove(); toast('Preparing…'); await new Promise(r => setTimeout(r, 30));
      try {
        if (x === 'jobpdf') await exportJobPDF(opts);
        if (x === 'viewpdf') await exportViewPDF(opts);
        if (x === 'viewimg') await exportImage(opts);
      } catch (err) { console.error(err); toast('Export failed: ' + err.message, 5000); }
    };
  }
  async function itemsFor(view, opts) {
    const off = offsets(view);
    const items = [];
    for (const { room, surface } of view.members) {
      const c = calc(surface); const bgD = bgData(surface);
      items.push({ room, surface: c.surface, tile: c.tile, res: c.res, mat: c.mat, cuts: c.cuts, ref: c.ref, off: off.get(surface.id), noSideDims: view.mode === 'strip' && items.length > 0, bgImg: opts.withBg && bgD ? await loadImg(bgD) : null });
    }
    return items;
  }
  async function exportJobPDF(opts) {
    const tot = jobTotals(S.job);
    const views = [];
    for (const g of S.job.groups) { const v = { group: g, mode: g.mode, members: g.members.map(id => findSurface(id)).filter(x => x.surface) }; views.push({ title: g.name, items: await itemsFor(v, opts) }); }
    const grouped = new Set(S.job.groups.flatMap(g => g.members));
    for (const r of S.job.rooms) for (const s of r.surfaces) if (!grouped.has(s.id)) views.push({ title: `${r.name} — ${s.name}`, items: await itemsFor({ mode: 'single', members: [{ room: r, surface: s }] }, opts) });
    const doc = await PDFX.exportJob(S.job, views, tot, opts);
    await shareOrDownload(doc.output('blob'), `${safeName(S.job.name)}-tile-setout.pdf`);
  }
  function viewTitle(v) { return v.group ? v.group.name : `${v.members[0].room.name} — ${v.members[0].surface.name}`; }
  async function exportViewPDF(opts) {
    const v = curView(); const items = await itemsFor(v, opts);
    const doc = await PDFX.exportView(S.job, { title: viewTitle(v), items }, opts);
    await shareOrDownload(doc.output('blob'), `${safeName(S.job.name)}-${safeName(viewTitle(v))}.pdf`);
  }
  async function exportImage(opts) {
    const v = curView(); const items = await itemsFor(v, opts);
    const bb = Render.itemsBBox(items); const W = 2200; const H = Math.round(Math.min(3000, Math.max(1000, W * bb.h / bb.w + 260)));
    const draw = Render.renderToCanvas(items, W, H - 150, { pad: 100, dimFont: 26, labelScale: 2.2, ids: opts.ids, setout: opts.setout, withBg: opts.withBg });
    const out = document.createElement('canvas'); out.width = W; out.height = H; const x = out.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, W, H); x.fillStyle = '#4A4B4D'; x.fillRect(0, 0, W, 110); x.fillStyle = '#CE8B3E'; x.fillRect(0, 110, W, 6);
    x.font = 'bold 44px system-ui'; x.fillStyle = '#fff'; x.fillText('NAOS', 40, 70); x.fillStyle = '#CE8B3E'; x.font = '44px system-ui'; x.fillText('FLOORS', 170, 70);
    x.fillStyle = '#fff'; x.font = '30px system-ui'; x.textAlign = 'right'; x.fillText(`${S.job.name} · ${viewTitle(v)}`, W - 40, 50);
    const t = items[0].tile; const p = items[0].surface.pattern; const need = items.reduce((s, i) => s + (i.res?.stats.needed || 0), 0);
    x.font = '24px system-ui'; x.fillText(`${t.name} ${t.w}×${t.h} · ${Geo.PATTERNS[p.type].name} · ${p.joint} mm joint · ${need} tiles`, W - 40, 90);
    x.drawImage(draw, 0, 130);
    await new Promise(res => out.toBlob(async b => { await shareOrDownload(b, `${safeName(S.job.name)}-${safeName(viewTitle(v))}.png`); res(); }, 'image/png'));
  }

  // ---------- editor ----------
  let cv = null, ctx = null, drawQ = false;
  function requestDraw() { if (drawQ) return; drawQ = true; requestAnimationFrame(() => { drawQ = false; drawEditor(); }); }

  function renderEditor() {
    const v = curView(); const { room, surface } = cur(); if (!surface) { location.hash = `#/job/${S.job.id}`; return; }
    const title = v.mode === 'folded' ? `${esc(v.floor.name)} — folded out` : v.group ? esc(v.group.name) : `${esc(room.name)} — ${esc(surface.name)}`;
    const canFold = v.mode !== 'folded' && v.members.some(({ surface: m }) => (m.kind === 'wall' && m.link) || (m.kind === 'floor' && allSurfaces().some(x => x.surface.link?.floorId === m.id)));
    app.innerHTML = `
      <div class="top"><button data-a="back" aria-label="Back to job">‹</button><h1>${title}</h1><span class="netslot">${netPill()}</span><button data-a="export">Export</button></div>
      <div class="editor">
        <div class="cvwrap"><canvas id="cv"></canvas>
          <div class="tools">
            <button data-mode="move" title="Drag to move the tiles">✥<span class="lbl"> Tiles</span></button><button data-mode="pan" title="Drag to move around">✋<span class="lbl"> Pan</span></button>${v.mode !== 'folded' ? '<button data-mode="edit" title="Drag corners and openings, tap a measurement to change it">✎<span class="lbl"> Shape</span></button>' : ''}
            ${v.mode === 'plan' ? '<button data-mode="arrange" title="Drag areas into place">⇄<span class="lbl"> Arrange</span></button>' : ''}${canFold ? '<button data-a="fold" title="See the floor with its walls folded out round it">▣<span class="lbl"> Fold out</span></button>' : ''}
            <span class="sp"></span><button data-noundo data-a="undo" title="Undo">↶</button><button data-noundo data-a="redo" title="Redo">↷</button><button data-a="fit" title="Fit to screen">⤢</button><button data-a="help" title="Help">?</button>
          </div>
          <div id="hint"></div>
          <div class="stat" id="stat"></div>
        </div>
        <div class="panel"><div class="tabs">${[['shape', 'Shape'], ['openings', 'Openings'], ['tile', 'Tile & pattern'], ['setout', 'Set-out'], ['cuts', 'Cut list'], ['order', 'Order'], ['drawing', 'Drawing']].map(([k, l]) => `<button data-tab="${k}" class="${S.tab === k ? 'on' : ''}">${l}</button>`).join('')}</div>
          <div class="pane" id="pane"></div></div>
      </div>`;
    cv = $('#cv'); ctx = cv.getContext('2d');
    setupCanvas(cv);
    new ResizeObserver(() => { sizeCanvas(); requestDraw(); }).observe(cv.parentElement);
    sizeCanvas(); setModeButtons(); renderPane(); requestDraw();
    app.oninput = null;
    app.onclick = e => {
      const tb = e.target.closest('[data-tab]'); if (tb) { S.tab = tb.dataset.tab; $$('.tabs button').forEach(b => b.classList.toggle('on', b === tb)); renderPane(); return; }
      const md = e.target.closest('[data-mode]'); if (md) { setMode(md.dataset.mode); return; }
      const a = e.target.closest('.top [data-a], .tools [data-a]')?.dataset.a;
      if (a === 'back') location.hash = `#/job/${S.job.id}`;
      if (a === 'fit') { S.view = null; requestDraw(); }
      if (a === 'undo') undo(); if (a === 'redo') redo();
      if (a === 'export') exportModal('view');
      if (a === 'help') helpModal();
      if (a === 'fold') { const sel = cur().surface; const fid = sel.kind === 'floor' ? sel.id : (sel.link?.floorId || v.members.map(m => m.surface).find(m => m.link)?.link.floorId); if (fid) openView('fold-' + fid, sel.id); }
    };
  }
  function helpModal() {
    modal(`<h3>How to use the set-out view</h3>
      <div class="note" style="font-size:14px;line-height:1.5">
      <b>✥ Tiles</b> — drag to slide the tiles. The bronze cross is the start point.<br>
      <b>✋ Pan</b> — drag to move around. Pinch or scroll to zoom. ⤢ fits everything on screen.<br>
      <b>✎ Shape</b> — drag corners and openings. <b>Tap a measurement</b> to type a new length. Tap an edge to add a corner.<br>
      ${curView().mode === 'plan' ? '<b>⇄ Arrange</b> — drag areas so they meet; they snap edge to edge.<br>' : ''}
      <b>↶ ↷</b> — undo and redo.<br><br>
      <b>Colours:</b> cream = full tile, light bronze = cut, darker bronze = notched or angled, red = sliver.
      Blue dashes = units tiled under; green dashes = doorway; green lines = set-out lines for fitters.<br><br>
      <b>Set-out tab</b> → <b>Find best start</b> tries every sensible start and ranks them.</div>
      <div class="row"><button class="btn" data-close>Got it</button></div>`);
  }
  function setMode(m) { S.mode = m; S.selVertex = -1; setModeButtons(); requestDraw(); }
  function setModeButtons() { $$('.tools [data-mode]').forEach(b => b.classList.toggle('on', b.dataset.mode === S.mode && !S.trace && !S.calib && !S.opTrace)); renderHint(); }
  function sizeCanvas() { if (!cv) return; const r = cv.parentElement.getBoundingClientRect(); const d = window.devicePixelRatio || 1; cv.width = Math.round(r.width * d); cv.height = Math.round(r.height * d); }
  function dims() { const d = window.devicePixelRatio || 1; return [cv.width / d, cv.height / d]; }
  function sceneItems(raw) {
    const v = curView(); const off = offsets(v);
    return v.members.map(({ surface }, idx) => {
      const c = raw ? null : calc(surface);
      const e = eff(surface);
      let rawT = null; if (raw && tileOf(surface)) { const reg = Geo.surfaceRegion(e); if (reg) rawT = Geo.layTiles(reg, tileOf(surface), e.pattern, { limit: 20000 }).tiles; }
      return { surface: e, real: surface, tile: tileOf(surface), res: c ? c.res : null, raw: rawT, off: off.get(surface.id), rot: rots(v).get(surface.id) || 0, selected: surface.id === S.selId, bgImg: bgImgFor(surface), ref: c ? c.ref : null, dimmed: v.members.length > 1 && S.mode === 'edit' && surface.id !== S.selId, noSideDims: v.mode === 'strip' && idx > 0 && !(S.mode === 'edit' && surface.id === S.selId) };
    });
  }
  function fitView() {
    const [W, H] = dims(); const items = sceneItems(true).map(i => ({ ...i, raw: null }));
    const pts = [];
    const bbAll = Render.itemsBBox(items); pts.push([bbAll.x0, bbAll.y0], [bbAll.x1, bbAll.y1]);
    const sel = items.find(i => i.selected);
    if (sel && sel.real.bg && (S.trace || S.calib)) { const img = bgImgFor(sel.real); if (img) { const b = sel.real.bg; pts.push([b.x + sel.off[0], b.y + sel.off[1]], [b.x + img.width * b.mmPerPx + sel.off[0], b.y - img.height * b.mmPerPx + sel.off[1]]); } }
    S.view = Render.makeView(Geo.bbox(pts), W, H, 54); S.view.cy += (items.length > 1 ? 26 : 16) / S.view.s;
  }
  function originPoints() {
    const v = curView();
    if (v.mode === 'plan') return [[+v.group.pattern.ox || 0, +v.group.pattern.oy || 0]];
    return v.members.filter(({ surface }) => v.members.length === 1 || surface.id === S.selId).map(({ surface }) => { const e = eff(surface); return toWorld(v, surface, [+e.pattern.ox || 0, +e.pattern.oy || 0]); });
  }
  function drawEditor() {
    if (!cv || !S.viewId) return; const v = curView(); if (!v) return;
    const [W, H] = dims(); const d = window.devicePixelRatio || 1;
    if (!S.view) fitView();
    ctx.setTransform(d, 0, 0, d, 0, 0);
    const items = sceneItems(S.dragging);
    S.dimHits = [];
    Render.scene(ctx, W, H, S.view, items, { vertices: S.mode === 'edit', selVertex: S.selVertex, selOpening: S.selOpening, trace: S.trace, calib: S.calib || (S.opTrace && S.opTrace.length ? S.opTrace : null), ids: S.showIds, origins: originPoints(), dimHits: S.dimHits, setout: S.showSetout && !S.dragging && S.mode !== 'edit' && v.mode !== 'folded', multi: items.length > 1 });
    const el = $('#stat'); if (!el) return;
    if (S.dragging) { el.innerHTML = '<span>moving…</span>'; return; }
    const tot = items.reduce((a, it) => { const st = it.res?.stats; if (!st) return a; a.n += st.needed; a.c += st.cuts; a.s += st.slivers; if (st.minCut != null) a.m = Math.min(a.m, st.minCut); return a; }, { n: 0, c: 0, s: 0, m: Infinity });
    if (!items.some(it => it.tile)) { el.innerHTML = '<span class="bad">Choose a tile — Tile &amp; pattern tab</span>'; return; }
    const sl = geoSettings(cur().surface).sliver;
    el.innerHTML = `<span>${tot.n} tiles</span><span>${tot.c} cuts</span><span class="${tot.m < sl ? 'bad' : 'good'}">smallest ${isFinite(tot.m) ? Math.round(tot.m) + ' mm' : '-'}</span>${tot.s ? `<span class="bad">${tot.s} sliver${tot.s > 1 ? 's' : ''}</span>` : ''}`;
  }
  function renderHint() {
    const h = $('#hint'); if (!h) return;
    let html = '';
    if (S.trace) html = `<span>Tap each corner in turn. Tap the first point to close.</span><label style="display:flex;gap:4px;align-items:center"><input type="checkbox" id="ortho" ${S.traceOrtho ? 'checked' : ''}>Square</label><button data-h="undo">Undo point</button><button data-h="finish">Finish</button><button data-h="cancel">Cancel</button>`;
    else if (S.calib) html = `<span>Scale: tap the two ends of a known dimension (${S.calib.length}/2).</span><button data-h="cancel">Cancel</button>`;
    else if (S.opTrace) html = `<span>${OP_TYPES[S.opType]}: tap two opposite corners (${S.opTrace.length}/2).</span><button data-h="cancel">Cancel</button>`;
    else if (S.mode === 'edit') html = `<span>Drag corners or openings · <b>tap a measurement</b> to change it · tap an edge to add a corner</span><button data-h="done">Done</button>`;
    else if (S.mode === 'arrange') html = `<span>Drag an area to move it — it snaps edge to edge and to doorways.</span><button data-h="done">Done</button>`;
    h.className = html ? 'hint' : ''; h.innerHTML = html;
    h.onclick = e => {
      const a = e.target.closest('[data-h]')?.dataset.h;
      if (a === 'undo') { S.trace.pop(); requestDraw(); }
      if (a === 'finish') finishTrace();
      if (a === 'cancel') { S.trace = S.calib = S.opTrace = null; setModeButtons(); requestDraw(); }
      if (a === 'done') setMode('move');
    };
    $('#ortho')?.addEventListener('change', e => { S.traceOrtho = e.target.checked; });
  }

  function setupCanvas(cv) {
    const ptrs = new Map(); let g = null;
    const pos = e => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    const world = (x, y) => { const [W, H] = dims(); return Render.toW(S.view, W, H, x, y); };
    cv.addEventListener('pointerdown', e => {
      cv.setPointerCapture(e.pointerId); const p = pos(e); ptrs.set(e.pointerId, p);
      if (ptrs.size === 2) {
        const [a, b] = [...ptrs.values()]; if (g && g.dragging) endDrag(true);
        g = { type: 'pinch', d0: Math.hypot(a[0] - b[0], a[1] - b[1]), m0: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], v0: { ...S.view } };
        g.w0 = world(...g.m0);
      } else if (ptrs.size === 1) g = startGesture(p);
    });
    cv.addEventListener('pointermove', e => {
      if (!ptrs.has(e.pointerId)) return; const p = pos(e); ptrs.set(e.pointerId, p);
      if (!g) return;
      if (g.type === 'pinch' && ptrs.size === 2) {
        const [a, b] = [...ptrs.values()]; const d = Math.hypot(a[0] - b[0], a[1] - b[1]); const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        const s = Math.max(0.005, Math.min(20, g.v0.s * d / Math.max(g.d0, 1)));
        const [W, H] = dims();
        S.view = { s, cx: g.w0[0] - (m[0] - W / 2) / s, cy: g.w0[1] + (m[1] - H / 2) / s };
        requestDraw(); return;
      }
      moveGesture(g, p);
    });
    const up = e => {
      if (!ptrs.has(e.pointerId)) return; ptrs.delete(e.pointerId);
      if (g && g.type === 'pinch') { if (ptrs.size === 0) g = null; return; }
      if (g) { endGesture(g, pos(e)); g = null; }
    };
    cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
    cv.addEventListener('wheel', e => {
      e.preventDefault(); const p = pos(e); const w0 = world(...p); const [W, H] = dims();
      const s = Math.max(0.005, Math.min(20, S.view.s * Math.exp(-e.deltaY * 0.0015)));
      S.view = { s, cx: w0[0] - (p[0] - W / 2) / s, cy: w0[1] + (p[1] - H / 2) / s }; requestDraw();
    }, { passive: false });

    function memberAt(w) {
      const v = curView();
      for (const { surface } of v.members) { if (Geo.pointInRing(toLocal(v, surface, w), surface.outline)) return surface; }
      return null;
    }
    // moving the tiles of one area (and everything it is locked to)
    function originDragger(s) {
      const g2 = groupOf(s);
      if (!g2) { const ox = +s.pattern.ox || 0, oy = +s.pattern.oy || 0; return (dx, dy) => { s.pattern.ox = Math.round(ox + dx); s.pattern.oy = Math.round(oy + dy); }; }
      if (g2.mode === 'plan') { const ox = +g2.pattern.ox || 0, oy = +g2.pattern.oy || 0; return (dx, dy) => { g2.pattern.ox = Math.round(ox + dx); g2.pattern.oy = Math.round(oy + dy); }; }
      const gx = +g2.pattern.ox || 0, gy = +g2.pattern.oy || 0, sx = +s.pattern.ox || 0, sy = +s.pattern.oy || 0;
      return (dx, dy) => { if (g2.lockX) g2.pattern.ox = Math.round(gx + dx); else s.pattern.ox = Math.round(sx + dx); if (g2.lockY !== false) g2.pattern.oy = Math.round(gy + dy); else s.pattern.oy = Math.round(sy + dy); };
    }
    function startGesture(p) {
      const v = curView(); const { surface } = cur(); const w = world(...p); const off = offsets(v);
      const base = { p0: p, t0: Date.now(), w0: w, moved: false, v0: { ...S.view } };
      if (S.trace || S.calib || S.opTrace) return { ...base, type: 'tap' };
      if (S.mode === 'move') { const hit = memberAt(w) || surface; if (!tileOf(hit)) return { ...base, type: 'pan' }; return { ...base, type: 'drag', apply: originDragger(hit), rot: rots(v).get(hit.id) || 0, hit }; }
      if (S.mode === 'arrange' && v.mode === 'plan') { const hit = memberAt(w); if (hit) { S.selId = hit.id; return { ...base, type: 'arrange', s: hit, px: hit.place.x, py: hit.place.y }; } }
      if (S.mode === 'bg' && surface.bg) return { ...base, type: 'bg', bx: surface.bg.x, by: surface.bg.y };
      if (S.mode === 'edit') {
        const [W, H] = dims(); const o = off.get(surface.id);
        let best = -1, bd = 22;
        surface.outline.forEach((q, i) => { const s = Render.toS(S.view, W, H, [q[0] + o[0], q[1] + o[1]]); const d = Math.hypot(s[0] - p[0], s[1] - p[1]); if (d < bd) { bd = d; best = i; } });
        if (best >= 0) { S.selVertex = best; return { ...base, type: 'vertex', i: best, q0: surface.outline[best].slice() }; }
        const lw = [w[0] - o[0], w[1] - o[1]];
        for (let i = surface.openings.length - 1; i >= 0; i--) { const op = surface.openings[i]; if (Geo.pointInRing(lw, Geo.opRing(op))) { S.selOpening = i; return { ...base, type: 'opening', i, x0: +op.x, y0: +op.y, pts0: op.pts ? op.pts.map(q => q.slice()) : null }; } }
      }
      return { ...base, type: 'pan' };
    }
    function moveGesture(g, p) {
      const dx = p[0] - g.p0[0], dy = p[1] - g.p0[1];
      if (!g.moved && Math.hypot(dx, dy) < 6) return;
      if (!g.moved && g.type !== 'pan' && g.type !== 'tap') checkpoint();
      g.moved = true;
      const { surface } = cur(); const s = S.view.s;
      const wdx = dx / s, wdy = -dy / s;
      if (g.type === 'pan' || g.type === 'tap') { S.view = { ...g.v0, cx: g.v0.cx - dx / s, cy: g.v0.cy + dy / s }; requestDraw(); return; }
      g.dragging = true;
      if (g.type === 'drag') { const l = Geo.rot([wdx, wdy], -g.rot); g.apply(l[0], l[1]); S.dragging = true; }
      if (g.type === 'arrange') {
        g.dragging = true;
        let nx = g.px + wdx, ny = g.py + wdy; const thr = 14 / s;
        const v = curView(); const others = v.members.filter(m => m.surface !== g.s).map(m => m.surface);
        const mine = g.s.outline.concat((g.s.doorways || []).flatMap(d => Geo.doorwayPts(g.s, d) || []));
        let bx = null, by = null;
        others.forEach(o => { const pts = o.outline.concat((o.doorways || []).flatMap(d => Geo.doorwayPts(o, d) || [])).map(q => [q[0] + o.place.x, q[1] + o.place.y]);
          mine.forEach(q => pts.forEach(r => { const ddx = r[0] - (q[0] + nx), ddy = r[1] - (q[1] + ny); if (Math.abs(ddx) < thr && (bx == null || Math.abs(ddx) < Math.abs(bx))) bx = ddx; if (Math.abs(ddy) < thr && (by == null || Math.abs(ddy) < Math.abs(by))) by = ddy; })); });
        if (bx != null) nx += bx; if (by != null) ny += by;
        g.s.place = { x: Math.round(nx), y: Math.round(ny) }; S.cache.clear();
      }
      if (g.type === 'bg') { surface.bg.x = g.bx + wdx; surface.bg.y = g.by + wdy; }
      if (g.type === 'vertex') {
        let nx = Math.round(g.q0[0] + wdx), ny = Math.round(g.q0[1] + wdy);
        const n = surface.outline.length; const pr = surface.outline[(g.i - 1 + n) % n], nxp = surface.outline[(g.i + 1) % n];
        const sn = 12 / s; [pr, nxp].forEach(q => { if (Math.abs(nx - q[0]) < sn) nx = q[0]; if (Math.abs(ny - q[1]) < sn) ny = q[1]; });
        surface.outline[g.i] = [nx, ny]; S.dragging = true;
      }
      if (g.type === 'opening') { const o = surface.openings[g.i]; o.x = Math.round(g.x0 + wdx); o.y = Math.max(surface.kind === 'wall' && !g.pts0 ? 0 : -1e9, Math.round(g.y0 + wdy)); if (g.pts0) o.pts = g.pts0.map(q => [Math.round(q[0] + o.x - g.x0), Math.round(q[1] + o.y - g.y0)]); S.dragging = true; }
      requestDraw();
    }
    function endGesture(g, p) {
      if (!g.moved && Date.now() - g.t0 < 700) { onTap(world(...p), p, g); return; }
      if (g.dragging) endDrag(true, g);
    }
    function endDrag(changed, g) {
      S.dragging = false; const v = curView();
      if (g && g.type === 'arrange' && v.group) { autoStartGroup(v.group); toast('Areas moved — set-out re-run for the joined floor (↶ to undo)', 3000); }
      else if (v && v.group) v.group.startLabel = 'Custom (dragged)'; else { const { surface } = cur(); if (surface) surface.startLabel = 'Custom (dragged)'; }
      if (changed) { save(); S.best = null; if (['setout', 'shape', 'openings'].includes(S.tab)) renderPane(); }
      requestDraw();
    }
    function onTap(w, p, g) {
      const v = curView(); const { surface } = cur(); const [W, H] = dims(); const o = offsets(v).get(surface.id);
      const lw = toLocal(v, surface, w);
      if (S.trace) {
        if (S.trace.length >= 3) { const f = Render.toS(S.view, W, H, toWorld(v, surface, S.trace[0])); if (Math.hypot(f[0] - p[0], f[1] - p[1]) < 18) return finishTrace(); }
        let q = [Math.round(lw[0]), Math.round(lw[1])];
        if (S.traceOrtho && S.trace.length) { const pr = S.trace[S.trace.length - 1]; const dx = Math.abs(q[0] - pr[0]), dy = Math.abs(q[1] - pr[1]); if (dy < dx * 0.18) q[1] = pr[1]; else if (dx < dy * 0.18) q[0] = pr[0]; }
        S.trace.push(q); requestDraw(); return;
      }
      if (S.calib) {
        S.calib.push(lw); requestDraw();
        if (S.calib.length === 2) setTimeout(() => {
          const [a, b] = S.calib; const meas = Math.hypot(b[0] - a[0], b[1] - a[1]);
          const val = prompt(`Real length between the two points (mm)?\nIt measures ${Math.round(meas)} mm at the moment.`);
          if (val && +val > 0 && meas > 0) { checkpoint(); const k = +val / meas; const bg = surface.bg; bg.mmPerPx *= k; bg.x = a[0] + (bg.x - a[0]) * k; bg.y = a[1] + (bg.y - a[1]) * k; bg.scaled = true; save(); toast('Scale set — now trace the outline'); S.view = null; }
          S.calib = null; setModeButtons(); renderPane(); requestDraw();
        }, 60);
        return;
      }
      if (S.opTrace) {
        S.opTrace.push(lw); requestDraw();
        if (S.opTrace.length === 2) {
          checkpoint();
          const [a, b] = S.opTrace; const op = { id: Store.uid(), type: S.opType, name: OP_TYPES[S.opType], x: Math.round(Math.min(a[0], b[0])), y: Math.round(Math.min(a[1], b[1])), w: Math.round(Math.abs(a[0] - b[0])), h: Math.round(Math.abs(a[1] - b[1])), tiled: S.opType === 'unit' };
          if (op.w > 0 && op.h > 0) surface.openings.push(op);
          S.opTrace = null; save(); setModeButtons(); renderPane(); requestDraw();
        }
        return;
      }
      if (S.mode === 'edit') {
        // tapped a measurement?
        const hit = S.dimHits.filter(h => h.surfId === surface.id).find(h => Math.hypot(h.x - p[0], h.y - p[1]) < 24);
        if (hit) {
          const val = prompt(`New length for this side (mm)\nNow ${Math.round(hit.len)} mm. Everything beyond the far end moves with it.`, Math.round(hit.len));
          if (val && +val > 0 && Math.abs(+val - hit.len) > 0.4) { checkpoint(); Geo.stretchEdge(surface, hit.i, +val); S.cache.clear(); save(); renderPane(); S.view = null; }
          requestDraw(); return;
        }
        const tappedOther = memberAt(w); if (tappedOther && tappedOther.id !== surface.id) { selectMember(tappedOther.id); return; }
        const n = surface.outline.length; let bi = -1, bd = 14;
        for (let i = 0; i < n; i++) { const a = Render.toS(S.view, W, H, [surface.outline[i][0] + o[0], surface.outline[i][1] + o[1]]), b = Render.toS(S.view, W, H, [surface.outline[(i + 1) % n][0] + o[0], surface.outline[(i + 1) % n][1] + o[1]]); const d = segDist(p, a, b); if (d < bd) { bd = d; bi = i; } }
        if (bi >= 0 && S.selVertex < 0 && S.selOpening < 0) { if (confirm('Add a corner here?')) { checkpoint(); surface.outline.splice(bi + 1, 0, [Math.round(lw[0]), Math.round(lw[1])]); save(); renderPane(); } }
        if (S.selOpening >= 0 && S.tab !== 'openings') { S.tab = 'openings'; $$('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === 'openings')); renderPane(); }
        S.selVertex = -1; requestDraw(); return;
      }
      // other modes: tap selects an area in a combined view
      const t = memberAt(w); if (t && t.id !== S.selId) selectMember(t.id);
    }
  }
  function selectMember(id) { S.selId = id; S.selOpening = -1; S.selVertex = -1; history.replaceState(null, '', `#/job/${S.job.id}/v/${S.viewId}/${id}`); renderPane(); requestDraw(); toast(`Selected ${findSurface(id).surface.name}`, 1200); }
  function segDist(p, a, b) { const dx = b[0] - a[0], dy = b[1] - a[1]; const l = dx * dx + dy * dy || 1; let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l; t = Math.max(0.1, Math.min(0.9, t)); return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy); }

  function finishTrace() {
    const { surface } = cur();
    if (!S.trace || S.trace.length < 3) { toast('Tap at least 3 corners'); return; }
    checkpoint();
    if (S.traceTarget === 'op') {
      const pts = S.trace.map(p => [Math.round(p[0]), Math.round(p[1])]); const b = Geo.bbox(pts);
      surface.openings.push({ id: Store.uid(), type: 'other', name: 'Not tiled', x: Math.round(b.x0), y: Math.round(b.y0), w: Math.round(b.w), h: Math.round(b.h), pts });
      S.trace = null; S.traceTarget = null; S.cache.clear(); save(); toast('Not-tiled area added'); setModeButtons(); renderPane(); requestDraw(); return;
    }
    const n = Geo.normaliseOutline(S.trace);
    surface.outline = n.pts;
    surface.openings.forEach(o => { o.x = Math.round(+o.x + n.dx); o.y = Math.round(+o.y + n.dy); });
    if (surface.bg) { surface.bg.x += n.dx; surface.bg.y += n.dy; }
    if (surface.place) { surface.place.x -= n.dx; surface.place.y -= n.dy; }
    S.trace = null; autoStart(surface); save(); toast('Shape traced — check the measurements'); S.view = null; setModeButtons(); renderPane(); requestDraw();
  }

  // ---------- panes ----------
  const num = (path, label, val, extra = '') => `<label class="f">${label}<input type="number" inputmode="decimal" step="any" data-b="${path}" value="${esc(val)}" ${extra}></label>`;
  const txt = (path, label, val) => `<label class="f">${label}<input data-b="${path}" value="${esc(val)}"></label>`;
  function setPath(obj, path, v) { const k = path.split('.'); let o = obj; for (let i = 0; i < k.length - 1; i++) { if (o[k[i]] == null) o[k[i]] = {}; o = o[k[i]]; } o[k[k.length - 1]] = v; }

  function memberBar() {
    const v = curView(); if (!v || v.members.length < 2) return '';
    return `<div class="row" style="margin-bottom:10px;gap:6px"><span class="muted">Editing:</span>${v.members.map(({ surface }) => `<button class="btn sm ${surface.id === S.selId ? '' : 'sec'}" data-sel="${surface.id}">${esc(surface.name)}</button>`).join('')}
      ${v.mode === 'strip' ? '<button class="btn sm sec" data-p="mvleft" title="Move wall left">◀</button><button class="btn sm sec" data-p="mvright" title="Move wall right">▶</button>' : ''}</div>`;
  }
  function renderPane() {
    const pane = $('#pane'); if (!pane) return; const { surface } = cur(); if (!surface) return;
    const fn = { shape: paneShape, openings: paneOpenings, tile: paneTile, setout: paneSetout, cuts: paneCuts, order: paneOrder, drawing: paneDrawing }[S.tab];
    const sc = pane.scrollTop; pane.innerHTML = memberBar() + fn(surface); pane.scrollTop = sc;
    pane.oninput = e => onBind(e, surface, false); pane.onchange = e => onBind(e, surface, true);
    pane.onclick = e => paneClick(e, surface);
  }
  function bindTarget(surface, path) {
    if (path.startsWith('pattern.')) { const g = groupOf(surface); if (g && !(g.mode === 'strip' && path === 'pattern.ox')) return g; }
    return surface;
  }
  function onBind(e, surface, isChange) {
    const t = e.target;
    if (t.dataset.b) {
      let v = t.type === 'checkbox' ? t.checked : t.type === 'number' || t.type === 'range' ? (t.value === '' ? '' : +t.value) : t.value;
      const target = bindTarget(surface, t.dataset.b);
      setPath(target, t.dataset.b, v);
      if (t.dataset.b === 'name') { const v2 = curView(); if (!v2.group) $('.top h1').textContent = `${findSurface(surface.id).room.name} — ${surface.name}`; }
      if (/^pattern\.(ox|oy|rotation)/.test(t.dataset.b)) target.startLabel = 'Custom';
      S.cache.clear(); save(); S.best = null; requestDraw();
      if (isChange && (t.dataset.rerender !== undefined || t.tagName === 'SELECT' || t.type === 'checkbox')) renderPane();
      return;
    }
    if (t.dataset.v != null) { const i = +t.dataset.v, k = +t.dataset.k; if (t.value === '') return; surface.outline[i][k] = +t.value; save(); requestDraw(); return; }
    if (t.dataset.o != null) {
      const o = surface.openings[+t.dataset.o]; const k = t.dataset.ok; const old = +o[k];
      o[k] = t.type === 'checkbox' ? t.checked : t.type === 'number' ? (t.value === '' ? 0 : +t.value) : t.value;
      if (o.pts && (k === 'x' || k === 'y')) { const d = +o[k] - old, ax = k === 'x' ? 0 : 1; o.pts.forEach(q => { q[ax] += d; }); }
      if (k === 'type' && isChange) { o.name = OP_TYPES[o.type]; o.tiled = o.type === 'unit'; renderPane(); }
      save(); requestDraw(); return;
    }
    if (t.dataset.d != null) {
      const d = surface.doorways[+t.dataset.d]; const k = t.dataset.dk; d[k] = t.type === 'number' || k === 'edge' ? (t.value === '' ? 0 : +t.value) : t.value;
      save(); requestDraw(); if (isChange && k === 'edge') renderPane(); return;
    }
    if (t.dataset.t) { const tile = tileOf(surface); tile[t.dataset.t] = t.type === 'number' && t.value !== '' ? +t.value : t.value; S.cache.clear(); save(); requestDraw(); return; }
    if (t.id === 'tileSel' && isChange) { tileTarget(surface).tileId = t.value; S.cache.clear(); save(); renderPane(); requestDraw(); }
    if (t.id === 'tileMode' && isChange) { const g = groupOf(surface); if (t.value === 'separate') g.members.forEach(id => { const m = findSurface(id).surface; if (m) m.tileId = g.tileId; }); else g.tileId = surface.tileId || g.tileId; g.tileMode = t.value; S.cache.clear(); save(); renderPane(); requestDraw(); }
    if ((t.id === 'lockX' || t.id === 'lockY') && isChange) {
      const g = groupOf(surface); const mem = g.members.map(id => findSurface(id).surface).filter(Boolean); const effs = new Map(mem.map(m => [m.id, eff(m).pattern]));
      if (t.id === 'lockY') { if (t.checked) g.pattern.oy = effs.get(surface.id).oy; else mem.forEach(m => { m.pattern.oy = effs.get(m.id).oy; }); g.lockY = t.checked; }
      else { if (t.checked) g.pattern.ox = effs.get(surface.id).ox + stripCum(g).get(surface.id) + g.members.indexOf(surface.id) * cornerAllow(); else mem.forEach(m => { m.pattern.ox = effs.get(m.id).ox; }); g.lockX = t.checked; }
      S.cache.clear(); S.best = null; save(); renderPane(); requestDraw();
      toast(t.checked ? 'Locked — walls now move together' : 'Unlocked — each wall moves on its own');
    }
    if (t.dataset.orig && isChange && t.value !== '') { const e2 = eff(surface).pattern; setOrigin(surface, t.dataset.orig === 'x' ? [+t.value, +e2.oy] : [+e2.ox, +t.value], 'Custom'); }
    if (t.id === 'linkSel' && isChange) { const [fid, edge] = t.value.split('|'); linkWall(surface, fid || null, edge); save(); S.view = null; renderPane(); requestDraw(); toast(fid ? 'Wall linked — its width now follows the floor and the floor follows it' : 'Wall unlinked'); }
    if (t.id === 'borderTile' && isChange) { surface.settings.border.tileId = t.value; S.cache.clear(); save(); renderPane(); requestDraw(); }
    if (t.id === 'idsChk') { S.showIds = t.checked; requestDraw(); }
    if (t.id === 'setChk') { S.showSetout = t.checked; requestDraw(); }
    if (t.id === 'nudgeStep') S.nudge = +t.value;
    if (t.id === 'opType') S.opType = t.value;
    if (t.id === 'bgOpacity' && surface.bg) { surface.bg.opacity = +t.value; save(); requestDraw(); }
    if (t.id === 'bgPage') S.bgPage = +t.value || 1;
  }

  function paneShape(s) {
    const walls = Geo.outlineToWalls(s.outline);
    const turnSel = (i, v) => { const opts = [[90, '↰ left 90°'], [-90, '↱ right 90°'], [45, '↰ left 45°'], [-45, '↱ right 45°'], [135, '↰ left 135°'], [-135, '↱ right 135°'], [0, 'straight on']]; if (!opts.some(o => o[0] === v)) opts.push([v, `${v > 0 ? '↰ left' : '↱ right'} ${Math.abs(v)}°`]); return `<select data-wt="${i}">${opts.map(o => `<option value="${o[0]}" ${o[0] === v ? 'selected' : ''}>${o[1]}</option>`).join('')}<option value="custom">custom angle…</option></select>`; };
    const bb = Geo.bbox(s.outline);
    return `
      <div class="card"><div class="grid">${txt('name', 'Name', s.name)}<label class="f">Type<select data-b="kind" data-rerender>${['wall', 'floor'].map(k => `<option ${s.kind === k ? 'selected' : ''} value="${k}">${k === 'wall' ? 'Wall (elevation)' : 'Floor (plan)'}</option>`).join('')}</select></label></div>
        <div class="muted" style="margin-top:6px">${s.kind === 'wall' ? 'Walls are drawn as if you are facing them: 0,0 is bottom-left at floor level.' : 'Floors are drawn in plan from the bottom-left corner.'} Size ${Math.round(bb.w)} × ${Math.round(bb.h)} mm.</div>
        <div class="note">Quickest way to change a size: tap <b>✎ Shape</b> on the drawing, then tap any measurement.</div></div>
      <div class="card"><h2>Quick shapes</h2>
        <div class="grid"><label class="f">Width mm<input id="qrW" type="number" inputmode="decimal" value="${Math.round(bb.w)}"></label><label class="f">${s.kind === 'wall' ? 'Height' : 'Depth'} mm<input id="qrH" type="number" inputmode="decimal" value="${Math.round(bb.h)}"></label></div>
        <div class="row" style="margin-top:8px"><button class="btn sm" data-p="rect">Rectangle</button></div>
        <div class="grid" style="margin-top:10px"><label class="f">Cut-out width mm<input id="qlW" type="number" inputmode="decimal" value="${Math.round(bb.w / 3)}"></label><label class="f">Cut-out ${s.kind === 'wall' ? 'height' : 'depth'} mm<input id="qlH" type="number" inputmode="decimal" value="${Math.round(bb.h / 3)}"></label>
          <label class="f">Cut-out corner<select id="qlC"><option value="tr">Top right</option><option value="tl">Top left</option><option value="br">Bottom right</option><option value="bl">Bottom left</option></select></label></div>
        <div class="row" style="margin-top:8px"><button class="btn sm sec" data-p="L">L-shape</button>${s.kind === 'wall' ? '<button class="btn sm sec" data-p="slope">Sloped ceiling</button>' : ''}</div>
        <div class="row" style="margin-top:10px"><span class="muted">Wrong corner or side?</span><button class="btn sm sec" data-p="mirrorx">⇆ Flip left/right</button><button class="btn sm sec" data-p="mirrory">⇅ Flip top/bottom</button></div>
        <div class="note">Flipping moves cut-outs and slopes to the other side. Openings stay where they are.</div></div>
      ${linkCard(s)}
      <div class="card"><h2>Wall by wall</h2>
        <div class="muted" style="margin-bottom:8px">Start at the bottom-left corner going right. Enter each length and which way you turn at the end. Going round anticlockwise, outside corners are left turns and inside corners are right turns. The last wall closes the shape.</div>
        ${walls.map((w, i) => `<div class="vtx" style="grid-template-columns:24px 1fr 1.3fr"><span class="muted">${i + 1}</span><input type="number" inputmode="decimal" data-wl="${i}" value="${w.len}">${i < walls.length - 1 ? turnSel(i, w.turn) : '<span class="muted">closes</span>'}</div>`).join('')}
        <div class="row"><button class="btn sm" data-p="walls">Apply walls</button><button class="btn sm sec" data-p="addwall">+ Wall</button><button class="btn sm sec" data-p="delwall">− Last wall</button></div><div id="wallMsg"></div></div>
      <div class="card"><h2>Corners (x, y mm)</h2>
        ${s.outline.map((p, i) => `<div class="vtx"><span class="muted">${i + 1}</span><input type="number" inputmode="decimal" data-v="${i}" data-k="0" value="${r1(p[0])}"><input type="number" inputmode="decimal" data-v="${i}" data-k="1" value="${r1(p[1])}"><button class="x" data-delv="${i}" aria-label="Remove corner">×</button></div>`).join('')}
        <div class="row"><button class="btn sm sec" data-p="addv">+ Corner</button><button class="btn sm sec" data-p="norm">Tidy (move to 0,0)</button></div></div>`;
  }
  function linkCard(s) {
    if (s.kind === 'wall') {
      const floors = allSurfaces().filter(x => x.surface.kind === 'floor');
      if (!floors.length) return '';
      const opts = floors.flatMap(({ room, surface: f }) => f.outline.map((p, i) => [`${f.id}|${i}`, `${room.name} — ${f.name}, side ${i + 1} (${Math.round(edgeLen(f, i))} mm)`]));
      const cur2 = s.link ? `${s.link.floorId}|${s.link.edge}` : '';
      return `<div class="card"><h2>Stands on</h2><label class="f">Floor side this wall sits on<select id="linkSel"><option value="">Not linked</option>${opts.map(([v, l]) => `<option value="${v}" ${v === cur2 ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
        <div class="note">Linked walls and floors keep the same length: change one and the other follows. Doors on the wall become doorways on the floor. Linked walls can be seen folded out round the floor (▣ Fold out).</div></div>`;
    }
    const walls = allSurfaces().filter(x => x.surface.link && x.surface.link.floorId === s.id);
    return walls.length ? `<div class="card"><h2>Walls on this floor</h2><div class="muted">${walls.map(w => `${esc(w.surface.name)} on side ${w.surface.link.edge + 1}`).join(' · ')}</div><div class="row" style="margin-top:8px"><button class="btn sm" data-p="openfold">▣ Open folded-out view</button></div></div>` : '';
  }
  function paneOpenings(s) {
    const b = Geo.bbox(s.outline);
    const edges = s.outline.map((p, i) => { const q = s.outline[(i + 1) % s.outline.length]; return `Side ${i + 1} (${Math.round(Math.hypot(q[0] - p[0], q[1] - p[1]))})`; });
    const types = s.kind === 'floor' ? ['unit', 'bath', 'tray', 'other'] : ['door', 'window', 'niche', 'bath', 'tray', 'other'];
    const drawBtn = '<button class="btn sm" data-p="drawop">✎ Draw a not-tiled area (any shape)</button>';
    return `<div class="card"><h2>Add</h2><div class="row">${types.map(k => `<button class="btn sm sec" data-addop="${k}">+ ${OP_TYPES[k]}</button>`).join('')}${s.kind === 'floor' ? '<button class="btn sm sec" data-p="adddoor">+ Doorway</button>' : ''}</div><div class="row" style="margin-top:8px">${drawBtn}</div>
      <div class="note">x, y is the bottom-left corner${s.kind === 'wall' ? ' (y from floor level)' : ''}. Area is ${Math.round(b.w)} × ${Math.round(b.h)} mm. Drag them on the drawing with ✎ Shape.${s.kind === 'floor' ? ' Kitchen units are tiled under by default: they show as blue dashes, and the drawing shows where joints fall against their fronts.' : ''}</div></div>
      ${s.kind === 'floor' ? `<div class="card"><h2>Doorways</h2>${(s.doorways || []).map((d, i) => `<div class="op"><div class="grid" style="grid-template-columns:1fr 1fr">
          <label class="f">Name<input data-d="${i}" data-dk="name" value="${esc(d.name)}"></label>
          <label class="f">On<select data-d="${i}" data-dk="edge">${edges.map((l, k) => `<option value="${k}" ${k === d.edge ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
          <label class="f">From start of side<input type="number" inputmode="decimal" data-d="${i}" data-dk="pos" value="${d.pos}"></label><label class="f">Width<input type="number" inputmode="decimal" data-d="${i}" data-dk="w" value="${d.w}"></label></div>
          <div class="row" style="margin-top:6px"><button class="btn sm sec" data-dctr="${i}">Centre on side</button><button class="btn sm danger" data-ddel="${i}">Remove</button></div></div>`).join('') || '<div class="muted">No doorways. Add them to centre the tiles on a door, line up rooms and list thresholds.</div>'}</div>` : ''}
      <div class="ops">${s.openings.map((o, i) => `<div class="op ${S.selOpening === i ? 'sel' : ''}"><div class="grid" style="grid-template-columns:1fr 1fr">
        <label class="f">Type<select data-o="${i}" data-ok="type">${Object.entries(OP_TYPES).map(([k, l]) => `<option value="${k}" ${o.type === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label class="f">Name<input data-o="${i}" data-ok="name" value="${esc(o.name)}"></label>
        <label class="f">x (from left)<input type="number" inputmode="decimal" data-o="${i}" data-ok="x" value="${o.x}"></label><label class="f">y (from ${s.kind === 'wall' ? 'floor' : 'bottom'})<input type="number" inputmode="decimal" data-o="${i}" data-ok="y" value="${o.y}"></label>
        <label class="f">Width<input type="number" inputmode="decimal" data-o="${i}" data-ok="w" value="${o.w}" ${o.pts ? 'disabled title="Drawn shape — redraw to change its size"' : ''}></label><label class="f">Height${s.kind === 'floor' ? ' (depth)' : ''}<input type="number" inputmode="decimal" data-o="${i}" data-ok="h" value="${o.h}" ${o.pts ? 'disabled' : ''}></label></div>
        ${['unit', 'other', 'bath', 'tray'].includes(o.type) && s.kind === 'floor' ? `<label class="chk"><input type="checkbox" data-o="${i}" data-ok="tiled" ${o.tiled ? 'checked' : ''}> Tiled under it (show only)</label>` : ''}
        <div class="row" style="margin-top:6px"><button class="btn sm sec" data-opc="${i}">Centre across</button><button class="btn sm danger" data-opdel="${i}">Remove</button></div></div>`).join('') || '<div class="muted">No openings.</div>'}</div>`;
  }
  function paneTile(s) {
    const t = tileOf(s); const g = groupOf(s); const p = eff(s).pattern;
    const modeCard = g ? `<div class="card"><h2>Tiles in “${esc(g.name)}”</h2><label class="f">Tile choice<select id="tileMode"><option value="linked" ${g.tileMode !== 'separate' ? 'selected' : ''}>Same tile on every ${g.mode === 'strip' ? 'wall' : 'area'}</option><option value="separate" ${g.tileMode === 'separate' ? 'selected' : ''}>Choose a tile for each ${g.mode === 'strip' ? 'wall' : 'area'}</option></select></label><div class="note">The pattern and joint stay shared. Offcuts are only shared between ${g.mode === 'strip' ? 'walls' : 'areas'} using the same tile.</div></div>` : '';
    if (!t) return `${modeCard}<div class="card" style="border:2px dashed var(--bronze)"><h2>Choose a tile</h2><div class="muted">This job has no tiles yet.</div><div class="row" style="margin-top:8px"><button class="btn" data-p="newtile">+ Add a tile</button></div></div>`;
    const unit = Geo.buildUnit(t, p);
    let extra = '';
    if (p.type === 'customOffset') extra = num('pattern.offsetPct', 'Offset % of tile', p.offsetPct);
    if (p.type === 'chevron') extra = num('pattern.chevronAngle', 'Chevron angle °', p.chevronAngle);
    if (p.type === 'modular') extra = num('pattern.moduleSize', 'Smallest tile size (module) mm', p.moduleSize) + `<div class="note" style="grid-column:1/-1">Sizes used (joint allowed for): ${unit.sizes.map(z => z.label).join(', ')}. One of each per repeat. Set m² per box on the tile for pack quantities.</div>`;
    if (p.type === 'basketweave') extra = `<div class="note" style="grid-column:1/-1">${Math.max(1, Math.round((Math.max(t.w, t.h) + +p.joint) / (Math.min(t.w, t.h) + +p.joint)))} tiles per block. Works best when the length is a multiple of the width plus joints.</div>`;
    if (p.type === 'windmill') extra = `<div class="note" style="grid-column:1/-1">Insert square: ${unit.sizes[1] ? unit.sizes[1].label : 'none (tiles too square)'}.</div>`;
    if (['herringbone', 'herringbone45', 'doubleHerringbone', 'chevron', 'basketweave', 'windmill'].includes(p.type)) extra += `<div class="note" style="grid-column:1/-1">Uses the long side × short side of the tile.</div>`;
    const bd = s.settings.border || {};
    return `${modeCard}<div class="card"><h2>Tile${g && g.tileMode === 'separate' ? ` — ${esc(s.name)}` : ''}</h2>${g && g.tileMode !== 'separate' ? `<div class="note">Shared by everything in “${esc(g.name)}”.</div>` : ''}
        <div class="row"><label class="f" style="flex:1">Tile<select id="tileSel">${S.job.tiles.map(x => `<option value="${x.id}" ${x.id === t.id ? 'selected' : ''}>${esc(x.name)} (${x.w}×${x.h})</option>`).join('')}</select></label><button class="btn sm sec" data-p="newtile" style="align-self:flex-end">+ New</button></div>
        <div style="margin-top:8px">${tileFields(t)}</div><div class="note">Tile changes apply to every area using this tile.</div></div>
      <div class="card"><h2>Pattern</h2><div class="grid">
        <label class="f" style="grid-column:1/-1">Laying pattern<select data-b="pattern.type" data-rerender>${Object.entries(Geo.PATTERNS).map(([k, v]) => `<option value="${k}" ${p.type === k ? 'selected' : ''}>${v.name}</option>`).join('')}</select></label>
        ${num('pattern.joint', 'Joint width mm', p.joint)}${num('pattern.rotation', 'Rotate layout °', p.rotation)}${extra}</div>
        <div class="row" style="margin-top:8px"><span class="muted">Rotate:</span>${[0, 45, 90, -45].map(a => `<button class="btn sm sec" data-rot="${a}">${a}°</button>`).join('')}</div></div>
      <div class="card"><h2>Border${g ? ` — ${esc(s.name)}` : ''}</h2>
        <label class="chk"><input type="checkbox" data-b="settings.border.on" ${bd.on ? 'checked' : ''}> Border round the edge of this area</label>
        ${bd.on ? `<div class="grid"><label class="f">Border tile<select id="borderTile">${S.job.tiles.map(x => `<option value="${x.id}" ${x.id === (bd.tileId || (S.job.tiles[0]?.id || null)) ? 'selected' : ''}>${esc(x.name)} (${x.w}×${x.h})</option>`).join('')}</select></label>${num('settings.border.rows', 'Rows', bd.rows || 1)}</div>
          <div class="note">Border tiles run along each side, centred on the side, with butt-jointed corners. The main pattern fills the middle. Add a separate tile for the border (e.g. 600×100) under Tile → + New.</div>` : ''}</div>`;
  }
  function paneSetout(s) {
    const g = groupOf(s); const t = tileOf(s); const c = calc(s); const st = c.res?.stats;
    if (!t) return '<div class="empty">Choose a tile first (Tile &amp; pattern tab).</div>';
    const e = eff(s); const cand = Geo.startCandidates(e, t);
    const lockCard = g && g.mode === 'strip' ? `<div class="card"><h2>Walls together</h2>
        <label class="chk"><input type="checkbox" id="lockY" ${g.lockY !== false ? 'checked' : ''}> 🔒 Courses level all the way round (up/down moves every wall)</label>
        <label class="chk"><input type="checkbox" id="lockX" ${g.lockX ? 'checked' : ''}> 🔒 Tiles carry round the corners (left/right moves every wall; the offcut from the end of one wall starts the next)</label>
        <div class="note">Untick to move walls on their own. Offcuts are shared between walls either way.</div></div>` : '';
    const floorAlign = s.kind === 'wall' && s.link && findSurface(s.link.floorId).surface ? `<button class="btn sm" data-p="alignfloor">Line up wall joints with the floor joints</button>` : '';
    const gs = geoSettings(s);
    const bestHtml = S.best ? S.best.map((b, i) => `<div class="opt" data-best="${i}"><div class="rk">${i + 1}</div><div class="main"><b>${esc(b.label)}</b>${b.stats.needed} tiles · smallest cut ${b.stats.minCut != null ? Math.round(b.stats.minCut) + ' mm' : 'none'} · ${b.stats.cuts} cuts${b.stats.slivers ? ` · <span style="color:var(--red)">${b.stats.slivers} slivers</span>` : ''}</div></div>`).join('') : '';
    const ref = c.ref;
    const refTxt = ref ? `<div class="note" style="border-left:3px solid #15803D"><b>For the fitter:</b> set-out point is <b>${Math.round(ref.dims.left)} mm</b> from the left ${s.kind === 'wall' ? 'end' : 'wall'} and <b>${Math.round(ref.dims.bottom)} mm</b> from the ${s.kind === 'wall' ? 'floor' : 'bottom wall'}${ref.dirs.length ? (ref.herringbone ? ', with the herringbone joint line running through it (green line).' : `, on a joint${ref.dirs.length === 2 ? ' where two straight joint lines cross (green lines)' : ' with a straight joint line through it (green line)'}.`) : '.'}</div>` : '';
    return `${lockCard}<div class="card"><h2>Find the best start${g ? ` — all of “${esc(g.name)}”` : ''}</h2>
        <div class="muted">${g ? (g.mode === 'strip' ? (g.lockX ? 'Treats the walls as one continuous run round the room.' : g.lockY !== false ? 'Keeps courses level round the room and finds the best position for each wall.' : 'Finds the best start for each wall on its own.') : 'Sets out all joined areas as one, so the tile runs through.') : `Tries every sensible start (centre, corners, edges, openings${(s.doorways || []).length ? ', doorways' : ''}${(s.openings || []).some(o => o.tiled) ? ', unit fronts' : ''}${Geo.herringboneAxis(t, e.pattern) ? ', herringbone joint line on centre' : ''}) and ranks them: no slivers first, then the biggest smallest cut, then fewest tiles.`}</div>
        <div class="row" style="margin-top:8px"><button class="btn" data-p="best">Find best start</button></div><div id="bestList" style="margin-top:8px">${bestHtml}</div></div>
      <div class="card"><h2>Snap to a start${g ? ` (using ${esc(s.name)})` : ''}</h2>
        ${cand.special.length ? `<div class="row" style="margin-bottom:8px">${cand.special.map((sp, i) => `<button class="btn sm sec" data-sp="${i}">${esc(sp.label)}</button>`).join('')}</div>` : ''}
        <div class="grid" style="grid-template-columns:1fr">
        <label class="f">Across (left ↔ right)<select id="sx">${cand.xs.map((x, i) => `<option value="${i}">${esc(x.label)}</option>`).join('')}</select></label>
        <label class="f">Up / down<select id="sy">${cand.ys.map((y, i) => `<option value="${i}">${esc(y.label)}</option>`).join('')}</select></label></div>
        <div class="row" style="margin-top:8px"><button class="btn sm" data-p="snap">Apply</button>${floorAlign}</div>
        ${s.kind === 'wall' ? `<div class="grid" style="margin-top:10px">${num('settings.battenY', 'Batten height mm (blank = none)', s.settings.battenY, 'placeholder="none"')}</div>` : ''}</div>
      <div class="card"><h2>Fine adjust</h2>
        <div class="row" style="align-items:flex-start;gap:14px">
          <div class="nudge"><span></span><button data-n="0,1" aria-label="Up">↑</button><span></span><button data-n="-1,0" aria-label="Left">←</button><button data-n="c" aria-label="Centre">⊙</button><button data-n="1,0" aria-label="Right">→</button><span></span><button data-n="0,-1" aria-label="Down">↓</button><span></span></div>
          <div style="flex:1;min-width:140px"><label class="f">Step mm<select id="nudgeStep">${[1, 5, 10, 25, 50, 100].map(x => `<option ${S.nudge === x ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
            <div class="grid" style="grid-template-columns:1fr 1fr;margin-top:6px"><label class="f">Start x<input type="number" inputmode="decimal" data-orig="x" value="${Math.round(e.pattern.ox)}"></label><label class="f">Start y<input type="number" inputmode="decimal" data-orig="y" value="${Math.round(e.pattern.oy)}"></label></div></div></div>
        <div class="note">Or use <b>✥ Tiles</b> and drag on the drawing.${g && g.mode === 'strip' ? ` Up/down moves ${g.lockY !== false ? 'every wall' : 'this wall only'}; left/right moves ${g.lockX ? 'every wall' : 'this wall only'}.` : ''}</div></div>
      <div class="card"><h2>Set-out lines</h2><label class="chk"><input type="checkbox" id="setChk" ${S.showSetout ? 'checked' : ''}> Show set-out lines and dimensions on the drawing</label>${refTxt}</div>
      <div class="card"><h2>Rules for ${esc(s.name)}</h2><div class="grid">
        ${num('settings.sliver', 'Sliver warning under mm', s.settings.sliver, `placeholder="default ${S.settings.sliver}"`)}${num('settings.spare', 'Spare / breakage %', s.settings.spare, `placeholder="auto ${Geo.PATTERNS[e.pattern.type]?.waste}%"`)}</div>
        <label class="chk"><input type="checkbox" data-b="settings.reuseOffcuts" ${s.settings.reuseOffcuts !== false ? 'checked' : ''}> Reuse offcuts where they fit (estimate)</label>
        ${st ? `<div class="muted">Now: ${st.needed} tiles, ${st.cuts} cuts, smallest ${st.minCut != null ? Math.round(st.minCut) + ' mm' : '-'}${st.slivers ? `, <b style="color:var(--red)">${st.slivers} under ${gs.sliver} mm</b>` : ''}.</div>` : ''}</div>`;
  }
  function paneCuts(s) {
    const c = calc(s); if (!c.res) return `<div class="empty">${tileOf(s) ? 'Set up the shape first.' : 'Choose a tile first (Tile &amp; pattern tab).'}</div>`;
    const st = c.res.stats; const sizes = c.res.sizes;
    const units = c.res.units || [];
    return `<div class="card"><h2>Summary — ${esc(s.name)}</h2><table class="t"><tr><th>Tile</th><th class="n">Full</th><th class="n">Cut</th><th class="n">From offcut</th><th class="n">Tiles</th></tr>
        ${st.per.map(p => `<tr><td>${esc(p.label)}</td><td class="n">${p.full}</td><td class="n">${p.cut + p.notch}</td><td class="n">${p.fromOffcut}</td><td class="n"><b>${p.needed}</b></td></tr>`).join('')}</table>
        <label class="chk" style="margin-top:6px"><input type="checkbox" id="idsChk" ${S.showIds ? 'checked' : ''}> Show piece numbers on drawing</label></div>
      ${units.length ? `<div class="card"><h2>Units tiled under</h2>${units.map(u => `<div style="margin-bottom:8px"><b>${esc(u.name)}</b> — ${fmt(u.m2, 2)} m² under (about ${u.tiles} tiles)<ul style="margin:4px 0;padding-left:18px">${u.fronts.map(f => `<li>${esc(f.edge)} front: ${f.dist == null ? esc(f.note) : f.side === 'on' ? 'joint right on the unit line' : `nearest joint ${f.dist} mm ${f.side === 'under' ? 'under the unit' : 'out from the unit'}`}${f.dist != null && f.side !== 'on' && f.dist < 50 ? ' <b style="color:var(--red)">— close to the plinth line</b>' : ''}</li>`).join('') || '<li>Against walls on all sides</li>'}</ul></div>`).join('')}
        <div class="note">Tip: Set-out tab → “Joint on … edge” puts a joint exactly on a unit front.</div></div>` : ''}
      <div class="card"><h2>Cut list (mm)</h2>${c.cuts.length ? `<table class="t"><tr>${sizes.length > 1 ? '<th>Tile</th>' : ''}<th>Piece</th><th class="n">Qty</th><th>Pieces</th></tr>
        ${c.cuts.map(g => `<tr class="${g.sliver ? 'flag' : ''}">${sizes.length > 1 ? `<td>${esc(sizes[g.sizeIdx].label)}</td>` : ''}<td>${esc(g.desc)}${g.sliver ? ' ⚠' : ''}${g.offcut ? `<div class="muted">${g.offcut} from offcut${g.from.length ? ` (of ${g.from.slice(0, 3).map(esc).join(', ')}${g.from.length > 3 ? '…' : ''})` : ''}</div>` : ''}</td><td class="n">${g.count}</td><td class="muted">${g.ids.length <= 10 ? g.ids.map(i => '#' + i).join(' ') : g.ids.length + ' pieces'}</td></tr>`).join('')}</table>` : '<div class="muted">No cuts — every tile is full.</div>'}
        <div class="note">Sizes are the finished piece, along the tile's length × width. Notch = the corner taken out. Angled pieces list their sides in order.<br><b>Offcuts</b> are only reused where the edges that meet other tiles are factory edges; cut edges go against walls, openings and corners. Strips can be turned 180°, so one tile can give two cuts.${c.pooled ? ' Offcuts are shared with the other areas in this view — e.g. the end of one wall starts the next.' : ''}</div></div>`;
  }
  function paneOrder(s) {
    const v = curView(); const c = calc(s); if (!c.res) return '<div class="empty">Set up the shape first.</div>';
    const rows = PDFX.matRows(c.mat);
    let viewTot = '';
    if (v.members.length > 1) {
      const t = v.members.reduce((a, { surface }) => { const cc = calc(surface); if (!cc.res) return a; a.m2 += cc.mat.m2; a.n += cc.res.stats.needed; a.o += cc.mat.tiles.reduce((x, y) => x + y.order, 0); return a; }, { m2: 0, n: 0, o: 0 });
      viewTot = `<div class="card"><h2>Whole view</h2><div class="muted">${fmt(t.m2, 2)} m² · ${t.n} tiles needed · ${t.o} including spare. The job page has the full order list.</div></div>`;
    }
    return `${viewTot}<div class="card"><h2>Order list — ${esc(s.name)}</h2><table class="t"><tr><th>Item</th><th>Quantity</th><th class="n">Order</th></tr>${rows.map(r => `<tr><td>${esc(r[0])}</td><td>${esc(r[1])}</td><td class="n"><b>${esc(r[2])}</b></td></tr>`).join('')}</table></div>
      <div class="card"><h2>Options</h2>
        <label class="chk"><input type="checkbox" data-b="settings.primer" ${s.settings.primer !== false ? 'checked' : ''}> Prime this area</label>
        <label class="chk"><input type="checkbox" data-b="settings.trimPerimeter" ${s.settings.trimPerimeter ? 'checked' : ''}> Trim round the outside edge</label>
        <label class="chk"><input type="checkbox" data-b="settings.trimOpenings" ${s.settings.trimOpenings ? 'checked' : ''}> Trim round openings (doors: sides and top)</label>
        <div class="grid">${num('settings.trimExtra', 'Extra trim (m)', s.settings.trimExtra)}</div>
        <div class="note">Product names, coverage and bag sizes are in Settings. A tile can have its own adhesive coverage.</div></div>`;
  }
  function paneDrawing(s) {
    const online = navigator.onLine, key = !!S.settings.apiKey;
    if (!s.bg) return `<div class="card"><h2>Import a drawing</h2><div class="muted">Photo, image or PDF of a plan or elevation. It sits behind the set-out so you can scale it and trace over it — all offline.</div>
        <div class="grid" style="margin-top:8px"><label class="f">PDF page<input id="bgPage" type="number" inputmode="numeric" value="${S.bgPage}"></label></div>
        <div class="row" style="margin-top:8px"><button class="btn" data-p="bgimport">Choose drawing</button></div></div>${aiCard(s, online, key)}`;
    return `<div class="card"><h2>Drawing</h2>
        <label class="f">Drawing visibility<input type="range" id="bgOpacity" min="0.1" max="1" step="0.05" value="${s.bg.opacity ?? 0.5}"></label>
        ${!s.bg.scaled ? '<div class="warn">Not scaled yet. Set the scale before tracing.</div>' : ''}
        <div class="row" style="margin-top:8px"><button class="btn sm" data-p="calib">1. Set scale</button><button class="btn sm" data-p="trace">2. Trace outline</button></div>
        <div class="row" style="margin-top:8px"><label class="f" style="flex:1">3. Trace an opening or units<select id="opType">${Object.entries(OP_TYPES).map(([k, l]) => `<option value="${k}" ${S.opType === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label><button class="btn sm" data-p="optrace" style="align-self:flex-end">Trace</button></div>
        <div class="row" style="margin-top:8px"><button class="btn sm sec" data-p="bgmove">${S.mode === 'bg' ? 'Done moving' : 'Move drawing'}</button><button class="btn sm sec" data-p="bgimport">Replace</button><button class="btn sm danger" data-p="bgdel">Remove drawing</button></div>
        <div class="note">Scale: tap both ends of a dimension you know (e.g. a 2400 wall) and type its length. Trace: tap each corner; tick Square to keep walls straight. Then tap any measurement in ✎ Shape mode to make it exact.</div></div>${aiCard(s, online, key)}`;
  }
  function aiCard(s, online, key) {
    return `<div class="card"><h2>Read the drawing automatically</h2>
      ${online && key ? `<label class="f">Anything to tell it? (optional)<input id="aiExtra" placeholder="e.g. only the en-suite, walls are 2400 high"></label><div class="row" style="margin-top:8px"><button class="btn" data-p="ai" ${s.bg ? '' : 'disabled'}>${S.aiBusy ? 'Reading…' : 'Read this drawing'}</button></div>`
        : `<div class="note">${!online ? 'No signal: automatic reading is switched off. Tracing still works.' : 'Add an API key in Settings to read drawings in the app.'}</div>`}
      <div class="row" style="margin-top:8px"><button class="btn sm sec" data-p="paste">Paste room data</button><button class="btn sm sec" data-p="prompt">Copy prompt for Claude</button></div></div>`;
  }

  function setOrigin(s, o, label) {
    // o is the origin in this area's own coordinates
    const g = groupOf(s);
    if (!g) { s.pattern.ox = Math.round(o[0] * 10) / 10; s.pattern.oy = Math.round(o[1] * 10) / 10; s.startLabel = label; }
    else if (g.mode === 'strip') {
      if (g.lockX) g.pattern.ox = r10(o[0] + stripCum(g).get(s.id) + g.members.indexOf(s.id) * cornerAllow()); else s.pattern.ox = r10(o[0]);
      if (g.lockY !== false) g.pattern.oy = r10(o[1]); else s.pattern.oy = r10(o[1]);
      g.startLabel = label;
    }
    else { g.pattern.ox = Math.round((o[0] + s.place.x) * 10) / 10; g.pattern.oy = Math.round((o[1] + s.place.y) * 10) / 10; g.startLabel = label; }
    S.cache.clear(); save(); requestDraw();
  }
  async function paneClick(e, s) {
    const t = e.target; const v = curView(); const g = groupOf(s);
    const sel = t.closest('[data-sel]'); if (sel) return selectMember(sel.dataset.sel);
    const bi = t.closest('[data-best]'); if (bi) { const b = S.best[+bi.dataset.best]; if (g) applyGroupBest(g, b); else { s.pattern.ox = Math.round(b.ox * 10) / 10; s.pattern.oy = Math.round(b.oy * 10) / 10; s.startLabel = b.label; } save(); requestDraw(); renderPane(); toast('Start applied'); return; }
    const sp = t.closest('[data-sp]'); if (sp) { const c = Geo.startCandidates(eff(s), tileOf(s)).special[+sp.dataset.sp]; setOrigin(s, c.o, c.label); renderPane(); toast('Start applied'); return; }
    if (t.closest('[data-rot]')) { const tg = patternTarget(s); tg.pattern.rotation = +t.closest('[data-rot]').dataset.rot; S.cache.clear(); save(); renderPane(); requestDraw(); return; }
    const n = t.closest('[data-n]')?.dataset.n;
    if (n) {
      if (n === 'c') { const b = Geo.bbox(s.outline); setOrigin(s, [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2], 'Custom'); }
      else { const [dx, dy] = n.split(',').map(Number); const e2 = eff(s); setOrigin(s, [+e2.pattern.ox + dx * S.nudge, +e2.pattern.oy + dy * S.nudge], 'Custom'); }
      renderPane(); return;
    }
    if (t.closest('[data-delv]')) { if (s.outline.length <= 3) return toast('Need at least 3 corners'); s.outline.splice(+t.closest('[data-delv]').dataset.delv, 1); save(); renderPane(); requestDraw(); return; }
    if (t.closest('[data-addop]')) {
      const type = t.closest('[data-addop]').dataset.addop; const b = Geo.bbox(s.outline);
      const def = { door: [838, 1981], window: [900, 1000], niche: [300, 600], bath: [1700, 560], tray: [900, 900], unit: [2400, 600], other: [500, 500] }[type];
      let [w, h] = def; if (s.kind === 'floor' && type === 'bath') h = 700;
      w = Math.min(w, Math.round(b.w)); const y = s.kind === 'wall' ? ({ window: 1000, niche: 1200 }[type] || 0) : (type === 'unit' ? Math.round(b.y1 - h) : 0);
      s.openings.push({ id: Store.uid(), type, name: OP_TYPES[type], x: Math.round(b.x0 + (b.w - w) / 2), y: Math.round(b.y0 + y), w, h, tiled: type === 'unit' });
      S.selOpening = s.openings.length - 1; save(); renderPane(); requestDraw(); return;
    }
    if (t.closest('[data-opdel]')) { s.openings.splice(+t.closest('[data-opdel]').dataset.opdel, 1); S.selOpening = -1; save(); renderPane(); requestDraw(); return; }
    if (t.closest('[data-opc]')) { const o = s.openings[+t.closest('[data-opc]').dataset.opc]; const b = Geo.bbox(s.outline); o.x = Math.round(b.x0 + (b.w - o.w) / 2); save(); renderPane(); requestDraw(); return; }
    if (t.closest('[data-ddel]')) { s.doorways.splice(+t.closest('[data-ddel]').dataset.ddel, 1); save(); renderPane(); requestDraw(); return; }
    if (t.closest('[data-dctr]')) { const d = s.doorways[+t.closest('[data-dctr]').dataset.dctr]; const A = s.outline[d.edge], B = s.outline[(d.edge + 1) % s.outline.length]; d.pos = Math.round((Math.hypot(B[0] - A[0], B[1] - A[1]) - d.w) / 2); save(); renderPane(); requestDraw(); return; }
    const p = t.closest('[data-p]')?.dataset.p; if (!p) return;
    const b = Geo.bbox(s.outline);
    if (p === 'mirrorx' || p === 'mirrory') {
      const ax = p === 'mirrorx' ? 0 : 1; const bb2 = Geo.bbox(s.outline); const mid = ax === 0 ? bb2.x0 + bb2.x1 : bb2.y0 + bb2.y1;
      const map = q => ax === 0 ? [mid - q[0], q[1]] : [q[0], mid - q[1]];
      const old = s.outline.map(q => q.slice());
      const linkedWalls = allSurfaces().map(x => x.surface).filter(w => w.link && w.link.floorId === s.id).map(w => ({ w, a: map(old[w.link.edge]), b: map(old[(w.link.edge + 1) % old.length]) }));
      s.outline = Geo.normaliseOutline(old.map(map)).pts.map((q, i, arr) => q); // anticlockwise again
      const nb = Geo.bbox(old.map(map)); const shift = [-nb.x0, -nb.y0];
      linkedWalls.forEach(({ w, a, b: b2 }) => { const A = [a[0] + shift[0], a[1] + shift[1]], B = [b2[0] + shift[0], b2[1] + shift[1]]; const i2 = s.outline.findIndex((q, i) => { const r = s.outline[(i + 1) % s.outline.length]; const same = (x, y) => Math.hypot(x[0] - y[0], x[1] - y[1]) < 1; return (same(q, A) && same(r, B)) || (same(q, B) && same(r, A)); }); if (i2 >= 0) w.link.edge = i2; });
      remapDoorways(s, old, q => { const r = map(q); return [r[0] + shift[0], r[1] + shift[1]]; });
      linkedWalls.forEach(({ w }) => syncDoors(w, s));
      resetSigs(); S.cache.clear(); autoStart(s); save(); renderPane(); requestDraw(); toast('Shape flipped'); return;
    }
    if (p === 'drawop') { S.calib = S.opTrace = null; S.trace = []; S.traceTarget = 'op'; S.mode = 'move'; setModeButtons(); requestDraw(); toast('Tap round the area that is not tiled, then tap the first point', 3500); return; }
    if (p === 'openfold') { openView('fold-' + s.id); return; }
    if (p === 'alignfloor') {
      const f = findSurface(s.link.floorId).surface; const cf = calc(f); if (!cf.res) return toast('Set up the floor tiles first');
      const e2 = eff(s); if (+e2.pattern.rotation || ['diagonal', 'herringbone45'].includes(e2.pattern.type)) return toast('Only works when the wall tiles run square');
      const joints = Geo.floorJointsOnEdge(cf.res, f.outline, s.link.edge, +eff(f).pattern.joint || 0);
      if (!joints.length) return toast('No floor joints meet this wall');
      const W = Geo.bbox(s.outline).w; const jc = joints.reduce((a, b) => Math.abs(b - W / 2) < Math.abs(a - W / 2) ? b : a);
      const ref = Geo.bbox(Geo.buildUnit(tileOf(s), e2.pattern).cells[0].pts); const gw = +e2.pattern.joint || 0;
      setOrigin(s, [jc + gw / 2 - ref.x0, +e2.pattern.oy], 'Joints lined up with the floor'); renderPane();
      toast(`Wall joint lined up with the floor joint ${Math.round(jc)} mm from the left`, 3000); return;
    }
    if (p === 'adddoor') {
      let bi2 = 0, bl = 0; s.outline.forEach((q, i) => { const r = s.outline[(i + 1) % s.outline.length]; const l = Math.hypot(r[0] - q[0], r[1] - q[1]); if (l > bl) { bl = l; bi2 = i; } });
      s.doorways = s.doorways || []; s.doorways.push({ id: Store.uid(), name: 'Doorway', edge: bi2, pos: Math.round((bl - 800) / 2), w: 800 }); save(); renderPane(); requestDraw(); return;
    }
    if (p === 'mvleft' || p === 'mvright') { const i = g.members.indexOf(s.id); const j = p === 'mvleft' ? i - 1 : i + 1; if (j < 0 || j >= g.members.length) return; g.members.splice(i, 1); g.members.splice(j, 0, s.id); save(); S.view = null; renderPane(); requestDraw(); return; }
    if (p === 'rect') { const W = +$('#qrW').value, H = +$('#qrH').value; if (!(W > 0 && H > 0)) return; s.outline = [[0, 0], [W, 0], [W, H], [0, H]]; }
    if (p === 'L') {
      const W = +$('#qrW').value, H = +$('#qrH').value, cw = +$('#qlW').value, ch = +$('#qlH').value, c = $('#qlC').value;
      if (!(cw > 0 && ch > 0 && cw < W && ch < H)) return toast('Cut-out must be smaller than the shape');
      s.outline = { tr: [[0, 0], [W, 0], [W, H - ch], [W - cw, H - ch], [W - cw, H], [0, H]], tl: [[0, 0], [W, 0], [W, H], [cw, H], [cw, H - ch], [0, H - ch]], br: [[0, 0], [W - cw, 0], [W - cw, ch], [W, ch], [W, H], [0, H]], bl: [[cw, 0], [W, 0], [W, H], [0, H], [0, ch], [cw, ch]] }[c];
    }
    if (p === 'slope') { const W = +$('#qrW').value, H = +$('#qrH').value, low = +prompt('Height at the low side of the slope (mm)?', Math.round(H * 0.5)); const at = +prompt('Distance from the left where the slope starts (mm)?', Math.round(W * 0.5)); if (!(low > 0) || !(at >= 0)) return; s.outline = [[0, 0], [W, 0], [W, low], [at, H], [0, H]]; }
    if (p === 'walls' || p === 'addwall' || p === 'delwall') {
      const walls = $$('[data-wl]').map((el, i) => { const sl = $(`[data-wt="${i}"]`); let turn = sl ? sl.value : 0; if (turn === 'custom') turn = +prompt(`Turn angle after wall ${i + 1} (left is +, right is −)`, '90') || 0; return { len: +el.value, turn: +turn }; });
      if (p === 'addwall') { walls.splice(walls.length - 1, 0, { len: 1000, turn: 90 }); walls[walls.length - 2].turn = 90; }
      if (p === 'delwall') { if (walls.length <= 3) return toast('Need at least 3 walls'); walls.splice(walls.length - 2, 1); }
      const out = Geo.wallsToOutline(walls);
      s.outline = Geo.normaliseOutline(out.pts).pts;
      save(); renderPane(); requestDraw(); S.view = null;
      const gap = Math.round(out.gap); const last = walls[walls.length - 1].len;
      const msg = $('#wallMsg'); if (msg) msg.innerHTML = `<div class="${Math.abs(gap - last) > 5 ? 'warn' : 'note'}">Closing wall measures ${gap} mm${Math.abs(gap - last) > 5 ? ` but you entered ${last} mm — check your lengths and turns.` : ' ✓'}</div>`;
      return;
    }
    if (p === 'addv') { const last = s.outline[s.outline.length - 1], first = s.outline[0]; s.outline.push([Math.round((last[0] + first[0]) / 2), Math.round((last[1] + first[1]) / 2)]); }
    if (p === 'norm') { const nn = Geo.normaliseOutline(s.outline); s.outline = nn.pts; s.openings.forEach(o => { o.x += nn.dx; o.y += nn.dy; }); if (s.bg) { s.bg.x += nn.dx; s.bg.y += nn.dy; } if (!groupOf(s)) { s.pattern.ox += nn.dx; s.pattern.oy += nn.dy; } if (s.place) { s.place.x -= nn.dx; s.place.y -= nn.dy; } }
    if (p === 'newtile') { addTileModal(t2 => { tileTarget(s).tileId = t2.id; S.cache.clear(); save(); }); return; }
    if (p === 'best') {
      $('#bestList').innerHTML = '<div class="muted">Working…</div>';
      await new Promise(r => setTimeout(r, 30));
      if (!tileOf(s)) { S.best = []; toast('Choose a tile first'); renderPane(); return; }
      if (g) { S.best = bestForGroup(g, 6); if (S.best.length) applyGroupBest(g, S.best[0]); }
      else { S.best = Geo.findBestStarts(s, tileOf(s), geoSettings(s), 6); if (S.best.length) { const b0 = S.best[0]; s.pattern.ox = Math.round(b0.ox * 10) / 10; s.pattern.oy = Math.round(b0.oy * 10) / 10; s.startLabel = b0.label; } }
      save(); renderPane(); requestDraw(); toast(S.best.length ? 'Best start applied — tap another option to compare' : 'No starts found'); return;
    }
    if (p === 'snap') { const cand = Geo.startCandidates(eff(s), tileOf(s)); const X = cand.xs[+$('#sx').value], Y = cand.ys[+$('#sy').value]; setOrigin(s, Geo.toAreaOrigin(X.v, Y.v, cand.a), `${X.label} · ${Y.label}`); toast('Start applied'); return; }
    if (p === 'bgimport') {
      const f = await pickFile('image/*,application/pdf'); if (!f) return;
      toast('Loading drawing…');
      try {
        const im = await fileToImage(f, S.bgPage); checkpoint();
        const mmPerPx = Math.max(b.w, 4000) * 1.15 / im.w; const id = Store.uid(); S.job.images[id] = im.dataUrl;
        if (s.bg && s.bg.img && !allSurfaces().some(x => x.surface !== s && x.surface.bg?.img === s.bg.img)) delete S.job.images[s.bg.img];
        s.bg = { img: id, mmPerPx, x: b.x0 - b.w * 0.05, y: b.y0 + im.h * mmPerPx - b.h * 0.05 - (im.h * mmPerPx - b.h) / 2, opacity: 0.55, scaled: false };
        save(); S.view = null; renderPane(); requestDraw();
        toast(im.pages > 1 ? `PDF has ${im.pages} pages — showing page ${Math.min(S.bgPage, im.pages)}. Now set the scale.` : 'Drawing added — now set the scale', 3500);
      } catch (err) { console.error(err); toast('Could not load that file: ' + err.message, 4000); }
      return;
    }
    if (p === 'bgdel') { if (confirm('Remove the drawing from this area?')) { s.bg = null; if (S.mode === 'bg') S.mode = 'move'; save(); setModeButtons(); renderPane(); requestDraw(); } return; }
    if (p === 'bgmove') { setMode(S.mode === 'bg' ? 'move' : 'bg'); renderPane(); return; }
    if (p === 'calib') { S.trace = S.opTrace = null; S.calib = []; setModeButtons(); fitBg(s); requestDraw(); return; }
    if (p === 'trace') { S.calib = S.opTrace = null; S.trace = []; setModeButtons(); fitBg(s); requestDraw(); return; }
    if (p === 'optrace') { S.calib = S.trace = null; S.opTrace = []; setModeButtons(); requestDraw(); return; }
    if (p === 'paste') return pasteModal(s);
    if (p === 'prompt') return copyPrompt();
    if (p === 'ai') {
      if (S.aiBusy) return; S.aiBusy = true; renderPane();
      try { const data = await AI.readWithApi(bgData(s), S.settings, $('#aiExtra')?.value || ''); previewImport(data, s); }
      catch (err) { toast(err.message, 5000); }
      S.aiBusy = false; renderPane(); return;
    }
    S.cache.clear(); save(); renderPane(); requestDraw();
  }
  function fitBg(s) { const img = bgImgFor(s); if (!img || !cv) return; const bg = s.bg; const o = offsets(curView()).get(s.id); if (rots(curView()).get(s.id)) return; const [W, H] = dims(); S.view = Render.makeView(Geo.bbox([[bg.x + o[0], bg.y + o[1]], [bg.x + img.width * bg.mmPerPx + o[0], bg.y - img.height * bg.mmPerPx + o[1]]]), W, H, 20); }

  window.__tso = S; // for testing
  route();
})();
