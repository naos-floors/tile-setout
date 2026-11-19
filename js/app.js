/* Naos Tile Set-out — app UI */
(function () {
  'use strict';
  const S = {
    settings: Store.getSettings(), job: null, surfId: null, tab: 'shape', mode: 'move', view: null,
    cache: new Map(), bgImgs: new Map(), selOpening: -1, selVertex: -1, trace: null, calib: null, opTrace: null, opType: 'window',
    traceOrtho: true, best: null, dragging: false, showIds: false, nudge: 10, aiBusy: false, bgPage: 1,
  };
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const app = $('#app');
  const r1 = n => Math.round(n * 10) / 10;
  const fmt = (n, d = 0) => (n == null || !isFinite(n)) ? '-' : (+n).toLocaleString('en-GB', { maximumFractionDigits: d, minimumFractionDigits: d });
  const OP_TYPES = { door: 'Door', window: 'Window', niche: 'Niche', bath: 'Bath', tray: 'Shower tray', other: 'Other' };

  function toast(msg, ms = 2400) { const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), ms); }
  function modal(html) {
    const m = document.createElement('div'); m.className = 'modal'; m.innerHTML = `<div class="box">${html}</div>`;
    document.body.appendChild(m);
    m.addEventListener('click', e => { if (e.target === m || e.target.closest('[data-close]')) m.remove(); });
    return m;
  }
  let saveT = null;
  function save() { clearTimeout(saveT); saveT = setTimeout(() => S.job && Store.put(S.job).catch(e => toast('Could not save: ' + e.message)), 350); }
  function netPill() { return navigator.onLine ? '' : '<span class="offline">Offline</span>'; }
  window.addEventListener('online', () => { $$('.netslot').forEach(e => e.innerHTML = netPill()); if (S.tab === 'drawing' && S.surfId) renderPane(); });
  window.addEventListener('offline', () => { $$('.netslot').forEach(e => e.innerHTML = netPill()); if (S.tab === 'drawing' && S.surfId) renderPane(); });

  // ---------- model helpers ----------
  function findSurface(id) { for (const r of S.job.rooms) for (const s of r.surfaces) if (s.id === id) return { room: r, surface: s }; return {}; }
  function tileOf(s) { return S.job.tiles.find(t => t.id === s.tileId) || S.job.tiles[0]; }
  function geoSettings(s) {
    const g = S.settings;
    return { sliver: s.settings.sliver !== '' && s.settings.sliver != null ? +s.settings.sliver : +g.sliver, kerf: +g.kerf, minOffcut: +g.minOffcut, reuseOffcuts: s.settings.reuseOffcuts !== false };
  }
  function calc(s) {
    const tile = tileOf(s); if (!tile) return {};
    const gs = geoSettings(s);
    const key = JSON.stringify([s.outline, s.openings, s.pattern, s.settings, tile, gs, S.settings.mat]);
    const hit = S.cache.get(s.id); if (hit && hit.key === key) return hit.val;
    let res = null; try { res = Geo.layout(s, tile, gs); } catch (e) { console.error(e); }
    const val = { tile, res, mat: res ? Geo.materials(s, tile, res, S.settings.mat) : null, cuts: res ? Geo.cutList(res) : [] };
    S.cache.set(s.id, { key, val });
    return val;
  }
  function jobTotals(job) {
    const all = []; const tiles = new Map();
    let adhBagsArea = new Map(), groutKg = 0, primerL = 0, trimM = 0, spacers = 0, area = 0;
    const mat = S.settings.mat;
    for (const room of job.rooms) for (const surface of room.surfaces) {
      const c = calc(surface); all.push({ room, surface, ...c });
      if (!c.res) continue;
      area += c.mat.m2;
      c.mat.tiles.forEach((t, i) => {
        const key = c.tile.id + '|' + t.label;
        if (!tiles.has(key)) tiles.set(key, { tile: c.tile, label: t.label, needed: 0, order: 0, m2: 0, modular: surface.pattern.type === 'modular' });
        const e = tiles.get(key); e.needed += t.needed; e.order += t.order; e.m2 += t.m2;
      });
      const cov = c.mat.adhesive.coverage; adhBagsArea.set(cov, (adhBagsArea.get(cov) || 0) + c.mat.m2);
      groutKg += c.mat.grout.kg; primerL += c.mat.primer.litres; trimM += c.mat.trim.m; spacers += c.mat.spacers.count;
    }
    const rows = [];
    rows.push(['Total tiled area', `${fmt(area, 2)} m²`, '']);
    const modularM2 = new Map();
    for (const e of tiles.values()) {
      let ord = '';
      if (e.modular) { modularM2.set(e.tile.id, (modularM2.get(e.tile.id) || 0) + e.m2); ord = `${fmt(e.m2, 2)} m²`; }
      else if (+e.tile.perBox > 0) ord = `${Math.ceil(e.order / +e.tile.perBox)} boxes`;
      else if (+e.tile.m2PerBox > 0) ord = `${Math.ceil(e.m2 / +e.tile.m2PerBox)} boxes`;
      else ord = `${fmt(e.m2, 2)} m²`;
      rows.push([`${e.tile.name} ${e.modular ? e.label : ''}`.trim(), `${e.needed} needed · ${e.order} incl. spare`, ord]);
    }
    for (const [tid, m2] of modularM2) { const t = job.tiles.find(x => x.id === tid); if (t && +t.m2PerBox > 0) rows.push([`${t.name} modular packs`, `${fmt(m2, 2)} m²`, `${Math.ceil(m2 / +t.m2PerBox)} packs`]); }
    let bags = 0; for (const [cov, a] of adhBagsArea) bags += a / cov * (1 + (+mat.adhExtra || 0) / 100);
    if (area > 0) rows.push([mat.adhName, `${fmt(area, 1)} m²`, `${Math.ceil(bags - 1e-9)} × ${mat.adhBagKg} kg`]);
    if (groutKg > 0) rows.push([mat.groutName, `${fmt(groutKg, 1)} kg`, `${Math.ceil(groutKg / (+mat.groutBagKg || 5) - 1e-9)} × ${mat.groutBagKg} kg`]);
    if (primerL > 0) rows.push([mat.primerName, `${fmt(primerL, 1)} L`, `${Math.ceil(primerL / (+mat.primerUnitL || 5) - 1e-9)} × ${mat.primerUnitL} L`]);
    if (trimM > 0) rows.push(['Trim', `${fmt(trimM, 1)} m`, `${Math.ceil(trimM / (+mat.trimLengthM || 2.5) - 1e-9)} × ${mat.trimLengthM} m`]);
    if (spacers > 0) rows.push(['Spacers / levelling clips', `${Math.ceil(spacers)}`, `${Math.ceil(spacers / (+mat.spacerPack || 100))} packs`]);
    return { all, rows, area };
  }

  function autoStart(surface) {
    try { const b = Geo.findBestStarts(surface, tileOf(surface), geoSettings(surface), 1)[0]; if (b) { surface.pattern.ox = Math.round(b.ox * 10) / 10; surface.pattern.oy = Math.round(b.oy * 10) / 10; surface.startLabel = b.label; } } catch (e) { console.warn(e); }
  }

  // ---------- files ----------
  async function shareOrDownload(blob, name) {
    const file = new File([blob], name, { type: blob.type });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === 'AbortError') return; }
    }
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }
  const safeName = s => (s || 'job').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'job';
  function pickFile(accept) { return new Promise(res => { const i = document.createElement('input'); i.type = 'file'; i.accept = accept; i.onchange = () => res(i.files[0] || null); i.click(); }); }
  async function fileToImage(file, page = 1) {
    let src;
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
    src = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(file); });
    const img = await loadImg(src);
    const sc = Math.min(1, 2600 / Math.max(img.width, img.height));
    const cv = document.createElement('canvas'); cv.width = Math.round(img.width * sc); cv.height = Math.round(img.height * sc);
    const cx = cv.getContext('2d'); cx.fillStyle = '#fff'; cx.fillRect(0, 0, cv.width, cv.height); cx.drawImage(img, 0, 0, cv.width, cv.height);
    return { dataUrl: cv.toDataURL('image/jpeg', 0.88), w: cv.width, h: cv.height };
  }
  function loadImg(src) { return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; }); }
  function bgImgFor(s) {
    if (!s.bg || !s.bg.dataUrl) return null;
    const k = s.id + ':' + s.bg.dataUrl.length;
    const e = S.bgImgs.get(k); if (e) return e.ready ? e.img : null;
    const img = new Image(); const ent = { img, ready: false }; S.bgImgs.set(k, ent);
    img.onload = () => { ent.ready = true; requestDraw(); }; img.src = s.bg.dataUrl;
    return null;
  }

  // ---------- routing ----------
  window.addEventListener('hashchange', route);
  async function route() {
    const h = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
    if (h[0] === 'job') {
      if (!S.job || S.job.id !== h[1]) { S.job = await Store.get(h[1]); S.cache.clear(); S.view = null; }
      if (!S.job) { location.hash = ''; return; }
      if (h[2] === 's' && h[3]) { if (S.surfId !== h[3]) { S.surfId = h[3]; S.view = null; S.best = null; S.selOpening = -1; S.trace = S.calib = S.opTrace = null; } return renderEditor(); }
      S.surfId = null; return renderJob();
    }
    S.surfId = null;
    if (h[0] === 'settings') return renderSettings();
    return renderHome();
  }

  // ---------- home ----------
  async function renderHome() {
    S.job = null;
    const jobs = await Store.list();
    app.innerHTML = `
      <div class="top"><div class="brand">NAOS <span>FLOORS</span></div><h1 style="font-weight:400;opacity:.85">Tile Set-out</h1><span class="netslot">${netPill()}</span><button data-a="settings" aria-label="Settings">⚙︎</button></div>
      <div class="scroll"><div class="wrap">
        <div class="card"><h2>Jobs<span class="sp"></span><button class="btn sec sm" data-a="import">Open job file</button><button class="btn sm" data-a="new">+ New job</button></h2>
          <div class="list">${jobs.length ? jobs.map(j => `<div class="item click" data-open="${j.id}"><div class="main"><div class="t">${esc(j.name)}</div><div class="s">${esc(j.client || '')}${j.client ? ' · ' : ''}${j.rooms.length} room${j.rooms.length === 1 ? '' : 's'} · ${j.rooms.reduce((a, r) => a + r.surfaces.length, 0)} areas · ${new Date(j.updated).toLocaleDateString('en-GB')}</div></div><span class="muted">›</span></div>`).join('') : '<div class="empty">No jobs yet. Start a new job, or open a job file.</div>'}</div>
        </div>
        <div class="note">Everything is saved on this device and works with no signal. To move a job between phone and computer, use <b>Save job file</b> on the job and open it on the other device.</div>
      </div></div>`;
    app.onclick = async e => {
      const o = e.target.closest('[data-open]'); if (o) { location.hash = `#/job/${o.dataset.open}`; return; }
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a === 'settings') location.hash = '#/settings';
      if (a === 'new') { const name = prompt('Job name', 'New job'); if (name == null) return; const j = Store.newJob(name || 'New job'); await Store.put(j); location.hash = `#/job/${j.id}`; }
      if (a === 'import') importJobFile();
    };
  }
  async function importJobFile() {
    const f = await pickFile('.json,.tso,application/json'); if (!f) return;
    try {
      const j = JSON.parse(await f.text()); const job = j.job || j;
      if (!job.rooms || !job.tiles) throw new Error('Not a tile set-out job file');
      const existing = await Store.get(job.id);
      if (existing && !confirm(`"${existing.name}" is already on this device. Replace it with the file version?`)) { job.id = Store.uid(); job.name += ' (copy)'; }
      await Store.put(job); toast('Job opened'); location.hash = `#/job/${job.id}`; if (S.job && S.job.id === job.id) { S.job = null; route(); }
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
          <div class="note">Default: Ardex X7R at about 2.2 m² per 20 kg bag. Tiles can override this (e.g. large format with back-buttering).</div></div>
        <div class="card"><h2>Grout</h2><div class="grid">${f('groutName', 'Product', 'text')}${f('groutDensity', 'Density (kg/L)')}${f('groutBagKg', 'Bag size kg')}${f('groutExtra', 'Extra %')}</div>
          <div class="note">Grout is worked out from joint length × joint width × tile thickness × density, so it adjusts to every tile size and pattern. Check the density and bag size against the Ardex data sheet for the grout you use.</div></div>
        <div class="card"><h2>Primer, trim and spacers</h2><div class="grid">${f('primerName', 'Primer', 'text')}${f('primerLPerM2', 'Primer litres per m²')}${f('primerUnitL', 'Primer container (L)')}${f('trimLengthM', 'Trim length (m)')}${f('spacersPerTile', 'Spacers/clips per tile')}${f('spacerPack', 'Spacers per pack')}</div></div>
        <div class="card"><h2>Automatic drawing reading (optional)</h2>
          <div class="grid">${f('apiKey', 'Anthropic API key', 'password', 'g', 'autocomplete="off" placeholder="sk-ant-…"')}${f('model', 'Model', 'text', 'g')}</div>
          <div class="note">Only needed for the in-app <b>Read drawing</b> button, which only works with signal. The key is stored on this device only. Without a key you can still send a drawing to Claude with the ready-made prompt and paste the reply in.</div></div>
        <div class="note">Version 1.0 · Naos Floors internal tool. Quantities are a guide: always check on site and follow BS 5385 and manufacturers’ instructions.</div>
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
      const c = tot.all.find(x => x.surface.id === s.id);
      const st = c?.res?.stats;
      return `<div class="item click" data-surf="${s.id}"><div class="main"><div class="t">${esc(s.name)} <span class="pill">${s.kind}</span></div>
        <div class="s">${c?.res ? `${fmt(c.mat.m2, 2)} m² · ${esc(c.tile?.name || '')} · ${esc(Geo.PATTERNS[s.pattern.type]?.name || '')} · ${st.needed} tiles` : 'Not set up yet'}</div></div>
        ${st && st.slivers ? `<span class="pill red">${st.slivers} sliver${st.slivers > 1 ? 's' : ''}</span>` : ''}<button class="btn sec sm" data-smenu="${s.id}">⋯</button></div>`;
    };
    app.innerHTML = `
      <div class="top"><button data-a="home">‹ Jobs</button><h1>${esc(job.name)}</h1><span class="netslot">${netPill()}</span><button data-a="pdf">PDF</button></div>
      <div class="scroll"><div class="wrap">
        <div class="card"><h2>Job details</h2><div class="grid">
          <label class="f">Job name<input data-j="name" value="${esc(job.name)}"></label>
          <label class="f">Client<input data-j="client" value="${esc(job.client)}"></label>
          <label class="f" style="grid-column:1/-1">Site address<input data-j="address" value="${esc(job.address)}"></label>
          <label class="f" style="grid-column:1/-1">Notes<textarea data-j="notes" rows="2">${esc(job.notes)}</textarea></label>
        </div></div>
        ${job.rooms.map(r => `<div class="card"><h2>${esc(r.name)}<span class="sp"></span><button class="btn sec sm" data-rmenu="${r.id}">⋯</button></h2>
          <div class="list">${r.surfaces.map(s => surfRow(r, s)).join('') || '<div class="muted">No areas yet.</div>'}</div>
          <div class="row" style="margin-top:8px"><button class="btn sec sm" data-add="wall" data-room="${r.id}">+ Wall</button><button class="btn sec sm" data-add="floor" data-room="${r.id}">+ Floor</button></div></div>`).join('')}
        <div class="row" style="margin-bottom:12px"><button class="btn" data-a="addroom">+ Room / area</button><button class="btn sec" data-a="quickroom">+ Quick room (4 walls + floor)</button></div>
        <div class="card"><h2>Tiles on this job<span class="sp"></span><button class="btn sec sm" data-a="addtile">+ Tile</button></h2>
          <div class="list">${job.tiles.map(t => `<div class="item click" data-tile="${t.id}"><div class="main"><div class="t">${esc(t.name)}</div><div class="s">${t.w} × ${t.h} × ${t.thick} mm · ${+t.perBox ? t.perBox + ' per box' : +t.m2PerBox ? t.m2PerBox + ' m² per box' : 'box size not set'}</div></div><span class="muted">Edit ›</span></div>`).join('')}</div></div>
        <div class="card"><h2>Order list — whole job</h2>
          <table class="t"><tr><th>Item</th><th>Quantity</th><th class="n">Order</th></tr>${tot.rows.map(r => `<tr><td>${esc(r[0])}</td><td>${esc(r[1])}</td><td class="n"><b>${esc(r[2])}</b></td></tr>`).join('')}</table></div>
        <div class="card"><h2>Drawings → rooms</h2>
          <div class="muted" style="margin-bottom:8px">Turn a floor plan or elevation into rooms and walls ready to set out.</div>
          <div class="row"><button class="btn" data-a="aifile" ${navigator.onLine && S.settings.apiKey ? '' : 'disabled'}>Read a drawing (needs signal)</button>
          <button class="btn sec" data-a="paste">Paste room data</button><button class="btn sec" data-a="prompt">Copy prompt for Claude</button></div>
          ${!navigator.onLine ? '<div class="note">Offline: automatic reading is switched off. You can still trace a drawing by hand inside any area (Drawing tab).</div>' : !S.settings.apiKey ? '<div class="note">Automatic reading needs an API key in Settings. Or: tap <b>Copy prompt for Claude</b>, send it to Claude with your drawing, then paste the reply here with <b>Paste room data</b>.</div>' : ''}
        </div>
        <div class="card"><h2>Export</h2>
          <label class="chk"><input type="checkbox" id="pdfIds" ${S.showIds ? 'checked' : ''}> Show piece numbers on PDF drawings</label>
          <label class="chk"><input type="checkbox" id="pdfBg"> Include imported drawings behind the set-out</label>
          <div class="row"><button class="btn" data-a="pdf">Job PDF</button><button class="btn sec" data-a="export">Save job file</button><button class="btn danger" data-a="deljob">Delete job</button></div></div>
      </div></div>`;
    app.oninput = e => { const k = e.target.dataset.j; if (k) { job[k] = e.target.value; save(); if (k === 'name') $('.top h1').textContent = job.name; } };
    app.onclick = async e => {
      const t = e.target;
      if (t.closest('[data-smenu]')) { e.stopPropagation(); return surfaceMenu(t.closest('[data-smenu]').dataset.smenu); }
      if (t.closest('[data-rmenu]')) return roomMenu(t.closest('[data-rmenu]').dataset.rmenu);
      const sv = t.closest('[data-surf]'); if (sv) { location.hash = `#/job/${job.id}/s/${sv.dataset.surf}`; return; }
      const tl = t.closest('[data-tile]'); if (tl) return tileModal(tl.dataset.tile);
      const ad = t.closest('[data-add]');
      if (ad) { const room = job.rooms.find(r => r.id === ad.dataset.room); const kind = ad.dataset.add; const n = room.surfaces.filter(s => s.kind === kind).length; const s = Store.newSurface(kind, { name: kind === 'wall' ? `Wall ${String.fromCharCode(65 + n)}` : (n ? `Floor ${n + 1}` : 'Floor'), tileId: job.tiles[0]?.id }); autoStart(s); room.surfaces.push(s); await Store.put(job); location.hash = `#/job/${job.id}/s/${s.id}`; return; }
      const a = t.closest('[data-a]')?.dataset.a; if (!a) return;
      if (a === 'home') location.hash = '';
      if (a === 'addroom') { const n = prompt('Room or area name', 'Room'); if (!n) return; job.rooms.push(Store.newRoom(n)); save(); renderJob(); }
      if (a === 'quickroom') quickRoomModal();
      if (a === 'addtile') { const tile = Store.newTile({ name: 'New tile' }); job.tiles.push(tile); save(); tileModal(tile.id, true); }
      if (a === 'pdf') exportPDF();
      if (a === 'export') { await Store.put(job); shareOrDownload(new Blob([JSON.stringify({ app: 'naos-tile-setout', v: 1, job })], { type: 'application/json' }), `${safeName(job.name)}.tso.json`); }
      if (a === 'deljob') { if (confirm(`Delete "${job.name}" from this device? Save a job file first if you want a copy.`)) { await Store.del(job.id); S.job = null; location.hash = ''; } }
      if (a === 'paste') pasteModal(null);
      if (a === 'prompt') copyPrompt();
      if (a === 'aifile') { const f = await pickFile('image/*,application/pdf'); if (!f) return; let page = 1; if (/pdf/.test(f.type)) { page = +prompt('Which page of the PDF?', '1') || 1; } toast('Reading drawing…', 8000); try { const im = await fileToImage(f, page); const data = await AI.readWithApi(im.dataUrl, S.settings); previewImport(data, null); } catch (err) { toast(err.message, 5000); } }
    };
    $('#pdfIds')?.addEventListener('change', e => { S.showIds = e.target.checked; });
  }

  function surfaceMenu(id) {
    const { room, surface } = findSurface(id);
    const m = modal(`<h3>${esc(surface.name)}</h3><div class="row" style="flex-direction:column;align-items:stretch">
      <button class="btn sec" data-m="rename">Rename</button><button class="btn sec" data-m="dup">Duplicate</button>
      ${S.job.rooms.length > 1 ? `<label class="f">Move to room<select data-m-move><option value="">—</option>${S.job.rooms.filter(r => r !== room).map(r => `<option value="${r.id}">${esc(r.name)}</option>`).join('')}</select></label>` : ''}
      <button class="btn danger" data-m="del">Delete</button><button class="btn sec" data-close>Close</button></div>`);
    m.onclick = e => {
      const a = e.target.closest('[data-m]')?.dataset.m; if (!a) { if (e.target === m) m.remove(); return; }
      if (a === 'rename') { const n = prompt('Name', surface.name); if (n) surface.name = n; }
      if (a === 'dup') { const c = JSON.parse(JSON.stringify(surface)); c.id = Store.uid(); c.name += ' copy'; c.openings.forEach(o => o.id = Store.uid()); room.surfaces.splice(room.surfaces.indexOf(surface) + 1, 0, c); }
      if (a === 'del') { if (!confirm(`Delete ${surface.name}?`)) return; room.surfaces.splice(room.surfaces.indexOf(surface), 1); }
      save(); m.remove(); renderJob();
    };
    m.querySelector('[data-m-move]')?.addEventListener('change', e => { const to = S.job.rooms.find(r => r.id === e.target.value); if (!to) return; room.surfaces.splice(room.surfaces.indexOf(surface), 1); to.surfaces.push(surface); save(); m.remove(); renderJob(); });
  }
  function roomMenu(id) {
    const room = S.job.rooms.find(r => r.id === id);
    const m = modal(`<h3>${esc(room.name)}</h3><div class="row" style="flex-direction:column;align-items:stretch"><button class="btn sec" data-m="rename">Rename</button><button class="btn sec" data-m="dup">Duplicate room</button><button class="btn danger" data-m="del">Delete room</button><button class="btn sec" data-close>Close</button></div>`);
    m.onclick = e => {
      const a = e.target.closest('[data-m]')?.dataset.m; if (!a) { if (e.target === m) m.remove(); return; }
      if (a === 'rename') { const n = prompt('Name', room.name); if (n) room.name = n; }
      if (a === 'dup') { const c = JSON.parse(JSON.stringify(room)); c.id = Store.uid(); c.name += ' copy'; c.surfaces.forEach(s => { s.id = Store.uid(); }); S.job.rooms.push(c); }
      if (a === 'del') { if (!confirm(`Delete ${room.name} and all its areas?`)) return; S.job.rooms.splice(S.job.rooms.indexOf(room), 1); }
      save(); m.remove(); renderJob();
    };
  }
  function tileFields(t) {
    const f = (k, l, type = 'number', ph = '') => `<label class="f">${l}<input data-t="${k}" type="${type}" ${type === 'number' ? 'inputmode="decimal" step="any"' : ''} value="${esc(t[k])}" placeholder="${ph}"></label>`;
    return `<div class="grid">${f('name', 'Name', 'text')}${f('w', 'Length / width mm')}${f('h', 'Height / width mm')}${f('thick', 'Thickness mm')}${f('perBox', 'Tiles per box')}${f('m2PerBox', 'or m² per box')}${f('adhCoverage', 'Adhesive m²/bag', 'number', 'use default')}</div>`;
  }
  function tileModal(id, isNew) {
    const t = S.job.tiles.find(x => x.id === id);
    const used = S.job.rooms.reduce((a, r) => a + r.surfaces.filter(s => s.tileId === id).length, 0);
    const m = modal(`<h3>${isNew ? 'New tile' : 'Edit tile'}</h3>${tileFields(t)}
      <div class="note">Used on ${used} area${used === 1 ? '' : 's'}. Changes apply everywhere this tile is used. For straight lay, the first size runs across.</div>
      <div class="row"><button class="btn" data-close>Done</button>${S.job.tiles.length > 1 ? '<button class="btn danger" data-m="del">Delete tile</button>' : ''}</div>`);
    m.oninput = e => { const k = e.target.dataset.t; if (!k) return; t[k] = e.target.type === 'number' && e.target.value !== '' ? +e.target.value : e.target.value; S.cache.clear(); save(); };
    m.addEventListener('click', e => {
      if (e.target.closest('[data-m="del"]')) { if (used && !confirm(`This tile is used on ${used} areas. They will switch to the first tile. Delete?`)) return; S.job.tiles.splice(S.job.tiles.indexOf(t), 1); S.job.rooms.forEach(r => r.surfaces.forEach(s => { if (s.tileId === id) s.tileId = S.job.tiles[0].id; })); save(); m.remove(); }
      if (!document.body.contains(m)) { if (S.surfId) renderPane(), requestDraw(); else renderJob(); }
    });
  }
  function quickRoomModal() {
    const m = modal(`<h3>Quick room</h3><div class="grid">
      <label class="f">Room name<input id="qName" value="Bathroom"></label><label class="f">Length (mm)<input id="qL" type="number" inputmode="decimal" value="2400"></label>
      <label class="f">Width (mm)<input id="qW" type="number" inputmode="decimal" value="1800"></label><label class="f">Tiling height (mm)<input id="qH" type="number" inputmode="decimal" value="2400"></label></div>
      <label class="chk"><input type="checkbox" id="qWalls" checked> 4 walls (A, B, C, D going round the room)</label><label class="chk"><input type="checkbox" id="qFloor" checked> Floor</label>
      <div class="row"><button class="btn" data-m="go">Create</button><button class="btn sec" data-close>Cancel</button></div>`);
    m.querySelector('[data-m="go"]').onclick = () => {
      const L = +$('#qL', m).value, W = +$('#qW', m).value, H = +$('#qH', m).value; if (!(L > 0 && W > 0)) return toast('Enter the room size');
      const room = Store.newRoom($('#qName', m).value || 'Room'); const tid = S.job.tiles[0].id;
      if ($('#qWalls', m).checked) [['A', L], ['B', W], ['C', L], ['D', W]].forEach(([n, len]) => room.surfaces.push(Store.newSurface('wall', { name: `Wall ${n}`, outline: [[0, 0], [len, 0], [len, H], [0, H]], tileId: tid })));
      if ($('#qFloor', m).checked) room.surfaces.push(Store.newSurface('floor', { name: 'Floor', outline: [[0, 0], [L, 0], [L, W], [0, W]], tileId: tid }));
      room.surfaces.forEach(autoStart); S.job.rooms.push(room); save(); m.remove(); renderJob();
    };
  }
  function copyPrompt() {
    const txt = AI.PROMPT;
    const m = modal(`<h3>Prompt for Claude</h3><div class="muted">Send this to Claude (or any AI chat) along with a photo or PDF of the drawing. Copy the reply and use <b>Paste room data</b>.</div><textarea class="code" readonly>${esc(txt)}</textarea><div class="row"><button class="btn" data-m="copy">Copy</button><button class="btn sec" data-close>Close</button></div>`);
    m.querySelector('[data-m="copy"]').onclick = async () => { try { await navigator.clipboard.writeText(txt); toast('Prompt copied'); } catch (e) { m.querySelector('textarea').select(); document.execCommand('copy'); toast('Prompt copied'); } };
  }
  function pasteModal(targetSurface) {
    const m = modal(`<h3>Paste room data</h3><div class="muted">Paste the reply from Claude (the JSON block).</div><textarea class="code" id="pj" placeholder='{"rooms":[...]}'></textarea><div class="row"><button class="btn" data-m="go">Check</button><button class="btn sec" data-close>Cancel</button></div>`);
    m.querySelector('[data-m="go"]').onclick = () => { try { const d = AI.extractJSON($('#pj', m).value); m.remove(); previewImport(d, targetSurface); } catch (e) { toast('Could not read that: ' + e.message, 4000); } };
  }
  function previewImport(data, targetSurface) {
    let out; try { out = AI.toRooms(data, S.job.tiles[0].id); } catch (e) { return toast(e.message, 4000); }
    const list = out.rooms.map(r => `<div><b>${esc(r.name)}</b><ul style="margin:4px 0 8px;padding-left:18px">${r.surfaces.map(s => { const b = Geo.bbox(s.outline); return `<li>${esc(s.name)} (${s.kind}) ${Math.round(b.w)} × ${Math.round(b.h)} mm, ${s.outline.length} corners, ${s.openings.length} openings</li>`; }).join('')}</ul></div>`).join('');
    const first = out.rooms[0]?.surfaces[0];
    const m = modal(`<h3>Found in drawing</h3>${list || '<div class="muted">Nothing usable found.</div>'}
      ${out.notes ? `<div class="warn"><b>Check:</b> ${esc(out.notes)}</div>` : ''}${out.warnings.map(w => `<div class="err">${esc(w)}</div>`).join('')}
      <div class="note">Automatic readings are a first draft. Check every dimension before setting out.</div>
      <div class="row">${out.rooms.length ? '<button class="btn" data-m="add">Add as new rooms</button>' : ''}${targetSurface && first ? '<button class="btn sec" data-m="replace">Use first area for this one</button>' : ''}<button class="btn sec" data-close>Cancel</button></div>`);
    m.onclick = e => {
      const a = e.target.closest('[data-m]')?.dataset.m;
      if (a === 'add') { out.rooms.forEach(r => r.surfaces.forEach(autoStart)); S.job.rooms.push(...out.rooms); save(); m.remove(); toast(`Added ${out.rooms.length} room${out.rooms.length > 1 ? 's' : ''}`); if (S.surfId) location.hash = `#/job/${S.job.id}`; else renderJob(); }
      if (a === 'replace') { targetSurface.outline = first.outline; targetSurface.openings = first.openings; targetSurface.kind = first.kind; autoStart(targetSurface); save(); m.remove(); S.view = null; renderPane(); requestDraw(); }
      if (e.target === m) m.remove();
    };
  }
  async function exportPDF() {
    toast('Building PDF…');
    await new Promise(r => setTimeout(r, 30));
    try {
      const tot = jobTotals(S.job);
      const withBg = $('#pdfBg')?.checked;
      if (withBg) for (const c of tot.all) if (c.surface.bg) c.bgImg = await loadImg(c.surface.bg.dataUrl);
      const doc = await PDFX.exportJob(S.job, tot.all, tot, { ids: $('#pdfIds') ? $('#pdfIds').checked : S.showIds, withDrawing: withBg });
      await shareOrDownload(doc.output('blob'), `${safeName(S.job.name)}-tile-setout.pdf`);
    } catch (e) { console.error(e); toast('PDF failed: ' + e.message, 5000); }
  }

  // ---------- editor ----------
  let cv = null, ctx = null, drawQ = false;
  function requestDraw() { if (drawQ) return; drawQ = true; requestAnimationFrame(() => { drawQ = false; drawEditor(); }); }
  function cur() { return findSurface(S.surfId); }

  function renderEditor() {
    const { room, surface } = cur(); if (!surface) { location.hash = `#/job/${S.job.id}`; return; }
    app.innerHTML = `
      <div class="top"><button data-a="back">‹</button><h1>${esc(room.name)} — ${esc(surface.name)}</h1><span class="netslot">${netPill()}</span><button data-a="img">Image</button><button data-a="pdf">PDF</button></div>
      <div class="editor">
        <div class="cvwrap"><canvas id="cv"></canvas>
          <div class="tools">
            <button data-mode="move">✥ Move tiles</button><button data-mode="pan">✋ Pan</button><button data-mode="edit">✎ Edit shape</button>
            <span class="sp"></span><button data-a="fit">Fit</button>
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
    app.onclick = e => {
      const tb = e.target.closest('[data-tab]'); if (tb) { S.tab = tb.dataset.tab; $$('.tabs button').forEach(b => b.classList.toggle('on', b === tb)); renderPane(); return; }
      const md = e.target.closest('[data-mode]'); if (md) { setMode(md.dataset.mode); return; }
      const a = e.target.closest('.top [data-a], .tools [data-a]')?.dataset.a;
      if (a === 'back') location.hash = `#/job/${S.job.id}`;
      if (a === 'fit') { S.view = null; requestDraw(); }
      if (a === 'img') exportImage();
      if (a === 'pdf') { location.hash = `#/job/${S.job.id}`; setTimeout(exportPDF, 150); }
    };
  }
  function setMode(m) { S.mode = m; S.selVertex = -1; setModeButtons(); requestDraw(); }
  function setModeButtons() { $$('.tools [data-mode]').forEach(b => b.classList.toggle('on', b.dataset.mode === S.mode && !S.trace && !S.calib && !S.opTrace)); renderHint(); }
  function sizeCanvas() { if (!cv) return; const r = cv.parentElement.getBoundingClientRect(); const d = window.devicePixelRatio || 1; cv.width = Math.round(r.width * d); cv.height = Math.round(r.height * d); }
  function fitView(surface) {
    const W = cv.width / (window.devicePixelRatio || 1), H = cv.height / (window.devicePixelRatio || 1);
    let pts = surface.outline.slice();
    if (surface.bg && (S.trace || S.calib || surface.outline.length < 3)) { const img = bgImgFor(surface); if (img) { const b = surface.bg; pts.push([b.x, b.y], [b.x + img.width * b.mmPerPx, b.y - img.height * b.mmPerPx]); } }
    S.view = Render.makeView(Geo.bbox(pts), W, H, 50); S.view.cy += 16 / S.view.s; // leave room for toolbar
  }
  function drawEditor() {
    if (!cv || !S.surfId) return;
    const { surface } = cur(); if (!surface) return;
    const d = window.devicePixelRatio || 1; const W = cv.width / d, H = cv.height / d;
    if (!S.view) fitView(surface);
    ctx.setTransform(d, 0, 0, d, 0, 0);
    const tile = tileOf(surface);
    let res = null, raw = null;
    if (S.dragging) { const reg = Geo.surfaceRegion(surface); if (reg) raw = Geo.layTiles(reg, tile, surface.pattern, { limit: 20000 }).tiles; }
    else res = calc(surface).res;
    Render.draw(ctx, W, H, S.view, surface, tile, res, { raw, bgImg: bgImgFor(surface), vertices: S.mode === 'edit', selVertex: S.selVertex, selOpening: S.selOpening, trace: S.trace, calib: S.calib || (S.opTrace && S.opTrace.length ? S.opTrace : null), ids: S.showIds });
    const st = res?.stats; const el = $('#stat');
    if (el) el.innerHTML = st ? `<span>${st.needed} tiles</span><span>${st.cuts} cuts</span><span class="${st.minCut != null && st.minCut < geoSettings(surface).sliver ? 'bad' : 'good'}">smallest ${st.minCut != null ? Math.round(st.minCut) + ' mm' : '-'}</span>${st.slivers ? `<span class="bad">${st.slivers} sliver${st.slivers > 1 ? 's' : ''}</span>` : ''}` : S.dragging ? '<span>moving…</span>' : '';
  }
  function renderHint() {
    const h = $('#hint'); if (!h) return;
    let html = '';
    if (S.trace) html = `<span>Tap each corner in turn. Tap the first point to close.</span><label style="display:flex;gap:4px;align-items:center"><input type="checkbox" id="ortho" ${S.traceOrtho ? 'checked' : ''}>Square</label><button data-h="undo">Undo</button><button data-h="finish">Finish</button><button data-h="cancel">Cancel</button>`;
    else if (S.calib) html = `<span>Scale: tap the two ends of a known dimension (${S.calib.length}/2).</span><button data-h="cancel">Cancel</button>`;
    else if (S.opTrace) html = `<span>${OP_TYPES[S.opType]}: tap two opposite corners (${S.opTrace.length}/2).</span><button data-h="cancel">Cancel</button>`;
    else if (S.mode === 'edit') html = '';
    h.className = html ? 'hint' : ''; h.innerHTML = html;
    h.onclick = e => {
      const a = e.target.closest('[data-h]')?.dataset.h;
      if (a === 'undo') { S.trace.pop(); requestDraw(); }
      if (a === 'finish') finishTrace();
      if (a === 'cancel') { S.trace = S.calib = S.opTrace = null; setModeButtons(); requestDraw(); }
    };
    $('#ortho')?.addEventListener('change', e => { S.traceOrtho = e.target.checked; });
  }

  function setupCanvas(cv) {
    const ptrs = new Map(); let g = null;
    const pos = e => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    const dims = () => { const d = window.devicePixelRatio || 1; return [cv.width / d, cv.height / d]; };
    const world = (x, y) => { const [W, H] = dims(); return Render.toW(S.view, W, H, x, y); };
    cv.addEventListener('pointerdown', e => {
      cv.setPointerCapture(e.pointerId); const p = pos(e); ptrs.set(e.pointerId, p);
      if (ptrs.size === 2) {
        const [a, b] = [...ptrs.values()]; if (g && g.type !== 'pan' && g.type !== 'tap') endDrag(false);
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

    function startGesture(p) {
      const { surface } = cur(); const w = world(...p);
      const base = { p0: p, t0: Date.now(), w0: w, moved: false, v0: { ...S.view } };
      if (S.trace || S.calib || S.opTrace) return { ...base, type: 'tap' };
      if (S.mode === 'move') return { ...base, type: 'origin', ox: +surface.pattern.ox || 0, oy: +surface.pattern.oy || 0 };
      if (S.mode === 'bg' && surface.bg) return { ...base, type: 'bg', bx: surface.bg.x, by: surface.bg.y };
      if (S.mode === 'edit') {
        const [W, H] = dims();
        let best = -1, bd = 22;
        surface.outline.forEach((q, i) => { const s = Render.toS(S.view, W, H, q); const d = Math.hypot(s[0] - p[0], s[1] - p[1]); if (d < bd) { bd = d; best = i; } });
        if (best >= 0) { S.selVertex = best; return { ...base, type: 'vertex', i: best, q0: surface.outline[best].slice() }; }
        for (let i = surface.openings.length - 1; i >= 0; i--) { const o = surface.openings[i]; if (w[0] >= o.x && w[0] <= +o.x + +o.w && w[1] >= o.y && w[1] <= +o.y + +o.h) { S.selOpening = i; return { ...base, type: 'opening', i, x0: +o.x, y0: +o.y }; } }
      }
      return { ...base, type: 'pan' };
    }
    function moveGesture(g, p) {
      const dx = p[0] - g.p0[0], dy = p[1] - g.p0[1];
      if (!g.moved && Math.hypot(dx, dy) < 5) return; g.moved = true;
      const { surface } = cur(); const s = S.view.s;
      const wdx = dx / s, wdy = -dy / s;
      if (g.type === 'pan' || g.type === 'tap') { S.view = { ...g.v0, cx: g.v0.cx - dx / s, cy: g.v0.cy + dy / s }; requestDraw(); return; }
      if (g.type === 'origin') { surface.pattern.ox = Math.round(g.ox + wdx); surface.pattern.oy = Math.round(g.oy + wdy); surface.startLabel = 'Custom (dragged)'; S.dragging = true; }
      if (g.type === 'bg') { surface.bg.x = g.bx + wdx; surface.bg.y = g.by + wdy; }
      if (g.type === 'vertex') {
        let nx = Math.round(g.q0[0] + wdx), ny = Math.round(g.q0[1] + wdy);
        const n = surface.outline.length; const pr = surface.outline[(g.i - 1 + n) % n], nxp = surface.outline[(g.i + 1) % n];
        const snap = 12 / s; // snap to square with neighbours
        [pr, nxp].forEach(q => { if (Math.abs(nx - q[0]) < snap) nx = q[0]; if (Math.abs(ny - q[1]) < snap) ny = q[1]; });
        surface.outline[g.i] = [nx, ny]; S.dragging = true;
      }
      if (g.type === 'opening') { const o = surface.openings[g.i]; o.x = Math.round(g.x0 + wdx); o.y = Math.max(surface.kind === 'wall' ? 0 : -1e9, Math.round(g.y0 + wdy)); S.dragging = true; }
      requestDraw();
    }
    function endGesture(g, p) {
      const { surface } = cur();
      if (!g.moved && Date.now() - g.t0 < 700) { onTap(world(...p), p); return; }
      if (g.type !== 'pan' && g.type !== 'tap') endDrag(true);
    }
    function endDrag(changed) { S.dragging = false; if (changed) { save(); if (['setout', 'shape', 'openings'].includes(S.tab)) renderPane(); } requestDraw(); }
    function onTap(w, p) {
      const { surface } = cur(); const [W, H] = dims();
      if (S.trace) {
        if (S.trace.length >= 3) { const f = Render.toS(S.view, W, H, S.trace[0]); if (Math.hypot(f[0] - p[0], f[1] - p[1]) < 18) return finishTrace(); }
        let q = [Math.round(w[0]), Math.round(w[1])];
        if (S.traceOrtho && S.trace.length) { const pr = S.trace[S.trace.length - 1]; const dx = Math.abs(q[0] - pr[0]), dy = Math.abs(q[1] - pr[1]); if (dy < dx * 0.18) q[1] = pr[1]; else if (dx < dy * 0.18) q[0] = pr[0]; }
        S.trace.push(q); requestDraw(); return;
      }
      if (S.calib) {
        S.calib.push(w); requestDraw();
        if (S.calib.length === 2) setTimeout(() => {
          const [a, b] = S.calib; const meas = Math.hypot(b[0] - a[0], b[1] - a[1]);
          const v = prompt(`Real length between the two points (mm)?\nCurrently measures ${Math.round(meas)} mm.`);
          if (v && +v > 0 && meas > 0) { const k = +v / meas; const bg = surface.bg; bg.mmPerPx *= k; bg.x = a[0] + (bg.x - a[0]) * k; bg.y = a[1] + (bg.y - a[1]) * k; bg.scaled = true; save(); toast('Scale set'); S.view = null; }
          S.calib = null; setModeButtons(); renderPane(); requestDraw();
        }, 60);
        return;
      }
      if (S.opTrace) {
        S.opTrace.push(w); requestDraw();
        if (S.opTrace.length === 2) {
          const [a, b] = S.opTrace; const o = { id: Store.uid(), type: S.opType, name: OP_TYPES[S.opType], x: Math.round(Math.min(a[0], b[0])), y: Math.round(Math.min(a[1], b[1])), w: Math.round(Math.abs(a[0] - b[0])), h: Math.round(Math.abs(a[1] - b[1])) };
          if (o.w > 0 && o.h > 0) surface.openings.push(o);
          S.opTrace = null; save(); setModeButtons(); renderPane(); requestDraw();
        }
        return;
      }
      if (S.mode === 'edit') {
        // tap on an edge midpoint area inserts a corner
        const n = surface.outline.length; let bi = -1, bd = 14;
        for (let i = 0; i < n; i++) { const a = Render.toS(S.view, W, H, surface.outline[i]), b = Render.toS(S.view, W, H, surface.outline[(i + 1) % n]); const d = segDist(p, a, b); if (d < bd) { bd = d; bi = i; } }
        if (bi >= 0 && S.selVertex < 0) { if (confirm('Add a corner here?')) { surface.outline.splice(bi + 1, 0, [Math.round(w[0]), Math.round(w[1])]); save(); renderPane(); } }
        requestDraw();
        if (S.selOpening >= 0 && S.tab !== 'openings') { S.tab = 'openings'; $$('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === 'openings')); renderPane(); }
      }
    }
  }
  function segDist(p, a, b) { const dx = b[0] - a[0], dy = b[1] - a[1]; const l = dx * dx + dy * dy || 1; let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l; t = Math.max(0.1, Math.min(0.9, t)); return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy); }

  function finishTrace() {
    const { surface } = cur();
    if (!S.trace || S.trace.length < 3) { toast('Tap at least 3 corners'); return; }
    const n = Geo.normaliseOutline(S.trace);
    surface.outline = n.pts;
    surface.openings.forEach(o => { o.x = Math.round(+o.x + n.dx); o.y = Math.round(+o.y + n.dy); });
    if (surface.bg) { surface.bg.x += n.dx; surface.bg.y += n.dy; }
    surface.pattern.ox = 0; surface.pattern.oy = 0;
    S.trace = null; save(); toast('Shape traced — check the wall lengths on the Shape tab'); S.view = null; setModeButtons(); renderPane(); requestDraw();
  }

  // ---------- panes ----------
  const num = (path, label, val, extra = '') => `<label class="f">${label}<input type="number" inputmode="decimal" step="any" data-b="${path}" value="${esc(val)}" ${extra}></label>`;
  const txt = (path, label, val) => `<label class="f">${label}<input data-b="${path}" value="${esc(val)}"></label>`;
  function setPath(obj, path, v) { const k = path.split('.'); let o = obj; for (let i = 0; i < k.length - 1; i++) o = o[k[i]]; o[k[k.length - 1]] = v; }

  function renderPane() {
    const pane = $('#pane'); if (!pane) return; const { surface } = cur(); if (!surface) return;
    const fn = { shape: paneShape, openings: paneOpenings, tile: paneTile, setout: paneSetout, cuts: paneCuts, order: paneOrder, drawing: paneDrawing }[S.tab];
    const sc = pane.scrollTop; pane.innerHTML = fn(surface); pane.scrollTop = sc;
    pane.oninput = e => onBind(e, surface, false); pane.onchange = e => onBind(e, surface, true);
    pane.onclick = e => paneClick(e, surface);
  }
  function onBind(e, surface, isChange) {
    const t = e.target;
    if (t.dataset.b) {
      let v = t.type === 'checkbox' ? t.checked : t.type === 'number' || t.type === 'range' ? (t.value === '' ? '' : +t.value) : t.value;
      setPath(surface, t.dataset.b, v);
      if (t.dataset.b === 'name') $('.top h1').textContent = `${findSurface(surface.id).room.name} — ${surface.name}`;
      if (/^pattern\.(type|ox|oy|rotation)/.test(t.dataset.b) && t.dataset.b !== 'pattern.type') surface.startLabel = 'Custom';
      save(); S.best = null; requestDraw();
      if (isChange && t.dataset.rerender !== undefined) renderPane();
      else if (isChange && ['tile', 'setout', 'order', 'cuts'].includes(S.tab) && t.tagName === 'SELECT') renderPane();
      return;
    }
    if (t.dataset.v != null) { // vertex table
      const i = +t.dataset.v, k = +t.dataset.k; if (t.value === '') return; surface.outline[i][k] = +t.value; save(); requestDraw(); return;
    }
    if (t.dataset.o != null) { // openings
      const o = surface.openings[+t.dataset.o]; const k = t.dataset.ok; o[k] = t.type === 'number' ? (t.value === '' ? 0 : +t.value) : t.value;
      if (k === 'type' && isChange) { o.name = OP_TYPES[o.type]; renderPane(); }
      save(); requestDraw(); return;
    }
    if (t.dataset.t) { const tile = tileOf(surface); tile[t.dataset.t] = t.type === 'number' && t.value !== '' ? +t.value : t.value; S.cache.clear(); save(); requestDraw(); return; }
    if (t.id === 'tileSel' && isChange) { surface.tileId = t.value; save(); renderPane(); requestDraw(); }
    if (t.id === 'idsChk') { S.showIds = t.checked; requestDraw(); }
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
        <div class="muted" style="margin-top:6px">${s.kind === 'wall' ? 'Walls are drawn as if you are facing them: 0,0 is bottom-left at floor level.' : 'Floors are drawn in plan from the bottom-left corner.'} Size ${Math.round(bb.w)} × ${Math.round(bb.h)} mm.</div></div>
      <div class="card"><h2>Quick shapes</h2>
        <div class="grid"><label class="f">Width mm<input id="qrW" type="number" inputmode="decimal" value="${Math.round(bb.w)}"></label><label class="f">${s.kind === 'wall' ? 'Height' : 'Depth'} mm<input id="qrH" type="number" inputmode="decimal" value="${Math.round(bb.h)}"></label></div>
        <div class="row" style="margin-top:8px"><button class="btn sm" data-p="rect">Rectangle</button></div>
        <div class="grid" style="margin-top:10px"><label class="f">Cut-out width mm<input id="qlW" type="number" inputmode="decimal" value="${Math.round(bb.w / 3)}"></label><label class="f">Cut-out ${s.kind === 'wall' ? 'height' : 'depth'} mm<input id="qlH" type="number" inputmode="decimal" value="${Math.round(bb.h / 3)}"></label>
          <label class="f">Cut-out corner<select id="qlC"><option value="tr">Top right</option><option value="tl">Top left</option><option value="br">Bottom right</option><option value="bl">Bottom left</option></select></label></div>
        <div class="row" style="margin-top:8px"><button class="btn sm sec" data-p="L">L-shape</button>${s.kind === 'wall' ? '<button class="btn sm sec" data-p="slope">Sloped ceiling</button>' : ''}</div></div>
      <div class="card"><h2>Wall by wall</h2>
        <div class="muted" style="margin-bottom:8px">Start at the bottom-left corner going right. Enter each wall length and which way you turn at the end. Going round anticlockwise, outside corners are left turns and inside corners are right turns. The last wall closes the shape.</div>
        ${walls.map((w, i) => `<div class="vtx" style="grid-template-columns:24px 1fr 1.3fr"><span class="muted">${i + 1}</span><input type="number" inputmode="decimal" data-wl="${i}" value="${w.len}">${i < walls.length - 1 ? turnSel(i, w.turn) : '<span class="muted">closes</span>'}</div>`).join('')}
        <div class="row"><button class="btn sm" data-p="walls">Apply walls</button><button class="btn sm sec" data-p="addwall">+ Wall</button><button class="btn sm sec" data-p="delwall">− Last wall</button></div><div id="wallMsg"></div></div>
      <div class="card"><h2>Corners (x, y mm)</h2>
        ${s.outline.map((p, i) => `<div class="vtx"><span class="muted">${i + 1}</span><input type="number" inputmode="decimal" data-v="${i}" data-k="0" value="${r1(p[0])}"><input type="number" inputmode="decimal" data-v="${i}" data-k="1" value="${r1(p[1])}"><button class="x" data-delv="${i}">×</button></div>`).join('')}
        <div class="row"><button class="btn sm sec" data-p="addv">+ Corner</button><button class="btn sm sec" data-p="norm">Tidy (move to 0,0)</button></div>
        <div class="note">Tip: use <b>✎ Edit shape</b> on the drawing to drag corners and openings, or tap near an edge to add a corner.</div></div>`;
  }
  function paneOpenings(s) {
    const b = Geo.bbox(s.outline);
    return `<div class="card"><h2>Add opening</h2><div class="row">${Object.entries(OP_TYPES).map(([k, l]) => `<button class="btn sm sec" data-addop="${k}">+ ${l}</button>`).join('')}</div>
      <div class="note">Openings are areas not tiled: x, y is the bottom-left corner${s.kind === 'wall' ? ' (y from floor level)' : ''}. Area is ${Math.round(b.w)} × ${Math.round(b.h)} mm. Drag them on the drawing in ✎ Edit shape mode.</div></div>
      <div class="ops">${s.openings.map((o, i) => `<div class="op ${S.selOpening === i ? 'sel' : ''}"><div class="grid" style="grid-template-columns:1fr 1fr">
        <label class="f">Type<select data-o="${i}" data-ok="type">${Object.entries(OP_TYPES).map(([k, l]) => `<option value="${k}" ${o.type === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label class="f">Name<input data-o="${i}" data-ok="name" value="${esc(o.name)}"></label>
        <label class="f">x (from left)<input type="number" inputmode="decimal" data-o="${i}" data-ok="x" value="${o.x}"></label><label class="f">y (from ${s.kind === 'wall' ? 'floor' : 'bottom'})<input type="number" inputmode="decimal" data-o="${i}" data-ok="y" value="${o.y}"></label>
        <label class="f">Width<input type="number" inputmode="decimal" data-o="${i}" data-ok="w" value="${o.w}"></label><label class="f">Height<input type="number" inputmode="decimal" data-o="${i}" data-ok="h" value="${o.h}"></label></div>
        <div class="row" style="margin-top:6px"><button class="btn sm sec" data-opc="${i}">Centre across</button><button class="btn sm danger" data-opdel="${i}">Remove</button></div></div>`).join('') || '<div class="muted">No openings.</div>'}</div>`;
  }
  function paneTile(s) {
    const t = tileOf(s); const p = s.pattern; const unit = Geo.buildUnit(t, p);
    let extra = '';
    if (p.type === 'customOffset') extra = num('pattern.offsetPct', 'Offset % of tile', p.offsetPct);
    if (p.type === 'chevron') extra = num('pattern.chevronAngle', 'Chevron angle °', p.chevronAngle);
    if (p.type === 'modular') extra = num('pattern.moduleSize', 'Smallest tile size (module) mm', p.moduleSize) + `<div class="note" style="grid-column:1/-1">Sizes used (joint allowed for): ${unit.sizes.map(z => z.label).join(', ')}. One of each per repeat. Set m² per box on the tile for pack quantities.</div>`;
    if (p.type === 'basketweave') extra = `<div class="note" style="grid-column:1/-1">${Math.max(1, Math.round((Math.max(t.w, t.h) + +p.joint) / (Math.min(t.w, t.h) + +p.joint)))} tiles per block. Works best when the length is a multiple of the width plus joints.</div>`;
    if (p.type === 'windmill') extra = `<div class="note" style="grid-column:1/-1">Insert square: ${unit.sizes[1] ? unit.sizes[1].label : 'none (tiles too square)'}.</div>`;
    if (['herringbone', 'herringbone45', 'doubleHerringbone', 'chevron', 'basketweave', 'windmill'].includes(p.type)) extra += `<div class="note" style="grid-column:1/-1">This pattern uses the long side × short side of the tile.</div>`;
    return `<div class="card"><h2>Tile</h2>
        <div class="row"><label class="f" style="flex:1">Tile on this area<select id="tileSel">${S.job.tiles.map(x => `<option value="${x.id}" ${x.id === t.id ? 'selected' : ''}>${esc(x.name)} (${x.w}×${x.h})</option>`).join('')}</select></label><button class="btn sm sec" data-p="newtile" style="align-self:flex-end">+ New</button></div>
        <div style="margin-top:8px">${tileFields(t)}</div><div class="note">Tile changes apply to every area using this tile.</div></div>
      <div class="card"><h2>Pattern</h2><div class="grid">
        <label class="f" style="grid-column:1/-1">Laying pattern<select data-b="pattern.type" data-rerender>${Object.entries(Geo.PATTERNS).map(([k, v]) => `<option value="${k}" ${p.type === k ? 'selected' : ''}>${v.name}</option>`).join('')}</select></label>
        ${num('pattern.joint', 'Joint width mm', p.joint)}${num('pattern.rotation', 'Rotate layout °', p.rotation)}${extra}</div>
        <div class="row" style="margin-top:8px"><span class="muted">Rotate:</span>${[0, 45, 90, -45].map(a => `<button class="btn sm sec" data-rot="${a}">${a}°</button>`).join('')}</div></div>`;
  }
  function paneSetout(s) {
    const t = tileOf(s); const c = calc(s); const st = c.res?.stats;
    const cand = Geo.startCandidates(s, t);
    const gs = geoSettings(s);
    const best = S.best ? S.best.map((b, i) => `<div class="opt" data-best="${i}"><div class="rk">${i + 1}</div><div class="main"><b>${esc(b.label)}</b>${b.stats.needed} tiles · smallest cut ${b.stats.minCut != null ? Math.round(b.stats.minCut) + ' mm' : 'none'} · ${b.stats.cuts} cuts${b.stats.slivers ? ` · <span style="color:var(--red)">${b.stats.slivers} slivers</span>` : ''}</div></div>`).join('') : '';
    return `<div class="card"><h2>Find the best start</h2>
        <div class="muted">Tries every standard start (centred, corners, edges, openings${s.settings.battenY !== '' ? ', batten' : ''}) and ranks them: no slivers first, then the biggest smallest cut, then fewest tiles.</div>
        <div class="row" style="margin-top:8px"><button class="btn" data-p="best">Find best start</button></div><div id="bestList" style="margin-top:8px">${best}</div></div>
      <div class="card"><h2>Snap to a start</h2><div class="grid" style="grid-template-columns:1fr">
        <label class="f">Across (left ↔ right)<select id="sx">${cand.xs.map((x, i) => `<option value="${i}">${esc(x.label)}</option>`).join('')}</select></label>
        <label class="f">Up / down<select id="sy">${cand.ys.map((y, i) => `<option value="${i}">${esc(y.label)}</option>`).join('')}</select></label></div>
        <div class="row" style="margin-top:8px"><button class="btn sm" data-p="snap">Apply</button></div>
        ${s.kind === 'wall' ? `<div class="grid" style="margin-top:10px">${num('settings.battenY', 'Batten height mm (blank = none)', s.settings.battenY, 'placeholder="none"')}</div>` : ''}</div>
      <div class="card"><h2>Fine adjust</h2>
        <div class="row" style="align-items:flex-start;gap:14px">
          <div class="nudge"><span></span><button data-n="0,1">↑</button><span></span><button data-n="-1,0">←</button><button data-n="c">⊙</button><button data-n="1,0">→</button><span></span><button data-n="0,-1">↓</button><span></span></div>
          <div style="flex:1;min-width:140px"><label class="f">Step<select id="nudgeStep">${[1, 5, 10, 25, 50, 100].map(v => `<option ${S.nudge === v ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
            <div class="grid" style="grid-template-columns:1fr 1fr;margin-top:6px">${num('pattern.ox', 'Start x', Math.round(s.pattern.ox))}${num('pattern.oy', 'Start y', Math.round(s.pattern.oy))}</div></div></div>
        <div class="note">Or use <b>✥ Move tiles</b> and drag on the drawing. ⊙ puts a tile corner on the area centre. The bronze cross is the start point.</div></div>
      <div class="card"><h2>Rules for this area</h2><div class="grid">
        ${num('settings.sliver', 'Sliver warning under mm', s.settings.sliver, `placeholder="default ${S.settings.sliver}"`)}${num('settings.spare', 'Spare / breakage %', s.settings.spare, `placeholder="auto ${Geo.PATTERNS[s.pattern.type]?.waste}%"`)}</div>
        <label class="chk"><input type="checkbox" data-b="settings.reuseOffcuts" ${s.settings.reuseOffcuts !== false ? 'checked' : ''}> Reuse offcuts where they fit (estimate)</label>
        ${st ? `<div class="muted">Now: ${st.needed} tiles, ${st.cuts} cuts, smallest ${st.minCut != null ? Math.round(st.minCut) + ' mm' : '-'}${st.slivers ? `, <b style="color:var(--red)">${st.slivers} under ${gs.sliver} mm</b>` : ''}.</div>` : ''}</div>`;
  }
  function paneCuts(s) {
    const c = calc(s); if (!c.res) return '<div class="empty">Set up the shape first.</div>';
    const st = c.res.stats; const sizes = c.res.unit.sizes;
    return `<div class="card"><h2>Summary</h2><table class="t"><tr><th>Tile</th><th class="n">Full</th><th class="n">Cut</th><th class="n">From offcut</th><th class="n">Tiles</th></tr>
        ${st.per.map(p => `<tr><td>${esc(p.label)}</td><td class="n">${p.full}</td><td class="n">${p.cut + p.notch}</td><td class="n">${p.fromOffcut}</td><td class="n"><b>${p.needed}</b></td></tr>`).join('')}</table>
        <label class="chk" style="margin-top:6px"><input type="checkbox" id="idsChk" ${S.showIds ? 'checked' : ''}> Show piece numbers on drawing</label></div>
      <div class="card"><h2>Cut list (mm)</h2>${c.cuts.length ? `<table class="t"><tr>${sizes.length > 1 ? '<th>Tile</th>' : ''}<th>Piece</th><th class="n">Qty</th><th>Pieces</th></tr>
        ${c.cuts.map(g => `<tr class="${g.sliver ? 'flag' : ''}">${sizes.length > 1 ? `<td>${esc(sizes[g.sizeIdx].label)}</td>` : ''}<td>${esc(g.desc)}${g.sliver ? ' ⚠' : ''}${g.offcut ? `<div class="muted">${g.offcut} from offcut</div>` : ''}</td><td class="n">${g.count}</td><td class="muted">${g.ids.length <= 10 ? g.ids.map(i => '#' + i).join(' ') : g.ids.length + ' pieces'}</td></tr>`).join('')}</table>` : '<div class="muted">No cuts — every tile is full.</div>'}
        <div class="note">Sizes are the finished piece, measured along the tile's length × width. Notch = size of the corner taken out. Offcut reuse is an estimate: check the cut edge goes where you want it.</div></div>`;
  }
  function paneOrder(s) {
    const c = calc(s); if (!c.res) return '<div class="empty">Set up the shape first.</div>';
    const rows = PDFX.matRows(c.mat);
    return `<div class="card"><h2>Order list — this area</h2><table class="t"><tr><th>Item</th><th>Quantity</th><th class="n">Order</th></tr>${rows.map(r => `<tr><td>${esc(r[0])}</td><td>${esc(r[1])}</td><td class="n"><b>${esc(r[2])}</b></td></tr>`).join('')}</table></div>
      <div class="card"><h2>Options</h2>
        <label class="chk"><input type="checkbox" data-b="settings.primer" ${s.settings.primer !== false ? 'checked' : ''}> Prime this area</label>
        <label class="chk"><input type="checkbox" data-b="settings.trimPerimeter" ${s.settings.trimPerimeter ? 'checked' : ''}> Trim round the outside edge</label>
        <label class="chk"><input type="checkbox" data-b="settings.trimOpenings" ${s.settings.trimOpenings ? 'checked' : ''}> Trim round openings (doors: sides and top)</label>
        <div class="grid">${num('settings.trimExtra', 'Extra trim (m)', s.settings.trimExtra)}</div>
        <div class="note">Product names, coverage and bag sizes are in Settings. A tile can have its own adhesive coverage.</div></div>`;
  }
  function paneDrawing(s) {
    const online = navigator.onLine, key = !!S.settings.apiKey;
    if (!s.bg) return `<div class="card"><h2>Import a drawing</h2><div class="muted">Photo, image or PDF of a plan or elevation. It sits behind the set-out so you can scale it and trace over it, all offline.</div>
        <div class="grid" style="margin-top:8px"><label class="f">PDF page<input id="bgPage" type="number" inputmode="numeric" value="${S.bgPage}"></label></div>
        <div class="row" style="margin-top:8px"><button class="btn" data-p="bgimport">Choose drawing</button></div></div>${aiCard(s, online, key)}`;
    return `<div class="card"><h2>Drawing</h2>
        <label class="f">Drawing visibility<input type="range" id="bgOpacity" min="0.1" max="1" step="0.05" value="${s.bg.opacity ?? 0.5}"></label>
        ${!s.bg.scaled ? '<div class="warn">Not scaled yet. Set the scale before tracing.</div>' : ''}
        <div class="row" style="margin-top:8px"><button class="btn sm" data-p="calib">1. Set scale</button><button class="btn sm" data-p="trace">2. Trace outline</button></div>
        <div class="row" style="margin-top:8px"><label class="f" style="flex:1">3. Trace an opening<select id="opType">${Object.entries(OP_TYPES).map(([k, l]) => `<option value="${k}" ${S.opType === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label><button class="btn sm" data-p="optrace" style="align-self:flex-end">Trace</button></div>
        <div class="row" style="margin-top:8px"><button class="btn sm sec" data-p="bgmove">${S.mode === 'bg' ? 'Done moving' : 'Move drawing'}</button><button class="btn sm sec" data-p="bgimport">Replace</button><button class="btn sm danger" data-p="bgdel">Remove drawing</button></div>
        <div class="note">Scale: tap both ends of a dimension you know (e.g. a 2400 wall) and type its length. Trace: tap each corner; tick Square to keep walls straight. You can type exact lengths on the Shape tab afterwards.</div></div>${aiCard(s, online, key)}`;
  }
  function aiCard(s, online, key) {
    return `<div class="card"><h2>Read the drawing automatically</h2>
      ${online && key ? `<label class="f">Anything to tell it? (optional)<input id="aiExtra" placeholder="e.g. only the en-suite, walls are 2400 high"></label><div class="row" style="margin-top:8px"><button class="btn" data-p="ai" ${s.bg ? '' : 'disabled'}>${S.aiBusy ? 'Reading…' : 'Read this drawing'}</button></div>`
        : `<div class="note">${!online ? 'No signal: automatic reading is switched off. Tracing still works.' : 'Add an API key in Settings to read drawings in the app.'}</div>`}
      <div class="row" style="margin-top:8px"><button class="btn sm sec" data-p="paste">Paste room data</button><button class="btn sm sec" data-p="prompt">Copy prompt for Claude</button></div></div>`;
  }

  async function paneClick(e, s) {
    const t = e.target;
    const bi = t.closest('[data-best]'); if (bi) { const b = S.best[+bi.dataset.best]; s.pattern.ox = Math.round(b.ox * 10) / 10; s.pattern.oy = Math.round(b.oy * 10) / 10; s.startLabel = b.label; save(); requestDraw(); renderPane(); toast('Start applied'); return; }
    if (t.closest('[data-rot]')) { s.pattern.rotation = +t.closest('[data-rot]').dataset.rot; s.startLabel = 'Custom'; save(); renderPane(); requestDraw(); return; }
    const n = t.closest('[data-n]')?.dataset.n;
    if (n) { if (n === 'c') { const b = Geo.bbox(s.outline); s.pattern.ox = Math.round((b.x0 + b.x1) / 2); s.pattern.oy = Math.round((b.y0 + b.y1) / 2); } else { const [dx, dy] = n.split(',').map(Number); s.pattern.ox = Math.round(+s.pattern.ox + dx * S.nudge); s.pattern.oy = Math.round(+s.pattern.oy + dy * S.nudge); } s.startLabel = 'Custom'; save(); requestDraw(); renderPane(); return; }
    if (t.closest('[data-delv]')) { if (s.outline.length <= 3) return toast('Need at least 3 corners'); s.outline.splice(+t.closest('[data-delv]').dataset.delv, 1); save(); renderPane(); requestDraw(); return; }
    if (t.closest('[data-addop]')) {
      const type = t.closest('[data-addop]').dataset.addop; const b = Geo.bbox(s.outline);
      const def = { door: [838, 1981], window: [900, 1000], niche: [300, 600], bath: [1700, 560], tray: [900, 900], other: [500, 500] }[type];
      let [w, h] = def; if (s.kind === 'floor' && type === 'bath') h = 700; if (s.kind === 'floor' && type === 'door') h = 100;
      const y = s.kind === 'wall' ? ({ window: 1000, niche: 1200 }[type] || 0) : 0;
      s.openings.push({ id: Store.uid(), type, name: OP_TYPES[type], x: Math.round(b.x0 + (b.w - w) / 2), y: Math.round(b.y0 + y), w, h });
      S.selOpening = s.openings.length - 1; save(); renderPane(); requestDraw(); return;
    }
    if (t.closest('[data-opdel]')) { s.openings.splice(+t.closest('[data-opdel]').dataset.opdel, 1); S.selOpening = -1; save(); renderPane(); requestDraw(); return; }
    if (t.closest('[data-opc]')) { const o = s.openings[+t.closest('[data-opc]').dataset.opc]; const b = Geo.bbox(s.outline); o.x = Math.round(b.x0 + (b.w - o.w) / 2); save(); renderPane(); requestDraw(); return; }
    const p = t.closest('[data-p]')?.dataset.p; if (!p) return;
    const b = Geo.bbox(s.outline);
    if (p === 'rect') { const W = +$('#qrW').value, H = +$('#qrH').value; if (!(W > 0 && H > 0)) return; s.outline = [[0, 0], [W, 0], [W, H], [0, H]]; }
    if (p === 'L') {
      const W = +$('#qrW').value, H = +$('#qrH').value, cw = +$('#qlW').value, ch = +$('#qlH').value, c = $('#qlC').value;
      if (!(cw > 0 && ch > 0 && cw < W && ch < H)) return toast('Cut-out must be smaller than the shape');
      const pts = { tr: [[0, 0], [W, 0], [W, H - ch], [W - cw, H - ch], [W - cw, H], [0, H]], tl: [[0, 0], [W, 0], [W, H], [cw, H], [cw, H - ch], [0, H - ch]], br: [[0, 0], [W - cw, 0], [W - cw, ch], [W, ch], [W, H], [0, H]], bl: [[cw, 0], [W, 0], [W, H], [0, H], [0, ch], [cw, ch]] }[c];
      s.outline = pts;
    }
    if (p === 'slope') { const W = +$('#qrW').value, H = +$('#qrH').value, low = +prompt('Height at the low side of the slope (mm)?', Math.round(H * 0.5)); const at = +prompt('Distance from the left where the slope starts (mm)?', Math.round(W * 0.5)); if (!(low > 0) || !(at >= 0)) return; s.outline = [[0, 0], [W, 0], [W, low], [at, H], [0, H]]; }
    if (p === 'walls' || p === 'addwall' || p === 'delwall') {
      const walls = $$('[data-wl]').map((el, i) => { const sel = $(`[data-wt="${i}"]`); let turn = sel ? sel.value : 0; if (turn === 'custom') turn = +prompt(`Turn angle after wall ${i + 1} (left is +, right is −)`, '90') || 0; return { len: +el.value, turn: +turn }; });
      if (p === 'addwall') { walls.splice(walls.length - 1, 0, { len: 1000, turn: 90 }); walls[walls.length - 2].turn = 90; }
      if (p === 'delwall') { if (walls.length <= 3) return toast('Need at least 3 walls'); walls.splice(walls.length - 2, 1); }
      const out = Geo.wallsToOutline(walls);
      s.outline = Geo.normaliseOutline(out.pts).pts;
      save(); renderPane(); requestDraw(); S.view = null;
      const gap = Math.round(out.gap);
      const msg = $('#wallMsg'); if (msg) msg.innerHTML = `<div class="${Math.abs(gap - walls[walls.length - 1].len) > 5 ? 'warn' : 'note'}">Closing wall measures ${gap} mm${Math.abs(gap - walls[walls.length - 1].len) > 5 ? ` but you entered ${walls[walls.length - 1].len} mm — check your lengths and turns.` : ' ✓'}</div>`;
      return;
    }
    if (p === 'addv') { const last = s.outline[s.outline.length - 1], first = s.outline[0]; s.outline.push([Math.round((last[0] + first[0]) / 2), Math.round((last[1] + first[1]) / 2)]); }
    if (p === 'norm') { const n = Geo.normaliseOutline(s.outline); s.outline = n.pts; s.openings.forEach(o => { o.x += n.dx; o.y += n.dy; }); if (s.bg) { s.bg.x += n.dx; s.bg.y += n.dy; } s.pattern.ox += n.dx; s.pattern.oy += n.dy; }
    if (p === 'newtile') { const t2 = Store.newTile({ name: 'New tile' }); S.job.tiles.push(t2); s.tileId = t2.id; save(); renderPane(); requestDraw(); return; }
    if (p === 'best') {
      $('#bestList').innerHTML = '<div class="muted">Working…</div>';
      await new Promise(r => setTimeout(r, 30));
      const t0 = performance.now();
      S.best = Geo.findBestStarts(s, tileOf(s), geoSettings(s), 6);
      if (S.best.length) { const b0 = S.best[0]; s.pattern.ox = Math.round(b0.ox * 10) / 10; s.pattern.oy = Math.round(b0.oy * 10) / 10; s.startLabel = b0.label; save(); }
      renderPane(); requestDraw(); toast('Best start applied — tap another option to compare'); return;
    }
    if (p === 'snap') { const cand = Geo.startCandidates(s, tileOf(s)); const X = cand.xs[+$('#sx').value], Y = cand.ys[+$('#sy').value]; const o = Geo.toAreaOrigin(X.v, Y.v, cand.a); s.pattern.ox = Math.round(o[0] * 10) / 10; s.pattern.oy = Math.round(o[1] * 10) / 10; s.startLabel = `${X.label} · ${Y.label}`; save(); requestDraw(); toast('Start applied'); return; }
    if (p === 'bgimport') {
      const f = await pickFile('image/*,application/pdf'); if (!f) return;
      toast('Loading drawing…');
      try {
        const im = await fileToImage(f, S.bgPage);
        const mmPerPx = Math.max(b.w, 4000) * 1.15 / im.w;
        s.bg = { dataUrl: im.dataUrl, mmPerPx, x: b.x0 - b.w * 0.05, y: b.y0 + im.h * mmPerPx - b.h * 0.05 - (im.h * mmPerPx - b.h) / 2, opacity: 0.55, scaled: false };
        S.bgImgs.clear(); save(); S.view = null; renderPane(); requestDraw();
        if (im.pages > 1) toast(`PDF has ${im.pages} pages — showing page ${Math.min(S.bgPage, im.pages)}`);
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
      try { const data = await AI.readWithApi(s.bg.dataUrl, S.settings, $('#aiExtra')?.value || ''); previewImport(data, s); }
      catch (err) { toast(err.message, 5000); }
      S.aiBusy = false; renderPane(); return;
    }
    save(); renderPane(); requestDraw();
  }
  function fitBg(s) { const img = bgImgFor(s); if (!img || !cv) return; const bg = s.bg; const d = window.devicePixelRatio || 1; S.view = Render.makeView(Geo.bbox([[bg.x, bg.y], [bg.x + img.width * bg.mmPerPx, bg.y - img.height * bg.mmPerPx]]), cv.width / d, cv.height / d, 20); }

  async function exportImage() {
    const { room, surface } = cur(); const c = calc(surface); if (!c.res) return;
    const bb = c.res.region.bb; const W = 2000; const H = Math.round(Math.min(2600, Math.max(900, W * bb.h / bb.w + 200)));
    const draw = Render.renderToCanvas(surface, c.tile, c.res, W, H - 150, { pad: 90, dimFont: 26, labelScale: 2.2, ids: S.showIds });
    const out = document.createElement('canvas'); out.width = W; out.height = H; const x = out.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, W, H); x.fillStyle = '#4A4B4D'; x.fillRect(0, 0, W, 110); x.fillStyle = '#CE8B3E'; x.fillRect(0, 110, W, 6);
    x.font = 'bold 44px system-ui'; x.fillStyle = '#fff'; x.fillText('NAOS', 40, 70); x.fillStyle = '#CE8B3E'; x.font = '44px system-ui'; x.fillText('FLOORS', 170, 70);
    x.fillStyle = '#fff'; x.font = '30px system-ui'; x.textAlign = 'right'; x.fillText(`${S.job.name} · ${room.name} — ${surface.name}`, W - 40, 50);
    const st = c.res.stats; x.font = '24px system-ui'; x.fillText(`${c.tile.name} ${c.tile.w}×${c.tile.h} · ${Geo.PATTERNS[surface.pattern.type].name} · ${surface.pattern.joint} mm joint · ${st.needed} tiles · smallest cut ${st.minCut != null ? Math.round(st.minCut) : '-'} mm`, W - 40, 90);
    x.drawImage(draw, 0, 130);
    out.toBlob(b => shareOrDownload(b, `${safeName(S.job.name)}-${safeName(room.name)}-${safeName(surface.name)}.png`), 'image/png');
  }

  window.__tso = S; // for testing
  route();
})();
