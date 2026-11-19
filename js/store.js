/* Storage: IndexedDB for jobs (they can hold drawing images), localStorage for settings */
(function () {
  'use strict';
  const DB = 'naos-tile-setout', VER = 1;
  let dbp = null;
  function db() {
    if (!dbp) dbp = new Promise((res, rej) => {
      const r = indexedDB.open(DB, VER);
      r.onupgradeneeded = () => { const d = r.result; if (!d.objectStoreNames.contains('jobs')) d.createObjectStore('jobs', { keyPath: 'id' }); };
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  async function tx(mode, fn) {
    const d = await db();
    return new Promise((res, rej) => {
      const t = d.transaction('jobs', mode); const s = t.objectStore('jobs');
      const out = fn(s);
      t.oncomplete = () => res(out && out.result !== undefined ? out.result : out);
      t.onerror = () => rej(t.error);
    });
  }
  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

  const DEFAULT_MAT = {
    adhName: 'Ardex X7R', adhCoverage: 2.2, adhBagKg: 20, adhExtra: 0,
    groutName: 'Ardex grout', groutDensity: 1.6, groutBagKg: 5, groutExtra: 10,
    primerName: 'Ardex primer', primerLPerM2: 0.15, primerUnitL: 5,
    trimLengthM: 2.5, spacersPerTile: 3, spacerPack: 100,
  };
  const DEFAULT_SETTINGS = { sliver: 50, kerf: 3, minOffcut: 30, reuseOffcuts: true, apiKey: '', model: 'claude-sonnet-5-5', mat: DEFAULT_MAT };

  function getSettings() {
    try { const s = JSON.parse(localStorage.getItem('tso-settings') || '{}'); return { ...DEFAULT_SETTINGS, ...s, mat: { ...DEFAULT_MAT, ...(s.mat || {}) } }; }
    catch (e) { return { ...DEFAULT_SETTINGS }; }
  }
  function saveSettings(s) { try { localStorage.setItem('tso-settings', JSON.stringify(s)); } catch (e) { } }

  function newTile(o = {}) { return { id: uid(), name: 'Porcelain 600×300', w: 600, h: 300, thick: 10, perBox: 8, m2PerBox: '', adhCoverage: '', ...o }; }
  function newSurface(kind = 'wall', o = {}) {
    const isWall = kind === 'wall';
    return {
      id: uid(), name: isWall ? 'Wall' : 'Floor', kind,
      outline: isWall ? [[0, 0], [2400, 0], [2400, 2400], [0, 2400]] : [[0, 0], [3000, 0], [3000, 2500], [0, 2500]],
      openings: [], doorways: [], place: { x: 0, y: 0 }, tileId: null,
      pattern: { type: isWall ? 'straight' : 'straight', joint: isWall ? 2 : 3, rotation: 0, ox: 0, oy: 0, offsetPct: 50, chevronAngle: 45, moduleSize: 200 },
      settings: { spare: '', sliver: '', battenY: '', reuseOffcuts: true, primer: true, trimPerimeter: false, trimOpenings: isWall, trimExtra: 0, border: { on: false, tileId: null, rows: 1 } },
      bg: null, ...o,
    };
  }
  function newGroup(name, mode, members, tileId, pattern) { return { id: uid(), name, mode, members, tileId, pattern: { ...pattern }, lockX: false, lockY: true, tileMode: 'linked' }; }
  /* bring older jobs up to date */
  function migrate(job) {
    job.groups = job.groups || []; job.images = job.images || {};
    job.groups.forEach(g => { if (g.lockY == null) g.lockY = true; if (g.lockX == null) g.lockX = false; if (!g.tileMode) g.tileMode = 'linked'; });
    job.rooms.forEach(r => r.surfaces.forEach(s => {
      s.doorways = s.doorways || []; s.place = s.place || { x: 0, y: 0 };
      s.settings = s.settings || {}; if (!s.settings.border) s.settings.border = { on: false, tileId: null, rows: 1 };
      if (s.bg && s.bg.dataUrl) { const id = uid(); job.images[id] = s.bg.dataUrl; delete s.bg.dataUrl; s.bg.img = id; }
    }));
    return job;
  }
  function newRoom(name = 'Room') { return { id: uid(), name, surfaces: [] }; }
  function newJob(name = 'New job') {
    return { id: uid(), name, client: '', address: '', notes: '', created: Date.now(), updated: Date.now(), tiles: [], rooms: [], groups: [], images: {} };
  }

  const Store = {
    uid, newJob, newRoom, newSurface, newTile, newGroup, migrate, getSettings, saveSettings, DEFAULT_MAT,
    async list() { return tx('readonly', s => s.getAll()).then(r => (r || []).sort((a, b) => b.updated - a.updated)); },
    async get(id) { const j = await tx('readonly', s => s.get(id)); return j ? migrate(j) : j; },
    async put(job) { job.updated = Date.now(); return tx('readwrite', s => s.put(JSON.parse(JSON.stringify(job)))); },
    async del(id) { return tx('readwrite', s => s.delete(id)); },
  };
  window.Store = Store;
})();
