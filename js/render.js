/* Canvas renderer shared by the editor and exports.
   A scene is a list of items (areas), each drawn at its own offset in one view frame. */
(function () {
  'use strict';
  const C = { bronze: '#CE8B3E', gun: '#6D6E70', full: '#F7F2EB', cut: '#F0D6B0', notch: '#E6B572', sliver: '#F28B82', border: '#DCD3C6', open: '#FFFFFF', bgArea: '#EDEDED', ink: '#2E2F31', blue: '#2563EB', green: '#15803D' };

  function makeView(bb, W, H, pad = 40) {
    const s = Math.min((W - pad * 2) / Math.max(bb.w, 1), (H - pad * 2) / Math.max(bb.h, 1));
    return { s, cx: (bb.x0 + bb.x1) / 2, cy: (bb.y0 + bb.y1) / 2 };
  }
  function toS(v, W, H, p) { return [(p[0] - v.cx) * v.s + W / 2, H / 2 - (p[1] - v.cy) * v.s]; }
  function toW(v, W, H, sx, sy) { return [(sx - W / 2) / v.s + v.cx, (H / 2 - sy) / v.s + v.cy]; }
  function path(ctx, ring, f) { ring.forEach((p, i) => { const q = f(p); i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]); }); ctx.closePath(); }
  const FONT = '"Myriad Pro", system-ui, -apple-system, sans-serif';

  /* items: [{surface, tile, res, raw, off, selected, bgImg, title, ref}]  o: {paper, labels, ids, dims, vertices, selVertex, selOpening, trace, calib, origins, dimHits, labelScale, dimFont, setout, noBg} */
  function scene(ctx, W, H, v, items, o = {}) {
    ctx.save();
    ctx.fillStyle = o.paper || '#FAFAFA'; ctx.fillRect(0, 0, W, H);
    const LS = o.labelScale || 1;
    // backgrounds
    if (!o.noBg) items.forEach(it => {
      if (!it.bgImg || !it.surface.bg || it.rot) return;
      const b = it.surface.bg; const f = itemF(v, W, H, it);
      const tl = f([b.x, b.y]); const sc = b.mmPerPx * v.s;
      ctx.globalAlpha = b.opacity ?? 0.5; ctx.drawImage(it.bgImg, tl[0], tl[1], it.bgImg.width * sc, it.bgImg.height * sc); ctx.globalAlpha = 1;
    });
    o.doorSeen = []; o.taken = []; o.deferred = [];
    if (!o.labelMode) o.labelMode = 'auto';
    // edges where two areas meet: no measurement labels (they would sit inside the other area)
    if (items.length > 1) {
      const key = (a, b) => { const k1 = `${Math.round(a[0] / 5)},${Math.round(a[1] / 5)}`, k2 = `${Math.round(b[0] / 5)},${Math.round(b[1] / 5)}`; return k1 < k2 ? k1 + '|' + k2 : k2 + '|' + k1; };
      const T = it => { const c = Math.cos(it.rot || 0), sn = Math.sin(it.rot || 0); return p => [p[0] * c - p[1] * sn + it.off[0], p[0] * sn + p[1] * c + it.off[1]]; };
      const segs = items.map(it => { const t = T(it); return it.surface.outline.map((p, i) => { const q = it.surface.outline[(i + 1) % it.surface.outline.length]; return [t(p), t(q)]; }); });
      const overlaps = (s1, s2) => { // collinear and overlapping
        const d = [s1[1][0] - s1[0][0], s1[1][1] - s1[0][1]]; const L = Math.hypot(d[0], d[1]); if (L < 1) return false;
        const u = [d[0] / L, d[1] / L]; const off = p => Math.abs((p[0] - s1[0][0]) * u[1] - (p[1] - s1[0][1]) * u[0]);
        if (off(s2[0]) > 3 || off(s2[1]) > 3) return false;
        const t = p => (p[0] - s1[0][0]) * u[0] + (p[1] - s1[0][1]) * u[1]; const a = t(s2[0]), b = t(s2[1]);
        return Math.min(Math.max(a, b), L) - Math.max(Math.min(a, b), 0) > 50;
      };
      items.forEach((it, k) => { it.skipEdges = new Set(); segs[k].forEach((sg, i) => { if (segs.some((o2, j) => j !== k && o2.some(s2 => overlaps(sg, s2)))) it.skipEdges.add(i); }); });
    }
    for (const it of items) drawItem(ctx, W, H, v, it, o, LS, 'fill');
    for (const it of items) drawItem(ctx, W, H, v, it, o, LS, 'over');
    // titles for multi-area views
    if (items.length > 1) items.forEach(it => {
      const reg = it.res ? it.res.region : Geo.surfaceRegion(it.surface); if (!reg) return;
      const f = itemF(v, W, H, it);
      if (it.rot) { const p = f([(reg.bb.x0 + reg.bb.x1) / 2, (reg.bb.y0 + reg.bb.y1) / 2]); ctx.font = `700 ${13 * LS}px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; const t = it.surface.name; const tw = ctx.measureText(t).width; ctx.fillStyle = 'rgba(255,255,255,0.85)'; ctx.fillRect(p[0] - tw / 2 - 4, p[1] - 9 * LS, tw + 8, 18 * LS); ctx.fillStyle = it.selected ? C.bronze : C.gun; ctx.fillText(t, p[0], p[1]); return; }
      const p = f([(reg.bb.x0 + reg.bb.x1) / 2, reg.bb.y1]);
      ctx.font = `700 ${13 * LS}px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.fillStyle = it.selected ? C.bronze : C.gun; ctx.fillText(it.surface.name, p[0], p[1] - 18 * LS);
    });
    // cut sizes last, only where they don't collide with anything already drawn
    o.deferred.sort((a, b) => b.pr - a.pr).forEach(d => { if (fits(o, d)) d.draw(); });
    // origin markers
    (o.origins || []).forEach(pt => {
      const q = toS(v, W, H, pt); ctx.strokeStyle = C.bronze; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(q[0], q[1], 7, 0, 7); ctx.moveTo(q[0] - 12, q[1]); ctx.lineTo(q[0] + 12, q[1]); ctx.moveTo(q[0], q[1] - 12); ctx.lineTo(q[0], q[1] + 12); ctx.stroke();
    });
    const sel = items.find(i => i.selected) || items[0];
    const fs = sel ? itemF(v, W, H, sel) : null;
    if (o.trace && o.trace.length && fs) {
      ctx.strokeStyle = C.blue; ctx.fillStyle = C.blue; ctx.lineWidth = 2;
      ctx.beginPath(); o.trace.forEach((p, i) => { const q = fs(p); i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]); }); ctx.stroke();
      o.trace.forEach(p => { const q = fs(p); ctx.beginPath(); ctx.arc(q[0], q[1], 5, 0, 7); ctx.fill(); });
    }
    if (o.calib && o.calib.length && fs) {
      ctx.strokeStyle = '#DC2626'; ctx.fillStyle = '#DC2626'; ctx.lineWidth = 2;
      ctx.beginPath(); o.calib.forEach((p, i) => { const q = fs(p); i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]); }); ctx.stroke();
      o.calib.forEach(p => { const q = fs(p); ctx.beginPath(); ctx.arc(q[0], q[1], 6, 0, 7); ctx.fill(); });
    }
    ctx.restore();
  }
  /* label collision: in 'auto' a label is skipped if it would overlap one already placed */
  function fits(o, r) {
    const pad = 2;
    if (o.labelMode !== 'all' && o.taken.some(t => r.x < t.x + t.w + pad && r.x + r.w + pad > t.x && r.y < t.y + t.h + pad && r.y + r.h + pad > t.y)) return false;
    o.taken.push({ x: r.x, y: r.y, w: r.w, h: r.h }); return true;
  }
  function fOf(v, W, H, off, rot) {
    const dx = off ? off[0] : 0, dy = off ? off[1] : 0;
    if (!rot) return p => toS(v, W, H, [p[0] + dx, p[1] + dy]);
    const c = Math.cos(rot), s = Math.sin(rot);
    return p => toS(v, W, H, [p[0] * c - p[1] * s + dx, p[0] * s + p[1] * c + dy]);
  }
  const itemF = (v, W, H, it) => fOf(v, W, H, it.off, it.rot);

  function drawItem(ctx, W, H, v, it, o, LS, phase) {
    const { surface, res } = it; const f = itemF(v, W, H, it);
    const region = res ? res.region : Geo.surfaceRegion(surface); if (!region) return;
    const dim = it.dimmed;
    ctx.save(); if (dim) ctx.globalAlpha = 0.55;
    if (phase === 'fill') {
    const clipArea = () => { ctx.beginPath(); path(ctx, region.outline, f); region.ops.forEach(op => path(ctx, Geo.opRing(op), f)); };
    clipArea(); ctx.fillStyle = it.bgImg ? 'rgba(237,237,237,0.35)' : C.bgArea; ctx.fill('evenodd');
    const lw = Math.max(0.5, Math.min(1.2 * LS, v.s * 2));
    if (it.raw && it.raw.length) {
      ctx.save(); clipArea(); ctx.clip('evenodd'); if (it.tileAlpha != null) ctx.globalAlpha = it.tileAlpha;
      ctx.fillStyle = it.bgImg ? 'rgba(247,242,235,0.7)' : C.full; ctx.strokeStyle = C.gun; ctx.lineWidth = lw;
      for (const t of it.raw) { ctx.beginPath(); path(ctx, t.pts, f); ctx.fill(); ctx.stroke(); }
      ctx.restore();
    } else if (res) {
      ctx.globalAlpha = (dim ? 0.55 : 1) * (it.tileAlpha ?? (it.bgImg ? 0.78 : 1));
      for (const p of res.pieces) {
        ctx.beginPath(); p.poly.forEach(r => path(ctx, r, f));
        ctx.fillStyle = p.sliver ? C.sliver : p.kind === 'full' ? (p.border ? C.border : C.full) : p.kind === 'cut' ? C.cut : C.notch;
        ctx.fill('evenodd'); ctx.strokeStyle = C.gun; ctx.lineWidth = lw; ctx.stroke();
      }
      ctx.globalAlpha = dim ? 0.55 : 1;
      if (o.labels !== false) labels(ctx, v, f, res, o, LS, dim ? 0.55 : 1);
    }
    ctx.restore(); return;
    }
    // openings (not tiled)
    region.ops.forEach(op => {
      const i = surface.openings.indexOf(op);
      const pts = Geo.opRing(op);
      ctx.beginPath(); path(ctx, pts, f); ctx.fillStyle = it.bgImg ? 'rgba(255,255,255,0.55)' : C.open; ctx.fill();
      hatch(ctx, f, op, 'rgba(109,110,112,0.35)');
      const sel = it.selected && o.selOpening === i;
      ctx.strokeStyle = sel ? C.bronze : C.gun; ctx.lineWidth = sel ? 2.5 : 1.5; ctx.beginPath(); path(ctx, pts, f); ctx.stroke();
      opLabel(ctx, f, op, op.name || op.type, C.ink, LS, o);
    });
    // tiled-under units: dashed outline over the tiles, joint distances at visible fronts
    region.units.forEach(op => {
      const i = surface.openings.indexOf(op);
      const pts = Geo.rectPts(+op.x, +op.y, +op.w, +op.h);
      ctx.beginPath(); path(ctx, pts, f); ctx.fillStyle = 'rgba(37,99,235,0.07)'; ctx.fill();
      const sel = it.selected && o.selOpening === i;
      ctx.setLineDash([7, 4]); ctx.strokeStyle = sel ? C.bronze : C.blue; ctx.lineWidth = sel ? 2.5 : 1.8; ctx.beginPath(); path(ctx, pts, f); ctx.stroke(); ctx.setLineDash([]);
      opLabel(ctx, f, op, `${op.name || 'Units'} (tiled under)`, C.blue, LS, o);
    });
    const showUnits = o.labelMode === 'all' || (o.labelMode === 'auto' && (!o.multi || it.selected));
    if (res && res.units && o.labels !== false && showUnits) res.units.forEach(u => u.fronts.forEach(fr => {
      if (fr.dist == null) return;
      const m = [(fr.a[0] + fr.b[0]) / 2 + fr.out[0] * 2, (fr.a[1] + fr.b[1]) / 2 + fr.out[1] * 2]; const q = f(m);
      const txt = fr.side === 'on' ? 'joint on line' : `joint ${fr.dist} ${fr.side === 'under' ? 'under' : 'out'}`;
      ctx.font = `600 ${10.5 * LS}px ${FONT}`; const tw = ctx.measureText(txt).width;
      if (!fits(o, { x: q[0] - tw / 2 - 4, y: q[1] - 8 * LS, w: tw + 8, h: 16 * LS })) return;
      ctx.fillStyle = 'rgba(255,255,255,0.92)'; ctx.fillRect(q[0] - tw / 2 - 4, q[1] - 8 * LS, tw + 8, 16 * LS);
      ctx.fillStyle = fr.side !== 'on' && fr.dist < 50 ? '#B91C1C' : C.blue; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(txt, q[0], q[1]);
    }));
    // outline
    ctx.beginPath(); path(ctx, region.outline, f); ctx.strokeStyle = it.selected && o.multi ? C.bronze : C.ink; ctx.lineWidth = it.selected && o.multi ? 3 : 2; ctx.stroke();
    // doorways
    (surface.doorways || []).forEach((d, i) => {
      const pts = Geo.doorwayPts(surface, d); if (!pts) return;
      const a = f(pts[0]), b = f(pts[1]);
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 6; ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      ctx.strokeStyle = C.green; ctx.lineWidth = 3; ctx.setLineDash([5, 3]); ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); ctx.setLineDash([]);
      [a, b].forEach(q => { ctx.fillStyle = C.green; ctx.beginPath(); ctx.arc(q[0], q[1], 3.5, 0, 7); ctx.fill(); });
      const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (o.doorSeen.some(x => Math.hypot(x[0] - mid[0], x[1] - mid[1]) < Math.max(14, len * 0.25))) return; // same doorway seen from the other room
      o.doorSeen.push(mid);
      if (o.labelMode === 'none') return;
      ctx.font = `600 ${10.5 * LS}px ${FONT}`; ctx.fillStyle = C.green; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const nx = -(b[1] - a[1]), ny = b[0] - a[0]; const nl = Math.hypot(nx, ny) || 1;
      const sign = Geo.ringArea(region.outline) >= 0 ? -1 : 1;
      const txt = `${d.name || 'Door'} ${Math.round(+d.w)}`, tw = ctx.measureText(txt).width;
      const px = mid[0] + sign * nx / nl * 12 * LS, py = mid[1] + sign * ny / nl * 12 * LS;
      if (!fits(o, { x: px - tw / 2, y: py - 7 * LS, w: tw, h: 14 * LS })) return;
      ctx.fillText(txt, px, py);
    });
    if (o.dims !== false) drawDims(ctx, region.outline, f, o, it, LS);
    if (o.vertices && it.selected) region.outline.forEach((p, i) => { const q = f(p); ctx.beginPath(); ctx.arc(q[0], q[1], o.selVertex === i ? 9 : 6, 0, 7); ctx.fillStyle = o.selVertex === i ? C.bronze : '#fff'; ctx.fill(); ctx.strokeStyle = C.bronze; ctx.lineWidth = 2; ctx.stroke(); });
    // batten
    const bat = surface.settings && surface.settings.battenY;
    if (bat !== '' && bat != null) {
      const a = f([region.bb.x0 - 60, +bat]), b = f([region.bb.x1 + 60, +bat]);
      ctx.setLineDash([8, 5]); ctx.strokeStyle = C.blue; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = C.blue; ctx.font = `${11 * LS}px ${FONT}`; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'; ctx.fillText(`batten ${bat}`, a[0] + 4, a[1] - 3);
    }
    // set-out lines for fitters
    if (o.setout && it.ref && (o.labelMode === 'all' || !o.multi || it.selected)) setoutOverlay(ctx, f, region, it.ref, LS, o);
    ctx.restore();
  }

  function hatch(ctx, f, op, col) {
    const ring = Geo.opRing(op);
    ctx.save(); ctx.beginPath(); path(ctx, ring, f); ctx.clip();
    ctx.strokeStyle = col; ctx.lineWidth = 1;
    const sp = ring.map(f); const xs = sp.map(p => p[0]), ys = sp.map(p => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys), h = y1 - y0;
    for (let x = x0 - h; x < x1; x += 10) { ctx.beginPath(); ctx.moveTo(x, y1); ctx.lineTo(x + h, y0); ctx.stroke(); }
    ctx.restore();
  }
  function opLabel(ctx, f, op, text, col, LS, o) {
    const sp = Geo.opRing(op).map(f); const xs = sp.map(p => p[0]), ys = sp.map(p => p[1]);
    const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - Math.min(...ys); if (w < 34 || h < 14) return;
    const c = [(Math.max(...xs) + Math.min(...xs)) / 2, (Math.max(...ys) + Math.min(...ys)) / 2];
    let fs = 12 * LS; ctx.font = `600 ${fs}px ${FONT}`; const tw = ctx.measureText(text).width; if (tw > w - 6) fs *= (w - 6) / tw; if (fs < 7) return;
    ctx.font = `600 ${fs}px ${FONT}`; const tw2 = ctx.measureText(text).width;
    if (o && !fits(o, { x: c[0] - tw2 / 2, y: c[1] - fs * 0.6, w: tw2, h: fs * 1.2 })) return;
    ctx.fillStyle = col; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text, c[0], c[1]);
  }

  function labels(ctx, v, f, res, o, LS, alpha) {
    if (o.labelMode === 'none') return;
    const auto = o.labelMode !== 'all'; const minFs = (auto ? 8.5 : 6.5) * LS;
    for (const p of res.pieces) {
      const b = Geo.bbox(p.poly[0]); const sw = b.w * v.s, sh = b.h * v.s;
      if (p.kind === 'full' && !o.ids) continue;
      const lp = p.kind === 'cut' || p.kind === 'full' ? { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2, r: Math.min(b.w, b.h) / 2 } : labelPoint(p.poly, b);
      const c = f([lp.x, lp.y]); const room = lp.r * 2 * v.s;
      if (p.kind !== 'full' && room > 14 * LS && Math.max(sw, sh) > 36 * LS) {
        const txt = `${Math.round(p.w)}×${Math.round(p.h)}`;
        const vertical = p.kind === 'cut' && sh > sw * 1.3;
        const along = p.kind === 'cut' ? (vertical ? sh : sw) : Math.max(room * 1.6, Math.min(sw, sh));
        let fs = Math.min(13 * LS, room / 2.6);
        ctx.font = `600 ${fs}px ${FONT}`; let tw = ctx.measureText(txt).width; if (tw > along - 6) { fs *= (along - 6) / tw; tw = along - 6; }
        if (fs < minFs) continue;
        const hh = fs * (o.ids ? 2.3 : 1.2), ww = tw + 2;
        const r = vertical ? { x: c[0] - hh / 2, y: c[1] - ww / 2, w: hh, h: ww } : { x: c[0] - ww / 2, y: c[1] - hh / 2, w: ww, h: hh };
        const draw = () => {
          ctx.save(); ctx.globalAlpha = alpha; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.font = `600 ${fs}px ${FONT}`; ctx.fillStyle = p.sliver ? '#8B1A12' : C.ink;
          ctx.translate(c[0], c[1]); if (vertical) ctx.rotate(-Math.PI / 2);
          ctx.fillText(txt, 0, o.ids ? -fs * 0.55 : 0);
          if (o.ids) { ctx.font = `${fs * 0.85}px ${FONT}`; ctx.fillStyle = C.gun; ctx.fillText('#' + p.id, 0, fs * 0.6); }
          ctx.restore();
        };
        if (auto) o.deferred.push({ ...r, pr: (p.sliver ? 1e6 : 0) + fs, draw }); else { o.taken.push(r); draw(); }
      } else if (o.ids && room > 12 * LS) {
        const fs = Math.min(11 * LS, room / 2.5); if (auto && fs < 7 * LS) continue;
        const draw = () => { ctx.save(); ctx.globalAlpha = alpha; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = `${fs}px ${FONT}`; ctx.fillStyle = C.gun; ctx.fillText('#' + p.id, c[0], c[1]); ctx.restore(); };
        const r = { x: c[0] - fs, y: c[1] - fs / 2, w: fs * 2, h: fs };
        if (auto) o.deferred.push({ ...r, pr: fs, draw }); else draw();
      }
    }
  }

  function setoutOverlay(ctx, f, region, ref, LS, o) {
    const P = ref.P; const bb = region.bb; const big = Math.hypot(bb.w, bb.h) * 1.5;
    ctx.save(); ctx.beginPath(); path(ctx, region.outline, f); ctx.clip();
    ctx.strokeStyle = 'rgba(21,128,61,0.9)'; ctx.lineWidth = 1.6 * LS; ctx.setLineDash([10, 5]);
    ref.dirs.forEach(d => { const a = f([P[0] - d[0] * big, P[1] - d[1] * big]), b = f([P[0] + d[0] * big, P[1] + d[1] * big]); ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); });
    ctx.setLineDash([]); ctx.restore();
    const q = f(P); ctx.fillStyle = C.green; ctx.beginPath(); ctx.arc(q[0], q[1], 5 * LS, 0, 7); ctx.fill();
    // dimension leaders to left and bottom edges
    ctx.strokeStyle = C.green; ctx.fillStyle = C.green; ctx.lineWidth = 1 * LS; ctx.font = `700 ${11 * LS}px ${FONT}`;
    const L = f([bb.x0, P[1]]), B = f([P[0], bb.y0]);
    ctx.beginPath(); ctx.moveTo(L[0], L[1]); ctx.lineTo(q[0], q[1]); ctx.moveTo(B[0], B[1]); ctx.lineTo(q[0], q[1]); ctx.stroke();
    const tag = (x, y, t, vert) => { const tw = ctx.measureText(t).width; if (o && o.labelMode === 'none') return; if (o && o.taken && !vert && !fits(o, { x: x - tw / 2 - 3, y: y - 8 * LS, w: tw + 6, h: 16 * LS })) return; ctx.fillStyle = 'rgba(255,255,255,0.92)'; ctx.fillRect(x - tw / 2 - 3, y - 8 * LS, tw + 6, 16 * LS); ctx.fillStyle = C.green; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(t, x, y); };
    tag((L[0] + q[0]) / 2, q[1] - 10 * LS, `${Math.round(ref.dims.left)}`);
    { const t = `${Math.round(ref.dims.bottom)}`; const tw = ctx.measureText(t).width; const cx = q[0] + 10 * LS, cy = (B[1] + q[1]) / 2;
      if (!o || !o.taken || fits(o, { x: cx - 8 * LS, y: cy - tw / 2 - 3, w: 16 * LS, h: tw + 6 })) { ctx.save(); ctx.translate(cx, cy); ctx.rotate(-Math.PI / 2); tag(0, 0, t, true); ctx.restore(); } }
  }

  function labelPoint(poly, b) {
    let best = { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2, r: 0 };
    const N = 9;
    for (let i = 1; i < N; i++) for (let j = 1; j < N; j++) {
      const x = b.x0 + b.w * i / N, y = b.y0 + b.h * j / N;
      let inside = Geo.pointInRing([x, y], poly[0]); for (let k = 1; k < poly.length && inside; k++) if (Geo.pointInRing([x, y], poly[k])) inside = false;
      if (!inside) continue;
      let d = Infinity; for (const r of poly) for (let k = 0; k < r.length; k++) d = Math.min(d, segD([x, y], r[k], r[(k + 1) % r.length]));
      if (d > best.r) best = { x, y, r: d };
    }
    return best;
  }
  function segD(p, a, b) { const dx = b[0] - a[0], dy = b[1] - a[1]; const l = dx * dx + dy * dy || 1; let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l; t = Math.max(0, Math.min(1, t)); return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy); }

  function drawDims(ctx, ring, f, o, it, LS) {
    const n = ring.length; const sign = Geo.ringArea(ring) >= 0 ? 1 : -1;
    const fs = (o.dimFont || 11) * (o.dimFont ? 1 : LS);
    const editable = o.vertices && it.selected;
    ctx.font = `${editable ? '700 ' : ''}${fs}px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let i = 0; i < n; i++) {
      const p = ring[i], q = ring[(i + 1) % n];
      const len = Math.hypot(q[0] - p[0], q[1] - p[1]); if (len < 1) continue;
      if (it.noSideDims && Math.abs(q[0] - p[0]) < 1) continue;
      if (it.skipEdges && it.skipEdges.has(i) && !(o.vertices && it.selected)) continue;
      const a = f(p), b = f(q); const sl = Math.hypot(b[0] - a[0], b[1] - a[1]); if (sl < 30) continue;
      let nx = (b[1] - a[1]) / sl, ny = -(b[0] - a[0]) / sl; nx *= -sign; ny *= -sign;
      const off = editable ? 17 : 14;
      const mx = (a[0] + b[0]) / 2 + nx * off * LS, my = (a[1] + b[1]) / 2 + ny * off * LS;
      let ang = Math.atan2(b[1] - a[1], b[0] - a[0]); if (ang > Math.PI / 2) ang -= Math.PI; if (ang < -Math.PI / 2) ang += Math.PI;
      const t = `${Math.round(len)}`;
      ctx.save(); ctx.translate(mx, my); ctx.rotate(ang);
      if (editable) { const tw = ctx.measureText(t).width; ctx.fillStyle = '#fff'; ctx.strokeStyle = C.bronze; ctx.lineWidth = 1.5; roundRect(ctx, -tw / 2 - 6, -11, tw + 12, 22, 6); ctx.fill(); ctx.stroke(); ctx.fillStyle = '#9A5F1C'; }
      else ctx.fillStyle = C.gun;
      ctx.fillText(t, 0, 0); ctx.restore();
      if (o.taken) { const tw = ctx.measureText(t).width; const vert = Math.abs(Math.sin(ang)) > 0.7; o.taken.push(vert ? { x: mx - fs * 0.6, y: my - tw / 2, w: fs * 1.2, h: tw } : { x: mx - tw / 2, y: my - fs * 0.6, w: tw, h: fs * 1.2 }); }
      if (o.dimHits) o.dimHits.push({ surfId: it.surface.id, i, x: mx, y: my, len });
    }
  }
  function roundRect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }

  function itemsBBox(items) {
    const pts = [];
    items.forEach(it => { const r = it.res ? it.res.region : Geo.surfaceRegion(it.surface); if (!r) return; const c = Math.cos(it.rot || 0), s = Math.sin(it.rot || 0); [[r.bb.x0, r.bb.y0], [r.bb.x1, r.bb.y0], [r.bb.x1, r.bb.y1], [r.bb.x0, r.bb.y1]].forEach(p => pts.push([p[0] * c - p[1] * s + it.off[0], p[0] * s + p[1] * c + it.off[1]])); });
    return Geo.bbox(pts.length ? pts : [[0, 0], [1000, 1000]]);
  }
  /* Render items to an offscreen canvas for export */
  function renderToCanvas(items, W, H, opts = {}) {
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');
    const bb = itemsBBox(items);
    const v = makeView(bb, W, H, opts.pad || 60);
    if (items.length > 1) v.cy += 10 / v.s;
    scene(ctx, W, H, v, items.map(i => ({ ...i, selected: items.length > 1 ? false : true })), { paper: '#FFFFFF', dimFont: opts.dimFont || 13, ids: opts.ids, labelScale: opts.labelScale || 1, setout: opts.setout, noBg: !opts.withBg, labelMode: opts.labelMode || 'auto', multi: false });
    return cv;
  }

  window.Render = { C, makeView, toS, toW, scene, renderToCanvas, itemsBBox };
})();
