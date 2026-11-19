/* Tile Set-out — geometry engine
   Units: millimetres. Area frame: x right, y up (walls: y = height from floor).
   Patterns are lattices: a unit of tiles repeated by vectors t1, t2, then rotated and offset. */
(function () {
  'use strict';
  const PC = window.polygonClipping;
  const EPS = 1e-6;

  // ---------- basic helpers ----------
  const rad = d => d * Math.PI / 180;
  function rot(p, a) { const c = Math.cos(a), s = Math.sin(a); return [p[0] * c - p[1] * s, p[0] * s + p[1] * c]; }
  function ringArea(r) { let a = 0; for (let i = 0, n = r.length; i < n; i++) { const p = r[i], q = r[(i + 1) % n]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; }
  function polyArea(poly) { // [outer, ...holes]
    let a = Math.abs(ringArea(poly[0])); for (let i = 1; i < poly.length; i++) a -= Math.abs(ringArea(poly[i])); return a;
  }
  function mpArea(mp) { return mp.reduce((s, p) => s + polyArea(p), 0); }
  function stripClose(r) { if (r.length > 1) { const a = r[0], b = r[r.length - 1]; if (Math.abs(a[0] - b[0]) < EPS && Math.abs(a[1] - b[1]) < EPS) return r.slice(0, -1); } return r; }
  function bbox(pts) { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const p of pts) { if (p[0] < x0) x0 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[0] > x1) x1 = p[0]; if (p[1] > y1) y1 = p[1]; } return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 }; }
  function perimeter(r) { let s = 0; for (let i = 0; i < r.length; i++) { const p = r[i], q = r[(i + 1) % r.length]; s += Math.hypot(q[0] - p[0], q[1] - p[1]); } return s; }
  function pointInRing(pt, r) {
    let inside = false; const x = pt[0], y = pt[1];
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const xi = r[i][0], yi = r[i][1], xj = r[j][0], yj = r[j][1];
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }
  function segX(a, b, c, d) { // proper or touching intersection
    const o = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
    const d1 = o(c, d, a), d2 = o(c, d, b), d3 = o(a, b, c), d4 = o(a, b, d);
    return ((d1 > 1e-9 && d2 < -1e-9) || (d1 < -1e-9 && d2 > 1e-9)) && ((d3 > 1e-9 && d4 < -1e-9) || (d3 < -1e-9 && d4 > 1e-9));
  }
  function bboxOverlap(a, b) { return a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0; }
  function rectPts(x, y, w, h) { return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]; }

  // ---------- patterns ----------
  const PATTERNS = {
    straight: { name: 'Straight lay (grid)', waste: 5 },
    brick: { name: 'Brick bond (½ offset)', waste: 5 },
    third: { name: '⅓ offset', waste: 5 },
    quarter: { name: '¼ offset', waste: 5 },
    customOffset: { name: 'Custom offset %', waste: 5 },
    stackVertical: { name: 'Vertical stack (portrait)', waste: 5 },
    brickVertical: { name: 'Vertical brick (½ offset)', waste: 5 },
    diagonal: { name: 'Diagonal (45° grid)', waste: 8 },
    herringbone: { name: 'Herringbone 90°', waste: 8 },
    herringbone45: { name: 'Herringbone 45°', waste: 10 },
    doubleHerringbone: { name: 'Double herringbone', waste: 8 },
    chevron: { name: 'Chevron', waste: 10 },
    basketweave: { name: 'Basketweave', waste: 5 },
    windmill: { name: 'Windmill / pinwheel (with insert)', waste: 6 },
    modular: { name: 'Modular 4-size (French / Versailles style)', waste: 8 },
  };

  /* Build the repeating unit. tile = {w (length), h (width)}; joint g.
     Returns { cells:[{pts, ang, sizeIdx, tw, th}], t1, t2, sizes:[{w,h,label}] } in pattern frame. */
  function buildUnit(tile, pat) {
    const g = +pat.joint || 0;
    const L = Math.max(+tile.w, +tile.h), W = Math.min(+tile.w, +tile.h); // long and short side
    const tw = +tile.w, th = +tile.h; // as entered (w = horizontal on straight lay)
    const cells = [];
    const sizes = [{ w: tw, h: th, label: `${tw}×${th}` }];
    const rect = (x, y, w, h, ang, sizeIdx = 0, ownW, ownH) => cells.push({ pts: rectPts(x, y, w, h), ang: ang || 0, sizeIdx, ownW: ownW ?? w, ownH: ownH ?? h });
    let t1, t2;
    const type = pat.type;
    if (type === 'straight' || type === 'diagonal') {
      rect(0, 0, tw, th); t1 = [tw + g, 0]; t2 = [0, th + g];
    } else if (type === 'brick' || type === 'third' || type === 'quarter' || type === 'customOffset') {
      const f = type === 'brick' ? 0.5 : type === 'third' ? 1 / 3 : type === 'quarter' ? 0.25 : (+pat.offsetPct || 50) / 100;
      rect(0, 0, tw, th); t1 = [tw + g, 0]; t2 = [f * (tw + g), th + g];
    } else if (type === 'stackVertical') {
      rect(0, 0, th, tw, 90, 0, tw, th); t1 = [th + g, 0]; t2 = [0, tw + g];
    } else if (type === 'brickVertical') {
      rect(0, 0, th, tw, 90, 0, tw, th); t1 = [0, tw + g]; t2 = [th + g, 0.5 * (tw + g)];
    } else if (type === 'herringbone' || type === 'herringbone45') {
      const a = L + g, b = W + g;
      rect(0, 0, L, W, 0, 0, L, W);
      rect(L + g, W - L, W, L, 90, 0, L, W);
      t1 = [b, b]; t2 = [a + b, b - a];
    } else if (type === 'doubleHerringbone') {
      // two tiles side by side act as one "fat" tile
      const W2 = 2 * W + g, a = L + g, b = W2 + g;
      rect(0, 0, L, W, 0, 0, L, W); rect(0, W + g, L, W, 0, 0, L, W);
      rect(L + g, W2 - L, W, L, 90, 0, L, W); rect(L + g + W + g, W2 - L, W, L, 90, 0, L, W);
      t1 = [b, b]; t2 = [a + b, b - a];
    } else if (type === 'basketweave') {
      const n = Math.max(1, Math.round((L + g) / (W + g)));
      const S = L; // block size
      for (let k = 0; k < n; k++) rect(0, k * (W + g), L, W, 0, 0, L, W);
      for (let k = 0; k < n; k++) rect(S + g + k * (W + g), 0, W, L, 90, 0, L, W);
      t1 = [S + g, S + g]; t2 = [S + g, -(S + g)];
    } else if (type === 'windmill') {
      // 4 rectangles L×W around a square insert of (L-W-g)
      const s = L - W - g; // insert size
      rect(0, 0, L, W, 0, 0, L, W);                 // bottom
      rect(L + g, 0, W, L, 90, 0, L, W);           // right
      rect(W + g, L + g, L, W, 0, 0, L, W);         // top
      rect(0, W + g, W, L, 90, 0, L, W);            // left
      if (s > 1) { sizes.push({ w: s, h: s, label: `${Math.round(s)}×${Math.round(s)} insert` }); cells.push({ pts: rectPts(W + g, W + g, s, s), ang: 0, sizeIdx: 1, ownW: s, ownH: s }); }
      t1 = [L + W + 2 * g, 0]; t2 = [0, L + W + 2 * g];
    } else if (type === 'chevron') {
      const th0 = rad(+pat.chevronAngle || 45);
      const cw = L * Math.cos(th0);           // horizontal extent of a tile
      const hgt = W / Math.cos(th0);          // vertical height of parallelogram
      const rise = cw * Math.tan(th0);
      const gv = g / Math.cos(th0);           // vertical grout step
      cells.push({ pts: [[0, 0], [cw, rise], [cw, rise + hgt], [0, hgt]], ang: th0 * 180 / Math.PI, sizeIdx: 0, ownW: L, ownH: W, angled: true });
      const x2 = cw + g;
      cells.push({ pts: [[x2, rise], [x2 + cw, 0], [x2 + cw, hgt], [x2, rise + hgt]], ang: -th0 * 180 / Math.PI, sizeIdx: 0, ownW: L, ownH: W, angled: true });
      t1 = [0, hgt + gv]; t2 = [2 * cw + 2 * g, 0];
    } else if (type === 'modular') {
      // module m = small square + joint. Pieces: 3×2, 2×2, 1×2, 1×1 modules (one of each per repeat, 13 modules).
      const S = +pat.moduleSize || W; const m = S + g;
      const sz = (k) => k * m - g;
      sizes.length = 0;
      sizes.push({ w: sz(3), h: sz(2), label: `${sz(3)}×${sz(2)}` }, { w: sz(2), h: sz(2), label: `${sz(2)}×${sz(2)}` }, { w: sz(2), h: sz(1), label: `${sz(2)}×${sz(1)}` }, { w: sz(1), h: sz(1), label: `${sz(1)}×${sz(1)}` });
      const P = (cx, cy, cwm, chm, idx, swap) => cells.push({ pts: rectPts(cx * m, cy * m, sz(cwm), sz(chm)), ang: swap ? 90 : 0, sizeIdx: idx, ownW: sizes[idx].w, ownH: sizes[idx].h });
      P(0, 0, 3, 2, 0); P(0, 2, 2, 2, 1); P(-1, 1, 1, 2, 2, true); P(0, -1, 1, 1, 3);
      t1 = [3 * m, 1 * m]; t2 = [1 * m, -4 * m];
    } else {
      rect(0, 0, tw, th); t1 = [tw + g, 0]; t2 = [0, th + g];
    }
    return { cells, t1, t2, sizes };
  }

  function patternRotation(pat) {
    let r = +pat.rotation || 0;
    if (pat.type === 'diagonal' || pat.type === 'herringbone45') r += 45;
    return r;
  }

  // ---------- region ----------
  function opRing(o) { return o.pts && o.pts.length > 2 ? o.pts.map(p => [+p[0], +p[1]]) : rectPts(+o.x, +o.y, +o.w, +o.h); }
  function surfaceRegion(surface) {
    const outline = stripClose(surface.outline || []);
    if (outline.length < 3) return null;
    let mp = [[outline.concat([outline[0]])]];
    const ops = (surface.openings || []).filter(o => o.w > 0 && o.h > 0 && !o.tiled);
    if (ops.length) {
      try { mp = PC.difference(mp, ...ops.map(o => { const r = opRing(o); return [[...r, r[0]]]; })); } catch (e) { console.warn(e); }
    }
    const units = (surface.openings || []).filter(o => o.w > 0 && o.h > 0 && o.tiled);
    return { mp, outline, ops, units, bb: bbox(outline), opBoxes: ops.map(o => { const b = bbox(opRing(o)); return { x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 }; }) };
  }

  // ---------- lay tiles ----------
  /* Returns array of raw tiles in area frame: {pts, cell} covering region bbox. */
  function layTiles(region, tile, pat, opts = {}) {
    const unit = buildUnit(tile, pat);
    const a = rad(patternRotation(pat));
    const ox = +pat.ox || 0, oy = +pat.oy || 0;
    const bb = region.bb;
    // area bbox corners into pattern frame (relative to origin)
    const corners = [[bb.x0, bb.y0], [bb.x1, bb.y0], [bb.x1, bb.y1], [bb.x0, bb.y1]].map(p => rot([p[0] - ox, p[1] - oy], -a));
    let R = 0; for (const c of unit.cells) for (const p of c.pts) R = Math.max(R, Math.hypot(p[0], p[1]));
    const [t1, t2] = [unit.t1, unit.t2];
    const det = t1[0] * t2[1] - t1[1] * t2[0];
    const inv = p => [(p[0] * t2[1] - p[1] * t2[0]) / det, (t1[0] * p[1] - t1[1] * p[0]) / det];
    const pb = bbox(corners);
    const ex = [[pb.x0 - R, pb.y0 - R], [pb.x1 + R, pb.y0 - R], [pb.x1 + R, pb.y1 + R], [pb.x0 - R, pb.y1 + R]].map(inv);
    const lb = bbox(ex);
    const i0 = Math.floor(lb.x0) - 1, i1 = Math.ceil(lb.x1) + 1, j0 = Math.floor(lb.y0) - 1, j1 = Math.ceil(lb.y1) + 1;
    const out = [];
    const ca = Math.cos(a), sa = Math.sin(a);
    const limit = opts.limit || 60000;
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const tx = i * t1[0] + j * t2[0], ty = i * t1[1] + j * t2[1];
      for (let k = 0; k < unit.cells.length; k++) {
        const c = unit.cells[k];
        const pts = c.pts.map(p => { const x = p[0] + tx, y = p[1] + ty; return [x * ca - y * sa + ox, x * sa + y * ca + oy]; });
        const b = bbox(pts);
        if (b.x1 <= bb.x0 || b.x0 >= bb.x1 || b.y1 <= bb.y0 || b.y0 >= bb.y1) continue;
        out.push({ pts, cell: c, bb: b });
        if (out.length > limit) return { tiles: out, unit, tooMany: true };
      }
    }
    return { tiles: out, unit, rotRad: a };
  }

  // ---------- analyse ----------
  function fullyInside(t, region) {
    const o = region.outline;
    for (const p of t.pts) if (!pointInRing(p, o)) return false;
    for (const b of region.opBoxes) if (bboxOverlap(t.bb, b)) return false;
    const n = o.length, m = t.pts.length;
    for (let i = 0; i < n; i++) {
      const A = o[i], B = o[(i + 1) % n];
      if (Math.max(A[0], B[0]) < t.bb.x0 || Math.min(A[0], B[0]) > t.bb.x1 || Math.max(A[1], B[1]) < t.bb.y0 || Math.min(A[1], B[1]) > t.bb.y1) continue;
      for (let k = 0; k < m; k++) if (segX(A, B, t.pts[k], t.pts[(k + 1) % m])) return false;
      // outline vertex strictly inside tile
      if (A[0] > t.bb.x0 + 1e-6 && A[0] < t.bb.x1 - 1e-6 && A[1] > t.bb.y0 + 1e-6 && A[1] < t.bb.y1 - 1e-6 && pointInRing(A, t.pts)) return false;
    }
    return true;
  }

  function ownFrame(pts, totalAng) { const a = -rad(totalAng); return pts.map(p => rot(p, a)); }

  function analysePiece(poly, cell, totalAngDeg, settings, tb) {
    const outer = stripClose(poly[0]);
    const area = polyArea(poly.map(stripClose));
    const own = ownFrame(outer, totalAngDeg + (cell.ang || 0));
    const b = bbox(own);
    let w = b.w, h = b.h;
    const tileArea = cell.ownW * cell.ownH;
    const piece = { poly: poly.map(stripClose), area, w, h, kind: 'cut', sizeIdx: cell.sizeIdx, notch: null, tw: cell.ownW, th: cell.ownH };
    piece.cutSides = tb ? { L: b.x0 > tb.x0 + 0.5, R: b.x1 < tb.x1 - 0.5, B: b.y0 > tb.y0 + 0.5, T: b.y1 < tb.y1 - 0.5 } : { L: true, R: true, B: true, T: true };
    if (area >= tileArea * 0.997) { piece.kind = 'full'; piece.w = cell.ownW; piece.h = cell.ownH; piece.minDim = Math.min(cell.ownW, cell.ownH); return piece; }
    const bbArea = w * h;
    if (poly.length > 1) { piece.kind = 'notch'; piece.notch = { hole: true }; }
    else if (cell.angled) { piece.kind = Math.abs(bbArea - area) / bbArea < 0.01 ? 'cut' : 'angled'; if (piece.kind === 'angled') piece.sides = own.map((p, i) => { const q = own[(i + 1) % own.length]; return Math.round(Math.hypot(q[0] - p[0], q[1] - p[1])); }).filter(v => v >= 1); }
    else if (Math.abs(bbArea - area) / bbArea > 0.005) {
      // not a rectangle: notched or angled
      const diag = own.some((p, i) => { const q = own[(i + 1) % own.length]; const dx = Math.abs(q[0] - p[0]), dy = Math.abs(q[1] - p[1]); return dx > 0.5 && dy > 0.5; });
      piece.kind = diag ? 'angled' : 'notch';
      if (diag) piece.sides = own.map((p, i) => { const q = own[(i + 1) % own.length]; return Math.round(Math.hypot(q[0] - p[0], q[1] - p[1])); }).filter(v => v >= 1);
      if (!diag) {
        try {
          const missing = PC.difference([[...rectPts(b.x0, b.y0, b.w, b.h), [b.x0, b.y0]]], [[...own, own[0]]]);
          if (missing.length === 1) { const mb = bbox(stripClose(missing[0][0])); piece.notch = { w: mb.w, h: mb.h, count: 1 }; }
          else piece.notch = { count: missing.length };
        } catch (e) { piece.notch = { count: 1 }; }
      }
    }
    let minDim = Math.min(w, h);
    if (piece.notch && piece.notch.w) minDim = Math.min(minDim, Math.max(w - piece.notch.w, h - piece.notch.h) > 0 ? Math.min(...[w - piece.notch.w, h - piece.notch.h].filter(v => v > 0.5)) : minDim);
    piece.minDim = minDim;
    piece.sliver = minDim < (settings.sliver || 0);
    return piece;
  }

  function layPieces(region, tile, pat, settings, noFast) {
    const totalAng = patternRotation(pat);
    const laid = layTiles(region, tile, pat);
    const pieces = [];
    for (const t of laid.tiles) {
      if (!noFast && fullyInside(t, region)) {
        pieces.push({ poly: [t.pts], area: t.cell.ownW * t.cell.ownH, w: t.cell.ownW, h: t.cell.ownH, kind: 'full', sizeIdx: t.cell.sizeIdx, minDim: Math.min(t.cell.ownW, t.cell.ownH) });
        continue;
      }
      let res;
      try { res = PC.intersection([[...t.pts, t.pts[0]]], region.mp); } catch (e) { continue; }
      for (const poly of res) {
        const tb = bbox(ownFrame(t.pts, totalAng + (t.cell.ang || 0)));
        const p = analysePiece(poly, t.cell, totalAng, settings, tb);
        if (p.area < 25 || p.minDim < 1) continue; // ignore crumbs (<5×5mm)
        pieces.push(p);
      }
    }
    return { pieces, laid, totalAng };
  }

  // edge strips (inward) used for borders
  function edgeStrips(outline, d) {
    const sign = ringArea(outline) >= 0 ? 1 : -1;
    return outline.map((A, i) => {
      const B = outline[(i + 1) % outline.length];
      const len = Math.hypot(B[0] - A[0], B[1] - A[1]); if (len < 1) return null;
      const u = [(B[0] - A[0]) / len, (B[1] - A[1]) / len], n = [-u[1] * sign, u[0] * sign];
      const P = (x, y) => [A[0] + u[0] * x + n[0] * y, A[1] + u[1] * x + n[1] * y];
      const pts = [P(0, 0), P(len, 0), P(len, d), P(0, d)];
      return { A, u, n, len, pts, ang: Math.atan2(u[1], u[0]) * 180 / Math.PI, P };
    }).filter(Boolean);
  }

  function layout(surface, tile, settings = {}, extra = {}) {
    const region = surfaceRegion(surface);
    if (!region || !tile) return null;
    const pat = surface.pattern;
    const g = +pat.joint || 0;
    const unit = buildUnit(tile, pat);
    const sizes = unit.sizes.map(z => ({ ...z, tile }));
    let fieldRegion = region, borderPieces = [], borderArea = 0, borderInfo = null;
    const bset = surface.settings && surface.settings.border;
    const bt = extra.borderTile;
    if (bset && bset.on && bt) {
      const Lb = Math.max(+bt.w, +bt.h), Wb = Math.min(+bt.w, +bt.h), rows = Math.max(1, +bset.rows || 1);
      const d = rows * (Wb + g);
      const strips = edgeStrips(region.outline, d);
      try {
        const U = PC.union(...strips.map(st => [[...st.pts, st.pts[0]]]));
        const borderMP = PC.intersection(region.mp, U);
        const fieldMP = PC.difference(region.mp, U);
        fieldRegion = { ...region, mp: fieldMP };
        borderArea = mpArea(borderMP);
        const bIdx = sizes.length; sizes.push({ w: Lb, h: Wb, label: `Border ${Lb}×${Wb}`, tile: bt, border: true });
        const assigned = [];
        strips.forEach(st => {
          let S = PC.intersection(borderMP, [[...st.pts, st.pts[0]]]);
          if (assigned.length && S.length) S = PC.difference(S, ...assigned);
          assigned.push([[...st.pts, st.pts[0]]]);
          if (!S.length) return;
          const step = Lb + g; const c0 = st.len / 2 - Lb / 2;
          const k0 = Math.floor((-Lb - c0) / step) - 1, k1 = Math.ceil((st.len - c0) / step) + 1;
          for (let r = 0; r < rows; r++) for (let k = k0; k <= k1; k++) {
            const x = c0 + k * step, y = r * (Wb + g);
            const pts = [st.P(x, y), st.P(x + Lb, y), st.P(x + Lb, y + Wb), st.P(x, y + Wb)];
            let res; try { res = PC.intersection([[...pts, pts[0]]], S); } catch (e) { continue; }
            for (const poly of res) {
              const pc = analysePiece(poly, { ownW: Lb, ownH: Wb, ang: st.ang, sizeIdx: bIdx }, 0, settings, bbox(ownFrame(pts, st.ang)));
              if (pc.area < 25 || pc.minDim < 1) continue; pc.border = true; borderPieces.push(pc);
            }
          }
        });
        borderInfo = { width: d, rows, tile: bt };
      } catch (e) { console.warn('border', e); }
    }
    const lp = layPieces(fieldRegion, tile, pat, settings, fieldRegion !== region);
    const pieces = lp.pieces.concat(borderPieces);
    const net = mpArea(region.mp);
    const res = { region, pieces, unit, sizes, totalAng: lp.totalAng, tooMany: lp.laid.tooMany, netArea: net, fieldArea: net - borderArea, borderArea, borderInfo, rawTiles: lp.laid.tiles };
    res.stats = countTiles(res, settings);
    res.units = unitInfo(region, res, g);
    res.doorways = (surface.doorways || []).map(d => ({ ...d, pts: doorwayPts(surface, d) })).filter(d => d.pts);
    return res;
  }

  // kitchen units etc. that are tiled under: area under, and where joints fall against their edges
  function unitInfo(region, res, g) {
    return region.units.map(u => {
      const rect = [[...rectPts(+u.x, +u.y, +u.w, +u.h), [+u.x, +u.y]]];
      const ub = { x0: +u.x, y0: +u.y, x1: +u.x + +u.w, y1: +u.y + +u.h };
      let under = 0, count = 0;
      for (const p of res.pieces) {
        const b = bbox(p.poly[0]); if (!bboxOverlap(b, ub)) continue;
        try { const a = mpArea(PC.intersection([p.poly.map(r => [...r, r[0]])], rect)); under += a; const sz = res.sizes[p.sizeIdx]; if (a > 0.5 * sz.w * sz.h || (p.kind !== 'full' && a > 0.5 * p.area)) count++; } catch (e) { }
      }
      const edges = [
        { name: 'left', a: [ub.x0, ub.y0], b: [ub.x0, ub.y1], out: [-1, 0] }, { name: 'right', a: [ub.x1, ub.y0], b: [ub.x1, ub.y1], out: [1, 0] },
        { name: 'bottom', a: [ub.x0, ub.y0], b: [ub.x1, ub.y0], out: [0, -1] }, { name: 'top', a: [ub.x0, ub.y1], b: [ub.x1, ub.y1], out: [0, 1] }];
      const fronts = [];
      for (const e of edges) {
        const mid = [(e.a[0] + e.b[0]) / 2 + e.out[0] * 5, (e.a[1] + e.b[1]) / 2 + e.out[1] * 5];
        if (!pointInRing(mid, region.outline)) continue; // against a wall: not a visible front
        const vert = e.out[1] === 0; const line = vert ? e.a[0] : e.a[1];
        const lo = vert ? Math.min(e.a[1], e.b[1]) : Math.min(e.a[0], e.b[0]), hi = vert ? Math.max(e.a[1], e.b[1]) : Math.max(e.a[0], e.b[0]);
        let best = null;
        for (const t of res.rawTiles) {
          const pts = t.pts;
          for (let k = 0; k < pts.length; k++) {
            const P = pts[k], Q = pts[(k + 1) % pts.length];
            const parallel = vert ? Math.abs(P[0] - Q[0]) < 0.5 : Math.abs(P[1] - Q[1]) < 0.5; if (!parallel) continue;
            const s0 = vert ? Math.min(P[1], Q[1]) : Math.min(P[0], Q[0]), s1 = vert ? Math.max(P[1], Q[1]) : Math.max(P[0], Q[0]);
            if (s1 < lo || s0 > hi) continue;
            const c = vert ? P[0] : P[1]; const dist = (c - line) * (vert ? e.out[0] : e.out[1]);
            if (!best || Math.abs(dist) < Math.abs(best)) best = dist;
          }
        }
        if (best == null) { fronts.push({ edge: e.name, note: 'joints run at an angle with this pattern — check the cuts along this line on the drawing' }); continue; }
        // tile edges sit g/2 either side of a joint centre line
        let jd = best; if (Math.abs(jd) <= g / 2 + 0.01) jd = 0; else jd = jd > 0 ? jd - g / 2 : jd + g / 2;
        fronts.push({ edge: e.name, dist: Math.round(Math.abs(jd)), side: jd === 0 ? 'on' : jd > 0 ? 'in front' : 'under', a: e.a, b: e.b, out: e.out });
      }
      return { name: u.name || 'Units', m2: under / 1e6, tiles: count, fronts };
    });
  }

  function doorwayPts(surface, d) {
    const o = surface.outline; if (!o || o.length < 2) return null;
    const i = Math.min(Math.max(0, d.edge | 0), o.length - 1); const A = o[i], B = o[(i + 1) % o.length];
    const len = Math.hypot(B[0] - A[0], B[1] - A[1]); if (len < 1) return null;
    const u = [(B[0] - A[0]) / len, (B[1] - A[1]) / len];
    const p0 = Math.max(0, Math.min(len, +d.pos || 0)), p1 = Math.max(0, Math.min(len, p0 + (+d.w || 0)));
    return [[A[0] + u[0] * p0, A[1] + u[1] * p0], [A[0] + u[0] * p1, A[1] + u[1] * p1]];
  }
  function pointToDoorway(outline, p1, p2) {
    // find the outline edge the doorway lies on: returns {edge, pos, w}
    let best = null;
    outline.forEach((A, i) => {
      const B = outline[(i + 1) % outline.length]; const len = Math.hypot(B[0] - A[0], B[1] - A[1]); if (len < 1) return;
      const u = [(B[0] - A[0]) / len, (B[1] - A[1]) / len];
      const proj = p => (p[0] - A[0]) * u[0] + (p[1] - A[1]) * u[1];
      const dist = p => Math.abs((p[0] - A[0]) * u[1] - (p[1] - A[1]) * u[0]);
      const dd = dist(p1) + dist(p2);
      if (!best || dd < best.dd) { const a = proj(p1), b = proj(p2); best = { dd, edge: i, pos: Math.round(Math.max(0, Math.min(a, b))), w: Math.round(Math.abs(b - a)) }; }
    });
    return best;
  }

  /* Change the length of edge i. Square shapes stay square: everything beyond the edge's end moves with it. */
  function stretchEdge(surface, i, newLen) {
    const o = surface.outline, n = o.length; const A = o[i], B = o[(i + 1) % n];
    const len = Math.hypot(B[0] - A[0], B[1] - A[1]); if (len < 1 || !(newLen > 0)) return false;
    const u = [(B[0] - A[0]) / len, (B[1] - A[1]) / len]; const delta = newLen - len;
    const ax = Math.abs(u[0]) > 0.9999 ? 0 : Math.abs(u[1]) > 0.9999 ? 1 : -1;
    if (ax >= 0) {
      const sg = Math.sign(u[ax]); const thr = B[ax];
      o.forEach(v => { if ((v[ax] - thr) * sg >= -0.5) v[ax] = Math.round((v[ax] + delta * sg) * 10) / 10; });
      const key = ax === 0 ? 'x' : 'y', sz = ax === 0 ? 'w' : 'h';
      (surface.openings || []).forEach(op => { const c = +op[key] + +op[sz] / 2; if ((c - thr) * sg >= 0) { op[key] = Math.round(+op[key] + delta * sg); if (op.pts) op.pts.forEach(q => { q[ax] += delta * sg; }); } });
    } else { o[(i + 1) % n] = [Math.round((B[0] + u[0] * delta) * 10) / 10, Math.round((B[1] + u[1] * delta) * 10) / 10]; }
    return true;
  }

  // ---------- counting + offcuts ----------
  /* Works out how many tiles are needed. Cut pieces come from new tiles or from offcuts.
     A piece's sides that meet other tiles must be factory edges; sides against a wall/opening can be cut edges.
     Offcuts may be turned 180° (setting). Several res can share one offcut pool (walls round a room). */
  function fitIn(ow, oh, f, pw, ph, need) {
    if (pw > ow + 0.5 || ph > oh + 0.5) return null;
    let px, py;
    if (need.L && need.R) { if (!(f.L && f.R) || Math.abs(ow - pw) > 1.5) return null; px = 0; }
    else if (need.L) { if (!f.L) return null; px = 0; }
    else if (need.R) { if (!f.R) return null; px = ow - pw; }
    else px = !f.L ? 0 : !f.R ? ow - pw : 0;
    if (need.B && need.T) { if (!(f.B && f.T) || Math.abs(oh - ph) > 1.5) return null; py = 0; }
    else if (need.B) { if (!f.B) return null; py = 0; }
    else if (need.T) { if (!f.T) return null; py = oh - ph; }
    else py = !f.B ? 0 : !f.T ? oh - ph : 0;
    return { px: Math.max(0, px), py: Math.max(0, py) };
  }
  function allocate(resList, settings) {
    const kerf = settings.kerf ?? 3, reuse = settings.reuseOffcuts !== false, minUse = settings.minOffcut ?? 30, turn = settings.turn180 !== false;
    const pools = new Map(), pairs = new Map();
    const out = resList.map(res => ({ per: res.sizes.map(z => ({ label: z.label, w: z.w, h: z.h, full: 0, cut: 0, notch: 0, fromOffcut: 0, newForCuts: 0, needed: 0 })), slivers: 0, minCut: Infinity }));
    const cuts = [], angled = [];
    const keyOf = (res, p) => `${res.sizes[p.sizeIdx]?.tile?.id || ''}|${Math.round(p.tw)}x${Math.round(p.th)}`;
    resList.forEach((res, ri) => res.pieces.forEach((p, idx) => {
      p.id = idx + 1; p.source = null; p.offcutFrom = null;
      const st = out[ri], s = st.per[p.sizeIdx];
      if (p.kind === 'full') { s.full++; return; }
      if (p.sliver) st.slivers++;
      st.minCut = Math.min(st.minCut, p.minDim);
      if (p.kind === 'cut') { s.cut++; cuts.push({ p, ri, key: keyOf(res, p) }); }
      else if (p.kind === 'angled' && reuse) { s.notch++; angled.push({ p, ri, key: keyOf(res, p) }); }
      else { s.notch++; s.newForCuts++; p.source = 'new'; }
    }));
    cuts.sort((a, b) => b.p.w * b.p.h - a.p.w * a.p.h);
    const label = (ri, p) => resList.length > 1 ? `${resList[ri].name || 'area ' + (ri + 1)} #${p.id}` : `#${p.id}`;
    for (const c of cuts) {
      const p = c.p; if (!pools.has(c.key)) pools.set(c.key, []); const list = pools.get(c.key);
      const pw = Math.min(p.w, p.tw), ph = Math.min(p.h, p.th);
      const cs = p.cutSides || { L: true, R: true, B: true, T: true };
      const need = { L: !cs.L, R: !cs.R, B: !cs.B, T: !cs.T };
      let best = null;
      if (reuse) list.forEach((o, i) => {
        for (const rot of turn ? [0, 180] : [0]) {
          const f = rot ? { L: o.f.R, R: o.f.L, B: o.f.T, T: o.f.B } : o.f;
          const fit = fitIn(o.w, o.h, f, pw, ph, need);
          if (fit && (!best || o.w * o.h < best.area)) best = { i, f, fit, area: o.w * o.h };
        }
      });
      let src, f, fit;
      if (best) { src = list.splice(best.i, 1)[0]; f = best.f; fit = best.fit; out[c.ri].per[p.sizeIdx].fromOffcut++; p.source = 'offcut'; p.offcutFrom = src.from; }
      else {
        src = { w: p.tw, h: p.th, from: label(c.ri, p) }; f = { L: true, R: true, B: true, T: true };
        fit = fitIn(src.w, src.h, f, pw, ph, need) || { px: 0, py: 0 };
        out[c.ri].per[p.sizeIdx].newForCuts++; p.source = 'new';
      }
      // what is left: strips either side of the piece, then above/below it
      const ow = src.w, oh = src.h, { px, py } = fit; const left = [];
      if (px > kerf) left.push({ w: px - kerf, h: oh, f: { L: f.L, R: false, B: f.B, T: f.T } });
      if (ow - px - pw > kerf) left.push({ w: ow - px - pw - kerf, h: oh, f: { L: false, R: f.R, B: f.B, T: f.T } });
      const colL = px < 0.5 ? f.L : false, colR = px + pw > ow - 0.5 ? f.R : false;
      if (py > kerf) left.push({ w: pw, h: py - kerf, f: { L: colL, R: colR, B: f.B, T: false } });
      if (oh - py - ph > kerf) left.push({ w: pw, h: oh - py - ph - kerf, f: { L: colL, R: colR, B: false, T: f.T } });
      left.forEach(o => { if (o.w >= minUse && o.h >= minUse) list.push({ ...o, from: src.from }); });
    }
    // angled pieces (diagonal / herringbone edges): two small pieces can usually come from one tile
    angled.sort((a, b) => b.p.area - a.p.area);
    for (const c of angled) {
      const p = c.p; if (!pairs.has(c.key)) pairs.set(c.key, []); const bins = pairs.get(c.key);
      const cap = p.tw * p.th * 0.92;
      const bin = p.area <= cap / 2 + 1 ? bins.find(b => b.n === 1 && b.used + p.area <= cap) : null;
      if (bin) { bin.n++; bin.used += p.area; out[c.ri].per[p.sizeIdx].fromOffcut++; p.source = 'offcut'; p.offcutFrom = bin.first; }
      else { bins.push({ n: 1, used: p.area, first: label(c.ri, p) }); out[c.ri].per[p.sizeIdx].newForCuts++; p.source = 'new'; }
    }
    return out.map(st => {
      let needed = 0, cutsN = 0;
      st.per.forEach(z => { z.needed = z.full + z.newForCuts; needed += z.needed; cutsN += z.cut + z.notch; });
      return { per: st.per, needed, cuts: cutsN, slivers: st.slivers, minCut: isFinite(st.minCut) ? st.minCut : null };
    });
  }
  function countTiles(res, settings) { return allocate([res], settings)[0]; }
  /* share offcuts between several areas (e.g. walls of one room); updates each res.stats */
  function poolTiles(resList, settings) { const sts = allocate(resList, settings); resList.forEach((r, i) => { r.stats = sts[i]; }); return sts; }

  // ---------- cut list grouping ----------
  function cutList(res) {
    const groups = new Map();
    for (const p of res.pieces) {
      if (p.kind === 'full') continue;
      const w = Math.round(p.w), h = Math.round(p.h);
      let key = `${p.sizeIdx}|${p.kind}|${w}|${h}`;
      let desc = `${w} × ${h}`;
      if (p.kind === 'notch' && p.notch) {
        if (p.notch.hole) desc += ' with hole';
        else if (p.notch.w) { desc += ` notch ${Math.round(p.notch.w)}×${Math.round(p.notch.h)}`; key += `|${Math.round(p.notch.w)}|${Math.round(p.notch.h)}`; }
        else desc += ` (${p.notch.count} notches)`;
      }
      if (p.kind === 'angled') { const sd = (p.sides || []).join(' · '); desc = `angled, sides ${sd}`; key += '|' + sd; }
      if (!groups.has(key)) groups.set(key, { sizeIdx: p.sizeIdx, kind: p.kind, w, h, desc, count: 0, sliver: false, ids: [], offcut: 0, from: [] });
      const g = groups.get(key); g.count++; g.ids.push(p.id); if (p.sliver) g.sliver = true; if (p.source === 'offcut') { g.offcut++; if (p.offcutFrom && !g.from.includes(p.offcutFrom)) g.from.push(p.offcutFrom); }
    }
    return [...groups.values()].sort((a, b) => a.sizeIdx - b.sizeIdx || b.w * b.h - a.w * a.h);
  }

  // ---------- materials ----------
  function jointPerM2(unit, g) {
    // joint length per m² of tiled area = (Σ perimeters / 2) / cell area
    const [t1, t2] = [unit.t1, unit.t2];
    const cellA = Math.abs(t1[0] * t2[1] - t1[1] * t2[0]);
    const per = unit.cells.reduce((s, c) => s + perimeter(c.pts), 0) / 2;
    return per / cellA * 1e6; // mm of joint per m²
  }

  function materials(surface, tile, res, mat) {
    const m2 = res.netArea / 1e6;
    const g = +surface.pattern.joint || 0;
    const depth = +tile.thick || 10;
    const out = { m2 };
    const st = res.stats;
    const spare = surface.settings && surface.settings.spare != null && surface.settings.spare !== '' ? +surface.settings.spare : (PATTERNS[surface.pattern.type]?.waste ?? 5);
    out.spare = spare;
    out.tiles = st.per.map((s, i) => {
      const order = Math.ceil(s.needed * (1 + spare / 100));
      const sz = res.sizes[i]; const t = sz.tile || tile;
      const tileM2 = s.w * s.h / 1e6;
      let boxes = null;
      const modular = surface.pattern.type === 'modular' && !sz.border;
      if (!modular && +t.perBox > 0) boxes = Math.ceil(order / +t.perBox);
      else if (!modular && +t.m2PerBox > 0) boxes = Math.ceil(order * tileM2 / +t.m2PerBox);
      return { label: sz.border ? `${t.name} (border)` : s.label, tileId: t.id, tileName: t.name, border: !!sz.border, modular, needed: s.needed, order, boxes, m2: order * tileM2, full: s.full, cuts: s.cut + s.notch, fromOffcut: s.fromOffcut };
    });
    if (surface.pattern.type === 'modular' && +tile.m2PerBox > 0) {
      const totM2 = out.tiles.filter(t => t.modular).reduce((s, t) => s + t.m2, 0);
      out.modularBoxes = Math.ceil(totM2 / +tile.m2PerBox);
    }
    // adhesive
    const adhCov = +(tile.adhCoverage || mat.adhCoverage) || 2.2;
    out.adhesive = { name: mat.adhName, bags: Math.ceil(m2 / adhCov * (1 + (+mat.adhExtra || 0) / 100) - 1e-9), coverage: adhCov, bagKg: mat.adhBagKg };
    // grout
    const jl = jointPerM2(res.unit, g);
    const dens = +mat.groutDensity || 1.6;
    const kgPerM2 = jl * g * depth * dens / 1e6;
    let rawKg = kgPerM2 * (res.fieldArea / 1e6);
    if (res.borderInfo) { const bt = res.borderInfo.tile; const A = +bt.w, B = +bt.h; rawKg += (A + B) / (A * B) * 1e6 * g * (+bt.thick || depth) * dens / 1e6 * (res.borderArea / 1e6); }
    const groutKg = rawKg * (1 + (+mat.groutExtra || 0) / 100);
    out.grout = { name: mat.groutName, kgPerM2, kg: groutKg, bags: g > 0 ? Math.ceil(groutKg / (+mat.groutBagKg || 5) - 1e-9) : 0, bagKg: mat.groutBagKg };
    // primer
    const primerOn = surface.settings?.primer !== false;
    const litres = primerOn ? m2 * (+mat.primerLPerM2 || 0) : 0;
    out.primer = { name: mat.primerName, litres, units: litres > 0 ? Math.ceil(litres / (+mat.primerUnitL || 5) - 1e-9) : 0, unitL: mat.primerUnitL };
    // trim
    let trimMM = 0;
    const s = surface.settings || {};
    if (s.trimPerimeter) trimMM += perimeter(res.region.outline);
    if (s.trimOpenings) for (const o of res.region.ops) { trimMM += 2 * +o.h + (o.type === 'door' ? 1 : 2) * +o.w; }
    trimMM += (+s.trimExtra || 0) * 1000;
    out.trim = { m: trimMM / 1000, lengths: trimMM > 0 ? Math.ceil(trimMM / ((+mat.trimLengthM || 2.5) * 1000) - 1e-9) : 0 };
    // spacers
    const tilesNeeded = st.needed;
    const spc = tilesNeeded * (+mat.spacersPerTile || 0);
    out.spacers = { count: Math.ceil(spc), packs: spc > 0 ? Math.ceil(spc / (+mat.spacerPack || 100)) : 0 };
    out.thresholds = (res.doorways || []).map(d => ({ name: d.name || 'Doorway', w: Math.round(+d.w) }));
    out.units = (res.units || []).map(u => ({ name: u.name, m2: u.m2, tiles: u.tiles }));
    return out;
  }

  // ---------- start candidates ----------
  function startCandidates(surface, tile, opts = {}) {
    const region = surfaceRegion(surface);
    if (!region) return { xs: [], ys: [] };
    const pat = surface.pattern;
    const a = rad(patternRotation(pat));
    const unit = buildUnit(tile, pat);
    const ref = bbox(unit.cells[0].pts);
    const g = +pat.joint || 0;
    const outlineP = region.outline.map(p => rot(p, -a));
    const ob = bbox(outlineP);
    const xs = [], ys = [];
    const addX = (v, label) => xs.push({ v, label });
    const addY = (v, label) => ys.push({ v, label });
    const cx = (ob.x0 + ob.x1) / 2, cy = (ob.y0 + ob.y1) / 2;
    const horiz = surface.kind === 'wall' ? ['left wall', 'right wall'] : ['left edge', 'right edge'];
    const vert = surface.kind === 'wall' ? ['floor', 'ceiling'] : ['bottom edge', 'top edge'];
    addX(ob.x0 - ref.x0, `Full tile at ${horiz[0]}`); addX(ob.x1 - ref.x1, `Full tile at ${horiz[1]}`);
    addX(cx - (ref.x0 + ref.x1) / 2, 'Tile centred'); addX(cx - ref.x1 - g / 2, 'Joint centred');
    addY(ob.y0 - ref.y0, `Full tile at ${vert[0]}`); addY(ob.y1 - ref.y1, `Full tile at ${vert[1]}`);
    addY(cy - (ref.y0 + ref.y1) / 2, 'Tile centred'); addY(cy - ref.y1 - g / 2, 'Joint centred');
    const bat = surface.settings?.battenY;
    if (bat != null && bat !== '' && Math.abs(a) < 1e-6) addY(+bat - ref.y0, `Batten at ${bat} mm`);
    region.ops.forEach((o, i) => {
      const nm = o.name || o.type || `opening ${i + 1}`;
      const b = bbox(rectPts(+o.x, +o.y, +o.w, +o.h).map(p => rot(p, -a)));
      const ocx = (b.x0 + b.x1) / 2, ocy = (b.y0 + b.y1) / 2;
      addX(ocx - (ref.x0 + ref.x1) / 2, `Tile centred on ${nm}`); addX(ocx - ref.x1 - g / 2, `Joint centred on ${nm}`);
      addX(b.x0 - ref.x0, `Tile edge at ${nm} left`); addX(b.x1 - ref.x1, `Tile edge at ${nm} right`);
      addY(b.y0 - ref.y1 - g, `Full tile under ${nm}`); addY(b.y1 - ref.y0, `Full tile above ${nm}`);
      addY(ocy - (ref.y0 + ref.y1) / 2, `Tile centred on ${nm}`);
    });
    (region.units || []).forEach((o, i) => {
      const nm = o.name || 'units';
      const b = bbox(rectPts(+o.x, +o.y, +o.w, +o.h).map(p => rot(p, -a)));
      addX(b.x0 + g / 2 - ref.x0, `Joint on ${nm} left edge`); addX(b.x1 + g / 2 - ref.x0, `Joint on ${nm} right edge`);
      addY(b.y0 + g / 2 - ref.y0, `Joint on ${nm} bottom edge`); addY(b.y1 + g / 2 - ref.y0, `Joint on ${nm} top edge`);
    });
    const special = [];
    (surface.doorways || []).forEach((d, i) => {
      const pts = doorwayPts(surface, d); if (!pts) return;
      const nm = d.name || `doorway ${i + 1}`;
      const P = pts.map(p => rot(p, -a)); const mx = (P[0][0] + P[1][0]) / 2, my = (P[0][1] + P[1][1]) / 2;
      if (Math.abs(P[1][0] - P[0][0]) >= Math.abs(P[1][1] - P[0][1])) { addX(mx - (ref.x0 + ref.x1) / 2, `Tile centred on ${nm}`); addX(mx - ref.x1 - g / 2, `Joint centred on ${nm}`); }
      else { addY(my - (ref.y0 + ref.y1) / 2, `Tile centred on ${nm}`); addY(my - ref.y1 - g / 2, `Joint centred on ${nm}`); }
    });
    // herringbone family: put the straight joint line (through the V points) on the centre line
    const hb = herringboneAxis(tile, pat);
    if (hb) {
      const C = [(region.bb.x0 + region.bb.x1) / 2, (region.bb.y0 + region.bb.y1) / 2];
      const place = (pt, label) => { const q = rot(hb.P, a); special.push({ o: [pt[0] - q[0], pt[1] - q[1]], label }); const q2 = rot([hb.P[0] + hb.half[0], hb.P[1] + hb.half[1]], a); special.push({ o: [pt[0] - q2[0], pt[1] - q2[1]], label: label + ' (half step along)' }); };
      place(C, 'Herringbone joint line on centre');
      (surface.doorways || []).forEach((d, i) => { const pts = doorwayPts(surface, d); if (pts) place([(pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2], `Herringbone joint line centred on ${d.name || 'doorway ' + (i + 1)}`); });
    }
    const ded = arr => { const o = []; for (const c of arr) if (!o.some(d => Math.abs(d.v - c.v) < 0.5)) o.push(c); return o; };
    return { xs: ded(xs), ys: ded(ys), a, special };
  }

  function toAreaOrigin(xp, yp, a) { return rot([xp, yp], a); }

  /* Joint centres where floor joints meet floor edge i, measured as a wall would see them: from P(i+1) back towards P(i) */
  function floorJointsOnEdge(floorRes, outline, i, g) {
    const n = outline.length, A = outline[i], B = outline[(i + 1) % n];
    const len = Math.hypot(B[0] - A[0], B[1] - A[1]); if (len < 1) return [];
    const u = [(B[0] - A[0]) / len, (B[1] - A[1]) / len];
    const hits = [];
    for (const t of floorRes.rawTiles) {
      const pts = t.pts;
      for (let k = 0; k < pts.length; k++) {
        const P = pts[k], Q = pts[(k + 1) % pts.length];
        const d = [Q[0] - P[0], Q[1] - P[1]]; const den = d[0] * u[1] - d[1] * u[0];
        if (Math.abs(den) < 1e-9) continue; // parallel to the wall
        // intersection of segment PQ with the edge line
        const s1 = ((A[0] - P[0]) * u[1] - (A[1] - P[1]) * u[0]) / den;
        if (s1 < -1e-6 || s1 > 1 + 1e-6) continue;
        const X = [P[0] + d[0] * s1, P[1] + d[1] * s1];
        const tt = (X[0] - A[0]) * u[0] + (X[1] - A[1]) * u[1];
        if (tt < -1 || tt > len + 1) continue;
        hits.push(len - tt);
      }
    }
    hits.sort((a, b) => a - b);
    const joints = [];
    for (let k = 0; k < hits.length - 1; k++) { const gap = hits[k + 1] - hits[k]; if (gap > 0.05 && Math.abs(gap - g) < Math.max(0.6, g * 0.6)) joints.push((hits[k] + hits[k + 1]) / 2); }
    if (!g) { const seen = []; hits.forEach(h => { if (!seen.some(x => Math.abs(x - h) < 0.5)) seen.push(h); }); return seen; }
    return joints;
  }

  // point on the centre of the straight joint line through the V points, and the direction of that line (pattern frame)
  function herringboneAxis(tile, pat) {
    if (!['herringbone', 'herringbone45', 'doubleHerringbone'].includes(pat.type)) return null;
    const g = +pat.joint || 0; const L = Math.max(+tile.w, +tile.h), W = Math.min(+tile.w, +tile.h);
    const Wt = pat.type === 'doubleHerringbone' ? 2 * W + g : W;
    const b = Wt + g;
    return { P: [L + g / 2, Wt / 2], dir: [Math.SQRT1_2, Math.SQRT1_2], half: [b / 2, b / 2] };
  }

  /* Set-out reference for fitters: a joint point near the middle, the continuous joint lines through it, and distances to the area edges */
  function setoutRef(surface, tile) {
    const region = surfaceRegion(surface); if (!region || !tile) return null;
    const pat = surface.pattern; const a = rad(patternRotation(pat)); const unit = buildUnit(tile, pat); const g = +pat.joint || 0;
    const O = [+pat.ox || 0, +pat.oy || 0];
    const hb = herringboneAxis(tile, pat);
    const ref = bbox(unit.cells[0].pts);
    const base = hb ? hb.P : [ref.x0 - g / 2, ref.y0 - g / 2];
    const C = [(region.bb.x0 + region.bb.x1) / 2, (region.bb.y0 + region.bb.y1) / 2];
    const Cp = rot([C[0] - O[0], C[1] - O[1]], -a);
    const [t1, t2] = [unit.t1, unit.t2]; const det = t1[0] * t2[1] - t1[1] * t2[0];
    const dx = Cp[0] - base[0], dy = Cp[1] - base[1];
    let i = Math.round((dx * t2[1] - dy * t2[0]) / det), j = Math.round((t1[0] * dy - t1[1] * dx) / det);
    let Pp = [base[0] + i * t1[0] + j * t2[0], base[1] + i * t1[1] + j * t2[1]];
    if (hb) { // slide along the joint line to the point nearest the centre
      const s = (Cp[0] - Pp[0]) * hb.dir[0] + (Cp[1] - Pp[1]) * hb.dir[1]; const step = Math.hypot(hb.half[0], hb.half[1]) * 2;
      const k = Math.round(s / step); Pp = [Pp[0] + hb.dir[0] * step * k, Pp[1] + hb.dir[1] * step * k];
    }
    const r = rot(Pp, a); const P = [r[0] + O[0], r[1] + O[1]];
    const t = pat.type; let dirs = [];
    if (['straight', 'diagonal', 'stackVertical', 'basketweave'].includes(t)) dirs = [[1, 0], [0, 1]];
    else if (['brick', 'third', 'quarter', 'customOffset'].includes(t)) dirs = [[1, 0]];
    else if (t === 'brickVertical') dirs = [[0, 1]];
    else if (hb) dirs = [hb.dir];
    dirs = dirs.map(d => rot(d, a));
    const bb = region.bb;
    return { P, dirs, dims: { left: P[0] - bb.x0, right: bb.x1 - P[0], bottom: P[1] - bb.y0, top: bb.y1 - P[1] }, herringbone: !!hb };
  }

  /* Best start for several areas set out together.
     items: [{surface, off:[x,y]}] in one view frame. mode 'plan' = one shared origin; 'strip' = shared height, each wall finds its own across position. */
  function bestForSet(items, tile, settings, mode, top = 6) {
    if (!items.length) return [];
    const pat0 = items[0].surface.pattern;
    // pseudo surface covering everything
    let pts = []; const ops = [], doors = [];
    items.forEach(it => {
      it.surface.outline.forEach(p => pts.push([p[0] + it.off[0], p[1] + it.off[1]]));
      (it.surface.openings || []).forEach(o => ops.push({ ...o, x: +o.x + it.off[0], y: +o.y + it.off[1] }));
    });
    const b = bbox(pts);
    const pseudo = { kind: items[0].surface.kind, outline: rectPts(b.x0, b.y0, b.w, b.h), openings: ops, pattern: pat0, settings: items[0].surface.settings || {}, doorways: [] };
    // doorways as tiny pseudo openings are not needed: add their centres as candidates through each member
    const cand = startCandidates(pseudo, tile);
    items.forEach(it => {
      const c2 = startCandidates(it.surface, tile);
      c2.xs.forEach(x => { if (/doorway|Door|centred on/i.test(x.label)) cand.xs.push({ v: x.v + rot(it.off, -cand.a)[0], label: `${x.label} (${it.surface.name})` }); });
      c2.ys.forEach(y => { if (/doorway|Door|centred on/i.test(y.label)) cand.ys.push({ v: y.v + rot(it.off, -cand.a)[1], label: `${y.label} (${it.surface.name})` }); });
      c2.special.forEach(sp => cand.special.push({ o: [sp.o[0] + it.off[0], sp.o[1] + it.off[1]], label: `${sp.label} (${it.surface.name})` }));
    });
    const evalAt = (o, perItem) => {
      let slivers = 0, needed = 0, cuts = 0, minCut = Infinity; const each = [];
      for (const it of items) {
        const oo = perItem ? perItem(it) : o;
        const s2 = { ...it.surface, pattern: { ...it.surface.pattern, ox: oo[0] - it.off[0], oy: oo[1] - it.off[1] } };
        const r = layout(s2, tile, settings); if (!r) continue;
        slivers += r.stats.slivers; needed += r.stats.needed; cuts += r.stats.cuts; if (r.stats.minCut != null) minCut = Math.min(minCut, r.stats.minCut);
        each.push(oo);
      }
      const stats = { slivers, needed, cuts, minCut: isFinite(minCut) ? minCut : null };
      return { stats, score: score({ stats }, tile), each };
    };
    const results = [];
    if (mode === 'strip') {
      // shared height; per wall best across-position
      const ys = cand.ys;
      for (const Y of ys) {
        const perWall = items.map(it => {
          const cw = startCandidates(it.surface, tile); let best = null;
          for (const X of cw.xs) {
            const o = toAreaOrigin(X.v, Y.v - rot(it.off, -cw.a)[1], cw.a);
            const s2 = { ...it.surface, pattern: { ...it.surface.pattern, ox: o[0], oy: o[1] } };
            const r = layout(s2, tile, settings); if (!r) continue;
            const sc = score(r, tile); if (!best || sc > best.sc) best = { sc, ox: o[0], oy: o[1], label: X.label, stats: r.stats };
          }
          return best;
        });
        if (perWall.some(p => !p)) continue;
        const st = perWall.reduce((s, p) => ({ slivers: s.slivers + p.stats.slivers, needed: s.needed + p.stats.needed, cuts: s.cuts + p.stats.cuts, minCut: Math.min(s.minCut, p.stats.minCut ?? Infinity) }), { slivers: 0, needed: 0, cuts: 0, minCut: Infinity });
        if (!isFinite(st.minCut)) st.minCut = null;
        results.push({ label: `Courses: ${Y.label}`, walls: perWall.map(p => ({ ox: p.ox, oy: p.oy, label: p.label })), stats: st, score: score({ stats: st }, tile) });
      }
    } else {
      for (const X of cand.xs) for (const Y of cand.ys) { const o = toAreaOrigin(X.v, Y.v, cand.a); const r = evalAt(o); results.push({ ox: o[0], oy: o[1], label: `${X.label} · ${Y.label}`, stats: r.stats, score: r.score }); }
      for (const sp of cand.special) { const r = evalAt(sp.o); results.push({ ox: sp.o[0], oy: sp.o[1], label: sp.label, stats: r.stats, score: r.score + 1 }); }
    }
    results.sort((p, q) => q.score - p.score);
    const out = [];
    for (const r of results) { if (!out.some(o => o.stats.needed === r.stats.needed && Math.abs((o.stats.minCut || 0) - (r.stats.minCut || 0)) < 0.5 && o.stats.cuts === r.stats.cuts)) out.push(r); if (out.length >= top) break; }
    return out;
  }

  function score(res, tile) {
    const st = res.stats;
    const short = Math.min(+tile.w, +tile.h);
    const cap = short / 2;
    const mc = st.minCut == null ? cap : Math.min(st.minCut, cap);
    return -st.slivers * 1e9 + mc * 1e5 - st.needed * 100 - st.cuts;
  }

  function findBestStarts(surface, tile, settings, top = 6) {
    const { xs, ys, a } = startCandidates(surface, tile);
    const results = [];
    for (const X of xs) for (const Y of ys) {
      const o = toAreaOrigin(X.v, Y.v, a);
      const s2 = { ...surface, pattern: { ...surface.pattern, ox: o[0], oy: o[1] } };
      const res = layout(s2, tile, settings);
      if (!res) continue;
      results.push({ ox: o[0], oy: o[1], label: `${X.label} · ${Y.label}`, xLabel: X.label, yLabel: Y.label, stats: res.stats, score: score(res, tile) });
    }
    for (const sp of startCandidates(surface, tile).special) {
      const s2 = { ...surface, pattern: { ...surface.pattern, ox: sp.o[0], oy: sp.o[1] } };
      const res = layout(s2, tile, settings); if (!res) continue;
      results.push({ ox: sp.o[0], oy: sp.o[1], label: sp.label, stats: res.stats, score: score(res, tile) + 1 });
    }
    results.sort((p, q) => q.score - p.score);
    const out = [];
    for (const r of results) { if (!out.some(o => o.stats.needed === r.stats.needed && Math.abs((o.stats.minCut || 0) - (r.stats.minCut || 0)) < 0.5 && o.stats.cuts === r.stats.cuts)) out.push(r); if (out.length >= top) break; }
    return out;
  }

  // ---------- shape helpers ----------
  function wallsToOutline(walls) {
    // walls: [{len, turn}] turn = degrees to turn left (+) after this wall; start heading east from (0,0)
    let x = 0, y = 0, h = 0; const pts = [[0, 0]];
    walls.forEach((w, i) => {
      x += Math.cos(rad(h)) * +w.len; y += Math.sin(rad(h)) * +w.len;
      if (i < walls.length - 1) pts.push([Math.round(x * 10) / 10, Math.round(y * 10) / 10]);
      h += +w.turn;
    });
    const gap = Math.hypot(x, y);
    return { pts, gap };
  }
  function outlineToWalls(pts) {
    const walls = []; let prevH = 0;
    const n = pts.length;
    const heads = [];
    for (let i = 0; i < n; i++) { const p = pts[i], q = pts[(i + 1) % n]; heads.push({ len: Math.hypot(q[0] - p[0], q[1] - p[1]), h: Math.atan2(q[1] - p[1], q[0] - p[0]) * 180 / Math.PI }); }
    for (let i = 0; i < n; i++) { let t = heads[(i + 1) % n].h - heads[i].h; while (t > 180) t -= 360; while (t <= -180) t += 360; walls.push({ len: Math.round(heads[i].len * 10) / 10, turn: Math.round(t * 10) / 10 }); }
    return walls;
  }
  function normaliseOutline(pts) {
    // shift so min x,y = 0 and make anticlockwise
    const b = bbox(pts); let p = pts.map(q => [q[0] - b.x0, q[1] - b.y0]);
    if (ringArea(p) < 0) p = p.reverse();
    return { pts: p, dx: -b.x0, dy: -b.y0 };
  }

  window.Geo = { PATTERNS, buildUnit, layTiles, layout, poolTiles, opRing, floorJointsOnEdge, setoutRef, bestForSet, stretchEdge, doorwayPts, pointToDoorway, herringboneAxis, pointInRing, cutList, materials, findBestStarts, startCandidates, toAreaOrigin, surfaceRegion, patternRotation, wallsToOutline, outlineToWalls, normaliseOutline, bbox, rectPts, ringArea, perimeter, polyArea, mpArea, rot, rad, stripClose };
})();
