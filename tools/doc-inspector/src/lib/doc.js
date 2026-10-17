'use strict';
// Word 97–2003 binary (.doc): Compound File Binary reader plus the parts of
// [MS-DOC] needed for text, character formatting, comments and metadata.
(() => {
  const LI = window.LI;
  const { add } = LI;

  // ---- Compound File Binary ([MS-CFB]) ----------------------------------------

  LI.readCfb = (buf) => {
    const u8 = new Uint8Array(buf);
    const dv = new DataView(buf);
    const sig = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
    if (!sig.every((b, i) => u8[i] === b)) throw new Error('Не составной файл OLE');
    const secShift = dv.getUint16(0x1e, true);
    const miniShift = dv.getUint16(0x20, true);
    const secSize = 1 << secShift, miniSize = 1 << miniShift;
    const csectFat = dv.getUint32(0x2c, true);
    const dirStart = dv.getUint32(0x30, true);
    const cutoff = dv.getUint32(0x38, true);
    const miniFatStart = dv.getUint32(0x3c, true);
    let difStart = dv.getUint32(0x44, true);
    const csectDif = dv.getUint32(0x48, true);
    const ENDC = 0xfffffffe, FREE = 0xffffffff;
    const secOff = (s) => (s + 1) * secSize;

    const fatSecs = [];
    for (let i = 0; i < 109 && fatSecs.length < csectFat; i++) {
      const s = dv.getUint32(0x4c + i * 4, true);
      if (s !== FREE) fatSecs.push(s);
    }
    for (let k = 0; k < csectDif && difStart !== ENDC && difStart !== FREE; k++) {
      const off = secOff(difStart);
      const per = secSize / 4 - 1;
      for (let i = 0; i < per && fatSecs.length < csectFat; i++) {
        const s = dv.getUint32(off + i * 4, true);
        if (s !== FREE) fatSecs.push(s);
      }
      difStart = dv.getUint32(off + per * 4, true);
    }
    const fat = new Uint32Array(fatSecs.length * (secSize / 4));
    fatSecs.forEach((s, i) => {
      const off = secOff(s);
      for (let j = 0; j < secSize / 4; j++) if (off + j * 4 + 4 <= u8.length) fat[i * (secSize / 4) + j] = dv.getUint32(off + j * 4, true);
    });
    const chain = (start, table) => {
      const out = [];
      let s = start, guard = 0;
      while (s !== ENDC && s !== FREE && s < table.length && guard++ < 1e6) {
        out.push(s);
        s = table[s];
      }
      return out;
    };
    const readChain = (start, size) => {
      const secs = chain(start, fat);
      const out = new Uint8Array(secs.length * secSize);
      secs.forEach((s, i) => out.set(u8.subarray(secOff(s), secOff(s) + secSize), i * secSize));
      return size != null ? out.subarray(0, Math.min(size, out.length)) : out;
    };

    const dirBytes = readChain(dirStart);
    const ddv = new DataView(dirBytes.buffer, dirBytes.byteOffset, dirBytes.byteLength);
    const entries = [];
    for (let off = 0; off + 128 <= dirBytes.length; off += 128) {
      const nl = ddv.getUint16(off + 64, true);
      let name = '';
      for (let i = 0; i < Math.max(0, nl / 2 - 1); i++) name += String.fromCharCode(ddv.getUint16(off + i * 2, true));
      entries.push({
        name,
        type: dirBytes[off + 66],
        left: ddv.getUint32(off + 68, true),
        right: ddv.getUint32(off + 72, true),
        child: ddv.getUint32(off + 76, true),
        start: ddv.getUint32(off + 116, true),
        size: ddv.getUint32(off + 120, true),
      });
    }
    const root = entries[0];
    const miniStream = root ? readChain(root.start, root.size) : new Uint8Array();
    const miniFatBytes = miniFatStart !== ENDC ? readChain(miniFatStart) : new Uint8Array();
    const miniFat = new Uint32Array(miniFatBytes.buffer.slice(miniFatBytes.byteOffset, miniFatBytes.byteOffset + (miniFatBytes.byteLength & ~3)));

    const readEntry = (e) => {
      if (e.size < cutoff && e !== root) {
        const secs = chain(e.start, miniFat);
        const out = new Uint8Array(secs.length * miniSize);
        secs.forEach((s, i) => out.set(miniStream.subarray(s * miniSize, (s + 1) * miniSize), i * miniSize));
        return out.subarray(0, e.size);
      }
      return readChain(e.start, e.size);
    };

    // Walk the red-black tree into full paths.
    const paths = {};
    const visit = (id, prefix, depth) => {
      if (id === FREE || id >= entries.length || depth > 64) return;
      const e = entries[id];
      if (!e || e.visited) return;
      e.visited = true;
      visit(e.left, prefix, depth + 1);
      const p = prefix + e.name;
      e.path = p;
      paths[p] = e;
      if (e.type === 1 || e.type === 5) visit(e.child, p + '/', depth + 1);
      visit(e.right, prefix, depth + 1);
    };
    if (root) visit(root.child, '', 0);
    return {
      paths,
      list: Object.values(paths),
      read: (p) => (paths[p] && paths[p].type === 2 ? readEntry(paths[p]) : null),
      readEntry,
    };
  };

  // ---- OLE property sets (SummaryInformation) ---------------------------------

  const FILETIME = (lo, hi) => {
    const ms = (hi * 4294967296 + lo) / 10000 - 11644473600000;
    if (!(ms > 0)) return null;
    return new Date(ms);
  };
  LI.readPropSet = (bytes, names) => {
    if (!bytes || bytes.length < 48) return [];
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const secOff = dv.getUint32(44, true);
    if (secOff + 8 > bytes.length) return [];
    const count = dv.getUint32(secOff + 4, true);
    const props = {};
    for (let i = 0; i < count && i < 200; i++) {
      const id = dv.getUint32(secOff + 8 + i * 8, true);
      const off = secOff + dv.getUint32(secOff + 12 + i * 8, true);
      if (off + 8 > bytes.length) continue;
      props[id] = off;
    }
    let cp = 1252;
    if (props[1]) cp = dv.getUint16(props[1] + 4, true);
    const out = [];
    for (const [idS, off] of Object.entries(props)) {
      const id = +idS;
      if (!names[id]) continue;
      const type = dv.getUint32(off, true);
      let v = null;
      if (type === 0x1e) {
        const len = dv.getUint32(off + 4, true);
        v = LI.decode(bytes.subarray(off + 8, off + 8 + Math.max(0, len - 1)), LI.CODEPAGES[cp] || 'windows-1252').replace(/\0+$/, '');
      } else if (type === 0x1f) {
        const len = dv.getUint32(off + 4, true);
        v = LI.decode(bytes.subarray(off + 8, off + 8 + Math.max(0, len - 1) * 2), 'utf-16le');
      } else if (type === 0x40) {
        const lo = dv.getUint32(off + 4, true), hi = dv.getUint32(off + 8, true);
        if (id === 10) v = String(Math.round((hi * 4294967296 + lo) / 600000000));
        else { const d = FILETIME(lo, hi); v = d ? d.toISOString().replace('T', ' ').slice(0, 19) : null; }
      } else if (type === 3) v = String(dv.getInt32(off + 4, true));
      else if (type === 2) v = String(dv.getInt16(off + 4, true));
      if (v !== null && v !== '' && v !== '0') out.push([names[id], v]);
    }
    return out;
  };
  const SUMMARY = { 2: 'Название', 3: 'Тема', 4: 'Автор', 5: 'Ключевые слова', 6: 'Примечания', 7: 'Шаблон', 8: 'Последним изменил', 9: 'Редакция', 10: 'Время правки, мин', 11: 'Последняя печать', 12: 'Создан', 13: 'Изменён', 18: 'Программа' };
  const DOCSUMMARY = { 2: 'Категория', 14: 'Руководитель', 15: 'Организация' };

  // ---- Word binary --------------------------------------------------------------

  // Operand size by spra (sprm >> 13).
  const SPRA = [1, 1, 2, 4, 2, 2, -1, 3];

  function readGrpprl(bytes, start, end, cb) {
    let i = start;
    while (i + 2 <= end) {
      const sprm = bytes[i] | (bytes[i + 1] << 8);
      i += 2;
      let size = SPRA[sprm >> 13];
      let opStart = i;
      if (size === -1) {
        if (sprm === 0xd608) { size = (bytes[i] | (bytes[i + 1] << 8)) - 1; opStart = i + 2; } // sprmTDefTable: 2-byte length
        else { size = bytes[i]; opStart = i + 1; }
      }
      if (opStart + size > end + 1) break;
      cb(sprm, bytes, opStart, size);
      i = opStart + size;
    }
  }

  const CP1252 = [...LI.decode(Uint8Array.from({ length: 256 }, (_, k) => k), 'windows-1252')];

  LI.parseDoc = async (buf, opts) => {
    const cfb = LI.readCfb(buf);
    const rep = LI.newReport('doc');
    for (const e of cfb.list) rep.structure.push({ name: e.path + (e.type === 1 ? '/' : ''), size: e.type === 2 ? e.size : null });

    const has = (re) => cfb.list.some((e) => re.test(e.path));
    if (has(/^(Macros|_VBA_PROJECT_CUR)(\/|$)/)) add(rep, 'critical', 'active', 'Макросы VBA', { detail: 'В файле есть хранилище макросов. Не включайте макросы в файле из внешнего источника.' });
    const ole = cfb.list.filter((e) => /^ObjectPool\/[^/]+$/.test(e.path) && e.type === 1);
    if (ole.length) add(rep, 'warning', 'active', `Встроенные OLE-объекты: ${ole.length}`, { list: ole.map((e) => e.path), detail: 'Внутри может быть отдельный документ или исполняемый пакет.' });
    if (has(/Ole10Native$/)) add(rep, 'warning', 'active', 'Вложенный файл (OLE Package)', { detail: 'Объект «Пакет» хранит произвольный файл, который открывается двойным щелчком.' });

    rep.meta.push(...LI.readPropSet(cfb.read('\u0005SummaryInformation'), SUMMARY));
    rep.meta.push(...LI.readPropSet(cfb.read('\u0005DocumentSummaryInformation'), DOCSUMMARY));
    for (const [k, v] of rep.meta) if (['Название', 'Тема', 'Ключевые слова', 'Примечания', 'Категория'].includes(k)) rep.segments.push({ text: v, loc: 'Свойство «' + k + '»', hidden: true, src: 'meta' });

    const wd = cfb.read('WordDocument');
    if (!wd || wd.length < 0x200) throw new Error('Нет потока WordDocument: это не документ Word');
    const dv = new DataView(wd.buffer, wd.byteOffset, wd.byteLength);
    if (dv.getUint16(0, true) !== 0xa5ec) throw new Error('Неизвестная сигнатура документа Word');
    const nFib = dv.getUint16(2, true);
    const flags = dv.getUint16(0x0a, true);
    if (flags & 0x0100) {
      add(rep, 'critical', 'structure', 'Документ зашифрован', { detail: 'Текст недоступен без пароля. Скрытое содержимое проверить нельзя.' });
      return rep;
    }
    if (nFib < 0x00c1) {
      add(rep, 'warning', 'structure', 'Формат Word 6/95', { detail: 'Поддерживается Word 97 и новее. Проверены только свойства и структура файла.' });
      return rep;
    }
    const table = cfb.read(flags & 0x0200 ? '1Table' : '0Table');
    if (!table) throw new Error('Нет потока таблиц документа');
    const tdv = new DataView(table.buffer, table.byteOffset, table.byteLength);

    let pos = 32;
    const csw = dv.getUint16(pos, true); pos += 2 + csw * 2;
    const cslw = dv.getUint16(pos, true); const lwStart = pos + 2; pos += 2 + cslw * 4;
    const cbRg = dv.getUint16(pos, true); const rgStart = pos + 2;
    const lw = (i) => dv.getInt32(lwStart + i * 4, true);
    const fcLcb = (i) => (i < cbRg ? [dv.getUint32(rgStart + i * 8, true), dv.getUint32(rgStart + i * 8 + 4, true)] : [0, 0]);
    const ccp = { text: lw(3), ftn: lw(4), hdd: lw(5), mcr: lw(6), atn: lw(7), edn: lw(8), txbx: lw(9), hdrTxbx: lw(10) };

    // Piece table.
    const [fcClx, lcbClx] = fcLcb(33);
    let i = fcClx;
    const end = fcClx + lcbClx;
    while (i < end && table[i] === 0x01) i += 3 + tdv.getInt16(i + 1, true);
    if (table[i] !== 0x02) throw new Error('Таблица фрагментов текста не найдена');
    const lcbPcd = tdv.getUint32(i + 1, true);
    const pStart = i + 5;
    const n = (lcbPcd - 4) / 12;
    const cps = [];
    for (let k = 0; k <= n; k++) cps.push(tdv.getUint32(pStart + k * 4, true));
    const pieces = [];
    for (let k = 0; k < n; k++) {
      const o = pStart + (n + 1) * 4 + k * 8;
      const fcRaw = tdv.getUint32(o + 2, true);
      const compressed = !!(fcRaw & 0x40000000);
      const fc = fcRaw & 0x3fffffff;
      pieces.push({ cpStart: cps[k], cpEnd: cps[k + 1], compressed, fc: compressed ? fc / 2 : fc });
    }

    // Character sprms. Toggles keep their raw operand (0, 1, 0x80 = as style, 0x81 = opposite of style).
    function applyChp(props, sprm, b, o, sz) {
      switch (sprm) {
        case 0x0800: props.del = b[o]; break;
        case 0x0801: props.ins = b[o]; break;
        case 0x083c: props.vanish = b[o]; break;
        case 0x2a42: props.ico = b[o]; break;
        case 0x6870: if (b[o + 3] !== 0xff) props.cv = [b[o], b[o + 1], b[o + 2]]; break;
        case 0x4a43: props.hps = b[o] | (b[o + 1] << 8); break;
        case 0x2a0c: props.hl = b[o]; break;
        case 0x4852: props.scale = b[o] | (b[o + 1] << 8); break;
        case 0x4a30: props.istd = b[o] | (b[o + 1] << 8); break;
        case 0xca71: if (sz >= 10) { const auto = b[o + 7] === 0xff; const ipat = b[o + 8] | (b[o + 9] << 8); if (!auto && ipat !== 0xffff) props.shd = [b[o + 4], b[o + 5], b[o + 6]]; } break;
        case 0x4866: { const v = b[o] | (b[o + 1] << 8); const icoBack = (v >> 5) & 0x1f; if (icoBack && LI.ICO[icoBack]) props.shd = LI.parseHex(LI.ICO[icoBack]); break; }
      }
    }
    const TOGGLES = ['del', 'ins', 'vanish'];
    const resolve = (own, base) => {
      const out = { ...base, ...own };
      for (const k of TOGGLES) if (k in own) {
        const v = own[k];
        out[k] = v === 0x80 ? !!base[k] : v === 0x81 ? !base[k] : v === 1 || v === true;
      }
      return out;
    };

    // Style sheet (STSH): character formatting of paragraph and character styles.
    const styles = [];
    try {
      const [fcSt, lcbSt] = fcLcb(1);
      if (lcbSt > 4) {
        const endSt = fcSt + lcbSt;
        const cbStshi = tdv.getUint16(fcSt, true);
        const cstd = tdv.getUint16(fcSt + 2, true), cbBase = tdv.getUint16(fcSt + 4, true);
        let o = fcSt + 2 + cbStshi;
        for (let k = 0; k < cstd && o + 2 <= endSt; k++) {
          const cb = tdv.getUint16(o, true);
          const s0 = o + 2;
          o = s0 + cb;
          if (!cb) { styles.push(null); continue; }
          const stk = tdv.getUint16(s0 + 2, true) & 0xf, base = tdv.getUint16(s0 + 2, true) >> 4, cupx = tdv.getUint16(s0 + 4, true) & 0xf;
          let q = s0 + cbBase;
          const nameLen = tdv.getUint16(q, true);
          q += 2 + (nameLen + 1) * 2;
          const chp = {};
          for (let u = 0; u < cupx && q + 2 <= o; u++) {
            const cbU = tdv.getUint16(q, true);
            const g = q + 2, end = g + cbU;
            if ((stk === 1 && u === 1) || (stk === 2 && u === 0)) readGrpprl(table, g, end, (sprm, b, op, sz) => applyChp(chp, sprm, b, op, sz));
            q = end + (cbU & 1);
          }
          styles.push({ stk, base, chp });
        }
      }
    } catch {}
    const styleChp = (istd, depth = 0) => {
      const st = styles[istd];
      if (!st || depth > 20) return {};
      if (st.eff) return st.eff;
      st.eff = {};
      const base = st.base !== 0xfff ? styleChp(st.base, depth + 1) : {};
      st.eff = resolve(st.chp, base);
      return st.eff;
    };
    const effCache = new Map();
    const effective = (props, paraIstd) => {
      const key = props;
      let m = effCache.get(key);
      if (!m) effCache.set(key, (m = new Map()));
      if (m.has(paraIstd)) return m.get(paraIstd);
      const p = styleChp(paraIstd ?? 0);
      const c = props.istd != null ? styleChp(props.istd) : {};
      const { istd, ...own } = props;
      const e = resolve(own, resolve(c, p));
      m.set(paraIstd, e);
      return e;
    };

    // Character runs (CHPX FKPs) keyed by file position.
    const [fcBte, lcbBte] = fcLcb(12);
    const nb = (lcbBte - 4) / 8;
    const runs = [];
    for (let k = 0; k < nb; k++) {
      const pn = tdv.getUint32(fcBte + (nb + 1) * 4 + k * 4, true) & 0x3fffff;
      const page = pn * 512;
      if (page + 512 > wd.length) continue;
      const crun = wd[page + 511];
      for (let r = 0; r < crun; r++) {
        const fcS = dv.getUint32(page + r * 4, true), fcE = dv.getUint32(page + (r + 1) * 4, true);
        const bOff = wd[page + (crun + 1) * 4 + r] * 2;
        const props = {};
        if (bOff) {
          const cb = wd[page + bOff];
          readGrpprl(wd, page + bOff + 1, page + bOff + 1 + cb, (sprm, b, o, sz) => applyChp(props, sprm, b, o, sz));
        }
        runs.push({ fcS, fcE, props });
      }
    }
    runs.sort((a, b) => a.fcS - b.fcS);
    const finder = (list) => (fc) => {
      let lo = 0, hi = list.length - 1;
      while (lo <= hi) {
        const m = (lo + hi) >> 1;
        if (list[m].fcE <= fc) lo = m + 1;
        else if (list[m].fcS > fc) hi = m - 1;
        else return list[m];
      }
      return null;
    };
    const findRun = finder(runs);

    // Paragraph runs (PAPX FKPs): table membership, row ends and shading.
    const shd10 = (b, o) => (b[o + 7] === 0xff ? null : [b[o + 4], b[o + 5], b[o + 6]]);
    const shd80 = (v) => { const back = (v >> 5) & 0x1f; return back && LI.ICO[back] ? LI.parseHex(LI.ICO[back]) : null; };
    const [fcBteP, lcbBteP] = fcLcb(13);
    const np = lcbBteP >= 4 ? (lcbBteP - 4) / 8 : 0;
    const papx = [];
    for (let k = 0; k < np; k++) {
      const pn = tdv.getUint32(fcBteP + (np + 1) * 4 + k * 4, true) & 0x3fffff;
      const page = pn * 512;
      if (page + 512 > wd.length) continue;
      const crun = wd[page + 511];
      for (let r = 0; r < crun; r++) {
        const fcS = dv.getUint32(page + r * 4, true), fcE = dv.getUint32(page + (r + 1) * 4, true);
        const bOff = wd[page + (crun + 1) * 4 + r * 13] * 2;
        const props = {};
        if (bOff) {
          let o = page + bOff, cb = wd[o], size, start;
          if (cb !== 0) { size = 2 * cb - 1; start = o + 1; } else { size = 2 * wd[o + 1]; start = o + 2; }
          props.istd = wd[start] | (wd[start + 1] << 8);
          readGrpprl(wd, start + 2, start + size, (sprm, b, op, sz) => {
            if (sprm === 0x2416) props.inTable = b[op] === 1;
            else if (sprm === 0x2417 || sprm === 0x244c) props.ttp = b[op] === 1;
            else if (sprm === 0xd612) { props.cells = []; for (let q = 0; q + 10 <= sz; q += 10) props.cells.push(shd10(b, op + q)); }
            else if (sprm === 0xd609 && !props.cells) { props.cells = []; for (let q = 0; q + 2 <= sz; q += 2) props.cells.push(shd80(b[op + q] | (b[op + q + 1] << 8))); }
            else if (sprm === 0xc64d && sz >= 10) props.pshd = shd10(b, op);
            else if (sprm === 0x442d && !props.pshd) props.pshd = shd80(b[op] | (b[op + 1] << 8));
          });
        }
        papx.push({ fcS, fcE, props });
      }
    }
    papx.sort((a, b) => a.fcS - b.fcS);
    const findPapx = finder(papx);
    const recolor = (para, bg, src) => {
      for (const r of para.runs) {
        if (!r.fg || r.ownBg) continue;
        r.flags = r.flags.filter((f) => f !== 'color' && f !== 'lowcontrast');
        r.note = r.note.split('; ').filter((n) => n && !n.startsWith('цвет ')).join('; ');
        const ci = LI.colorIssue(r.fg, bg, opts);
        if (ci) {
          r.flags.push(ci.flag);
          r.note = (r.note ? r.note + '; ' : '') + `цвет ${LI.toHex(ci.fg)} на фоне ${LI.toHex(bg)} (${src}), контраст ${LI.fmtNum(ci.ratio)}:1`;
        }
      }
    };

    // Character stream with properties.
    const total = Object.values(ccp).reduce((a, b) => a + Math.max(0, b), 0);
    const chars = []; // {ch, props}
    for (const pc of pieces) {
      for (let cp = pc.cpStart; cp < pc.cpEnd && cp < total + 1; cp++) {
        const fc = pc.compressed ? pc.fc + (cp - pc.cpStart) : pc.fc + (cp - pc.cpStart) * 2;
        let ch;
        if (pc.compressed) ch = CP1252[wd[fc]] ?? '';
        else { if (fc + 1 >= wd.length) break; ch = String.fromCharCode(wd[fc] | (wd[fc + 1] << 8)); }
        const run = findRun(fc);
        chars.push({ ch, fc, props: run ? run.props : {} });
      }
    }

    // Split into story parts.
    const parts = [];
    let at = 0;
    const take = (len, label, kind) => { if (len > 0) parts.push({ label, kind, from: at, to: at + len }); at += Math.max(0, len); };
    take(ccp.text, 'Основной текст', 'main');
    take(ccp.ftn, 'Сноски', 'footnote');
    take(ccp.hdd, 'Колонтитулы', 'header');
    take(ccp.mcr, 'Макросы', 'other');
    take(ccp.atn, 'Комментарии', 'comment');
    take(ccp.edn, 'Концевые сноски', 'footnote');
    take(ccp.txbx, 'Надписи', 'main');
    take(ccp.hdrTxbx, 'Надписи в колонтитулах', 'header');

    const fieldCodes = [];
    const delRevs = { n: 0 }, insRevs = { n: 0 };
    for (const part of parts) {
      let para = null, idx = 0;
      const fields = [];
      const newPara = () => {
        idx++;
        para = { part: part.label, partKind: part.kind, loc: `${part.label}, абз. ${idx}`, runs: [] };
        rep.paragraphs.push(para);
      };
      newPara();
      let prevDel = false, prevIns = false;
      let cell = [], row = [];
      for (let k = part.from; k < part.to && k < chars.length; k++) {
        const { ch, props: direct, fc } = chars[k];
        const props = effective(direct, findPapx(fc)?.props.istd);
        const code = ch.charCodeAt(0);
        if (code === 0x13) { fields.push({ instr: '', phase: 'instr', loc: para.loc }); continue; }
        if (code === 0x14) { if (fields.length) fields[fields.length - 1].phase = 'result'; continue; }
        if (code === 0x15) { const f = fields.pop(); if (f) fieldCodes.push(f); continue; }
        if (fields.length && fields[fields.length - 1].phase === 'instr') { fields[fields.length - 1].instr += ch; continue; }
        if (code === 0x0d || code === 0x07 || code === 0x0c) {
          const pp = findPapx(fc)?.props || {};
          if (pp.pshd) recolor(para, pp.pshd, 'заливка абзаца');
          if (code === 0x07 && pp.ttp) {
            // Row end: its TAPX carries the shading of every cell in the row.
            row.forEach((c, i) => { const bg = pp.cells && pp.cells[i]; if (bg) c.forEach((p) => recolor(p, bg, 'заливка ячейки')); });
            row = []; cell = [];
          } else if (code === 0x07) { cell.push(para); row.push(cell); cell = []; }
          else if (pp.inTable) cell.push(para);
          newPara();
          continue;
        }
        if (code === 0x01 || code === 0x08 || code === 0x05 || code === 0x02 || code === 0x03 || code === 0x04) continue;
        let t = ch;
        if (code === 0x0b) t = '\n';
        else if (code === 0x1e) t = '‑';
        else if (code === 0x1f) t = '­';
        else if (code === 0xa0) t = ' ';
        const fl = [], notes = [];
        if (props.del) { fl.push('deleted'); if (!prevDel) delRevs.n++; }
        if (props.ins) { fl.push('inserted'); if (!prevIns) insRevs.n++; }
        prevDel = !!props.del; prevIns = !!props.ins;
        if (props.vanish) fl.push('hidden');
        if (props.hps) {
          const pt = props.hps / 2;
          if (pt <= opts.tinyCritical) fl.push('tiny');
          else if (pt < opts.tinyPt) fl.push('small');
          if (pt < opts.tinyPt) notes.push(`размер ${LI.fmtNum(pt, 1)} пт`);
        }
        const fg = props.cv || (props.ico && LI.ICO[props.ico] ? LI.parseHex(LI.ICO[props.ico]) : null);
        if (fg) {
          const bg = props.shd || (props.hl && LI.ICO[props.hl] ? LI.parseHex(LI.ICO[props.hl]) : null);
          const ci = LI.colorIssue(fg, bg, opts);
          if (ci) { fl.push(ci.flag); notes.push(`цвет ${LI.toHex(ci.fg)} на фоне ${LI.toHex(ci.bg || [255, 255, 255])}, контраст ${LI.fmtNum(ci.ratio)}:1`); }
        }
        if (props.scale && props.scale < 34) { fl.push('scaled'); notes.push(`ширина знаков ${props.scale}%`); }
        const note = notes.join('; ');
        const ownBg = !!(props.shd || props.hl);
        const last = para.runs[para.runs.length - 1];
        if (last && last.flags.join() === fl.join() && last.note === note && String(last.fg) === String(fg) && last.ownBg === ownBg) last.text += t;
        else para.runs.push({ text: t, flags: fl, note, fg, ownBg });
      }
    }
    rep.paragraphs = rep.paragraphs.filter((p) => p.runs.some((r) => r.text.trim()));

    // Comments: split the annotation story by PlcfandTxt and attach authors.
    const commentParas = rep.paragraphs.filter((p) => p.partKind === 'comment');
    if (commentParas.length) {
      const authors = [];
      const [fcAuth, lcbAuth] = fcLcb(36);
      for (let o = fcAuth; o + 2 <= fcAuth + lcbAuth;) {
        const cch = tdv.getUint16(o, true);
        let s = '';
        for (let q = 0; q < cch; q++) s += String.fromCharCode(tdv.getUint16(o + 2 + q * 2, true));
        authors.push(s);
        o += 2 + cch * 2;
      }
      const [fcRef, lcbRef] = fcLcb(4);
      const nRef = lcbRef >= 4 ? Math.floor((lcbRef - 4) / 34) : 0;
      const refAuthors = [];
      for (let q = 0; q < nRef; q++) refAuthors.push(authors[tdv.getUint16(fcRef + (nRef + 1) * 4 + q * 30 + 20, true)] || '—');
      const texts = commentParas.map((p) => p.runs.map((r) => r.text).join('')).join('\n');
      add(rep, 'warning', 'revisions', `Комментарии${nRef ? ': ' + nRef : ''}`, {
        excerpt: LI.clip(texts, 800),
        detail: `Авторы: ${[...new Set(refAuthors)].join(', ') || 'не указаны'}. Комментарии уходят вместе с файлом и видны получателю.`,
      });
      for (const p of commentParas) rep.segments.push({ text: p.runs.map((r) => r.text).join(''), loc: p.loc, hidden: false, src: 'comment' });
      rep.paragraphs = rep.paragraphs.filter((p) => p.partKind !== 'comment');
    }

    LI.collectRunFindings(rep, opts);
    if (delRevs.n || insRevs.n) add(rep, delRevs.n ? 'warning' : 'info', 'revisions', `Непринятые исправления: удалений ${delRevs.n}, вставок ${insRevs.n}`, { detail: 'Удалённый текст остаётся в файле и читается получателем. Удалённые фрагменты перечислены отдельно.' });

    const codes = fieldCodes.map((f) => ({ ...f, instr: f.instr.trim() })).filter((f) => f.instr);
    for (const f of codes) {
      rep.segments.push({ text: f.instr, loc: f.loc + ' — код поля', hidden: true, src: 'field' });
      const name = (f.instr.match(/^\s*([A-Z]+)/i) || [])[1]?.toUpperCase() || '';
      if (name === 'DDE' || name === 'DDEAUTO') add(rep, 'critical', 'active', `Поле ${name}: запуск внешнего приложения`, { loc: f.loc, excerpt: f.instr });
      else if (/^(INCLUDETEXT|INCLUDEPICTURE|LINK|IMPORT)$/.test(name) && /(https?:|\\\\|file:)/i.test(f.instr)) add(rep, 'warning', 'active', `Поле ${name} подгружает внешнее содержимое`, { loc: f.loc, excerpt: f.instr });
    }
    if (codes.length) add(rep, 'info', 'active', `Поля Word: ${codes.length}`, { list: codes.slice(0, 30).map((f) => `${f.loc}: ${LI.clip(f.instr, 160)}`) });
    const who = rep.meta.filter(([k]) => ['Автор', 'Последним изменил', 'Организация', 'Руководитель'].includes(k)).map(([k, v]) => `${k}: ${v}`);
    if (who.length) add(rep, 'info', 'meta', 'Сведения об авторах в свойствах файла', { list: who });
    rep.notes.push('Формат .doc: учитываются прямое форматирование, стили абзацев и знаков, заливка абзацев и ячеек. Цвет фона страницы и темы оформления считаются стандартными.');
    return rep;
  };
})();
