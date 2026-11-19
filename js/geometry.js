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
  function surfaceRegion(surface) {
    const outline = stripClose(surface.outline || []);
    if (outline.length < 3) return null;
    let mp = [[outline.concat([outline[0]])]];
    const ops = (surface.openings || []).filter(o => o.w > 0 && o.h > 0 && !o.tiled);
    if (ops.length) {
      try { mp = PC.difference(mp, ...ops.map(o => [[...rectPts(+o.x, +o.y, +o.w, +o.h), [+o.x, +o.y]]])); } catch (e) { console.warn(e); }
    }
    return { mp, outline, ops, bb: bbox(outline), opBoxes: ops.map(o => ({ x0: +o.x, y0: +o.y, x1: +o.x + +o.w, y1: +o.y + +o.h })) };
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

  function analysePiece(poly, cell, totalAngDeg, settings) {
    const outer = stripClose(poly[0]);
    const area = polyArea(poly.map(stripClose));
    const own = ownFrame(outer, totalAngDeg + (cell.ang || 0));
    const b = bbox(own);
    let w = b.w, h = b.h;
    const tileArea = cell.ownW * cell.ownH;
    const piece = { poly: poly.map(stripClose), area, w, h, kind: 'cut', sizeIdx: cell.sizeIdx, notch: null };
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

  function layout(surface, tile, settings = {}) {
    const region = surfaceRegion(surface);
    if (!region || !tile) return null;
    const pat = surface.pattern;
    const totalAng = patternRotation(pat);
    const laid = layTiles(region, tile, pat);
    const pieces = [];
    let raw = 0;
    for (const t of laid.tiles) {
      if (t.bb.x1 <= region.bb.x0 || t.bb.x0 >= region.bb.x1) continue;
      if (fullyInside(t, region)) {
        pieces.push({ poly: [t.pts], area: t.cell.ownW * t.cell.ownH, w: t.cell.ownW, h: t.cell.ownH, kind: 'full', sizeIdx: t.cell.sizeIdx, minDim: Math.min(t.cell.ownW, t.cell.ownH) });
        continue;
      }
      let res;
      try { res = PC.intersection([[...t.pts, t.pts[0]]], region.mp); } catch (e) { continue; }
      for (const poly of res) {
        const p = analysePiece(poly, t.cell, totalAng, settings);
        if (p.area < 25 || p.minDim < 1) continue; // ignore crumbs (<5×5mm)
        pieces.push(p);
      }
      raw++;
    }
    const net = mpArea(region.mp);
    const res = { region, pieces, unit: laid.unit, totalAng, tooMany: laid.tooMany, netArea: net };
    res.stats = countTiles(res, settings);
    return res;
  }

  // ---------- counting + offcuts ----------
  function countTiles(res, settings) {
    const kerf = settings.kerf ?? 3;
    const reuse = settings.reuseOffcuts !== false;
    const minUse = settings.minOffcut ?? 30;
    const sizes = res.unit.sizes;
    const per = sizes.map(s => ({ label: s.label, w: s.w, h: s.h, full: 0, cut: 0, notch: 0, fromOffcut: 0, newForCuts: 0, needed: 0 }));
    const offcuts = sizes.map(() => []);
    let slivers = 0, minCut = Infinity;
    const cutsSorted = [], angled = [];
    res.pieces.forEach((p, idx) => {
      p.id = idx + 1;
      const s = per[p.sizeIdx];
      if (p.kind === 'full') { s.full++; return; }
      if (p.sliver) slivers++;
      minCut = Math.min(minCut, p.minDim);
      if (p.kind === 'cut') { s.cut++; cutsSorted.push(p); } else if (p.kind === 'angled' && reuse) { s.notch++; angled.push(p); } else { s.notch++; s.newForCuts++; p.source = 'new'; }
    });
    // angled pieces (diagonal / herringbone edges): two small pieces can usually come from one tile
    angled.sort((a, b) => b.area - a.area);
    const bins = [];
    for (const p of angled) {
      const cap = sizes[p.sizeIdx].w * sizes[p.sizeIdx].h * 0.92;
      const bin = p.area <= cap / 2 + 1 ? bins.find(b => b.sizeIdx === p.sizeIdx && b.n === 1 && b.used + p.area <= cap) : null;
      if (bin) { bin.n++; bin.used += p.area; per[p.sizeIdx].fromOffcut++; p.source = 'offcut'; p.offcutFrom = bin.first; }
      else { bins.push({ sizeIdx: p.sizeIdx, n: 1, used: p.area, first: p.id }); per[p.sizeIdx].newForCuts++; p.source = 'new'; }
    }
    cutsSorted.sort((a, b) => b.w * b.h - a.w * a.h);
    for (const p of cutsSorted) {
      const s = per[p.sizeIdx], list = offcuts[p.sizeIdx];
      const sz = sizes[p.sizeIdx];
      // piece own dims could be either orientation relative to tile; normalise to tile orientation
      let pw = p.w, ph = p.h;
      const TW = Math.max(sz.w, sz.h), TH = Math.min(sz.w, sz.h);
      if (pw < ph && TW !== TH) { const t = pw; pw = ph; ph = t; }
      let best = -1, bestA = Infinity;
      if (reuse) for (let i = 0; i < list.length; i++) { const o = list[i]; if (o.w + 0.5 >= pw && o.h + 0.5 >= ph && o.w * o.h < bestA) { best = i; bestA = o.w * o.h; } }
      let src;
      if (best >= 0) { src = list.splice(best, 1)[0]; s.fromOffcut++; p.source = 'offcut'; p.offcutFrom = src.from; }
      else { src = { w: TW, h: TH, from: p.id }; s.newForCuts++; p.source = 'new'; }
      const r1 = { w: src.w - pw - kerf, h: src.h, from: src.from }, r2 = { w: pw, h: src.h - ph - kerf, from: src.from };
      if (r1.w >= minUse && r1.h >= minUse) list.push(r1);
      if (r2.w >= minUse && r2.h >= minUse) list.push(r2);
    }
    let needed = 0, cuts = 0;
    per.forEach(s => { s.needed = s.full + s.newForCuts; needed += s.needed; cuts += s.cut + s.notch; });
    return { per, needed, cuts, slivers, minCut: isFinite(minCut) ? minCut : null };
  }

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
      if (!groups.has(key)) groups.set(key, { sizeIdx: p.sizeIdx, kind: p.kind, w, h, desc, count: 0, sliver: false, ids: [], offcut: 0 });
      const g = groups.get(key); g.count++; g.ids.push(p.id); if (p.sliver) g.sliver = true; if (p.source === 'offcut') g.offcut++;
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
    out.tiles = st.per.map(s => {
      const order = Math.ceil(s.needed * (1 + spare / 100));
      const tileM2 = s.w * s.h / 1e6;
      let boxes = null;
      const modular = surface.pattern.type === 'modular';
      if (!modular && +tile.perBox > 0) boxes = Math.ceil(order / +tile.perBox);
      else if (!modular && +tile.m2PerBox > 0) boxes = Math.ceil(order * tileM2 / +tile.m2PerBox);
      return { label: s.label, needed: s.needed, order, boxes, m2: order * tileM2, full: s.full, cuts: s.cut + s.notch, fromOffcut: s.fromOffcut };
    });
    if (surface.pattern.type === 'modular' && +tile.m2PerBox > 0) {
      const totM2 = out.tiles.reduce((s, t) => s + t.m2, 0);
      out.modularBoxes = Math.ceil(totM2 / +tile.m2PerBox);
    }
    // adhesive
    const adhCov = +(tile.adhCoverage || mat.adhCoverage) || 2.2;
    out.adhesive = { name: mat.adhName, bags: Math.ceil(m2 / adhCov * (1 + (+mat.adhExtra || 0) / 100) - 1e-9), coverage: adhCov, bagKg: mat.adhBagKg };
    // grout
    const jl = jointPerM2(res.unit, g);
    const kgPerM2 = jl * g * depth * (+mat.groutDensity || 1.6) / 1e6;
    const groutKg = kgPerM2 * m2 * (1 + (+mat.groutExtra || 0) / 100);
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
    const ded = arr => { const o = []; for (const c of arr) if (!o.some(d => Math.abs(d.v - c.v) < 0.5)) o.push(c); return o; };
    return { xs: ded(xs), ys: ded(ys), a };
  }

  function toAreaOrigin(xp, yp, a) { return rot([xp, yp], a); }

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

  window.Geo = { PATTERNS, buildUnit, layTiles, layout, cutList, materials, findBestStarts, startCandidates, toAreaOrigin, surfaceRegion, patternRotation, wallsToOutline, outlineToWalls, normaliseOutline, bbox, rectPts, ringArea, perimeter, polyArea, mpArea, rot, rad, stripClose };
})();
