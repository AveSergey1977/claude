'use strict';
// PDF analysis on top of pdf.js: visibility of every text item on the rendered
// page, invisible text layers, annotations, attachments, scripts, layers,
// earlier revisions and changes after signing.
(() => {
  const LI = window.LI;
  const { add } = LI;

  const pdfDate = (s) => {
    const m = /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/.exec(s || '');
    if (!m) return s;
    return `${m[1]}-${m[2] || '01'}-${m[3] || '01'}${m[4] ? ' ' + m[4] + ':' + (m[5] || '00') : ''}`;
  };

  const latin1 = (u8) => {
    let s = '';
    for (let k = 0; k < u8.length; k += 65536) s += String.fromCharCode.apply(null, u8.subarray(k, k + 65536));
    return s;
  };

  async function loadPdf(u8, password) {
    const task = pdfjsLib.getDocument({ data: u8.slice(), password, isEvalSupported: false, stopAtErrors: false });
    return task.promise;
  }

  async function pageLines(page) {
    const tc = await page.getTextContent();
    const lines = [];
    let cur = '';
    for (const it of tc.items) {
      if (typeof it.str !== 'string') continue;
      cur += it.str;
      if (it.hasEOL) { lines.push(cur); cur = ''; }
    }
    if (cur) lines.push(cur);
    return { tc, lines };
  }

  // Groups PDF lines into paragraphs: a numbered line or a line after a sentence end starts one.
  LI.linesToParagraphs = (lines) => {
    const out = [];
    const lens = lines.map((l) => l.trim().length).filter((n) => n > 0).sort((a, b) => a - b);
    const median = lens[Math.floor(lens.length / 2)] || 60;
    let cur = '';
    let prevShort = false;
    for (const raw of lines) {
      const l = raw.replace(/\s+/g, ' ').trim();
      if (!l) { if (cur) out.push(cur); cur = ''; prevShort = false; continue; }
      const starts = /^((\d+\.)+\d*|\d+[.)]|\(?[a-zа-яё]\)|\(?[ivxlcdm]+\)|(Статья|Article|Section|Clause|Раздел|Глава|Пункт)\s+\d+|\d+\s+(straipsnis|skyrius|punktas))(\s|$)/iu.test(l);
      if (cur && (starts || prevShort || /[.:;!?»”"]$/.test(cur))) { out.push(cur); cur = l; }
      else cur = cur ? (cur.endsWith('-') && !cur.endsWith(' -') ? cur.slice(0, -1) + l : cur + ' ' + l) : l;
      prevShort = l.length < median * 0.6;
    }
    if (cur) out.push(cur);
    return out;
  };

  function scanOps(ops) {
    const O = pdfjsLib.OPS;
    let mode = 0;
    const stack = [];
    let invisible = '', images = 0, chars = 0, block = '';
    const blocks = [];
    for (let k = 0; k < ops.fnArray.length; k++) {
      const fn = ops.fnArray[k], args = ops.argsArray[k];
      if (fn === O.save || fn === O.paintFormXObjectBegin) stack.push(mode);
      else if (fn === O.restore || fn === O.paintFormXObjectEnd) mode = stack.length ? stack.pop() : mode;
      else if (fn === O.setTextRenderingMode) mode = args[0];
      else if (fn === O.beginText) block = '';
      else if (fn === O.endText) { if (block.trim()) blocks.push(block); block = ''; }
      else if (fn === O.paintImageXObject || fn === O.paintInlineImageXObject || fn === O.paintJpegXObject || fn === O.paintImageXObjectRepeat) images++;
      else if (fn === O.showText || fn === O.showSpacedText || fn === O.nextLineShowText || fn === O.nextLineSetSpacingShowText) {
        const glyphs = args[args.length - 1];
        if (!Array.isArray(glyphs)) continue;
        let t = '';
        for (const g of glyphs) {
          if (g && typeof g === 'object' && g.unicode) t += g.unicode;
          else if (typeof g === 'number' && g < -200) t += ' ';
        }
        chars += t.length;
        block += t;
        if ((mode & 3) === 3) invisible += t + ' ';
      }
    }
    return { invisible: invisible.trim(), images, chars, blocks };
  }

  function checkVisibility(page, tc, opts) {
    return (async () => {
      const S = opts.pdfScale;
      const vp = page.getViewport({ scale: S });
      const W = Math.ceil(vp.width), H = Math.ceil(vp.height);
      const canvas = document.createElement('canvas');
      canvas.width = W; canvas.height = H;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, W, H);
      await page.render({ canvasContext: ctx, viewport: vp, background: 'rgba(255,255,255,1)' }).promise;
      const data = ctx.getImageData(0, 0, W, H).data;
      canvas.width = 0; canvas.height = 0;
      const res = [];
      for (const it of tc.items) {
        if (typeof it.str !== 'string' || !it.str.trim()) { res.push(null); continue; }
        const tx = pdfjsLib.Util.transform(vp.transform, it.transform);
        const fh = Math.hypot(tx[2], tx[3]);
        const a = Math.atan2(tx[1], tx[0]);
        const ux = Math.cos(a), uy = Math.sin(a), vx = Math.sin(a), vy = -Math.cos(a);
        const w = it.width ? it.width * S : it.str.length * fh * 0.5;
        const nx = Math.max(3, Math.min(80, Math.ceil(w / 1.5))), ny = Math.max(3, Math.min(14, Math.ceil(fh / 1.5)));
        let min = 255, max = 0, inside = 0, total = 0;
        for (let ix = 0; ix < nx; ix++) {
          const t = w * (0.02 + (0.96 * ix) / (nx - 1));
          for (let iy = 0; iy < ny; iy++) {
            const h = fh * (-0.12 + (0.9 * iy) / (ny - 1));
            const x = Math.round(tx[4] + ux * t + vx * h), y = Math.round(tx[5] + uy * t + vy * h);
            total++;
            if (x < 0 || y < 0 || x >= W || y >= H) continue;
            inside++;
            const o = (y * W + x) * 4;
            const L = 0.2126 * data[o] + 0.7152 * data[o + 1] + 0.0722 * data[o + 2];
            if (L < min) min = L;
            if (L > max) max = L;
          }
        }
        const sizePt = fh / S;
        let flag = null, note = '';
        if (!inside) { flag = 'offpage'; note = 'текст расположен за пределами видимой области страницы'; }
        else if (sizePt <= opts.tinyCritical) { flag = 'tiny'; note = `размер ${LI.fmtNum(sizePt, 1)} пт`; }
        else if (max - min < opts.pdfInvisibleRange) { flag = 'color'; note = 'на отрисованной странице в этом месте нет различимых знаков'; }
        else if (max - min < opts.pdfLowRange) { flag = 'lowcontrast'; note = `перепад яркости ${Math.round(max - min)} из 255`; }
        else if (sizePt < opts.tinyPt) { flag = 'small'; note = `размер ${LI.fmtNum(sizePt, 1)} пт`; }
        res.push(flag ? { flag, note, partial: inside < total } : null);
      }
      return res;
    })();
  }

  LI.parsePdf = async (buf, opts, deps) => {
    const rep = LI.newReport('pdf');
    const u8 = new Uint8Array(buf);
    const raw = latin1(u8);

    let pdf;
    try {
      pdf = await loadPdf(u8, opts.password || undefined);
    } catch (e) {
      if (e && e.name === 'PasswordException') {
        add(rep, 'critical', 'structure', 'PDF защищён паролем на открытие', { detail: 'Без пароля содержимое проверить нельзя.' });
        return rep;
      }
      throw e;
    }

    // Metadata.
    try {
      const md = await pdf.getMetadata();
      const INFO = { Title: 'Название', Author: 'Автор', Subject: 'Тема', Keywords: 'Ключевые слова', Creator: 'Программа-источник', Producer: 'Создан в', CreationDate: 'Создан', ModDate: 'Изменён', Trapped: null };
      for (const [k, v] of Object.entries(md.info || {})) {
        if (k === 'Custom' && v && typeof v === 'object') {
          for (const [ck, cv] of Object.entries(v)) {
            rep.meta.push(['Свойство: ' + ck, String(cv?.name ?? cv)]);
            rep.segments.push({ text: String(cv?.name ?? cv), loc: 'Свойство ' + ck, hidden: true, src: 'meta' });
          }
          continue;
        }
        if (!INFO[k] || v == null || v === '' || typeof v === 'object') continue;
        const val = /Date$/.test(k) ? pdfDate(v) : String(v);
        rep.meta.push([INFO[k], val]);
        if (['Title', 'Subject', 'Keywords'].includes(k)) rep.segments.push({ text: val, loc: 'Свойство «' + INFO[k] + '»', hidden: true, src: 'meta' });
      }
      if (md.info?.PDFFormatVersion) rep.meta.push(['Версия PDF', md.info.PDFFormatVersion]);
      const x = md.metadata?.getAll?.();
      if (x) for (const [k, v] of Object.entries(x).slice(0, 30)) {
        const val = Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : String(v);
        if (val && val.length < 500) rep.meta.push(['XMP ' + k, val]);
        if (/description|title|subject|keywords/i.test(k)) rep.segments.push({ text: val, loc: 'XMP ' + k, hidden: true, src: 'meta' });
      }
    } catch {}
    rep.meta.push(['Страниц', String(pdf.numPages)]);

    // Pages.
    const allLines = [];
    const comments = [], links = [], hiddenAnnots = [], fields = [];
    let ocrPages = 0, invisiblePages = 0, renderSkipped = false;
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const { tc, lines } = await pageLines(page);
      allLines.push(...lines, '');
      let vis = null;
      if (opts.pdfRender && p <= opts.pdfMaxRenderPages) {
        try { vis = await checkVisibility(page, tc, opts); } catch (e) { rep.notes.push(`Стр. ${p}: отрисовка не удалась (${e.message || e}), проверка видимости пропущена.`); }
      } else if (opts.pdfRender) renderSkipped = true;

      let ops = null;
      try { ops = scanOps(await page.getOperatorList()); } catch {}
      if (ops && ops.invisible.trim()) {
        if (ops.images) ocrPages++;
        else {
          invisiblePages++;
          if (!vis) add(rep, 'critical', 'hidden', 'Невидимый текст (режим отрисовки 3)', { loc: `стр. ${p}`, excerpt: LI.clip(ops.invisible, 600), detail: 'Текст записан в режиме «не отображать». На странице нет изображения, под которым он мог бы служить слоем распознавания.' });
        }
      }

      // pdf.js leaves text drawn outside the page out of the text layer: compare with what the content stream draws.
      if (ops) {
        const norm = (x) => x.normalize('NFKC').replace(/\s+/g, '');
        const layer = norm(tc.items.map((i) => i.str || '').join(''));
        for (const b of ops.blocks) {
          const n = norm(b);
          if (n.length >= 3 && !layer.includes(n)) {
            add(rep, 'critical', 'hidden', 'Текст за пределами страницы', { loc: `стр. ${p}`, excerpt: LI.clip(b.trim(), 600), detail: 'Текст записан в странице, но расположен вне её видимой области или обрезан. При просмотре и печати его не видно, а программы и ИИ-инструменты могут его прочитать.' });
            rep.segments.push({ text: b, loc: `стр. ${p} (вне страницы)`, hidden: true, src: 'main' });
          }
        }
      }

      // Per-item findings, grouped by consecutive flag.
      const loc = `стр. ${p}`;
      let visible = '', hidden = '', cur = null;
      const TITLES = { color: ['critical', 'Невидимый текст'], offpage: ['critical', 'Текст за пределами страницы'], tiny: ['critical', 'Текст микроскопического размера'], lowcontrast: ['warning', 'Текст с очень низким контрастом'], small: ['warning', 'Текст очень мелкого размера'] };
      const flush = () => {
        if (cur && cur.text.trim()) {
          const [sev, title] = TITLES[cur.flag];
          add(rep, sev, 'hidden', title, { loc, excerpt: LI.clip(cur.text.trim(), 600), detail: cur.note + (cur.flag === 'color' ? '. Это белый текст на белом, текст под закрашенной фигурой, невидимый режим отрисовки или скрытый слой.' : '') });
        }
        cur = null;
      };
      const runs = [];
      tc.items.forEach((it, k) => {
        if (typeof it.str !== 'string') return;
        const v = vis ? vis[k] : null;
        const sep = it.hasEOL ? '\n' : '';
        const hid = v && ['color', 'offpage', 'tiny'].includes(v.flag);
        if (hid) hidden += it.str + sep; else visible += it.str + sep;
        runs.push({ text: it.str + (it.hasEOL ? ' ' : ''), flags: v ? [v.flag] : [], note: v ? v.note : '' });
        if (!v) { if (it.str.trim()) flush(); return; }
        if (cur && cur.flag === v.flag) cur.text += (cur.text.endsWith(' ') ? '' : ' ') + it.str;
        else { flush(); cur = { flag: v.flag, text: it.str, note: v.note }; }
      });
      flush();
      rep.pageRuns = rep.pageRuns || [];
      rep.pageRuns.push({ loc, runs });
      if (visible.trim()) rep.segments.push({ text: visible, loc, hidden: false, src: 'main' });
      if (hidden.trim()) rep.segments.push({ text: hidden, loc: loc + ' (невидимая часть)', hidden: true, src: 'main' });
      if (ops && ops.invisible && !ops.images) rep.segments.push({ text: ops.invisible, loc: loc + ' (режим 3)', hidden: true, src: 'main' });

      // Annotations.
      try {
        for (const a of await page.getAnnotations()) {
          const contents = a.contentsObj?.str || a.contents || '';
          const author = a.titleObj?.str || a.title || '';
          const hiddenFlag = (a.annotationFlags & 2) || (a.annotationFlags & 32);
          if (a.subtype === 'Link') {
            const u = a.url || a.unsafeUrl;
            if (u) links.push({ url: u, loc });
            if (u && /^javascript:/i.test(u)) add(rep, 'critical', 'active', 'Ссылка выполняет JavaScript', { loc, excerpt: u });
            continue;
          }
          if (a.subtype === 'Widget') {
            const val = Array.isArray(a.fieldValue) ? a.fieldValue.join(', ') : a.fieldValue;
            if (val && typeof val === 'string' && val.trim()) {
              fields.push({ name: a.fieldName, val, loc, hidden: !!hiddenFlag });
              rep.segments.push({ text: val, loc: `${loc}, поле «${a.fieldName}»`, hidden: !!hiddenFlag, src: 'field' });
            }
            if (a.actions && Object.keys(a.actions).length) add(rep, 'critical', 'active', 'JavaScript в поле формы', { loc, excerpt: LI.clip(Object.values(a.actions).flat().join('\n'), 400), detail: `Поле «${a.fieldName}».` });
            continue;
          }
          if (a.subtype === 'FileAttachment') add(rep, 'warning', 'active', 'Вложенный файл в пометке', { loc, excerpt: a.file?.filename || '' });
          if (contents.trim() || hiddenFlag) {
            if (hiddenFlag) hiddenAnnots.push({ subtype: a.subtype, contents, author, loc });
            else comments.push({ subtype: a.subtype, contents, author, loc });
            if (contents.trim()) rep.segments.push({ text: contents, loc: `${loc}, пометка ${a.subtype}`, hidden: !!hiddenFlag, src: 'comment' });
          }
        }
      } catch {}
      page.cleanup();
      if (p % 5 === 0) await LI.yieldUI();
    }
    if (renderSkipped) rep.notes.push(`Проверка видимости выполнена для первых ${opts.pdfMaxRenderPages} страниц.`);
    if (!opts.pdfRender) rep.notes.push('Проверка видимости по отрисовке отключена в настройках: белый текст на белом и текст под фигурами не выявляются.');
    if (ocrPages) add(rep, 'info', 'hidden', `Невидимый текстовый слой поверх изображений: ${ocrPages} стр.`, { detail: 'Обычно это слой распознавания (OCR) скана. Проверьте выборочно, что его текст совпадает с изображением: при подделке в слое может быть другой текст.' });

    rep.paragraphs = LI.linesToParagraphs(allLines).map((t, k) => ({ part: 'Текст', partKind: 'main', loc: `абз. ${k + 1}`, runs: [{ text: t, flags: [] }], text: t }));

    if (comments.length) add(rep, 'warning', 'revisions', `Комментарии и пометки: ${comments.length}`, { list: comments.map((c) => `${c.loc}, ${c.subtype}${c.author ? ', ' + c.author : ''}: ${LI.clip(c.contents, 300)}`), detail: 'Комментарии видны получателю в любой программе просмотра PDF.' });
    for (const h of hiddenAnnots) add(rep, h.contents.trim() ? 'critical' : 'warning', 'hidden', 'Скрытая пометка', { loc: h.loc, excerpt: h.contents, detail: `Пометка ${h.subtype} с флагом «скрыта»${h.author ? ', автор ' + h.author : ''}.` });
    if (fields.length) add(rep, fields.some((f) => f.hidden) ? 'warning' : 'info', 'hidden', `Заполненные поля формы: ${fields.length}`, { list: fields.map((f) => `${f.loc}, «${f.name}»${f.hidden ? ' (скрытое поле)' : ''}: ${LI.clip(f.val, 200)}`) });
    if (links.length) add(rep, 'info', 'active', `Внешние ссылки: ${links.length}`, { list: [...new Set(links.map((l) => l.url))].slice(0, 40) });

    // Document-level objects.
    try {
      const att = await pdf.getAttachments();
      if (att && Object.keys(att).length) {
        const list = Object.values(att);
        add(rep, 'warning', 'active', `Вложенные файлы: ${list.length}`, { list: list.map((a) => `${a.filename} (${LI.fmtSize(a.content?.length)})`), detail: 'Файлы хранятся внутри PDF и не видны при обычном просмотре страниц.' });
        if (deps && deps.depth < 1) for (const a of list) if (/\.(pdf|docx|docm|doc|rtf|txt)$/i.test(a.filename) && a.content) await deps.nested(a.filename, a.content.buffer.slice(a.content.byteOffset, a.content.byteOffset + a.content.byteLength), rep);
      }
    } catch {}
    try {
      const js = await pdf.getJSActions();
      if (js && Object.keys(js).length) add(rep, 'critical', 'active', 'JavaScript уровня документа', { excerpt: LI.clip(Object.entries(js).map(([k, v]) => `${k}: ${[].concat(v).join(' ')}`).join('\n'), 600), detail: 'Скрипт выполняется при открытии или других событиях документа.' });
    } catch {}
    try {
      const cfg = await pdf.getOptionalContentConfig();
      const groups = cfg && cfg.getGroups ? cfg.getGroups() : null;
      if (groups) {
        const arr = Object.values(groups);
        const off = arr.filter((g) => !g.visible);
        if (off.length) add(rep, 'critical', 'hidden', `Скрытые слои: ${off.length}`, { list: off.map((g) => g.name || '(без названия)'), detail: 'Содержимое выключенных слоёв не отображается, но хранится в файле и включается одним щелчком.' });
        if (arr.length) rep.meta.push(['Слои', arr.map((g) => `${g.name}${g.visible ? '' : ' (скрыт)'}`).join(', ')]);
      }
    } catch {}

    // Raw keyword scan (object streams can hide these, so absence proves nothing).
    const kw = (re) => (raw.match(re) || []).length;
    if (kw(/\/Launch\b/g)) add(rep, 'critical', 'active', 'Действие /Launch', { detail: 'Документ может запустить внешнюю программу или файл.' });
    if (kw(/\/(JavaScript|JS)\b/g) && !rep.findings.some((f) => /JavaScript/.test(f.title))) add(rep, 'warning', 'active', 'Ключевые слова JavaScript в теле файла', { detail: 'В структуре PDF встречаются /JavaScript или /JS. Программа просмотра не нашла активных скриптов, но объекты могут быть неиспользуемыми или повреждёнными.' });
    if (kw(/\/OpenAction\b/g)) rep.meta.push(['Действие при открытии', 'задано']);
    if (kw(/\/RichMedia\b/g)) add(rep, 'warning', 'active', 'Мультимедийное содержимое (RichMedia)');
    if (kw(/\/SubmitForm\b/g)) add(rep, 'warning', 'active', 'Форма отправляет данные на сервер (SubmitForm)');
    if (kw(/\/XFA\b/g)) add(rep, 'warning', 'structure', 'Форма XFA', { detail: 'Содержимое XFA-форм отображается только в Adobe Reader и здесь не проверено.' });
    if (kw(/\/EmbeddedFile\b/g) && !rep.findings.some((f) => /Вложенн/.test(f.title))) add(rep, 'warning', 'active', 'Объекты /EmbeddedFile', { detail: 'В структуре есть встроенные файлы, не перечисленные в списке вложений.' });
    if (kw(/\/Encrypt\b/g)) rep.meta.push(['Шифрование', 'есть (открывается без пароля)']);
    const objstm = kw(/\/ObjStm\b/g);
    if (objstm) rep.notes.push('Часть объектов PDF упакована в потоки объектов: поиск ключевых слов по сырому файлу неполон. Проверки через программу просмотра это не затрагивает.');

    // Signatures and incremental updates.
    const eofs = [];
    for (const m of raw.matchAll(/%%EOF/g)) eofs.push(m.index);
    const linearized = /\/Linearized\b/.test(raw.slice(0, 2048));
    const revEnds = linearized ? eofs.slice(1) : eofs;
    const brs = [...raw.matchAll(/\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g)].map((m) => +m[3] + +m[4]);
    if (brs.length) {
      const last = Math.max(...brs);
      rep.meta.push(['Электронных подписей', String(brs.length)]);
      const tail = raw.slice(last).replace(/[\s\0]+/g, '');
      if (tail.length > 0) add(rep, 'warning', 'structure', 'Изменения после подписания', { detail: `Файл продолжается после последней подписанной области (${LI.fmtSize(raw.length - last)}). Проверьте подпись в Adobe Reader: изменения после подписи могут быть разрешёнными (заполнение формы) или нет.` });
    }
    if (revEnds.length > 1) {
      rep.meta.push(['Редакций (инкрементальных сохранений)', String(revEnds.length)]);
      const finalSet = new Set(allLines.map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean));
      const removed = [];
      for (const pos of revEnds.slice(0, -1).slice(-opts.pdfMaxRevisions)) {
        try {
          const old = await loadPdf(u8.subarray(0, pos + 5));
          for (let p = 1; p <= Math.min(old.numPages, 300); p++) {
            const { lines } = await pageLines(await old.getPage(p));
            for (const l of lines) {
              const n = l.replace(/\s+/g, ' ').trim();
              if (n.length > 3 && !finalSet.has(n) && !removed.some((r) => r.text === n)) removed.push({ text: n, loc: `редакция до байта ${pos}, стр. ${p}` });
            }
          }
          old.destroy();
        } catch {}
      }
      add(rep, removed.length ? 'warning' : 'info', 'revisions', `PDF сохранялся ${revEnds.length} раз(а) поверх прежней версии`, {
        detail: removed.length ? 'Прежние редакции остаются в файле. Ниже строки, которые были в прежней редакции, но отсутствуют в текущей.' : 'Прежние редакции остаются в файле. Отличий в тексте между редакциями не найдено.',
        list: removed.slice(0, 60).map((r) => `${r.loc}: ${LI.clip(r.text, 200)}`),
      });
    }
    await pdf.destroy();
    rep.notes.push('PDF: шрифты и таблицы кодировок с внешних серверов не загружаются, поэтому текст в некоторых азиатских кодировках может не извлечься.');
    return rep;
  };
})();
