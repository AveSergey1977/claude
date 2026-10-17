'use strict';
// Entry point for the scanner: detects the real format, runs the parser,
// the text checks and recursion into embedded files.
(() => {
  const LI = window.LI;

  LI.DEFAULT_OPTS = {
    tinyPt: 5, // below this a run is "very small"
    tinyCritical: 2, // at or below this a run is unreadable
    invisibleContrast: 1.25,
    lowContrast: 1.6,
    pdfRender: true,
    pdfScale: 1.5,
    pdfMaxRenderPages: 150,
    pdfInvisibleRange: 10,
    pdfLowRange: 24,
    pdfMaxRevisions: 3,
    password: '',
  };

  LI.KIND_LABEL = { docx: 'DOCX', doc: 'DOC (Word 97–2003)', rtf: 'RTF', pdf: 'PDF', txt: 'Текст', html: 'HTML', xlsx: 'XLSX', pptx: 'PPTX', zip: 'ZIP', cfb: 'OLE' };

  LI.detectKind = (u8) => {
    const head = String.fromCharCode(...u8.subarray(0, Math.min(1024, u8.length)));
    if (u8[0] === 0x50 && u8[1] === 0x4b && u8[2] === 0x03 && u8[3] === 0x04) return 'zip';
    if (u8[0] === 0xd0 && u8[1] === 0xcf && u8[2] === 0x11 && u8[3] === 0xe0) return 'cfb';
    if (head.includes('%PDF-')) return 'pdf';
    if (/^\s*\{\\rtf/.test(head)) return 'rtf';
    if (/^\s*(<\?xml[^>]*>\s*)?(<!DOCTYPE html|<html)/i.test(head) || /xmlns:w="urn:schemas-microsoft-com:office:word"/.test(head)) return 'html';
    return 'txt';
  };

  async function parseTxt(u8, opts, encoding) {
    const rep = LI.newReport('txt');
    const enc = encoding || LI.detectEncoding(u8);
    let text = LI.decode(u8, enc);
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    rep.meta.push(['Кодировка', enc]);
    const lines = text.split(/\r\n|\r|\n/);
    rep.meta.push(['Строк', String(lines.length)]);
    for (let a = 0; a < lines.length; a += 200) {
      rep.segments.push({ text: lines.slice(a, a + 200).join('\n'), loc: `строки ${a + 1}–${Math.min(lines.length, a + 200)}`, hidden: false, src: 'main' });
    }
    let k = 0;
    for (const block of text.split(/\n\s*\n|\r\n\s*\r\n/)) {
      for (const line of block.split(/\r?\n/)) {
        const t = line.trim();
        if (t) rep.paragraphs.push({ part: 'Текст', partKind: 'main', loc: `абз. ${++k}`, runs: [{ text: t, flags: [] }], text: t });
      }
    }
    return rep;
  }

  async function parseHtml(u8, opts) {
    const rep = LI.newReport('html');
    const enc = LI.detectEncoding(u8);
    const src = LI.decode(u8, enc);
    const d = new DOMParser().parseFromString(src, 'text/html');
    d.querySelectorAll('script,style').forEach((e) => e.remove());
    let k = 0;
    for (const el of d.body ? d.body.querySelectorAll('p,li,h1,h2,h3,h4,h5,h6,td,div') : []) {
      if (el.querySelector('p,li,div,td')) continue;
      const t = el.textContent.replace(/\s+/g, ' ').trim();
      if (!t) continue;
      const style = (el.getAttribute('style') || '') + ' ' + [...el.querySelectorAll('[style]')].map((x) => x.getAttribute('style')).join(' ');
      const hidden = /display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0|mso-hide\s*:\s*all/i.test(style);
      rep.paragraphs.push({ part: 'Текст', partKind: 'main', loc: `абз. ${++k}`, runs: [{ text: t, flags: hidden ? ['hidden'] : [] }], text: hidden ? '' : t });
      rep.segments.push({ text: t, loc: `абз. ${k}`, hidden, src: 'main' });
      if (hidden) LI.add(rep, 'critical', 'hidden', 'Текст, скрытый стилем', { loc: `абз. ${k}`, excerpt: LI.clip(t, 400), detail: style.trim() });
    }
    rep.notes.push('HTML-документ: проверены текст и явные стили скрытия. Цвета и внешние таблицы стилей не учитываются.');
    return rep;
  }

  async function parseCfb(buf, opts) {
    const cfb = LI.readCfb(buf);
    if (cfb.paths['EncryptedPackage'] || cfb.paths['EncryptionInfo']) {
      const rep = LI.newReport('docx');
      LI.add(rep, 'critical', 'structure', 'Документ Office зашифрован паролем', { detail: 'Содержимое недоступно без пароля. Откройте файл, снимите пароль и проверьте снова.' });
      for (const e of cfb.list) rep.structure.push({ name: e.path, size: e.type === 2 ? e.size : null });
      return rep;
    }
    if (cfb.paths['WordDocument']) return LI.parseDoc(buf, opts);
    const rep = LI.newReport('cfb');
    for (const e of cfb.list) rep.structure.push({ name: e.path, size: e.type === 2 ? e.size : null });
    rep.notes.push('Составной файл OLE, но не документ Word (например, Excel 97–2003 или Outlook .msg). Проверены только структура и свойства.');
    rep.meta.push(...LI.readPropSet(cfb.read('\u0005SummaryInformation'), { 2: 'Название', 3: 'Тема', 4: 'Автор', 8: 'Последним изменил', 12: 'Создан', 13: 'Изменён', 18: 'Программа' }));
    if (cfb.list.some((e) => /^(_VBA_PROJECT_CUR|Macros|VBA)(\/|$)/.test(e.path))) LI.add(rep, 'critical', 'active', 'Макросы VBA');
    return rep;
  }

  LI.scanFile = async (name, buf, userOpts = {}, depth = 0) => {
    const opts = { ...LI.DEFAULT_OPTS, ...userOpts };
    const u8 = new Uint8Array(buf);
    const kind = LI.detectKind(u8);
    const ext = (name.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase() || '';
    const deps = {
      depth,
      nested: async (n, b, parent) => {
        try {
          const r = await LI.scanFile(n, b, userOpts, depth + 1);
          for (const f of r.rep.findings) parent.findings.push({ ...f, loc: `Вложение «${n}»${f.loc ? ': ' + f.loc : ''}` });
          LI.add(parent, 'info', 'structure', `Вложенный файл «${n}» проверен`, { detail: `${LI.KIND_LABEL[r.rep.kind] || r.rep.kind}, ${LI.fmtSize(b.byteLength)}. Его замечания включены в отчёт с пометкой «Вложение».` });
        } catch (e) {
          LI.add(parent, 'warning', 'structure', `Вложенный файл «${n}» не разобран`, { detail: String(e.message || e) });
        }
      },
    };
    let rep;
    if (kind === 'zip') rep = await LI.parseDocx(buf, opts, deps);
    else if (kind === 'cfb') rep = await parseCfb(buf, opts);
    else if (kind === 'pdf') rep = await LI.parsePdf(buf, opts, deps);
    else if (kind === 'rtf') rep = await LI.parseRtf(buf, opts);
    else if (kind === 'html') rep = await parseHtml(u8, opts);
    else rep = await parseTxt(u8, opts, opts.encoding);

    const expected = { docx: ['docx', 'docm', 'dotx', 'dotm'], doc: ['doc', 'dot'], rtf: ['rtf', 'doc'], pdf: ['pdf'], txt: ['txt', 'text', 'md', 'csv', 'log', ''], html: ['htm', 'html', 'doc', 'mht'] }[rep.kind];
    if (expected && ext && !expected.includes(ext)) {
      LI.add(rep, 'warning', 'structure', 'Расширение не соответствует содержимому', { detail: `Расширение «.${ext}», а по содержимому это ${LI.KIND_LABEL[rep.kind] || rep.kind}. Программы открывают файл по содержимому, поэтому проверка выполнена для ${LI.KIND_LABEL[rep.kind] || rep.kind}.` });
    } else if (ext === 'doc' && rep.kind === 'rtf') {
      rep.notes.push('Файл .doc фактически сохранён в формате RTF. Для Word это нормально.');
    }

    LI.textChecks(rep, opts);
    rep.findings.sort((a, b) => LI.SEV_RANK[b.sev] - LI.SEV_RANK[a.sev]);
    return { name, size: buf.byteLength, kind: rep.kind, sha: depth ? '' : await LI.sha256(buf), rep, opts };
  };
})();
