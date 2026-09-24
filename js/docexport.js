/* ==========================================================================
   docexport.js — Writer → .docx / .pdf with inline formatting.
   The editor DOM is flattened into blocks (paragraphs, headings, list
   items, tables, code, rules) whose text is a list of styled runs. Styles
   come from getComputedStyle, so whatever the page shows — bold spans,
   <font> colors, highlight, links, font sizes — is what gets exported.
   Both writers consume the same block list.
   ========================================================================== */

const DocExport = (() => {
  const BLOCK_TAGS = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'TABLE',
    'PRE', 'BLOCKQUOTE', 'HR', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'FIGURE', 'ADDRESS']);
  const MAX_IMG_W = 624;   // 6.5in content width at 96 px/in

  // ---------- Colors ----------
  function parseColor(css) {
    const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/.exec(css || '');
    if (!m) return null;
    if (m[4] !== undefined && +m[4] === 0) return null;   // transparent
    return [+m[1], +m[2], +m[3]];
  }
  const hex = (rgb) => rgb.map(v => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase();

  // ---------- Block extraction ----------
  function collect(root) {
    const blocks = [];
    const styleCache = new Map();
    const rootCs = getComputedStyle(root);
    const defaults = {
      color: hex(parseColor(rootCs.color) || [0, 0, 0]),
      font: firstFamily(rootCs.fontFamily),
      sizePt: parseFloat(rootCs.fontSize) * 0.75,
    };
    let listInstance = 0;

    function firstFamily(ff) { return (ff || '').split(',')[0].replace(/["']/g, '').trim() || null; }

    function styleOf(el) {
      if (styleCache.has(el)) return styleCache.get(el);
      const cs = getComputedStyle(el);
      let underline = false, strike = false, highlight = null;
      for (let n = el; n && n !== root; n = n.parentElement) {
        const ncs = n === el ? cs : getComputedStyle(n);
        const deco = ncs.textDecorationLine || ncs.textDecoration || '';
        if (deco.includes('underline')) underline = true;
        if (deco.includes('line-through')) strike = true;
        if (!highlight && !BLOCK_TAGS.has(n.tagName)) {
          const bg = parseColor(ncs.backgroundColor);
          if (bg) highlight = hex(bg);
        }
      }
      const link = el.closest('a[href]');
      const s = {
        bold: parseInt(cs.fontWeight, 10) >= 600,
        italic: cs.fontStyle === 'italic' || cs.fontStyle === 'oblique',
        underline, strike, highlight,
        color: hex(parseColor(cs.color) || [0, 0, 0]),
        font: firstFamily(cs.fontFamily),
        sizePt: Math.round(parseFloat(cs.fontSize) * 0.75 * 2) / 2,
        link: link && root.contains(link) ? link.getAttribute('href') : null,
        sup: !!el.closest('sup'),
        sub: !!el.closest('sub'),
      };
      styleCache.set(el, s);
      return s;
    }

    function imageOf(img) {
      if (!img.complete || !img.naturalWidth) return null;
      let w = img.getBoundingClientRect().width || img.naturalWidth;
      let h = img.getBoundingClientRect().height || img.naturalHeight;
      if (w > MAX_IMG_W) { h = h * MAX_IMG_W / w; w = MAX_IMG_W; }
      try {
        // Re-encode as PNG: jsPDF and Word both handle it, whatever the source.
        const scale = Math.min(1, 2000 / img.naturalWidth);
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.naturalWidth * scale));
        c.height = Math.max(1, Math.round(img.naturalHeight * scale));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        return { dataUrl: c.toDataURL('image/png'), w, h };
      } catch (e) {
        return null;   // cross-origin image: the canvas is tainted
      }
    }

    // Inline content of `nodes` as runs. Nested blocks inside inline
    // content (e.g. <p> inside <li>) become line breaks; nested lists are
    // skipped here because the list walker emits them as their own items.
    function runsOf(nodes) {
      const runs = [];
      const lastText = () => { for (let i = runs.length - 1; i >= 0; i--) { if (runs[i].br) return null; if (runs[i].text != null) return runs[i]; } return null; };
      const visit = (n) => {
        if (n.nodeType === 3) {
          let text = n.nodeValue.replace(/[\s]+/g, ' ');
          if (!text) return;
          const prev = lastText();
          if (text.startsWith(' ') && (!prev || prev.text.endsWith(' '))) text = text.slice(1);
          if (!text) return;
          runs.push(Object.assign({ text: text.replace(/ /g, ' ') }, styleOf(n.parentElement)));
        } else if (n.nodeType === 1) {
          const tag = n.tagName;
          if (tag === 'BR') runs.push({ br: true });
          else if (tag === 'IMG') { const img = imageOf(n); if (img) runs.push({ image: img }); }
          else if (tag === 'UL' || tag === 'OL') { /* emitted separately */ }
          else if (BLOCK_TAGS.has(tag)) {
            if (runs.length && !runs[runs.length - 1].br) runs.push({ br: true });
            n.childNodes.forEach(visit);
          } else n.childNodes.forEach(visit);
        }
      };
      nodes.forEach(visit);
      // Trim edges and trailing breaks.
      while (runs.length && runs[runs.length - 1].br) runs.pop();
      const first = runs.find(r => r.text != null);
      if (first) first.text = first.text.replace(/^ +/, '');
      for (let i = runs.length - 1; i >= 0; i--) {
        if (runs[i].text != null) { runs[i].text = runs[i].text.replace(/ +$/, ''); break; }
        if (!runs[i].br) break;
      }
      return runs.filter(r => r.text !== '');
    }

    const alignOf = (el) => {
      const a = getComputedStyle(el).textAlign;
      return a === 'center' ? 'center' : (a === 'right' || a === 'end') ? 'right' : a === 'justify' ? 'justify' : 'left';
    };
    const hasContent = (runs) => runs.some(r => r.image || (r.text && r.text.trim()));

    function container(el, ctx) {
      let buf = [];
      const flush = () => {
        if (!buf.length) return;
        const runs = runsOf(buf);
        if (hasContent(runs)) blocks.push({ type: 'para', runs, align: alignOf(el), quote: ctx.quote });
        buf = [];
      };
      for (const node of el.childNodes) {
        if (node.nodeType === 1 && BLOCK_TAGS.has(node.tagName)) { flush(); block(node, ctx); }
        else buf.push(node);
      }
      flush();
    }

    function list(el, ctx, level) {
      const ordered = el.tagName === 'OL';
      const instance = ordered ? ++listInstance : 0;
      let n = ordered ? (parseInt(el.getAttribute('start'), 10) || 1) : 0;
      for (const li of el.children) {
        if (li.tagName === 'UL' || li.tagName === 'OL') { list(li, ctx, level + 1); continue; }
        const runs = runsOf([...li.childNodes]);
        blocks.push({ type: 'li', runs, level, ordered, instance, number: ordered ? n++ : 0, align: alignOf(li) });
        for (const sub of li.children) {
          if (sub.tagName === 'UL' || sub.tagName === 'OL') list(sub, ctx, level + 1);
        }
      }
    }

    function block(el, ctx) {
      const tag = el.tagName;
      if (/^H[1-6]$/.test(tag)) {
        blocks.push({ type: 'heading', level: +tag[1], runs: runsOf([...el.childNodes]), align: alignOf(el) });
      } else if (tag === 'UL' || tag === 'OL') {
        list(el, ctx, 0);
      } else if (tag === 'PRE') {
        const s = styleOf(el);
        blocks.push({ type: 'pre', text: el.textContent.replace(/\n$/, ''), color: s.color });
      } else if (tag === 'HR') {
        blocks.push({ type: 'hr' });
      } else if (tag === 'TABLE') {
        const rows = [...el.querySelectorAll('tr')].filter(tr => tr.closest('table') === el).map(tr =>
          [...tr.children].filter(c => c.tagName === 'TD' || c.tagName === 'TH').map(c => ({
            header: c.tagName === 'TH',
            runs: runsOf([...c.childNodes]),
          })));
        if (rows.length) blocks.push({ type: 'table', rows });
      } else if (tag === 'BLOCKQUOTE') {
        container(el, Object.assign({}, ctx, { quote: true }));
      } else if (tag === 'P' || tag === 'LI') {
        if ([...el.children].some(c => BLOCK_TAGS.has(c.tagName))) container(el, ctx);
        else {
          const runs = runsOf([...el.childNodes]);
          blocks.push({ type: 'para', runs, align: alignOf(el), quote: ctx.quote, empty: !hasContent(runs) });
        }
      } else {
        container(el, ctx);
      }
    }

    container(root, { quote: false });
    return { blocks, defaults };
  }

  function dataUrlBytes(dataUrl) {
    const bin = atob(dataUrl.split(',')[1] || '');
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // ---------- .docx ----------
  async function toDocx(root) {
    const D = window.docx;
    const { blocks } = collect(root);
    const ALIGN = {
      center: D.AlignmentType.CENTER, right: D.AlignmentType.RIGHT,
      justify: D.AlignmentType.JUSTIFIED || D.AlignmentType.BOTH,
    };

    function textRun(r, extra = {}) {
      return new D.TextRun(Object.assign({
        text: r.text,
        bold: r.bold || undefined,
        italics: r.italic || undefined,
        underline: r.underline ? {} : undefined,
        strike: r.strike || undefined,
        color: r.color,
        font: r.font || undefined,
        size: r.sizePt ? Math.round(r.sizePt * 2) : undefined,
        superScript: r.sup || undefined,
        subScript: r.sub || undefined,
        shading: r.highlight ? { type: D.ShadingType.CLEAR, color: 'auto', fill: r.highlight } : undefined,
      }, extra));
    }
    function runs(list, extra = {}) {
      const out = [];
      for (let i = 0; i < list.length; i++) {
        const r = list[i];
        if (r.br) { out.push(new D.TextRun({ text: '', break: 1 })); continue; }
        if (r.image) {
          out.push(new D.ImageRun({ data: dataUrlBytes(r.image.dataUrl), transformation: { width: r.image.w, height: r.image.h } }));
          continue;
        }
        if (r.link && /^(https?:|mailto:)/i.test(r.link)) {
          // Group consecutive runs of the same link into one hyperlink.
          const group = [];
          while (i < list.length && list[i].link === r.link && list[i].text != null) group.push(list[i++]);
          i--;
          out.push(new D.ExternalHyperlink({
            link: r.link,
            children: group.map(g => textRun(g, Object.assign({ style: 'Hyperlink' }, extra))),
          }));
          continue;
        }
        out.push(textRun(r, extra));
      }
      return out;
    }

    const children = [];
    for (const b of blocks) {
      if (b.type === 'heading') {
        children.push(new D.Paragraph({
          heading: D.HeadingLevel['HEADING_' + Math.min(6, b.level)],
          alignment: ALIGN[b.align], children: runs(b.runs),
        }));
      } else if (b.type === 'para') {
        children.push(new D.Paragraph({
          alignment: ALIGN[b.align],
          indent: b.quote ? { left: 720 } : undefined,
          children: runs(b.runs),
        }));
      } else if (b.type === 'li') {
        children.push(new D.Paragraph(Object.assign({
          alignment: ALIGN[b.align], children: runs(b.runs),
        }, b.ordered
          ? { numbering: { reference: 'po-num', level: Math.min(8, b.level), instance: b.instance } }
          : { bullet: { level: Math.min(8, b.level) } })));
      } else if (b.type === 'pre') {
        const lines = b.text.split('\n');
        const kids = [];
        lines.forEach((l, i) => kids.push(new D.TextRun({ text: l, font: 'Courier New', size: 20, break: i ? 1 : undefined })));
        children.push(new D.Paragraph({ children: kids }));
      } else if (b.type === 'hr') {
        children.push(new D.Paragraph({ border: { bottom: { color: '999999', space: 1, style: D.BorderStyle.SINGLE, size: 6 } } }));
      } else if (b.type === 'table') {
        const cols = Math.max(...b.rows.map(r => r.length));
        children.push(new D.Table({
          width: { size: 100, type: D.WidthType.PERCENTAGE },
          rows: b.rows.map(r => new D.TableRow({
            children: Array.from({ length: cols }, (_, ci) => {
              const c = r[ci] || { runs: [], header: false };
              return new D.TableCell({ children: [new D.Paragraph({ children: runs(c.runs, c.header ? { bold: true } : {}) })] });
            }),
          })),
        }));
        children.push(new D.Paragraph({ children: [] }));
      }
    }
    if (!children.length) children.push(new D.Paragraph({ children: [] }));

    const doc = new D.Document({
      numbering: {
        config: [{
          reference: 'po-num',
          levels: Array.from({ length: 9 }, (_, l) => ({
            level: l, format: D.LevelFormat.DECIMAL, text: `%${l + 1}.`,
            alignment: D.AlignmentType.START,
            style: { paragraph: { indent: { left: 720 * (l + 1), hanging: 360 } } },
          })),
        }],
      },
      sections: [{ properties: {}, children }],
    });
    const blob = await D.Packer.toBlob(doc);
    return new Uint8Array(await blob.arrayBuffer());
  }

  // ---------- .pdf ----------
  async function toPdf(root) {
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ unit: 'pt', format: 'a4' });
    PdfFonts.register(pdf);
    const { blocks, defaults } = collect(root);
    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();
    const margin = 56;
    const maxW = pageW - margin * 2;
    let y = margin;

    const rgb = (h) => [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    function setStyle(r) {
      const { family, style } = PdfFonts.pick(r.font, !!r.bold, !!r.italic);
      pdf.setFont(family, style);
      pdf.setFontSize((r.sup || r.sub) ? r.sizePt * 0.7 : r.sizePt);
    }
    function ensureSpace(h) {
      if (y + h > pageH - margin) { pdf.addPage(); y = margin; }
    }

    // Break runs into lines of at most `width` points. Each line is
    // { items: [{ kind, x, w, run, text | image }], w, h, size }.
    function breakLines(runs, width, base = {}) {
      const lines = [];
      let line = { items: [], w: 0 };
      const push = () => { trimTrailing(line); lines.push(line); line = { items: [], w: 0 }; };
      function trimTrailing(l) {
        while (l.items.length && l.items[l.items.length - 1].space) l.w -= l.items.pop().w;
      }
      function add(item) {
        if (item.space && !line.items.length) return;
        if (line.items.length && line.w + item.w > width && !item.space) push();
        line.items.push(item);
        line.w += item.w;
      }
      for (const r0 of runs) {
        if (r0.br) { push(); continue; }
        if (r0.image) {
          let { w, h } = r0.image;
          w *= 0.75; h *= 0.75;                    // CSS px -> pt
          if (w > width) { h = h * width / w; w = width; }
          add({ kind: 'image', w, h, image: r0.image });
          continue;
        }
        const r = Object.assign({}, r0, base);
        if (!r.sizePt) r.sizePt = defaults.sizePt;
        setStyle(r);
        for (const piece of r.text.split(/( +)/)) {
          if (!piece) continue;
          const space = /^ +$/.test(piece);
          let w = pdf.getTextWidth(piece);
          if (!space && w > width) {
            // A single word wider than the line: hard-split it.
            for (const part of pdf.splitTextToSize(piece, width)) add({ kind: 'text', text: part, w: pdf.getTextWidth(part), run: r });
            continue;
          }
          add({ kind: 'text', text: piece, w, run: r, space });
        }
      }
      if (line.items.length || !lines.length) push();
      for (const l of lines) {
        let size = 0, h = 0;
        for (const it of l.items) {
          if (it.kind === 'image') h = Math.max(h, it.h + 4);
          else size = Math.max(size, it.run.sizePt);
        }
        if (!size && !h) size = (base.sizePt || defaults.sizePt);
        l.size = size;
        l.h = Math.max(h, size * 1.35);
      }
      return lines;
    }

    function drawLine(l, x0, top, width, align) {
      let x = x0;
      if (align === 'center') x += (width - l.w) / 2;
      else if (align === 'right') x += width - l.w;
      const baseline = top + (l.h - l.size * 1.35) + l.size * 1.05;
      for (const it of l.items) {
        if (it.kind === 'image') {
          try { pdf.addImage(it.image.dataUrl, 'PNG', x, top + l.h - it.h - 2, it.w, it.h); } catch (e) { /* skip */ }
          x += it.w;
          continue;
        }
        const r = it.run;
        setStyle(r);
        const size = (r.sup || r.sub) ? r.sizePt * 0.7 : r.sizePt;
        const by = baseline + (r.sup ? -r.sizePt * 0.35 : r.sub ? r.sizePt * 0.15 : 0);
        if (r.highlight) {
          pdf.setFillColor(...rgb(r.highlight));
          pdf.rect(x, by - size * 0.85, it.w, size * 1.15, 'F');
        }
        const col = rgb(r.color || defaults.color);
        pdf.setTextColor(...col);
        if (!it.space) pdf.text(it.text, x, by);
        if (r.underline || r.strike || r.link) {
          pdf.setDrawColor(...col);
          pdf.setLineWidth(Math.max(0.5, size * 0.05));
          if (r.underline) pdf.line(x, by + size * 0.12, x + it.w, by + size * 0.12);
          if (r.strike) pdf.line(x, by - size * 0.3, x + it.w, by - size * 0.3);
        }
        if (r.link && /^(https?:|mailto:)/i.test(r.link)) pdf.link(x, by - size * 0.85, it.w, size * 1.1, { url: r.link });
        x += it.w;
      }
    }

    function flow(runs, { indent = 0, align = 'left', prefix = null, base = {}, gapAfter = 6 } = {}) {
      const width = maxW - indent;
      const lines = breakLines(runs, width, base);
      lines.forEach((l, i) => {
        ensureSpace(l.h);
        if (i === 0 && prefix) {
          const r = Object.assign({ sizePt: l.size || defaults.sizePt, color: defaults.color, font: defaults.font }, base);
          setStyle(r);
          pdf.setTextColor(...rgb(r.color));
          const pw = pdf.getTextWidth(prefix);
          pdf.text(prefix, margin + indent - pw - 4, y + l.size * 1.05);
        }
        drawLine(l, margin + indent, y, width, align === 'justify' ? 'left' : align);
        y += l.h;
      });
      y += gapAfter;
    }

    function table(rows) {
      const cols = Math.max(...rows.map(r => r.length));
      const colW = maxW / cols;
      const pad = 4;
      for (const r of rows) {
        const cells = Array.from({ length: cols }, (_, ci) => {
          const c = r[ci] || { runs: [], header: false };
          return breakLines(c.runs, colW - pad * 2, c.header ? { bold: true } : {});
        });
        const rowH = Math.max(...cells.map(ls => ls.reduce((s, l) => s + l.h, 0))) + pad * 2;
        ensureSpace(rowH);
        pdf.setDrawColor(140, 140, 140);
        pdf.setLineWidth(0.5);
        cells.forEach((ls, ci) => {
          const cx = margin + ci * colW;
          pdf.rect(cx, y, colW, rowH);
          let cy = y + pad;
          for (const l of ls) { drawLine(l, cx + pad, cy, colW - pad * 2, 'left'); cy += l.h; }
        });
        y += rowH;
      }
      y += 8;
    }

    for (const b of blocks) {
      if (b.type === 'heading') {
        y += 6;
        flow(b.runs, { align: b.align, gapAfter: 4 });
      } else if (b.type === 'para') {
        if (b.empty) { y += defaults.sizePt * 1.35; continue; }
        flow(b.runs, { align: b.align, indent: b.quote ? 24 : 0 });
      } else if (b.type === 'li') {
        const indent = 22 * (b.level + 1);
        // Standard PDF fonts are WinAnsi: '•' exists there, '◦' does not.
        const prefix = b.ordered ? b.number + '.' : (b.level % 2 ? '-' : '•');
        flow(b.runs, { indent, align: b.align, prefix, gapAfter: 2 });
      } else if (b.type === 'pre') {
        const base = { font: 'JetBrains Mono', sizePt: 9.5, color: b.color };
        for (const l of b.text.split('\n')) flow([{ text: l || ' ' }], { base, gapAfter: 0 });
        y += 6;
      } else if (b.type === 'hr') {
        ensureSpace(12);
        pdf.setDrawColor(160, 160, 160);
        pdf.setLineWidth(0.75);
        pdf.line(margin, y + 5, pageW - margin, y + 5);
        y += 12;
      } else if (b.type === 'table') {
        table(b.rows);
      }
    }
    return new Uint8Array(pdf.output('arraybuffer'));
  }

  return { toDocx, toPdf, collect };
})();
