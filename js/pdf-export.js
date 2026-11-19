/* PDF export with Naos branding (jsPDF) */
(function () {
  'use strict';
  const BRONZE = [206, 139, 62], GUN = [109, 110, 112], INK = [46, 47, 49];
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
    const widths = cols.map(c => c.w); const x0 = M;
    const rowH = 6;
    const head = () => {
      doc.setFillColor(...(opts.headFill || [240, 233, 224])); doc.rect(x0, y, widths.reduce((a, b) => a + b, 0), rowH, 'F');
      doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5);
      let x = x0; cols.forEach((c, i) => { doc.text(String(c.label), c.align === 'right' ? x + widths[i] - 2 : x + 2, y + 4.2, { align: c.align === 'right' ? 'right' : 'left' }); x += widths[i]; });
      y += rowH; doc.setFont('helvetica', 'normal');
    };
    head();
    rows.forEach((r, ri) => {
      if (y > PH - 22) { opts.newPage(); y = 26; head(); }
      if (ri % 2) { doc.setFillColor(250, 248, 245); doc.rect(x0, y, widths.reduce((a, b) => a + b, 0), rowH, 'F'); }
      let x = x0;
      if (r._flag) doc.setTextColor(180, 40, 30);
      r.forEach((cell, i) => {
        const c = cols[i]; let t = String(cell ?? '');
        const maxW = widths[i] - 3; while (doc.getTextWidth(t) > maxW && t.length > 3) t = t.slice(0, -2) + '…';
        doc.text(t, c.align === 'right' ? x + widths[i] - 2 : x + 2, y + 4.2, { align: c.align === 'right' ? 'right' : 'left' });
        x += widths[i];
      });
      doc.setTextColor(...INK);
      y += rowH;
    });
    return y + 3;
  }

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
    return rows;
  }

  async function exportJob(job, calcAll, totals, opts = {}) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    let page = 1;
    const newPage = () => { footer(doc, page); doc.addPage(); page++; header(doc, job, 'Tile set-out'); };
    header(doc, job, 'Tile set-out & materials');
    let y = 30;
    doc.setFontSize(18); doc.setFont('helvetica', 'bold'); doc.text(job.name || 'Job', M, y); y += 7;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
    [job.client && `Client: ${job.client}`, job.address && `Site: ${job.address}`, `Date: ${new Date().toLocaleDateString('en-GB')}`].filter(Boolean).forEach(l => { doc.text(l, M, y); y += 5; });
    if (job.notes) { const ls = doc.splitTextToSize(job.notes, PW - 2 * M); doc.text(ls, M, y); y += ls.length * 4.5; }
    y += 3;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.setTextColor(...BRONZE); doc.text('Order list — whole job', M, y); doc.setTextColor(...INK); y += 3;
    y = table(doc, y, [{ label: 'Item', w: 72 }, { label: 'Quantity', w: 70 }, { label: 'Order', w: 40, align: 'right' }], totals.rows, { newPage });
    y += 2;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.setTextColor(...BRONZE); doc.text('Areas', M, y); doc.setTextColor(...INK); y += 3;
    const areaRows = [];
    calcAll.forEach(c => areaRows.push([c.room.name, c.surface.name, c.surface.kind, c.tile ? c.tile.name : '-', Geo.PATTERNS[c.surface.pattern.type]?.name || '', c.res ? c.res.netArea / 1e6 : 0]));
    y = table(doc, y, [{ label: 'Room', w: 32 }, { label: 'Area', w: 36 }, { label: 'Type', w: 14 }, { label: 'Tile', w: 42 }, { label: 'Pattern', w: 40 }, { label: 'm²', w: 18, align: 'right' }], areaRows.map(r => { r[5] = r[5].toFixed(2); return r; }), { newPage });

    for (const c of calcAll) {
      if (!c.res) continue;
      newPage();
      let yy = 27;
      doc.setFont('helvetica', 'bold'); doc.setFontSize(14); doc.text(`${c.room.name} — ${c.surface.name}`, M, yy); yy += 5.5;
      doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...GUN);
      const st = c.res.stats; const p = c.surface.pattern;
      doc.text(`${c.surface.kind === 'wall' ? 'Wall' : 'Floor'} · ${c.tile.name} (${c.tile.w}×${c.tile.h}) · ${Geo.PATTERNS[p.type]?.name} · ${p.joint} mm joint${+p.rotation ? ` · rotated ${p.rotation}°` : ''} · ${(c.res.netArea / 1e6).toFixed(2)} m²`, M, yy); yy += 4.5;
      doc.text(`Start: ${c.surface.startLabel || 'custom'} · origin x ${Math.round(p.ox)}, y ${Math.round(p.oy)} mm · smallest cut ${st.minCut != null ? Math.round(st.minCut) + ' mm' : '-'} · ${st.slivers} sliver${st.slivers === 1 ? '' : 's'}`, M, yy); yy += 3;
      doc.setTextColor(...INK);
      // drawing
      const bb = c.res.region.bb; const ar = bb.h / Math.max(bb.w, 1);
      const imgW = PW - 2 * M; let imgH = Math.min(150, imgW * ar + 20);
      const pxW = 1800, pxH = Math.round(pxW * imgH / imgW);
      const cv = Render.renderToCanvas(c.surface, c.tile, c.res, pxW, pxH, { pad: 90, dimFont: 26, labelScale: 2.2, ids: opts.ids, bgImg: opts.withDrawing ? c.bgImg : null });
      // scale fonts for print: renderer uses px; acceptable
      doc.addImage(cv.toDataURL('image/jpeg', 0.9), 'JPEG', M, yy, imgW, imgH); yy += imgH + 4;
      // legend
      const leg = [['Full', [247, 242, 235]], ['Cut', [240, 214, 176]], ['Notched/angled', [230, 181, 114]], ['Sliver', [242, 139, 130]]];
      let lx = M; doc.setFontSize(8);
      leg.forEach(([t, col]) => { doc.setFillColor(...col); doc.setDrawColor(...GUN); doc.rect(lx, yy - 3, 4, 4, 'FD'); doc.text(t, lx + 5.5, yy); lx += doc.getTextWidth(t) + 12; });
      yy += 5;
      doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(...BRONZE); doc.text('Cut list (mm)', M, yy); doc.setTextColor(...INK); yy += 2.5;
      const sizes = c.res.unit.sizes;
      const per = st.per.map(s => `${s.label}: ${s.full} full, ${s.cut + s.notch} cut${s.fromOffcut ? ` (${s.fromOffcut} from offcuts)` : ''}, ${s.needed} tiles`).join(' · ');
      doc.setFontSize(8.5); const pl = doc.splitTextToSize(per, PW - 2 * M); doc.text(pl, M, yy + 3); yy += pl.length * 4 + 2;
      const multi = sizes.length > 1;
      const rows = c.cuts.map(g => { const r = [multi ? sizes[g.sizeIdx].label : '', g.desc, g.count, g.offcut ? `${g.offcut} from offcut` : '', g.sliver ? 'SLIVER' : '', g.ids.length <= 8 ? g.ids.map(i => '#' + i).join(' ') : `${g.ids.length} pieces`]; if (g.sliver) r._flag = true; return r; });
      if (!multi) rows.forEach(r => r.shift());
      yy = table(doc, yy, multi ? [{ label: 'Tile', w: 22 }, { label: 'Piece', w: 62 }, { label: 'Qty', w: 12, align: 'right' }, { label: 'Source', w: 28 }, { label: 'Flag', w: 16 }, { label: 'Pieces', w: 42 }] : [{ label: 'Piece', w: 76 }, { label: 'Qty', w: 14, align: 'right' }, { label: 'Source', w: 30 }, { label: 'Flag', w: 18 }, { label: 'Pieces', w: 44 }], rows, { newPage });
      if (yy > PH - 70) { newPage(); yy = 27; }
      doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(...BRONZE); doc.text('Materials for this area', M, yy); doc.setTextColor(...INK); yy += 2.5;
      table(doc, yy, [{ label: 'Item', w: 72 }, { label: 'Quantity', w: 70 }, { label: 'Order', w: 40, align: 'right' }], matRows(c.mat), { newPage });
    }
    footer(doc, page);
    return doc;
  }

  window.PDFX = { exportJob, matRows };
})();
