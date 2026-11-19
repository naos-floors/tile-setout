/* Canvas renderer shared by the editor and exports */
(function () {
  'use strict';
  const C = { bronze: '#CE8B3E', gun: '#6D6E70', full: '#F7F2EB', cut: '#F0D6B0', notch: '#E6B572', sliver: '#F28B82', open: '#FFFFFF', bgArea: '#EDEDED', ink: '#2E2F31' };

  function makeView(bb, W, H, pad = 40) {
    const s = Math.min((W - pad * 2) / Math.max(bb.w, 1), (H - pad * 2) / Math.max(bb.h, 1));
    return { s, cx: (bb.x0 + bb.x1) / 2, cy: (bb.y0 + bb.y1) / 2 };
  }
  function toS(v, W, H, p) { return [(p[0] - v.cx) * v.s + W / 2, H / 2 - (p[1] - v.cy) * v.s]; }
  function toW(v, W, H, sx, sy) { return [(sx - W / 2) / v.s + v.cx, (H / 2 - sy) / v.s + v.cy]; }

  function path(ctx, ring, f) { ring.forEach((p, i) => { const q = f(p); i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]); }); ctx.closePath(); }

  function draw(ctx, W, H, v, surface, tile, res, o = {}) {
    const f = p => toS(v, W, H, p);
    ctx.save();
    ctx.fillStyle = o.paper || '#FAFAFA'; ctx.fillRect(0, 0, W, H);
    // background drawing
    if (o.bgImg && surface.bg) {
      const b = surface.bg;
      const tl = f([b.x, b.y]);
      const sc = b.mmPerPx * v.s;
      ctx.globalAlpha = b.opacity ?? 0.5;
      ctx.drawImage(o.bgImg, tl[0], tl[1], o.bgImg.width * sc, o.bgImg.height * sc);
      ctx.globalAlpha = 1;
    }
    const region = res ? res.region : Geo.surfaceRegion(surface);
    if (region) {
      // area fill
      ctx.beginPath(); path(ctx, region.outline, f);
      region.ops.forEach(op => path(ctx, Geo.rectPts(+op.x, +op.y, +op.w, +op.h), f));
      ctx.fillStyle = o.bgImg ? 'rgba(237,237,237,0.35)' : C.bgArea; ctx.fill('evenodd');
      const lw = Math.max(0.5, Math.min(1.2, v.s * 2));
      if (o.raw && o.raw.length) {
        ctx.save(); ctx.beginPath(); path(ctx, region.outline, f);
        region.ops.forEach(op => path(ctx, Geo.rectPts(+op.x, +op.y, +op.w, +op.h), f));
        ctx.clip('evenodd');
        ctx.fillStyle = o.bgImg ? 'rgba(247,242,235,0.7)' : C.full; ctx.strokeStyle = C.gun; ctx.lineWidth = lw;
        for (const t of o.raw) { ctx.beginPath(); path(ctx, t.pts, f); ctx.fill(); ctx.stroke(); }
        ctx.restore();
      } else if (res) {
        const alpha = o.bgImg ? 0.75 : 1;
        ctx.globalAlpha = alpha;
        for (const p of res.pieces) {
          ctx.beginPath(); p.poly.forEach(r => path(ctx, r, f));
          ctx.fillStyle = p.kind === 'full' ? C.full : p.sliver ? C.sliver : p.kind === 'cut' ? C.cut : C.notch;
          ctx.fill('evenodd'); ctx.strokeStyle = C.gun; ctx.lineWidth = lw; ctx.stroke();
        }
        ctx.globalAlpha = 1;
        // labels
        if (o.labels !== false) {
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          const LS = o.labelScale || 1;
          for (const p of res.pieces) {
            const b = Geo.bbox(p.poly[0]); const sw = b.w * v.s, sh = b.h * v.s;
            const lp = p.kind === 'cut' || p.kind === 'full' ? { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2, r: Math.min(b.w, b.h) / 2 } : labelPoint(p.poly, b);
            const c = f([lp.x, lp.y]);
            const room = lp.r * 2 * v.s; // clear width around label point
            if (p.kind !== 'full' && room > 14 * LS && Math.max(sw, sh) > 36 * LS) {
              const txt = `${Math.round(p.w)}×${Math.round(p.h)}`;
              const vertical = p.kind === 'cut' && sh > sw * 1.3;
              const along = p.kind === 'cut' ? (vertical ? sh : sw) : Math.max(room * 1.6, Math.min(sw, sh));
              let fs = Math.min(13 * LS, room / 2.6);
              ctx.font = `600 ${fs}px "Myriad Pro", system-ui, sans-serif`;
              const tw = ctx.measureText(txt).width; if (tw > along - 6) fs *= (along - 6) / tw;
              if (fs < 6.5 * LS) continue;
              ctx.font = `600 ${fs}px "Myriad Pro", system-ui, sans-serif`;
              ctx.fillStyle = p.sliver ? '#8B1A12' : C.ink;
              ctx.save(); ctx.translate(c[0], c[1]); if (vertical) ctx.rotate(-Math.PI / 2);
              ctx.fillText(txt, 0, o.ids ? -fs * 0.55 : 0);
              if (o.ids) { ctx.font = `${fs * 0.85}px system-ui, sans-serif`; ctx.fillStyle = C.gun; ctx.fillText('#' + p.id, 0, fs * 0.6); }
              ctx.restore();
            } else if (o.ids && room > 12 * LS) {
              ctx.font = `${Math.min(11 * LS, room / 2.5)}px system-ui`; ctx.fillStyle = C.gun; ctx.fillText('#' + p.id, c[0], c[1]);
            }
          }
        }
      }
      // openings
      region.ops.forEach((op, i) => {
        const pts = Geo.rectPts(+op.x, +op.y, +op.w, +op.h);
        ctx.beginPath(); path(ctx, pts, f); ctx.fillStyle = o.bgImg ? 'rgba(255,255,255,0.55)' : C.open; ctx.fill();
        ctx.save(); ctx.clip(); ctx.strokeStyle = 'rgba(109,110,112,0.35)'; ctx.lineWidth = 1;
        const a = f([+op.x, +op.y]), b = f([+op.x + +op.w, +op.y + +op.h]);
        for (let x = a[0] - (a[1] - b[1]); x < b[0]; x += 10) { ctx.beginPath(); ctx.moveTo(x, a[1]); ctx.lineTo(x + (a[1] - b[1]), b[1]); ctx.stroke(); }
        ctx.restore();
        ctx.strokeStyle = o.selOpening === i ? C.bronze : C.gun; ctx.lineWidth = o.selOpening === i ? 2.5 : 1.5; ctx.beginPath(); path(ctx, pts, f); ctx.stroke();
        const c = f([+op.x + op.w / 2, +op.y + op.h / 2]);
        ctx.font = '600 12px system-ui, sans-serif'; ctx.fillStyle = C.ink; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        if (Math.abs(b[0] - a[0]) > 40) ctx.fillText(op.name || op.type, c[0], c[1]);
      });
      // outline + dims
      ctx.beginPath(); path(ctx, region.outline, f); ctx.strokeStyle = C.ink; ctx.lineWidth = 2; ctx.stroke();
      if (o.dims !== false) drawDims(ctx, region.outline, f, o);
      if (o.vertices) { region.outline.forEach((p, i) => { const q = f(p); ctx.beginPath(); ctx.arc(q[0], q[1], o.selVertex === i ? 9 : 6, 0, 7); ctx.fillStyle = o.selVertex === i ? C.bronze : '#fff'; ctx.fill(); ctx.strokeStyle = C.bronze; ctx.lineWidth = 2; ctx.stroke(); }); }
    }
    // batten
    const bat = surface.settings && surface.settings.battenY;
    if (bat !== '' && bat != null && region) {
      const a = f([region.bb.x0 - 100, +bat]), b = f([region.bb.x1 + 100, +bat]);
      ctx.setLineDash([8, 5]); ctx.strokeStyle = '#2563EB'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = '#2563EB'; ctx.font = '11px system-ui'; ctx.textAlign = 'left'; ctx.fillText(`batten ${bat}`, b[0] - 70, b[1] - 6);
    }
    // origin marker
    if (o.origin !== false && surface.pattern) {
      const q = f([+surface.pattern.ox || 0, +surface.pattern.oy || 0]);
      ctx.strokeStyle = C.bronze; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(q[0], q[1], 7, 0, 7); ctx.moveTo(q[0] - 12, q[1]); ctx.lineTo(q[0] + 12, q[1]); ctx.moveTo(q[0], q[1] - 12); ctx.lineTo(q[0], q[1] + 12); ctx.stroke();
    }
    // trace overlay
    if (o.trace && o.trace.length) {
      ctx.strokeStyle = '#2563EB'; ctx.fillStyle = '#2563EB'; ctx.lineWidth = 2;
      ctx.beginPath(); o.trace.forEach((p, i) => { const q = f(p); i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]); }); ctx.stroke();
      o.trace.forEach(p => { const q = f(p); ctx.beginPath(); ctx.arc(q[0], q[1], 5, 0, 7); ctx.fill(); });
    }
    if (o.calib && o.calib.length) {
      ctx.strokeStyle = '#DC2626'; ctx.fillStyle = '#DC2626'; ctx.lineWidth = 2;
      ctx.beginPath(); o.calib.forEach((p, i) => { const q = f(p); i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]); }); ctx.stroke();
      o.calib.forEach(p => { const q = f(p); ctx.beginPath(); ctx.arc(q[0], q[1], 6, 0, 7); ctx.fill(); });
    }
    ctx.restore();
  }

  function labelPoint(poly, b) {
    // best interior point: grid search for the point furthest from any edge
    let best = { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2, r: 0 };
    const N = 9;
    for (let i = 1; i < N; i++) for (let j = 1; j < N; j++) {
      const x = b.x0 + b.w * i / N, y = b.y0 + b.h * j / N;
      let inside = pip([x, y], poly[0]); for (let k = 1; k < poly.length && inside; k++) if (pip([x, y], poly[k])) inside = false;
      if (!inside) continue;
      let d = Infinity; for (const r of poly) for (let k = 0; k < r.length; k++) d = Math.min(d, segD([x, y], r[k], r[(k + 1) % r.length]));
      if (d > best.r) best = { x, y, r: d };
    }
    return best;
  }
  function pip(pt, r) { let c = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { if (((r[i][1] > pt[1]) !== (r[j][1] > pt[1])) && (pt[0] < (r[j][0] - r[i][0]) * (pt[1] - r[i][1]) / (r[j][1] - r[i][1]) + r[i][0])) c = !c; } return c; }
  function segD(p, a, b) { const dx = b[0] - a[0], dy = b[1] - a[1]; const l = dx * dx + dy * dy || 1; let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l; t = Math.max(0, Math.min(1, t)); return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy); }

  function drawDims(ctx, ring, f, o) {
    const n = ring.length;
    // orientation: outward normal for anticlockwise ring is to the right of edge direction
    const area = Geo.ringArea(ring); const sign = area >= 0 ? 1 : -1;
    ctx.font = `${o.dimFont || 11}px system-ui, sans-serif`; ctx.fillStyle = C.gun; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let i = 0; i < n; i++) {
      const p = ring[i], q = ring[(i + 1) % n];
      const len = Math.hypot(q[0] - p[0], q[1] - p[1]); if (len < 1) continue;
      const a = f(p), b = f(q); const sl = Math.hypot(b[0] - a[0], b[1] - a[1]); if (sl < 30) continue;
      let nx = (b[1] - a[1]) / sl, ny = -(b[0] - a[0]) / sl; // screen normal (y down flips)
      nx *= -sign; ny *= -sign;
      const mx = (a[0] + b[0]) / 2 + nx * 14, my = (a[1] + b[1]) / 2 + ny * 14;
      let ang = Math.atan2(b[1] - a[1], b[0] - a[0]); if (ang > Math.PI / 2) ang -= Math.PI; if (ang < -Math.PI / 2) ang += Math.PI;
      ctx.save(); ctx.translate(mx, my); ctx.rotate(ang); ctx.fillText(`${Math.round(len)}`, 0, 0); ctx.restore();
    }
  }

  /* Render a surface to an offscreen canvas for export */
  function renderToCanvas(surface, tile, res, W, H, opts = {}) {
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');
    const bb = res ? res.region.bb : Geo.bbox(surface.outline);
    const v = makeView(bb, W, H, opts.pad || 60);
    draw(ctx, W, H, v, surface, tile, res, { paper: '#FFFFFF', origin: false, dimFont: opts.dimFont || 13, ids: opts.ids, bgImg: opts.bgImg, labelScale: opts.labelScale || 1 });
    return cv;
  }

  window.Render = { C, makeView, toS, toW, draw, renderToCanvas };
})();
