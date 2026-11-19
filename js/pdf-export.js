/* PDF export with Naos branding (jsPDF) */
(function () {
  'use strict';
  const BRONZE = [206, 139, 62], GUN = [109, 110, 112], INK = [46, 47, 49], GREEN = [21, 128, 61];
  const PW = 210, PH = 297, M = 14;

  function header(doc, job, title) {
    doc.setFillColor(...GUN); doc.rect(0, 0, PW, 18, 'F');
    doc.setFillColor(...BRONZE); doc.rect(0, 18, PW, 1.2, 'F');
    doc.setTextColor(255, 255, 255); doc.setFont('helvetica', 'bold'); doc.setFontSize(15);
    doc.text('NAOS', M, 11.5); doc.setFont('helvetica', 'normal'); doc.setTextColor(...BRONZE); doc.text('FLOORS', M + 17, 11.5);
    doc.setTextColor(255, 255, 255); doc.setFontSize(9);
    doc.text(title, PW - M, 8, { align: 'right' });
    doc.text(job.name || '', PW - M, 13, { align: 'right' });
    doc.setTextColor(...INK);
  }
  function footer(doc, n) {
    doc.setFontSize(7.5); doc.setTextColor(...GUN);
    doc.text('Naos Floors Ltd · 16–17 Vale Rise, Tonbridge, Kent TN9 1TB · 01732 770 222 · www.naosfloors.com', M, PH - 8);
    doc.text(`Page ${n}`, PW - M, PH - 8, { align: 'right' });
    doc.text('Set-out and quantities are a guide: check all measurements on site. Work to BS 5385 and manufacturers’ instructions.', M, PH - 4.5);
    doc.setTextColor(...INK);
  }
  function table(doc, y, cols, rows, opts = {}) {
    const widths = cols.map(c => c.w); const x0 = M; const rowH = 6; const tw = widths.reduce((a, b) => a + b, 0);
    const head = () => {
      doc.setFillColor(240, 233, 224); doc.rect(x0, y, tw, rowH, 'F');
      doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5);
      let x = x0; cols.forEach((c, i) => { doc.text(String(c.label), c.align === 'right' ? x + widths[i] - 2 : x + 2, y + 4.2, { align: c.align === 'right' ? 'right' : 'left' }); x += widths[i]; });
      y += rowH; doc.setFont('helvetica', 'normal');
    };
    head();
    rows.forEach((r, ri) => {
      if (y > PH - 22) { opts.newPage(); y = 26; head(); }
      if (ri % 2) { doc.setFillColor(250, 248, 245); doc.rect(x0, y, tw, rowH, 'F'); }
      let x = x0; if (r._flag) doc.setTextColor(180, 40, 30);
      r.forEach((cell, i) => {
        const c = cols[i]; let t = String(cell ?? '');
        const maxW = widths[i] - 3; while (doc.getTextWidth(t) > maxW && t.length > 3) t = t.slice(0, -2) + '…';
        doc.text(t, c.align === 'right' ? x + widths[i] - 2 : x + 2, y + 4.2, { align: c.align === 'right' ? 'right' : 'left' });
        x += widths[i];
      });
      doc.setTextColor(...INK); y += rowH;
    });
    return y + 3;
  }
  function h2(doc, y, t) { doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(...BRONZE); doc.text(t, M, y); doc.setTextColor(...INK); doc.setFont('helvetica', 'normal'); return y + 2.5; }

  function matRows(m) {
    const rows = [];
    rows.push(['Tiled area', `${m.m2.toFixed(2)} m²`, '']);
    m.tiles.forEach(t => rows.push([`Tiles ${t.label}`, `${t.needed} needed · ${t.order} with ${m.spare}% spare`, t.boxes != null ? `${t.boxes} boxes` : `${t.m2.toFixed(2)} m²`]));
    if (m.modularBoxes) rows.push(['Modular packs', '', `${m.modularBoxes} packs`]);
    rows.push([m.adhesive.name, `${m.adhesive.coverage} m² per bag`, `${m.adhesive.bags} × ${m.adhesive.bagKg} kg`]);
    rows.push([m.grout.name, `${m.grout.kg.toFixed(1)} kg (${m.grout.kgPerM2.toFixed(2)} kg/m²)`, `${m.grout.bags} × ${m.grout.bagKg} kg`]);
    if (m.primer.litres > 0) rows.push([m.primer.name, `${m.primer.litres.toFixed(1)} L`, `${m.primer.units} × ${m.primer.unitL} L`]);
    if (m.trim.m > 0) rows.push(['Trim', `${m.trim.m.toFixed(1)} m`, `${m.trim.lengths} lengths`]);
    if (m.spacers.count > 0) rows.push(['Spacers / clips', `${m.spacers.count}`, `${m.spacers.packs} packs`]);
    (m.thresholds || []).forEach(t => rows.push([`Threshold: ${t.name}`, '', `${t.w} mm`]));
    (m.units || []).forEach(u => rows.push([`Under ${u.name}`, `${u.m2.toFixed(2)} m² (about ${u.tiles} tiles)`, 'included']));
    return rows;
  }

  function drawingBlock(doc, items, y, maxH, opts) {
    const bb = Render.itemsBBox(items); const imgW = PW - 2 * M;
    const imgH = Math.min(maxH, imgW * bb.h / Math.max(bb.w, 1) + 22);
    const pxW = 1900, pxH = Math.round(pxW * imgH / imgW);
    const cv = Render.renderToCanvas(items, pxW, pxH, { pad: 95, dimFont: 26, labelScale: 2.2, ids: opts.ids, setout: opts.setout, withBg: opts.withBg });
    doc.addImage(cv.toDataURL('image/jpeg', 0.9), 'JPEG', M, y, imgW, imgH); y += imgH + 4;
    const leg = [['Full', [247, 242, 235]], ['Cut', [240, 214, 176]], ['Notched/angled', [230, 181, 114]], ['Sliver', [242, 139, 130]]];
    let lx = M; doc.setFontSize(8);
    leg.forEach(([t, col]) => { doc.setFillColor(...col); doc.setDrawColor(...GUN); doc.rect(lx, y - 3, 4, 4, 'FD'); doc.text(t, lx + 5.5, y); lx += doc.getTextWidth(t) + 12; });
    if (opts.setout) { doc.setTextColor(...GREEN); doc.text('Green = set-out point and joint lines', lx, y); doc.setTextColor(...INK); }
    return y + 5;
  }

  function areaSection(doc, it, y, opts, newPage, showDrawing) {
    const s = it.surface, st = it.res.stats, p = s.pattern, t = it.tile;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(14); doc.text(`${it.room ? it.room.name + ' — ' : ''}${s.name}`, M, y); y += 5.5;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...GUN);
    doc.text(`${s.kind === 'wall' ? 'Wall' : 'Floor'} · ${t.name} (${t.w}×${t.h}) · ${Geo.PATTERNS[p.type]?.name} · ${p.joint} mm joint${+p.rotation ? ` · rotated ${p.rotation}°` : ''} · ${(it.res.netArea / 1e6).toFixed(2)} m²`, M, y); y += 4.5;
    doc.text(`Smallest cut ${st.minCut != null ? Math.round(st.minCut) + ' mm' : '-'} · ${st.slivers} sliver${st.slivers === 1 ? '' : 's'} · ${st.needed} tiles`, M, y); y += 4.5;
    if (it.ref && opts.setout) { doc.setTextColor(...GREEN); doc.setFont('helvetica', 'bold'); doc.text(`Set-out point: ${Math.round(it.ref.dims.left)} mm from left, ${Math.round(it.ref.dims.bottom)} mm from ${s.kind === 'wall' ? 'floor' : 'bottom'}${it.ref.dirs.length ? ' — on the joint line(s) shown in green' : ''}`, M, y); doc.setFont('helvetica', 'normal'); y += 4.5; }
    doc.setTextColor(...INK);
    if (showDrawing) y = drawingBlock(doc, [{ ...it, off: [0, 0], noSideDims: false }], y, 140, opts);
    (it.res.units || []).forEach(u => { const fr = u.fronts.filter(f => f.dist != null).map(f => `${f.edge}: ${f.side === 'on' ? 'joint on line' : `joint ${f.dist} mm ${f.side === 'under' ? 'under' : 'out'}`}`).join(', '); doc.setFontSize(8.5); doc.text(`${u.name} (tiled under): ${u.m2.toFixed(2)} m² underneath. ${fr}`, M, y + 2); y += 5; });
    y = h2(doc, y + 2, 'Cut list (mm)');
    const sizes = it.res.sizes;
    const per = st.per.map(z => `${z.label}: ${z.full} full, ${z.cut + z.notch} cut${z.fromOffcut ? ` (${z.fromOffcut} from offcuts)` : ''}, ${z.needed} tiles`).join(' · ');
    doc.setFontSize(8.5); const pl = doc.splitTextToSize(per, PW - 2 * M); doc.text(pl, M, y + 3); y += pl.length * 4 + 2;
    const multi = sizes.length > 1;
    const rows = it.cuts.map(g => { const r = [multi ? sizes[g.sizeIdx].label : '', g.desc, g.count, g.offcut ? `${g.offcut} from offcut` : '', g.sliver ? 'SLIVER' : '', g.ids.length <= 8 ? g.ids.map(i => '#' + i).join(' ') : `${g.ids.length} pieces`]; if (g.sliver) r._flag = true; return r; });
    if (!multi) rows.forEach(r => r.shift());
    y = table(doc, y, multi ? [{ label: 'Tile', w: 26 }, { label: 'Piece', w: 62 }, { label: 'Qty', w: 12, align: 'right' }, { label: 'Source', w: 26 }, { label: 'Flag', w: 16 }, { label: 'Pieces', w: 40 }] : [{ label: 'Piece', w: 76 }, { label: 'Qty', w: 14, align: 'right' }, { label: 'Source', w: 30 }, { label: 'Flag', w: 18 }, { label: 'Pieces', w: 44 }], rows, { newPage });
    if (y > PH - 70) { newPage(); y = 27; }
    y = h2(doc, y, 'Materials for this area');
    return table(doc, y, [{ label: 'Item', w: 72 }, { label: 'Quantity', w: 70 }, { label: 'Order', w: 40, align: 'right' }], matRows(it.mat), { newPage });
  }

  function viewPages(doc, job, view, opts, ctx) {
    const items = view.items.filter(i => i.res);
    if (!items.length) return;
    ctx.newPage();
    let y = 27;
    if (items.length > 1) {
      doc.setFont('helvetica', 'bold'); doc.setFontSize(14); doc.text(view.title, M, y); y += 5;
      doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...GUN); doc.text(`${items.length} areas set out together · ${items.reduce((a, i) => a + i.res.stats.needed, 0)} tiles`, M, y); doc.setTextColor(...INK); y += 3;
      drawingBlock(doc, items, y, 215, opts);
      items.forEach(it => { ctx.newPage(); areaSection(doc, it, 27, opts, ctx.newPage, true); });
    } else areaSection(doc, items[0], y, opts, ctx.newPage, true);
  }

  async function exportJob(job, views, totals, opts = {}) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    let page = 1;
    const ctx = { newPage: () => { footer(doc, page); doc.addPage(); page++; header(doc, job, 'Tile set-out'); } };
    header(doc, job, 'Tile set-out & materials');
    let y = 30;
    doc.setFontSize(18); doc.setFont('helvetica', 'bold'); doc.text(job.name || 'Job', M, y); y += 7;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
    [job.client && `Client: ${job.client}`, job.address && `Site: ${job.address}`, `Date: ${new Date().toLocaleDateString('en-GB')}`].filter(Boolean).forEach(l => { doc.text(l, M, y); y += 5; });
    if (job.notes) { const ls = doc.splitTextToSize(job.notes, PW - 2 * M); doc.text(ls, M, y); y += ls.length * 4.5; }
    y = h2(doc, y + 3, 'Order list — whole job');
    y = table(doc, y, [{ label: 'Item', w: 72 }, { label: 'Quantity', w: 70 }, { label: 'Order', w: 40, align: 'right' }], totals.rows, { newPage: ctx.newPage });
    y = h2(doc, y + 2, 'Areas');
    const areaRows = totals.all.map(c => [c.room.name, c.surface.name, c.surface.kind, c.tile ? c.tile.name : '-', Geo.PATTERNS[c.surface.pattern.type]?.name || '', c.res ? (c.res.netArea / 1e6).toFixed(2) : '-']);
    table(doc, y, [{ label: 'Room', w: 32 }, { label: 'Area', w: 36 }, { label: 'Type', w: 14 }, { label: 'Tile', w: 42 }, { label: 'Pattern', w: 40 }, { label: 'm²', w: 18, align: 'right' }], areaRows, { newPage: ctx.newPage });
    views.forEach(v => viewPages(doc, job, v, opts, ctx));
    footer(doc, page);
    return doc;
  }

  async function exportView(job, view, opts = {}) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    let page = 1; let first = true;
    const ctx = { newPage: () => { if (first) { first = false; header(doc, job, 'Tile set-out'); return; } footer(doc, page); doc.addPage(); page++; header(doc, job, 'Tile set-out'); } };
    viewPages(doc, job, view, opts, ctx);
    footer(doc, page);
    return doc;
  }

  window.PDFX = { exportJob, exportView, matRows };
})();
