'use strict';
// RTF analysis: a tokenizer that tracks character formatting, destinations,
// shapes, comments, fields and embedded objects.
(() => {
  const LI = window.LI;
  const { add } = LI;

  const CHARSET_CP = { 161: 1253, 162: 1254, 177: 1255, 178: 1256, 186: 1257, 204: 1251, 238: 1250, 255: 437 };
  const SKIP = new Set(['pict', 'objdata', 'themedata', 'colorschememapping', 'datastore', 'latentstyles', 'stylesheet', 'listtable', 'listoverridetable', 'rsidtbl', 'generator', 'xmlnstbl', 'mmathPr', 'pgdsctbl', 'revtbl', 'filetbl', 'fontemb', 'fontfile', 'bkmkstart', 'bkmkend', 'atnid', 'atntime', 'atnref', 'atndate', 'atnicn', 'atnparent', 'pn', 'pntext', 'pntxta', 'pntxtb', 'listtext', 'protusertbl', 'docvar', 'wgrffmtfilter', 'ftnsep', 'ftnsepc', 'aftnsep', 'aftnsepc', 'xmlattrname', 'xmlattrvalue', 'shppict', 'nonshppict', 'blipuid', 'passwordhash', 'objclass_skip', 'falt', 'panose', 'leveltext', 'levelnumbers', 'formfield', 'userprops', 'bookmarks']);
  const PART = {
    header: 'Колонтитул', headerl: 'Колонтитул', headerr: 'Колонтитул', headerf: 'Колонтитул',
    footer: 'Колонтитул', footerl: 'Колонтитул', footerr: 'Колонтитул', footerf: 'Колонтитул',
    footnote: 'Сноски', annotation: 'Комментарий', shptxt: 'Надпись',
  };
  const INFO = { title: 'Название', subject: 'Тема', author: 'Автор', operator: 'Последним изменил', keywords: 'Ключевые слова', comment: 'Примечания', doccomm: 'Примечания', company: 'Организация', manager: 'Руководитель', category: 'Категория', hlinkbase: 'База гиперссылок' };
  const SYM = { emdash: '—', endash: '–', bullet: '•', lquote: '‘', rquote: '’', ldblquote: '“', rdblquote: '”', emspace: ' ', enspace: ' ', qmspace: ' ', zwbo: '​', zwnbo: '⁠', zwj: '‍', zwnj: '‌', ltrmark: '‎', rtlmark: '‏', tab: '\t', line: '\n' };

  LI.parseRtf = async (buf, opts) => {
    const bytes = new Uint8Array(buf);
    const rep = LI.newReport('rtf');
    let s = '';
    for (let k = 0; k < bytes.length; k += 65536) s += String.fromCharCode.apply(null, bytes.subarray(k, k + 65536));

    const fonts = {}, colors = [];
    let ansicpg = 1252, defFont = null, curFontDef = null, colorAcc = null;
    const decoders = {};
    const dec = (cp) => (decoders[cp] = decoders[cp] || new TextDecoder(LI.CODEPAGES[cp] || 'windows-1252'));

    let st = { uc: 1, v: false, fs: 24, cf: 0, hl: 0, cb: 0, del: false, ins: false, f: null, scale: 100, up: 0, dest: null, part: 'Основной текст', buf: null, shape: null, starred: false };
    const stack = [];
    const paras = {}, counts = {};
    const fieldCodes = [], comments = [], objects = [];
    let lastAuthor = '', pendingSn = '', template = '';
    let rowCells = [], pendingCellPat = 0, cellIdx = 0; // table cell backgrounds (colour-table indices)
    let hexBuf = [], skip = 0;

    const newPara = (part) => {
      counts[part] = (counts[part] || 0) + 1;
      const p = { part, partKind: part === 'Основной текст' || part === 'Надпись' ? 'main' : part === 'Сноски' ? 'footnote' : part === 'Комментарий' ? 'comment' : 'header', loc: `${part}, абз. ${counts[part]}`, runs: [] };
      rep.paragraphs.push(p);
      paras[part] = p;
      return p;
    };

    const flags = () => {
      const fl = [], notes = [];
      if (st.del) fl.push('deleted');
      if (st.ins) fl.push('inserted');
      if (st.v) fl.push('hidden');
      if (st.shape?.hidden) fl.push('hidden');
      if (st.shape?.offpage) fl.push('offpage');
      const pt = st.fs / 2;
      if (pt <= opts.tinyCritical) fl.push('tiny');
      else if (pt < opts.tinyPt) fl.push('small');
      if (pt < opts.tinyPt) notes.push(`размер ${LI.fmtNum(pt, 1)} пт`);
      const fg = st.cf ? colors[st.cf] : null;
      if (fg) {
        const bg = (st.cb && colors[st.cb]) || (st.hl && colors[st.hl]) || (st.intbl && rowCells[cellIdx] && colors[rowCells[cellIdx]]) || (st.pbg && colors[st.pbg]) || null;
        const ci = LI.colorIssue(fg, bg, opts);
        if (ci) { fl.push(ci.flag); notes.push(`цвет ${LI.toHex(ci.fg)} на фоне ${LI.toHex(ci.bg || [255, 255, 255])}, контраст ${LI.fmtNum(ci.ratio)}:1`); }
      }
      if (st.scale < 34) { fl.push('scaled'); notes.push(`ширина знаков ${st.scale}%`); }
      if (Math.abs(st.up) >= 96) { fl.push('shifted'); notes.push(`смещение ${st.up / 2} пт`); }
      return { fl, note: notes.join('; ') };
    };

    const emit = (text) => {
      if (!text) return;
      const d = st.dest;
      if (d === 'skip' || d === 'fonttbl' || d === 'colortbl' || d === 'info' || d === 'object') return;
      if (d && d !== 'fldrslt' && st.buf) { st.buf.text += text; return; }
      const part = st.part;
      const p = paras[part] || newPara(part);
      const { fl, note } = flags();
      const last = p.runs[p.runs.length - 1];
      if (last && last.flags.join() === fl.join() && last.note === note) last.text += text;
      else p.runs.push({ text, flags: fl, note });
    };

    const flushHex = () => {
      if (!hexBuf.length) return;
      const cs = fonts[st.f ?? defFont];
      const cp = cs != null && CHARSET_CP[cs] !== undefined ? CHARSET_CP[cs] : ansicpg;
      emit(dec(cp).decode(new Uint8Array(hexBuf)));
      hexBuf = [];
    };

    const setDest = (name) => {
      st.dest = name;
      st.buf = { text: '' };
    };

    const control = (w, p) => {
      const starred = st.starred;
      st.starred = false;
      if (st.dest === 'skip') return;
      if (st.dest === 'fonttbl') {
        if (w === 'f') { curFontDef = p; if (!(p in fonts)) fonts[p] = null; }
        else if (w === 'fcharset' && curFontDef !== null) fonts[curFontDef] = p;
        return;
      }
      if (st.dest === 'colortbl') {
        colorAcc = colorAcc || [0, 0, 0];
        if (w === 'red') colorAcc[0] = p; else if (w === 'green') colorAcc[1] = p; else if (w === 'blue') colorAcc[2] = p;
        return;
      }
      if (SKIP.has(w)) { setDest('skip'); return; }
      if (PART[w]) { st.part = PART[w]; st.dest = null; if (w === 'annotation') { st.buf = { text: '' }; st.dest = 'annotation'; } else newPara(st.part); return; }
      if (w === 'shptxt') { st.part = 'Надпись'; st.dest = null; newPara('Надпись'); return; }
      switch (w) {
        case 'fonttbl': st.dest = 'fonttbl'; return;
        case 'colortbl': st.dest = 'colortbl'; colorAcc = null; return;
        case 'info': st.dest = 'info'; return;
        case 'fldinst': setDest('fldinst'); return;
        case 'fldrslt': st.dest = 'fldrslt'; return;
        case 'atnauthor': setDest('atnauthor'); return;
        case 'sn': setDest('sn'); return;
        case 'sv': setDest('sv'); return;
        case 'template': setDest('template'); return;
        case 'object': objects.push({ upd: false, autlink: false, cls: '' }); st.dest = 'object'; return;
        case 'objclass': setDest('objclass'); return;
        case 'objupdate': if (objects.length) objects[objects.length - 1].upd = true; return;
        case 'objautlink': if (objects.length) objects[objects.length - 1].autlink = true; return;
        case 'objemb': case 'objlink': if (objects.length) objects[objects.length - 1].kind = w; return;
        case 'shp': st.shape = { hidden: false, offpage: false }; return;
        case 'shpinst': case 'sp': return;
        case 'shpleft': case 'shptop': if (st.shape && (p < -14400 || p > 40000)) st.shape.offpage = true; return;
        case 'ansicpg': ansicpg = p; return;
        case 'deff': defFont = p; return;
        case 'uc': st.uc = p ?? 1; return;
        case 'u': flushHex(); emit(String.fromCharCode(p < 0 ? p + 65536 : p)); skip = st.uc; return;
        case 'trowd': rowCells = []; pendingCellPat = 0; cellIdx = 0; return;
        case 'clcbpat': pendingCellPat = p ?? 0; return;
        case 'cellx': rowCells.push(pendingCellPat); pendingCellPat = 0; return;
        case 'intbl': st.intbl = true; return;
        case 'pard': st.intbl = false; st.pbg = 0; return;
        case 'cbpat': st.pbg = p ?? 0; return;
        case 'cell': flushHex(); emit('\t'); cellIdx++; return;
        case 'row': flushHex(); cellIdx = 0; if (!st.dest || st.dest === 'fldrslt') newPara(st.part); return;
        case 'par': case 'sect': case 'page': flushHex(); if (!st.dest || st.dest === 'fldrslt') newPara(st.part); else if (st.buf) st.buf.text += '\n'; return;
        case 'plain': Object.assign(st, { v: false, fs: 24, cf: 0, hl: 0, cb: 0, del: false, ins: false, scale: 100, up: 0, f: defFont }); return;
        case 'v': st.v = p !== 0; return;
        case 'fs': st.fs = p ?? 24; return;
        case 'cf': st.cf = p ?? 0; return;
        case 'highlight': st.hl = p ?? 0; return;
        case 'chcbpat': case 'cb': st.cb = p ?? 0; return;
        case 'deleted': st.del = p !== 0; return;
        case 'revised': st.ins = p !== 0; return;
        case 'charscalex': st.scale = p ?? 100; return;
        case 'up': st.up = p ?? 6; return;
        case 'dn': st.up = -(p ?? 6); return;
        case 'f': st.f = p; return;
      }
      if (w === 'upr') { st.upr = true; return; } // {\upr{ANSI}{\*\ud{Unicode}}}: keep the Unicode copy
      if (w === 'ud') { st.ud = true; return; }
      if (INFO[w] && st.dest === 'info') { if (st.upr && !st.ud) setDest('skip'); else setDest('info:' + w); return; }
      if (SYM[w]) { flushHex(); emit(SYM[w]); return; }
      if (starred) setDest('skip');
    };

    const endGroup = (closing, parent) => {
      const d = closing.dest, b = closing.buf;
      if (!b || b === parent.buf) return; // buffer belongs to an outer group
      const t = b.text.trim();
      if (d === 'fldinst') fieldCodes.push({ instr: t, loc: (paras[closing.part] || { loc: closing.part }).loc });
      else if (d === 'atnauthor') lastAuthor = t;
      else if (d === 'annotation') comments.push({ author: lastAuthor || '—', text: t });
      else if (d === 'sn') pendingSn = t;
      else if (d === 'sv') { if (pendingSn === 'fHidden' && t === '1' && closing.shape) closing.shape.hidden = true; }
      else if (d === 'template') template = t;
      else if (d === 'objclass' && objects.length) objects[objects.length - 1].cls = t;
      else if (d && d.startsWith('info:') && t) rep.meta.push([INFO[d.slice(5)], t]);
    };

    const N = s.length;
    let i = 0;
    while (i < N) {
      const c = s[i];
      if (c === '{') { flushHex(); stack.push({ ...st }); i++; continue; }
      if (c === '}') {
        flushHex();
        if (st.dest === 'colortbl' && colorAcc) { colors.push(colorAcc); colorAcc = null; }
        const closing = st;
        st = stack.pop() || st;
        // Shape objects are shared by reference so properties set inside reach the text.
        if (closing.shape && st.shape === closing.shape) st.shape = closing.shape;
        endGroup(closing, st);
        i++;
        continue;
      }
      if (c === '\\') {
        const n = s[i + 1];
        if (n >= 'a' && n <= 'z' || n >= 'A' && n <= 'Z') {
          let j = i + 1;
          while (j < N && /[a-zA-Z]/.test(s[j])) j++;
          const word = s.slice(i + 1, j);
          let k = j, param = null;
          if (s[k] === '-' || (s[k] >= '0' && s[k] <= '9')) {
            let m = k + 1;
            while (m < N && s[m] >= '0' && s[m] <= '9') m++;
            param = parseInt(s.slice(k, m), 10);
            k = m;
          }
          if (s[k] === ' ') k++;
          i = k;
          if (word === 'bin' && param > 0) { i += param; continue; }
          if (word !== 'u') flushHex();
          control(word, param);
          continue;
        }
        if (n === "'") {
          const h = parseInt(s.substr(i + 2, 2), 16);
          i += 4;
          if (skip > 0) { skip--; continue; }
          if (Number.isFinite(h)) hexBuf.push(h);
          continue;
        }
        i += 2;
        if (n === '*') { st.starred = true; continue; }
        flushHex();
        if (n === '~') emit(' ');
        else if (n === '-') emit('­');
        else if (n === '_') emit('‑');
        else if (n === '\\' || n === '{' || n === '}') { if (skip > 0) skip--; else { hexBuf.push(n.charCodeAt(0)); } }
        else if (n === '\n' || n === '\r') { if (!st.dest) newPara(st.part); }
        continue;
      }
      if (c === '\r' || c === '\n') { i++; continue; }
      if (st.dest === 'colortbl') { if (c === ';') { colors.push(colorAcc); colorAcc = null; } i++; continue; }
      if (skip > 0) { skip--; i++; continue; }
      hexBuf.push(c.charCodeAt(0));
      i++;
    }
    flushHex();

    // Comments live in their own buffer; drop empty comment paragraphs.
    rep.paragraphs = rep.paragraphs.filter((p) => p.partKind !== 'comment' && p.runs.some((r) => r.text.trim()));
    LI.collectRunFindings(rep, opts);

    if (comments.length) {
      add(rep, 'warning', 'revisions', `Комментарии: ${comments.length}`, { list: comments.map((c) => `${c.author}: ${LI.clip(c.text, 400)}`), detail: 'Комментарии уходят вместе с файлом и видны получателю.' });
      for (const c of comments) rep.segments.push({ text: c.text, loc: `Комментарий (${c.author})`, hidden: false, src: 'comment' });
    }
    const delCount = rep.findings.filter((f) => f.title.startsWith('Удалённый текст')).length;
    if (delCount) add(rep, 'warning', 'revisions', `Непринятые исправления: удалённых фрагментов ${delCount}`, { detail: 'Удалённый текст остаётся в файле и читается получателем.' });
    for (const f of fieldCodes.filter((f) => f.instr)) {
      rep.segments.push({ text: f.instr, loc: f.loc + ' — код поля', hidden: true, src: 'field' });
      const name = (f.instr.match(/^\s*([A-Z]+)/i) || [])[1]?.toUpperCase() || '';
      if (name === 'DDE' || name === 'DDEAUTO') add(rep, 'critical', 'active', `Поле ${name}: запуск внешнего приложения`, { loc: f.loc, excerpt: f.instr });
      else if (/^(INCLUDETEXT|INCLUDEPICTURE|LINK|IMPORT)$/.test(name) && /(https?:|\\\\|file:)/i.test(f.instr)) add(rep, 'warning', 'active', `Поле ${name} подгружает внешнее содержимое`, { loc: f.loc, excerpt: f.instr });
    }
    if (fieldCodes.length) add(rep, 'info', 'active', `Поля: ${fieldCodes.length}`, { list: fieldCodes.slice(0, 30).map((f) => `${f.loc}: ${LI.clip(f.instr, 160)}`) });
    for (const o of objects) {
      const sev = o.upd || o.autlink ? 'critical' : 'warning';
      add(rep, sev, 'active', `Встроенный объект${o.cls ? ' ' + o.cls : ''}${o.upd ? ' с автообновлением' : ''}`, {
        detail: o.upd || o.autlink ? 'Объект обновляется при открытии файла. Через такие объекты распространяли эксплойты (например, CVE-2017-0199).' : 'Внутри объекта может быть отдельный файл.',
      });
    }
    if (template && /^(https?:|\\\\|file:)/i.test(template)) add(rep, 'critical', 'active', 'Внешний шаблон загружается по сети', { excerpt: template });
    else if (template) rep.meta.push(['Шаблон', template]);
    for (const [k, v] of rep.meta) if (['Название', 'Тема', 'Ключевые слова', 'Примечания', 'Категория'].includes(k)) rep.segments.push({ text: v, loc: 'Свойство «' + k + '»', hidden: true, src: 'meta' });
    const who = rep.meta.filter(([k]) => ['Автор', 'Последним изменил', 'Организация', 'Руководитель'].includes(k)).map(([k, v]) => `${k}: ${v}`);
    if (who.length) add(rep, 'info', 'meta', 'Сведения об авторах в свойствах файла', { list: who });
    rep.notes.push('RTF: стили из таблицы стилей не учитываются, цвет фона страницы считается белым.');
    return rep;
  };
})();
