'use strict';
// DOCX / DOCM / DOTX (Office Open XML) analysis.
(() => {
  const LI = window.LI;
  const { kids, kid, desc, wattr, rattr, wbool, parseXml, add } = LI;

  const KNOWN_PART = /^(\[Content_Types\]\.xml|_rels\/\.rels|docProps\/(core|app|custom)\.xml|docProps\/thumbnail\.\w+|customXml\/.+|docMetadata\/.+|word\/(document|styles|stylesWithEffects|settings|webSettings|fontTable|numbering|footnotes|endnotes|comments|commentsExtended|commentsIds|commentsExtensible|people|header\d*|footer\d*|vbaData|customizations|document2)\.xml|word\/_rels\/.+\.rels|word\/theme\/.+|word\/media\/.+|word\/glossary\/.+|word\/embeddings\/.+|word\/activeX\/.+|word\/fonts\/.+|word\/diagrams\/.+|word\/charts\/.+|word\/ink\/.+|word\/webextensions\/.+|word\/printerSettings\/.+|word\/vbaProject\.bin|word\/afchunk.*|word\/intelligence\d*\.xml|word\/_rels\/.*|_xmlsignatures\/.+|customUI\/.+|userCustomization\/.+)$/i;

  const THEME_MAP = {
    dark1: 'dk1', light1: 'lt1', dark2: 'dk2', light2: 'lt2', text1: 'dk1', text2: 'dk2', background1: 'lt1', background2: 'lt2',
    accent1: 'accent1', accent2: 'accent2', accent3: 'accent3', accent4: 'accent4', accent5: 'accent5', accent6: 'accent6',
    hyperlink: 'hlink', followedHyperlink: 'folHlink',
  };

  const RU_LOWER = 'абвгдежзиклмнопрстуфхцчшщэюя';

  const joinPath = (base, target) => {
    if (target.startsWith('/')) return target.slice(1);
    const parts = base.split('/').slice(0, -1);
    for (const seg of target.split('/')) {
      if (seg === '..') parts.pop();
      else if (seg !== '.') parts.push(seg);
    }
    return parts.join('/');
  };

  const readRels = async (zip, partPath) => {
    const dir = partPath.split('/').slice(0, -1).join('/');
    const name = partPath.split('/').pop();
    const relPath = (dir ? dir + '/' : '') + '_rels/' + name + '.rels';
    const f = zip.file(relPath);
    const map = {};
    if (!f) return map;
    try {
      const d = parseXml(await f.async('string'));
      for (const r of desc(d, 'Relationship')) {
        const ext = r.getAttribute('TargetMode') === 'External';
        const target = r.getAttribute('Target') || '';
        map[r.getAttribute('Id')] = {
          type: (r.getAttribute('Type') || '').split('/').pop(),
          target,
          external: ext,
          path: ext ? null : joinPath(partPath, target),
        };
      }
    } catch {}
    return map;
  };

  const readRPr = (rPr) => {
    const o = {};
    if (!rPr) return o;
    for (const c of rPr.children) {
      switch (c.localName) {
        case 'vanish': o.vanish = wbool(c); break;
        case 'specVanish': o.specVanish = wbool(c); break;
        case 'webHidden': o.webHidden = wbool(c); break;
        case 'color': o.color = { val: wattr(c, 'val'), theme: wattr(c, 'themeColor'), tint: wattr(c, 'themeTint'), shade: wattr(c, 'themeShade') }; break;
        case 'sz': o.sz = parseInt(wattr(c, 'val'), 10); break;
        case 'highlight': o.highlight = wattr(c, 'val'); break;
        case 'shd': o.shd = { fill: wattr(c, 'fill'), val: wattr(c, 'val'), color: wattr(c, 'color') }; break;
        case 'w': o.w = parseInt(wattr(c, 'val'), 10); break;
        case 'position': o.position = parseInt(wattr(c, 'val'), 10); break;
        case 'rStyle': o.rStyle = wattr(c, 'val'); break;
      }
    }
    return o;
  };

  const shdColor = (shd) => {
    if (!shd) return null;
    if (shd.val === 'solid' && shd.color && shd.color !== 'auto') return LI.parseHex(shd.color);
    if (shd.fill && shd.fill !== 'auto') return LI.parseHex(shd.fill);
    return null;
  };

  function loadTheme(d) {
    const t = {};
    if (!d) return t;
    const scheme = desc(d, 'clrScheme')[0];
    if (!scheme) return t;
    for (const c of scheme.children) {
      const s = kid(c, 'srgbClr'), y = kid(c, 'sysClr');
      const v = s ? s.getAttribute('val') : y ? y.getAttribute('lastClr') : null;
      if (v) t[c.localName] = LI.parseHex(v);
    }
    return t;
  }

  function loadStyles(d) {
    const st = { byId: {}, defaults: {}, defaultPara: null };
    const dd = d ? desc(d, 'rPrDefault')[0] : null;
    if (dd) st.defaults = readRPr(kid(dd, 'rPr'));
    for (const s of d ? desc(d, 'style') : []) {
      const id = wattr(s, 'styleId');
      const pPr = kid(s, 'pPr');
      const numPr = pPr && kid(pPr, 'numPr');
      st.byId[id] = {
        id,
        type: wattr(s, 'type'),
        name: wattr(kid(s, 'name'), 'val') || id,
        basedOn: wattr(kid(s, 'basedOn'), 'val'),
        rPr: readRPr(kid(s, 'rPr')),
        numId: numPr ? wattr(kid(numPr, 'numId'), 'val') : null,
        ilvl: numPr ? wattr(kid(numPr, 'ilvl'), 'val') : null,
        shd: pPr ? (() => { const x = kid(pPr, 'shd'); return x ? { fill: wattr(x, 'fill'), val: wattr(x, 'val'), color: wattr(x, 'color') } : null; })() : null,
      };
      const isDef = wattr(s, 'default');
      if (st.byId[id].type === 'paragraph' && (isDef === '1' || isDef === 'true')) st.defaultPara = id;
    }
    const cache = {};
    st.chain = (id) => {
      if (!id || !st.byId[id]) return { rPr: {}, numId: null, ilvl: null, shd: null };
      if (cache[id]) return cache[id];
      cache[id] = { rPr: {}, numId: null, ilvl: null, shd: null }; // cycle guard
      const s = st.byId[id];
      const base = st.chain(s.basedOn);
      const r = {
        rPr: { ...base.rPr, ...s.rPr },
        numId: s.numId ?? base.numId,
        ilvl: s.ilvl ?? base.ilvl,
        shd: s.shd ?? base.shd,
      };
      cache[id] = r;
      return r;
    };
    return st;
  }

  // ---- Numbering ------------------------------------------------------------

  const roman = (n) => {
    const t = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
    let o = '';
    for (const [v, s] of t) while (n >= v) { o += s; n -= v; }
    return o;
  };
  const letters = (n, alpha) => {
    const k = alpha.length;
    const ch = alpha[(n - 1) % k];
    return ch.repeat(Math.floor((n - 1) / k) + 1);
  };
  const fmtNum = (n, fmt) => {
    switch (fmt) {
      case 'lowerLetter': return letters(n, 'abcdefghijklmnopqrstuvwxyz');
      case 'upperLetter': return letters(n, 'abcdefghijklmnopqrstuvwxyz').toUpperCase();
      case 'lowerRoman': return roman(n);
      case 'upperRoman': return roman(n).toUpperCase();
      case 'russianLower': return letters(n, RU_LOWER);
      case 'russianUpper': return letters(n, RU_LOWER).toUpperCase();
      case 'decimalZero': return String(n).padStart(2, '0');
      case 'bullet': return '•';
      case 'none': return '';
      default: return String(n);
    }
  };

  function loadNumbering(d) {
    const abs = {}, nums = {};
    if (!d) return { label: () => '' };
    for (const a of desc(d, 'abstractNum')) {
      const lv = {};
      for (const l of kids(a, 'lvl')) {
        lv[wattr(l, 'ilvl')] = {
          start: parseInt(wattr(kid(l, 'start'), 'val') ?? '1', 10),
          fmt: wattr(kid(l, 'numFmt'), 'val') || 'decimal',
          text: wattr(kid(l, 'lvlText'), 'val') ?? '',
          isLgl: !!kid(l, 'isLgl'),
          restart: kid(l, 'lvlRestart') ? parseInt(wattr(kid(l, 'lvlRestart'), 'val'), 10) : null,
        };
      }
      abs[wattr(a, 'abstractNumId')] = lv;
    }
    for (const n of kids(d.documentElement, 'num')) {
      const ov = {};
      for (const o of kids(n, 'lvlOverride')) {
        const so = kid(o, 'startOverride');
        if (so) ov[wattr(o, 'ilvl')] = parseInt(wattr(so, 'val'), 10);
      }
      nums[wattr(n, 'numId')] = { abs: wattr(kid(n, 'abstractNumId'), 'val'), ov, used: false };
    }
    const counters = {}; // absId -> [counts per level]
    return {
      label(numId, ilvl) {
        const n = nums[numId];
        if (!n || numId === '0') return '';
        const lv = abs[n.abs];
        if (!lv) return '';
        ilvl = parseInt(ilvl ?? '0', 10) || 0;
        const c = (counters[n.abs] = counters[n.abs] || []);
        if (!n.used) {
          n.used = true;
          for (const k of Object.keys(n.ov)) c[k] = n.ov[k] - 1;
        }
        const L = lv[ilvl] || { start: 1, fmt: 'decimal', text: '%' + (ilvl + 1) + '.' };
        c[ilvl] = (c[ilvl] ?? L.start - 1) + 1;
        for (let k = ilvl + 1; k < 9; k++) {
          const sub = lv[k];
          if (!sub || sub.restart === null || sub.restart === undefined || sub.restart > ilvl) c[k] = undefined;
        }
        return L.text.replace(/%(\d)/g, (_, d) => {
          const k = parseInt(d, 10) - 1;
          const LL = lv[k] || { start: 1, fmt: 'decimal' };
          const val = c[k] ?? LL.start;
          return fmtNum(val, L.isLgl && k < ilvl ? 'decimal' : LL.fmt);
        }).trim();
      },
    };
  }

  // ---- Body walker ------------------------------------------------------------

  function makeWalker(env) {
    const { rep, styles, theme, opts } = env;
    const ctxStack = [];

    const effRPr = (para, rPr) => {
      const pChain = styles.chain(para.pStyle || styles.defaultPara);
      const direct = readRPr(rPr);
      const cChain = styles.chain(direct.rStyle);
      return { ...styles.defaults, ...pChain.rPr, ...cChain.rPr, ...direct };
    };

    const themeColor = (c) => {
      const base = theme[THEME_MAP[c.theme] || c.theme];
      if (!base) return null;
      let [r, g, b] = base;
      if (c.tint) {
        const t = parseInt(c.tint, 16) / 255;
        [r, g, b] = [r, g, b].map((v) => v + (255 - v) * (1 - t));
      }
      if (c.shade) {
        const s = parseInt(c.shade, 16) / 255;
        [r, g, b] = [r, g, b].map((v) => v * s);
      }
      return [r, g, b];
    };

    const fgOf = (p) => {
      if (!p.color) return null;
      if (p.color.theme) return themeColor(p.color);
      if (p.color.val && p.color.val !== 'auto') return LI.parseHex(p.color.val);
      return null;
    };

    function runFlags(p, ctx, para) {
      const flags = [];
      const notes = [];
      if (ctx.rev === 'del') flags.push('deleted');
      if (ctx.rev === 'ins') flags.push('inserted');
      if (p.vanish || p.specVanish) flags.push('hidden');
      if (p.webHidden) flags.push('hidden');
      if (ctx.hiddenShape) flags.push('hidden');
      if (ctx.offpage) flags.push('offpage');
      if (ctx.tinyBox) flags.push('tinybox');
      const sizePt = (Number.isFinite(p.sz) ? p.sz : 20) / 2;
      if (sizePt <= opts.tinyCritical) flags.push('tiny');
      else if (sizePt < opts.tinyPt) flags.push('small');
      if (sizePt < opts.tinyPt) notes.push(`размер ${LI.fmtNum(sizePt, 1)} пт`);
      const fg = fgOf(p);
      if (fg) {
        let bg = null, bgSrc = 'страница';
        const rs = shdColor(p.shd);
        if (rs) { bg = rs; bgSrc = 'заливка текста'; }
        else if (p.highlight && p.highlight !== 'none' && LI.HIGHLIGHT[p.highlight]) { bg = LI.parseHex(LI.HIGHLIGHT[p.highlight]); bgSrc = 'выделение'; }
        else if (para.shd) { bg = para.shd; bgSrc = 'заливка абзаца'; }
        else if (ctx.cellFill) { bg = ctx.cellFill; bgSrc = 'заливка ячейки'; }
        else if (ctx.boxFill) { bg = ctx.boxFill; bgSrc = 'заливка фигуры'; }
        else if (env.pageBg) { bg = env.pageBg; bgSrc = 'цвет страницы'; }
        const ci = LI.colorIssue(fg, bg, opts);
        if (ci) {
          flags.push(ci.flag);
          notes.push(`цвет ${LI.toHex(ci.fg)} на фоне ${LI.toHex(ci.bg || [255, 255, 255])} (${bgSrc}), контраст ${LI.fmtNum(ci.ratio)}:1`);
        }
      }
      if (Number.isFinite(p.w) && p.w < 34) { flags.push('scaled'); notes.push(`ширина знаков ${p.w}%`); }
      if (Number.isFinite(p.position) && Math.abs(p.position) >= 96) { flags.push('shifted'); notes.push(`смещение по вертикали ${LI.fmtNum(p.position / 2, 0)} пт`); }
      return { flags, note: notes.join('; ') };
    }

    function pushText(para, text, rf, ctx) {
      if (!text) return;
      const fieldInstr = ctx.fields.length && ctx.fields[ctx.fields.length - 1].phase === 'instr';
      if (fieldInstr) return; // stray w:t inside an instruction is ignored like Word does
      const last = para.runs[para.runs.length - 1];
      if (last && last.flags.join() === rf.flags.join() && last.note === rf.note) last.text += text;
      else para.runs.push({ text, flags: rf.flags, note: rf.note });
    }

    function walkRun(r, ctx, para) {
      const p = effRPr(para, kid(r, 'rPr'));
      const rf = runFlags(p, ctx, para);
      for (const c of r.children) {
        switch (c.localName) {
          case 't': pushText(para, c.textContent, rf, ctx); break;
          case 'delText': pushText(para, c.textContent, { ...rf, flags: rf.flags.includes('deleted') ? rf.flags : [...rf.flags, 'deleted'] }, ctx); break;
          case 'tab': case 'ptab': pushText(para, '\t', rf, ctx); break;
          case 'br': case 'cr': pushText(para, '\n', rf, ctx); break;
          case 'noBreakHyphen': pushText(para, '‑', rf, ctx); break;
          case 'softHyphen': pushText(para, '­', rf, ctx); break;
          case 'sym': {
            const ch = parseInt(wattr(c, 'char') || '', 16);
            if (Number.isFinite(ch)) pushText(para, String.fromCodePoint(ch), rf, ctx);
            break;
          }
          case 'instrText': case 'delInstrText': {
            const f = ctx.fields[ctx.fields.length - 1];
            if (f) f.instr += c.textContent;
            else env.fieldCodes.push({ instr: c.textContent, loc: para.loc });
            break;
          }
          case 'fldChar': {
            const t = wattr(c, 'fldCharType');
            if (t === 'begin') ctx.fields.push({ instr: '', phase: 'instr', loc: para.loc });
            else if (t === 'separate') { const f = ctx.fields[ctx.fields.length - 1]; if (f) f.phase = 'result'; }
            else if (t === 'end') { const f = ctx.fields.pop(); if (f) env.fieldCodes.push(f); }
            break;
          }
          case 'drawing': case 'pict': case 'object': walkShape(c, ctx, para); break;
          case 'AlternateContent': walkAlt(c, ctx, para, (n) => walkRunChildren(n, ctx, para, r)); break;
        }
      }
    }
    function walkRunChildren(container, ctx, para, r) {
      // AlternateContent inside a run: treat its chosen branch as if it were the run's content.
      const fake = { children: container.children };
      for (const c of fake.children) {
        if (c.localName === 'drawing' || c.localName === 'pict' || c.localName === 'object') walkShape(c, ctx, para);
      }
    }
    function walkAlt(el, ctx, para, fn) {
      const choice = kid(el, 'Choice') || kid(el, 'Fallback');
      if (choice) fn(choice);
    }

    function walkShape(el, ctx, para) {
      const nctx = { ...ctx };
      // DrawingML
      for (const dp of desc(el, 'docPr')) {
        const descr = (dp.getAttribute('descr') || '') + (dp.getAttribute('title') ? ' ' + dp.getAttribute('title') : '');
        if (descr.trim()) {
          env.altTexts.push({ text: descr.trim(), loc: para.loc });
        }
        if (dp.getAttribute('hidden') === '1' || dp.getAttribute('hidden') === 'true') nctx.hiddenShape = true;
      }
      const anchor = desc(el, 'anchor')[0];
      if (anchor) {
        const pos = (axis) => {
          const p = kid(anchor, axis);
          const off = p && kid(p, 'posOffset');
          return off ? parseInt(off.textContent, 10) : null;
        };
        const x = pos('positionH'), y = pos('positionV');
        if ((x !== null && (x < -env.pageW * 0.5 || x > env.pageW * 1.05)) || (y !== null && (y < -env.pageH * 0.5 || y > env.pageH * 1.05))) {
          nctx.offpage = true;
        }
      }
      const ext = desc(el, 'extent')[0];
      if (ext) {
        const cx = parseInt(ext.getAttribute('cx'), 10), cy = parseInt(ext.getAttribute('cy'), 10);
        if ((cx >= 0 && cx < 12700) || (cy >= 0 && cy < 12700)) nctx.tinyBox = true;
      }
      const solid = desc(el, 'spPr')[0];
      if (solid) {
        const sf = kid(solid, 'solidFill');
        const clr = sf && (kid(sf, 'srgbClr') || kid(sf, 'schemeClr'));
        if (clr) nctx.boxFill = clr.localName === 'srgbClr' ? LI.parseHex(clr.getAttribute('val')) : theme[THEME_MAP[clr.getAttribute('val')] || clr.getAttribute('val')] || null;
      }
      // VML
      for (const v of [el, ...el.querySelectorAll('*')]) {
        const style = v.getAttribute && v.getAttribute('style');
        if (style && /^(shape|rect|roundrect|textbox|oval)$/.test(v.localName)) {
          if (/visibility\s*:\s*hidden/i.test(style)) nctx.hiddenShape = true;
          for (const m of style.matchAll(/(margin-left|margin-top|left|top)\s*:\s*(-?[\d.]+)(pt|in|px|mm|cm)?/gi)) {
            const k = { pt: 1, in: 72, px: 0.75, mm: 2.835, cm: 28.35 }[(m[3] || 'px').toLowerCase()];
            if (Math.abs(parseFloat(m[2]) * k) > 1200) nctx.offpage = true;
          }
          const wd = /width\s*:\s*([\d.]+)(pt|in|px|mm|cm)?/i.exec(style), ht = /height\s*:\s*([\d.]+)(pt|in|px|mm|cm)?/i.exec(style);
          const toPt = (m) => (m ? parseFloat(m[1]) * ({ pt: 1, in: 72, px: 0.75, mm: 2.835, cm: 28.35 }[(m[2] || 'px').toLowerCase()]) : null);
          const w = toPt(wd), h = toPt(ht);
          if ((w !== null && w < 1) || (h !== null && h < 1)) nctx.tinyBox = true;
          const fc = v.getAttribute('fillcolor');
          if (fc && v.getAttribute('filled') !== 'f') nctx.boxFill = LI.parseHex(fc.replace(/\s.*$/, '')) || nctx.boxFill;
        }
        if (v.localName === 'OLEObject') env.oleObjects.push({ prog: v.getAttribute('ProgID') || '', type: v.getAttribute('Type') || '', loc: para.loc });
      }
      const boxes = desc(el, 'txbxContent');
      // With mc:AlternateContent already resolved to one branch, both DrawingML and VML
      // boxes may still appear when a shape nests a fallback; take the outermost only.
      const outer = boxes.filter((b) => !boxes.some((o) => o !== b && o.contains(b)));
      for (const b of outer.slice(0, 1)) {
        walkBlock(b, { ...nctx, part: ctx.part + ' — надпись', inBox: true });
      }
    }

    function walkPara(p, ctx) {
      const pPr = kid(p, 'pPr');
      const pStyle = pPr ? wattr(kid(pPr, 'pStyle'), 'val') : null;
      const numPr = pPr && kid(pPr, 'numPr');
      const chain = styles.chain(pStyle || styles.defaultPara);
      const shdEl = pPr && kid(pPr, 'shd');
      const pshd = shdEl ? { fill: wattr(shdEl, 'fill'), val: wattr(shdEl, 'val'), color: wattr(shdEl, 'color') } : chain.shd;
      const idx = (env.paraCount[ctx.part] = (env.paraCount[ctx.part] || 0) + 1);
      const para = {
        part: ctx.part,
        partKind: ctx.partKind,
        loc: `${ctx.part}, абз. ${idx}`,
        pStyle,
        shd: shdColor(pshd),
        numId: numPr ? wattr(kid(numPr, 'numId'), 'val') : chain.numId,
        ilvl: numPr ? wattr(kid(numPr, 'ilvl'), 'val') : chain.ilvl,
        runs: [],
        inBox: !!ctx.inBox,
      };
      rep.paragraphs.push(para);
      walkInline(p, ctx, para);
    }

    function walkInline(el, ctx, para) {
      for (const c of el.children) {
        switch (c.localName) {
          case 'r': walkRun(c, ctx, para); break;
          case 'ins': case 'moveTo': walkInline(c, { ...ctx, rev: 'ins' }, para); env.revs.push({ kind: c.localName === 'ins' ? 'ins' : 'move', author: wattr(c, 'author'), date: wattr(c, 'date'), loc: para.loc }); break;
          case 'del': case 'moveFrom': walkInline(c, { ...ctx, rev: 'del' }, para); env.revs.push({ kind: c.localName === 'del' ? 'del' : 'move', author: wattr(c, 'author'), date: wattr(c, 'date'), loc: para.loc }); break;
          case 'hyperlink': {
            const before = para.runs.map((r) => r.text).join('');
            walkInline(c, ctx, para);
            const after = para.runs.map((r) => r.text).join('');
            const id = rattr(c, 'id');
            const rel = id && env.rels[ctx.relsKey]?.[id];
            env.links.push({ text: after.slice(before.length), target: rel ? rel.target : '#' + (wattr(c, 'anchor') || ''), external: rel ? rel.external : false, loc: para.loc });
            break;
          }
          case 'fldSimple': {
            env.fieldCodes.push({ instr: wattr(c, 'instr') || '', loc: para.loc });
            walkInline(c, ctx, para);
            break;
          }
          case 'smartTag': case 'customXml': case 'sdtContent': case 'dir': case 'bdo': walkInline(c, ctx, para); break;
          case 'sdt': { const sc = kid(c, 'sdtContent'); if (sc) walkInline(sc, ctx, para); break; }
          case 'AlternateContent': walkAlt(c, ctx, para, (n) => walkInline(n, ctx, para)); break;
          case 'pPr': { const rp = kid(c, 'rPr'); if (rp && kid(rp, 'rPrChange')) env.fmtChanges++; if (kid(c, 'pPrChange')) env.fmtChanges++; break; }
          case 'bookmarkStart': case 'bookmarkEnd': case 'proofErr': case 'commentRangeStart': case 'commentRangeEnd': case 'permStart': case 'permEnd': break;
          case 'oMath': case 'oMathPara': {
            const t = desc(c, 't').map((x) => x.textContent).join('');
            if (t) pushText(para, t, { flags: [], note: '' }, ctx);
            break;
          }
        }
        if (c.localName === 'r' && desc(c, 'rPrChange').length) env.fmtChanges++;
      }
    }

    function walkBlock(el, ctx) {
      for (const c of el.children) {
        switch (c.localName) {
          case 'p': walkPara(c, ctx); break;
          case 'tbl': {
            for (const tr of kids(c, 'tr')) {
              for (const tc of kids(tr, 'tc')) {
                const tcPr = kid(tc, 'tcPr');
                const shd = tcPr && kid(tcPr, 'shd');
                const fill = shd ? shdColor({ fill: wattr(shd, 'fill'), val: wattr(shd, 'val'), color: wattr(shd, 'color') }) : null;
                walkBlock(tc, { ...ctx, cellFill: fill || ctx.cellFill });
              }
            }
            break;
          }
          case 'sdt': { const sc = kid(c, 'sdtContent'); if (sc) walkBlock(sc, ctx); break; }
          case 'customXml': case 'ins': case 'moveTo': walkBlock(c, c.localName === 'customXml' ? ctx : { ...ctx, rev: 'ins' }); break;
          case 'del': case 'moveFrom': walkBlock(c, { ...ctx, rev: 'del' }); break;
          case 'AlternateContent': walkAlt(c, ctx, null, (n) => walkBlock(n, ctx)); break;
          case 'altChunk': env.altChunks.push({ id: rattr(c, 'id'), relsKey: ctx.relsKey, part: ctx.part }); break;
        }
      }
    }

    return { walkBlock };
  }

  // ---- Main --------------------------------------------------------------------

  LI.parseDocx = async (buf, opts, deps) => {
    const zip = await JSZip.loadAsync(buf);
    const rep = LI.newReport('docx');
    const files = Object.values(zip.files).filter((f) => !f.dir);
    const str = async (p) => { const f = zip.file(p); return f ? f.async('string') : null; };
    const xml = async (p) => {
      const s = await str(p);
      if (s === null) return null;
      try { return parseXml(s); } catch { add(rep, 'warning', 'structure', 'Часть пакета не разбирается как XML', { loc: p }); return null; }
    };

    // Locate the main part via the package relationships.
    const pkgRels = await readRels(zip, '');
    let mainPath = 'word/document.xml';
    for (const r of Object.values(pkgRels)) if (r.type === 'officeDocument' && r.path) mainPath = r.path;
    const ctypes = (await str('[Content_Types].xml')) || '';
    if (!zip.file(mainPath)) {
      return LI.parseGenericZip(zip, rep, opts, ctypes);
    }
    if (/macroEnabled/i.test(ctypes)) rep.notes.push('Тип содержимого пакета: документ с поддержкой макросов.');

    const doc = await xml(mainPath);
    if (!doc) throw new Error('Основная часть документа повреждена');
    const styles = loadStyles(await xml('word/styles.xml'));
    const theme = loadTheme(await xml('word/theme/theme1.xml'));
    const numbering = loadNumbering(await xml('word/numbering.xml'));
    const settings = await xml('word/settings.xml');

    const body = desc(doc, 'body')[0];
    const pgSz = desc(doc, 'pgSz').pop();
    const pageW = (parseInt(wattr(pgSz, 'w') || '11906', 10)) * 635;
    const pageH = (parseInt(wattr(pgSz, 'h') || '16838', 10)) * 635;
    const bgEl = kid(doc.documentElement, 'background');
    const pageBg = bgEl && wattr(bgEl, 'color') && wattr(bgEl, 'color') !== 'auto' ? LI.parseHex(wattr(bgEl, 'color')) : null;

    const env = {
      rep, styles, theme, opts, pageW, pageH, pageBg,
      rels: {}, paraCount: {}, fieldCodes: [], links: [], revs: [], altTexts: [], altChunks: [], oleObjects: [], fmtChanges: 0,
    };
    env.rels[mainPath] = await readRels(zip, mainPath);
    const walker = makeWalker(env);
    walker.walkBlock(body, { part: 'Основной текст', partKind: 'main', relsKey: mainPath, fields: [] });

    // Numbering labels for the main body, in document order.
    for (const p of rep.paragraphs) {
      if (p.partKind === 'main' && p.numId && !p.inBox) p.label = numbering.label(p.numId, p.ilvl);
    }

    // Other story parts.
    const mainRels = env.rels[mainPath];
    const partsByType = (t) => Object.values(mainRels).filter((r) => r.type === t && r.path);
    const story = async (path, label, kind, rootName) => {
      const d = await xml(path);
      if (!d) return;
      env.rels[path] = await readRels(zip, path);
      const roots = rootName ? desc(d, rootName) : [d.documentElement];
      for (const r of roots) {
        const type = wattr(r, 'type');
        if (type === 'separator' || type === 'continuationSeparator' || type === 'continuationNotice') continue;
        walker.walkBlock(r, { part: label, partKind: kind, relsKey: path, fields: [] });
      }
    };
    for (const r of partsByType('header')) await story(r.path, 'Верхний колонтитул (' + r.path.split('/').pop() + ')', 'header');
    for (const r of partsByType('footer')) await story(r.path, 'Нижний колонтитул (' + r.path.split('/').pop() + ')', 'footer');
    for (const r of partsByType('footnotes')) await story(r.path, 'Сноски', 'footnote', 'footnote');
    for (const r of partsByType('endnotes')) await story(r.path, 'Концевые сноски', 'footnote', 'endnote');

    // Comments.
    const commentRel = partsByType('comments')[0];
    if (commentRel) {
      const d = await xml(commentRel.path);
      if (d) {
        const list = [];
        for (const c of desc(d, 'comment')) {
          const text = desc(c, 'p').map((p) => desc(p, 't').map((t) => t.textContent).join('')).join('\n');
          const author = wattr(c, 'author') || '—';
          const date = wattr(c, 'date') || '';
          list.push({ author, date, text });
          rep.segments.push({ text, loc: `Комментарий (${author})`, hidden: false, src: 'comment' });
        }
        if (list.length) {
          add(rep, 'warning', 'revisions', `Комментарии: ${list.length}`, {
            list: list.map((c) => `${c.author}${c.date ? ', ' + c.date.replace('T', ' ').replace('Z', '') : ''}: ${LI.clip(c.text, 400)}`),
            detail: 'Комментарии уходят вместе с файлом и видны получателю. Удалите их до отправки, если они внутренние.',
          });
        }
      }
    }

    // Glossary (building blocks): stored text that never shows in the body.
    if (zip.file('word/glossary/document.xml')) {
      const d = await xml('word/glossary/document.xml');
      const t = d ? desc(d, 't').map((x) => x.textContent).join(' ').trim() : '';
      if (t) {
        rep.segments.push({ text: t, loc: 'Стандартные блоки (glossary)', hidden: true, src: 'glossary' });
        add(rep, 'info', 'hidden', 'Текст в стандартных блоках (glossary)', { loc: 'word/glossary/document.xml', excerpt: LI.clip(t, 400), detail: 'Хранится в файле, но в документе не отображается. Обычно это шаблоны Word, однако там можно спрятать произвольный текст.' });
      }
    }

    // Segments and run-level findings.
    collectRunFindings(rep, opts);

    // Tracked changes.
    const dels = env.revs.filter((r) => r.kind === 'del'), ins = env.revs.filter((r) => r.kind === 'ins'), moves = env.revs.filter((r) => r.kind === 'move');
    const authors = [...new Set(env.revs.map((r) => r.author).filter(Boolean))];
    if (env.revs.length) {
      add(rep, dels.length ? 'warning' : 'info', 'revisions', `Непринятые исправления: удалений ${dels.length}, вставок ${ins.length}${moves.length ? ', перемещений ' + moves.length : ''}`, {
        detail: `Авторы: ${authors.join(', ') || 'не указаны'}. В режиме «Без исправлений» удалённый текст не виден, но остаётся в файле, и получатель может его прочитать. Удалённые фрагменты перечислены отдельно.`,
      });
    }
    if (env.fmtChanges) add(rep, 'info', 'revisions', `Записанные изменения форматирования: ${env.fmtChanges}`, { detail: 'Word хранит прежнее оформление фрагментов до принятия исправлений.' });

    // Fields.
    const ext = (s) => /(https?:|ftp:|\\\\|file:)/i.test(s);
    const codes = env.fieldCodes.map((f) => ({ ...f, instr: f.instr.trim() })).filter((f) => f.instr);
    for (const f of codes) {
      const name = (f.instr.match(/^\s*([A-Z]+)/i) || [])[1]?.toUpperCase() || '';
      rep.segments.push({ text: f.instr, loc: f.loc + ' — код поля', hidden: true, src: 'field' });
      if (name === 'DDE' || name === 'DDEAUTO') add(rep, 'critical', 'active', `Поле ${name}: запуск внешнего приложения`, { loc: f.loc, excerpt: f.instr, detail: 'Через DDE документ может запустить команду на компьютере получателя. Такие поля в договорах не встречаются.' });
      else if (/^(INCLUDETEXT|INCLUDEPICTURE|LINK|IMPORT)$/.test(name) && ext(f.instr)) add(rep, 'warning', 'active', `Поле ${name} подгружает внешнее содержимое`, { loc: f.loc, excerpt: f.instr, detail: 'При обновлении полей Word обратится к внешнему адресу. Так можно подменить фрагмент текста или узнать, что файл открыли.' });
      else if (name === 'MACROBUTTON' || name === 'GOTOBUTTON') add(rep, 'warning', 'active', `Поле ${name}`, { loc: f.loc, excerpt: f.instr, detail: 'Поле запускает макрос или переход по клику.' });
    }
    const otherCodes = codes.filter((f) => !/^\s*(PAGE|NUMPAGES|SECTIONPAGES|TOC|HYPERLINK|PAGEREF|REF|SEQ|NOTEREF|STYLEREF|DATE|TIME|FORMTEXT|FORMCHECKBOX|FORMDROPDOWN|MERGEFORMAT|DOCPROPERTY|FILENAME|XE|TC|INDEX|DDE|DDEAUTO|INCLUDETEXT|INCLUDEPICTURE|LINK|IMPORT|MACROBUTTON|GOTOBUTTON|SYMBOL|EQ|AUTHOR|TITLE|CREATEDATE|SAVEDATE|PRINTDATE|ADVANCE|LISTNUM|IF|QUOTE|ASK|FILLIN|SET|MERGEFIELD)\b/i.test(f.instr));
    if (codes.length) {
      add(rep, 'info', 'active', `Поля Word: ${codes.length}`, {
        list: codes.slice(0, 30).map((f) => `${f.loc}: ${LI.clip(f.instr, 160)}`).concat(codes.length > 30 ? [`и ещё ${codes.length - 30}`] : []),
        detail: otherCodes.length ? `Нестандартных полей: ${otherCodes.length}.` : 'Коды полей не видны в документе. Перечень приведён для проверки.',
      });
    }

    // Links.
    const extLinks = env.links.filter((l) => l.external);
    if (extLinks.length) {
      add(rep, 'info', 'active', `Внешние гиперссылки: ${extLinks.length}`, { list: extLinks.slice(0, 40).map((l) => `«${LI.clip(l.text.trim(), 80)}» → ${l.target}`) });
      for (const l of extLinks) {
        const shown = l.text.trim().toLowerCase();
        const dom = (s) => { try { return new URL(/^[a-z]+:/i.test(s) ? s : 'http://' + s).hostname.replace(/^www\./, ''); } catch { return ''; } };
        if (/^(https?:\/\/|www\.)\S+$|^[\w-]+(\.[\w-]+)+(\/\S*)?$/i.test(shown) && dom(shown) && dom(l.target) && dom(shown) !== dom(l.target)) {
          add(rep, 'warning', 'active', 'Текст ссылки не совпадает с адресом', { loc: l.loc, excerpt: `Показано: ${l.text.trim()}\nВедёт на: ${l.target}` });
        }
      }
    }

    // Alt text.
    for (const a of env.altTexts) rep.segments.push({ text: a.text, loc: a.loc + ' — замещающий текст рисунка', hidden: true, src: 'alt' });
    if (env.altTexts.length) add(rep, 'info', 'hidden', `Замещающий текст рисунков: ${env.altTexts.length}`, { list: env.altTexts.slice(0, 20).map((a) => `${a.loc}: ${LI.clip(a.text, 200)}`), detail: 'Не виден на странице, но читается программами и ИИ-инструментами.' });

    // altChunk: embedded foreign-format content.
    for (const a of env.altChunks) {
      const rel = env.rels[a.relsKey]?.[a.id];
      if (!rel || !rel.path) continue;
      const raw = await str(rel.path);
      const t = raw ? raw.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim() : '';
      if (t) rep.segments.push({ text: t, loc: 'Встроенный фрагмент ' + rel.path, hidden: false, src: 'altchunk' });
      add(rep, 'warning', 'structure', 'Встроенный фрагмент другого формата (altChunk)', { loc: rel.path, excerpt: LI.clip(t, 300), detail: 'Word вставляет такой фрагмент при открытии. Его содержимое не проверялось на форматирование (белый текст, скрытие).' });
    }

    // Settings.
    if (settings) {
      const vars = desc(settings, 'docVar');
      if (vars.length) {
        add(rep, 'warning', 'hidden', `Переменные документа (docVars): ${vars.length}`, { list: vars.map((v) => `${wattr(v, 'name')} = ${LI.clip(wattr(v, 'val') || '', 200)}`), detail: 'Значения хранятся в файле и нигде не отображаются.' });
        for (const v of vars) rep.segments.push({ text: wattr(v, 'val') || '', loc: 'Переменная ' + wattr(v, 'name'), hidden: true, src: 'docvar' });
      }
      if (kid(settings.documentElement, 'trackRevisions')) rep.meta.push(['Запись исправлений', 'включена']);
      const prot = kid(settings.documentElement, 'documentProtection');
      if (prot) rep.meta.push(['Защита документа', wattr(prot, 'edit') || 'да']);
      const rsids = desc(settings, 'rsid').length;
      if (rsids) rep.meta.push(['Сеансов редактирования (rsid)', String(rsids)]);
      const setRels = await readRels(zip, 'word/settings.xml');
      for (const r of Object.values(setRels)) {
        if (r.type === 'attachedTemplate') {
          if (r.external && /^(https?:|\\\\|file:)/i.test(r.target)) add(rep, 'critical', 'active', 'Внешний шаблон загружается по сети', { loc: 'word/settings.xml', excerpt: r.target, detail: 'При открытии Word скачает шаблон с этого адреса. Приём используют для доставки макросов и для отслеживания открытия файла.' });
          else rep.meta.push(['Прикреплённый шаблон', r.target]);
        }
      }
    }

    // External relationships of every part.
    for (const f of files.filter((f) => /\.rels$/.test(f.name))) {
      const base = f.name.replace(/_rels\//, '').replace(/\.rels$/, '');
      const rels = await readRels(zip, base);
      for (const r of Object.values(rels)) {
        if (!r.external || r.type === 'hyperlink' || r.type === 'attachedTemplate') continue;
        const sev = /oleObject|subDocument|frame/i.test(r.type) ? 'critical' : 'warning';
        add(rep, sev, 'active', `Внешняя связь «${r.type}»`, { loc: f.name, excerpt: r.target, detail: r.type === 'image' ? 'Картинка загружается из сети при открытии. Это позволяет узнать, кто и когда открыл файл.' : 'Документ ссылается на внешний ресурс, который Word может загрузить.' });
      }
    }

    // Macros, embeddings, ActiveX, unknown parts.
    for (const f of files) {
      const size = f._data?.uncompressedSize ?? null;
      rep.structure.push({ name: f.name, size });
      if (/vbaProject\.bin$/i.test(f.name)) add(rep, 'critical', 'active', 'Макросы VBA', { loc: f.name, detail: 'Файл содержит программный код. Не включайте макросы в файле из внешнего источника.' });
      else if (/^word\/embeddings\//i.test(f.name)) {
        add(rep, 'warning', 'active', 'Встроенный объект', { loc: f.name, detail: `Размер ${LI.fmtSize(size)}. Внутри может быть отдельный документ со своим содержимым.` });
        if (deps && deps.depth < 1 && /\.(docx|docm|pdf|doc|rtf|xlsx|pptx)$/i.test(f.name)) {
          const inner = await f.async('arraybuffer');
          await deps.nested(f.name.split('/').pop(), inner, rep);
        }
      } else if (/^word\/activeX\//i.test(f.name) && /\.xml$/i.test(f.name)) add(rep, 'warning', 'active', 'Элемент ActiveX', { loc: f.name });
      else if (!KNOWN_PART.test(f.name)) {
        let snippet = '';
        if (/\.(xml|txt|json|html?|md|csv)$/i.test(f.name) || size < 200000) {
          const raw = await f.async('string');
          snippet = raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
          if (/^[\x09\x0a\x0d\x20-\x7e -￿]*$/.test(snippet.slice(0, 2000)) && snippet) rep.segments.push({ text: snippet, loc: 'Часть пакета ' + f.name, hidden: true, src: 'part' });
          else snippet = '';
        }
        add(rep, 'warning', 'structure', 'Нестандартная часть пакета', { loc: f.name, excerpt: LI.clip(snippet, 300), detail: `Размер ${LI.fmtSize(size)}. Word такую часть не показывает, но она передаётся вместе с файлом.` });
      }
    }
    const custom = files.filter((f) => /^customXml\/item\d+\.xml$/i.test(f.name));
    for (const f of custom) {
      const raw = await f.async('string');
      const t = raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (t.length > 0) {
        rep.segments.push({ text: t, loc: 'Пользовательский XML ' + f.name, hidden: true, src: 'customxml' });
        if (t.length > 40) add(rep, 'info', 'hidden', 'Данные в пользовательском XML (customXml)', { loc: f.name, excerpt: LI.clip(t, 300), detail: 'Обычно это свойства SharePoint или привязки элементов управления. В документе не отображается.' });
      }
    }
    if (env.oleObjects.length) add(rep, 'warning', 'active', `OLE-объекты: ${env.oleObjects.length}`, { list: env.oleObjects.map((o) => `${o.loc}: ${o.prog} (${o.type || 'Embed'})`) });

    await LI.readOoxmlProps(zip, rep);
    return rep;
  };

  // Turns flagged runs into findings and fills rep.segments.
  function collectRunFindings(rep, opts) {
    const TITLES = {
      hidden: ['critical', 'Скрытый текст (атрибут «скрытый»)'],
      color: ['critical', 'Текст цвета фона'],
      tiny: ['critical', 'Текст микроскопического размера'],
      offpage: ['critical', 'Текст за пределами страницы'],
      tinybox: ['critical', 'Текст в надписи нулевого размера'],
      deleted: ['warning', 'Удалённый текст (исправление не принято)'],
      lowcontrast: ['warning', 'Текст с очень низким контрастом'],
      small: ['warning', 'Текст очень мелкого размера'],
      scaled: ['warning', 'Текст, сжатый по ширине'],
      shifted: ['warning', 'Текст, смещённый по вертикали'],
    };
    const ORDER = ['hidden', 'color', 'tiny', 'offpage', 'tinybox', 'deleted', 'lowcontrast', 'small', 'scaled', 'shifted'];
    for (const p of rep.paragraphs) {
      const full = p.runs.map((r) => r.text).join('');
      const hiddenTxt = p.runs.filter((r) => r.flags.some((f) => TITLES[f] && f !== 'small' && f !== 'lowcontrast' && f !== 'scaled' && f !== 'shifted')).map((r) => r.text).join('');
      const visible = p.runs.filter((r) => !r.flags.some((f) => ['hidden', 'color', 'tiny', 'offpage', 'tinybox', 'deleted'].includes(f))).map((r) => r.text).join('');
      p.text = visible.replace(/­/g, '');
      if (visible.trim()) rep.segments.push({ text: visible, loc: p.loc, hidden: false, src: p.partKind });
      if (hiddenTxt.trim()) rep.segments.push({ text: hiddenTxt, loc: p.loc + ' (скрытая часть)', hidden: true, src: p.partKind });
      // Group consecutive runs that share the primary flag.
      let cur = null;
      const flush = () => {
        if (cur && cur.text.trim()) {
          const [sev, title] = TITLES[cur.flag];
          LI.add(rep, sev, cur.flag === 'deleted' ? 'revisions' : 'hidden', title, { loc: p.loc, excerpt: LI.clip(cur.text, 600), detail: cur.note });
        }
        cur = null;
      };
      for (const r of p.runs) {
        const flag = ORDER.find((f) => r.flags.includes(f));
        if (!flag) { flush(); continue; }
        if (cur && cur.flag === flag) { cur.text += r.text; if (r.note && !cur.note.includes(r.note)) cur.note += (cur.note ? '; ' : '') + r.note; }
        else { flush(); cur = { flag, text: r.text, note: r.note || '' }; }
      }
      flush();
      if (!full.trim()) continue;
    }
  }
  LI.collectRunFindings = collectRunFindings;

  // docProps/core.xml, app.xml, custom.xml — shared by all OOXML packages.
  LI.readOoxmlProps = async (zip, rep) => {
    const get = async (p) => { const f = zip.file(p); if (!f) return null; try { return parseXml(await f.async('string')); } catch { return null; } };
    const CORE = { title: 'Название', subject: 'Тема', creator: 'Автор', keywords: 'Ключевые слова', description: 'Примечания', lastModifiedBy: 'Последним изменил', revision: 'Редакция', created: 'Создан', modified: 'Изменён', lastPrinted: 'Последняя печать', category: 'Категория', contentStatus: 'Состояние', identifier: 'Идентификатор', language: 'Язык', version: 'Версия' };
    const core = await get('docProps/core.xml');
    if (core) for (const c of core.documentElement.children) {
      const v = c.textContent.trim();
      if (!v) continue;
      rep.meta.push([CORE[c.localName] || c.localName, v]);
      if (['title', 'subject', 'keywords', 'description', 'category'].includes(c.localName)) rep.segments.push({ text: v, loc: 'Свойство «' + (CORE[c.localName] || c.localName) + '»', hidden: true, src: 'meta' });
    }
    const APP = { Template: 'Шаблон', TotalTime: 'Время правки, мин', Pages: 'Страниц', Words: 'Слов', Characters: 'Знаков', Application: 'Программа', AppVersion: 'Версия программы', Company: 'Организация', Manager: 'Руководитель', HyperlinkBase: 'База гиперссылок' };
    const app = await get('docProps/app.xml');
    if (app) for (const c of app.documentElement.children) {
      if (!APP[c.localName]) continue;
      const v = c.textContent.trim();
      if (v) rep.meta.push([APP[c.localName], v]);
      if (c.localName === 'HyperlinkBase' && v) add(rep, 'warning', 'active', 'Задана база гиперссылок', { excerpt: v, detail: 'Все относительные ссылки документа будут вести на этот адрес.' });
      if (c.localName === 'Template' && /^(\\\\|https?:)/i.test(v)) add(rep, 'info', 'meta', 'Шаблон на сетевом ресурсе', { excerpt: v, detail: 'Путь раскрывает внутреннюю инфраструктуру автора.' });
    }
    const custom = await get('docProps/custom.xml');
    if (custom) {
      const props = desc(custom, 'property');
      for (const p of props) {
        const v = p.textContent.trim();
        rep.meta.push(['Свойство: ' + p.getAttribute('name'), v]);
        rep.segments.push({ text: v, loc: 'Пользовательское свойство ' + p.getAttribute('name'), hidden: true, src: 'meta' });
      }
    }
    if (rep.meta.length) {
      const who = rep.meta.filter(([k]) => ['Автор', 'Последним изменил', 'Организация', 'Руководитель'].includes(k)).map(([k, v]) => `${k}: ${v}`);
      if (who.length) add(rep, 'info', 'meta', 'Сведения об авторах в свойствах файла', { list: who, detail: 'Свойства передаются вместе с файлом. Перед отправкой контрагенту их можно очистить: «Файл → Сведения → Проверить документ».' });
    }
  };

  // Non-Word OOXML or unknown ZIP: list parts, pull text from XML.
  LI.parseGenericZip = async (zip, rep, opts, ctypes) => {
    rep.kind = /spreadsheetml/.test(ctypes) ? 'xlsx' : /presentationml/.test(ctypes) ? 'pptx' : 'zip';
    rep.notes.push('Это не документ Word. Проверены текст XML-частей, макросы, внешние связи и свойства, без анализа форматирования.');
    for (const f of Object.values(zip.files).filter((f) => !f.dir)) {
      rep.structure.push({ name: f.name, size: f._data?.uncompressedSize ?? null });
      if (/vbaProject\.bin$/i.test(f.name)) add(rep, 'critical', 'active', 'Макросы VBA', { loc: f.name });
      if (/\.xml$/i.test(f.name) && !/^\[Content_Types\]|\.rels$/i.test(f.name)) {
        const raw = await f.async('string');
        const t = raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        if (t) rep.segments.push({ text: t, loc: f.name, hidden: false, src: 'part' });
        if (/TargetMode="External"/.test(raw)) add(rep, 'warning', 'active', 'Внешние связи', { loc: f.name });
      }
      if (/\.rels$/.test(f.name)) {
        const raw = await f.async('string');
        for (const m of raw.matchAll(/Target="([^"]+)"[^>]*TargetMode="External"|TargetMode="External"[^>]*Target="([^"]+)"/g)) add(rep, 'warning', 'active', 'Внешняя связь', { loc: f.name, excerpt: m[1] || m[2] });
      }
    }
    rep.paragraphs = rep.segments.map((s) => ({ part: s.loc, partKind: 'main', loc: s.loc, runs: [{ text: s.text, flags: [] }], text: s.text }));
    await LI.readOoxmlProps(zip, rep);
    return rep;
  };
})();
