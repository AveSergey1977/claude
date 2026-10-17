'use strict';
// Legal translation check: aligns clauses of the original and the translation
// and compares what must survive translation unchanged.
(() => {
  const LI = window.LI;
  const T = (LI.TR = {});

  // ---- Language ------------------------------------------------------------

  T.LANG_LABEL = { ru: 'русский', en: 'английский', lt: 'литовский' };
  T.detectLang = (text) => {
    const cyr = (text.match(/\p{Script=Cyrillic}/gu) || []).length;
    const lat = (text.match(/\p{Script=Latin}/gu) || []).length;
    if (cyr > lat) return 'ru';
    const ltc = (text.match(/[ąčęėįšųūžĄČĘĖĮŠŲŪŽ]/g) || []).length;
    const ltw = (text.match(/(?<![\p{L}])(ir|yra|kad|su|bei|arba|pagal|šalys|sutarties|sutartis|įmonės|bendrovė)(?![\p{L}])/giu) || []).length;
    const enw = (text.match(/\b(the|and|of|shall|any|or|to|which|this|agreement|party)\b/gi) || []).length;
    return ltc * 2 + ltw > enw ? 'lt' : 'en';
  };

  // ---- Paragraph labels ----------------------------------------------------

  const RU_ENUM = 'абвгдежзиклмнопрстуфхцчшщэюя';
  const romanVal = (s) => {
    const m = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };
    let n = 0, prev = 0;
    for (const ch of s.toLowerCase().split('').reverse()) { const v = m[ch]; if (!v) return NaN; n += v < prev ? -v : v; prev = Math.max(prev, v); }
    return n;
  };
  const LABEL_RE = /^\s*(?:(статья|ст\.|article|section|clause|раздел|глава|пункт|chapter|schedule|приложение|annex|appendix|priedas|dalis)\s+(\d+(?:\.\d+)*|[ivxlcdm]+)\.?|(\d+)\s*(straipsnis|skyrius|punktas|priedas|dalis)|((?:\d+\.)+\d+\.?|\d+[.)])|\(?([a-zа-яё])\)|\(([ivxlcdm]+)\)|([ivxlcdm]+)\))(?=\s|$)/iu;

  T.parseLabel = (text, prevKind, prevLetter) => {
    const m = LABEL_RE.exec(text);
    if (!m) return null;
    const raw = m[0].trim();
    if (m[2] !== undefined) {
      const n = /^\d/.test(m[2]) ? m[2] : String(romanVal(m[2]));
      return { key: 'H' + n, raw, kind: 'H' };
    }
    if (m[3] !== undefined) return { key: 'H' + m[3], raw, kind: 'H' };
    if (m[5] !== undefined) return { key: 'N' + m[5].replace(/[.)]$/, ''), raw, kind: 'N' };
    if (m[6] !== undefined) {
      const ch = m[6].toLowerCase();
      // (i), (v), (x) are roman numerals unless they continue a letter list.
      if (/[ivx]/.test(ch) && (prevKind === 'R' || (ch === 'i' && prevLetter !== 'h') || (ch === 'v' && prevLetter !== 'u') || (ch === 'x' && prevLetter !== 'w'))) {
        return { key: 'R' + romanVal(ch), raw, kind: 'R', letter: ch };
      }
      const idx = /[a-z]/.test(ch) ? ch.charCodeAt(0) - 96 : RU_ENUM.indexOf(ch === 'ё' ? 'е' : ch) + 1;
      return { key: 'L' + idx, raw, kind: 'L', letter: ch };
    }
    const r = m[7] || m[8];
    return { key: 'R' + romanVal(r), raw, kind: 'R' };
  };

  // ---- Extraction ------------------------------------------------------------

  const mask = (text, a, b) => text.slice(0, a) + ' '.repeat(b - a) + text.slice(b);

  const ID_RES = [
    ['email', /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, (s) => s.toLowerCase()],
    ['url', /\b(?:https?:\/\/|www\.)[^\s<>«»"“”]+[^\s<>«»"“”.,;:)]/gi, (s) => s.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '')],
    ['IBAN', /\b[A-Z]{2}\d{2}(?:[  ]?[A-Z0-9]{4}){2,7}(?:[  ]?[A-Z0-9]{1,4})?\b/g, (s) => s.replace(/[  ]/g, '')],
    ['BIC/SWIFT', /(?<=(?<![\p{L}])(?:BIC|SWIFT|БИК|S\.W\.I\.F\.T\.)[\s:./-]{0,12}(?:code|код|kodas)?[\s:]{0,4})[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}(?:[A-Z0-9]{3})?\b/gu, (s) => s],
    ['рег. номер', /\bHE[  ]?\d{4,7}\b/g, (s) => s.replace(/[  ]/g, '')],
  ];
  T.extractIds = (text) => {
    const out = [];
    for (const [type, re, norm] of ID_RES) {
      for (const m of text.matchAll(re)) {
        out.push({ type, v: type + ':' + norm(m[0]), raw: m[0], i: m.index });
        text = mask(text, m.index, m.index + m[0].length);
      }
    }
    return { items: out, text };
  };

  const MONTHS = {
    ru: ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'],
    en: ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'],
    enShort: ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'],
    lt: ['sausio', 'vasario', 'kovo', 'balandžio', 'gegužės', 'birželio', 'liepos', 'rugpjūčio', 'rugsėjo', 'spalio', 'lapkričio', 'gruodžio'],
  };
  const monthIdx = (w) => {
    w = w.toLowerCase().replace(/\.$/, '');
    for (const k of ['ru', 'en', 'lt']) { const i = MONTHS[k].indexOf(w); if (i >= 0) return i + 1; }
    const i = MONTHS.enShort.indexOf(w.slice(0, 3));
    if (i >= 0 && /^[a-z]+$/.test(w)) return i + 1;
    if (w === 'sept') return 9;
    return 0;
  };
  const ymd = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const validDate = (y, m, d) => m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 1900 && y <= 2200;
  const EN_M = 'January|February|March|April|May|June|July|August|September|October|November|December|Jan\\.?|Feb\\.?|Mar\\.?|Apr\\.?|Jun\\.?|Jul\\.?|Aug\\.?|Sept?\\.?|Oct\\.?|Nov\\.?|Dec\\.?';
  const DATE_RES = [
    ['words', new RegExp(`[«"„]?(\\d{1,2})[»"“]?\\s+(${MONTHS.ru.join('|')})\\s+(\\d{4})(?:\\s*(?:года|г\\.|г(?![\\p{L}])))?`, 'giu'), (m) => [+m[3], monthIdx(m[2]), +m[1]]],
    ['words', new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:day\\s+of\\s+)?(${EN_M})\\s*,?\\s+(\\d{4})\\b`, 'gi'), (m) => [+m[3], monthIdx(m[2]), +m[1]]],
    ['words', new RegExp(`\\b(${EN_M})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s*,?\\s+(\\d{4})\\b`, 'gi'), (m) => [+m[3], monthIdx(m[1]), +m[2]]],
    ['words', new RegExp(`(\\d{4})\\s*m\\.\\s*(${MONTHS.lt.join('|')})(?:\\s+mėn\\.)?\\s+(\\d{1,2})\\s*d\\.?`, 'giu'), (m) => [+m[1], monthIdx(m[2]), +m[3]]],
    ['iso', /\b(\d{4})-(\d{2})-(\d{2})\b/g, (m) => [+m[1], +m[2], +m[3]]],
    ['ymd', /\b(\d{4})[./](\d{2})[./](\d{2})\b/g, (m) => [+m[1], +m[2], +m[3]]],
    ['numeric', /\b(\d{1,2})([./])(\d{1,2})\2(\d{4})\b/g, null],
  ];
  T.extractDates = (text, lang) => {
    const out = [];
    for (const [fmt, re, f] of DATE_RES) {
      for (const m of [...text.matchAll(re)]) {
        let y, mo, d, ambiguous = false;
        if (f) [y, mo, d] = f(m);
        else {
          const a = +m[1], b = +m[3];
          y = +m[4];
          if (m[2] === '/' && lang === 'en') {
            if (a > 12) { d = a; mo = b; } else if (b > 12) { mo = a; d = b; } else { d = a; mo = b; ambiguous = a !== b; }
          } else { d = a; mo = b; }
        }
        if (!validDate(y, mo, d)) continue;
        out.push({ v: ymd(y, mo, d), raw: m[0].trim(), i: m.index, fmt, sep: m[2], ambiguous });
        text = mask(text, m.index, m.index + m[0].length);
      }
    }
    return { items: out, text };
  };

  const canon = (intPart, frac) => {
    intPart = intPart.replace(/^0+(?=\d)/, '');
    frac = (frac || '').replace(/0+$/, '');
    return frac ? `${intPart}.${frac}` : intPart;
  };
  T.parseNumber = (tok, lang) => {
    const chunks = tok.split(/[    ']/).filter(Boolean);
    const merged = [];
    let cur = null, grouped = false;
    for (const c of chunks) {
      if (cur !== null && /^\d{3}([.,]\d+)?$/.test(c) && !/[.,]/.test(cur) && (grouped || cur.length <= 3)) { cur += c; grouped = true; continue; }
      if (cur !== null) merged.push({ t: cur, spaced: grouped });
      cur = c; grouped = false;
    }
    if (cur !== null) merged.push({ t: cur, spaced: grouped });
    const out = [];
    for (const { t, spaced } of merged) {
      const hasC = t.includes(','), hasD = t.includes('.');
      let v, alt = null, shape = spaced ? 'space-thousands' : 'plain';
      if (hasC && hasD) {
        const dec = t.lastIndexOf(',') > t.lastIndexOf('.') ? ',' : '.';
        const [ip, fp] = t.split(dec);
        v = canon(ip.replace(/[.,]/g, ''), fp);
        shape = dec === '.' ? 'en-mixed' : 'eu-mixed';
      } else if (hasC) {
        const g = t.split(',');
        if (g.length > 2) {
          if (g.slice(1).every((x) => x.length === 3) && g[0].length <= 3) { v = canon(g.join('')); shape = 'en-thousands'; }
          else { for (const x of g) if (x) out.push({ v: canon(x), alt: null, raw: x, shape: 'plain' }); continue; }
        } else if (lang === 'en') {
          if (g[1].length === 3) { v = canon(g.join('')); alt = canon(g[0], g[1]); shape = 'en-thousands'; }
          else { v = canon(g[0], g[1]); shape = 'eu-decimal'; }
        } else {
          v = canon(g[0], g[1]);
          shape = 'eu-decimal';
          if (g[1].length === 3) alt = canon(g.join(''));
        }
      } else if (hasD) {
        const g = t.split('.');
        if (g.length > 2) {
          if (g.slice(1).every((x) => x.length === 3) && g[0].length <= 3) { v = canon(g.join('')); alt = 'ref:' + t; shape = 'dot-thousands'; }
          else v = 'ref:' + t;
        } else {
          v = canon(g[0], g[1]);
          shape = 'en-decimal';
          if (g[1].length === 3) alt = canon(g.join(''));
        }
      } else v = canon(t);
      out.push({ v, alt, raw: t, shape });
    }
    return out;
  };
  T.extractNumbers = (text, lang) => {
    const out = [];
    for (const m of text.matchAll(/(?<![\p{L}\p{N}_])[-−]?\d+(?:(?:[.,]|[    '](?=\d{3}(?!\d)))\d+)*/gu)) {
      for (const n of T.parseNumber(m[0].replace(/^[-−]/, ''), lang)) out.push({ ...n, raw: m[0], i: m.index, end: m.index + m[0].length });
    }
    return out;
  };

  // \b is ASCII-only in JS regexes, so word edges are written as Unicode lookarounds.
  const CURRENCIES = [
    ['EUR', '€|<EUR>|<euros?>|<евро>|<eur(?:ų|ai|as|ais|ui)>'],
    ['USD', 'US\\$|\\$|<USD>|<U\\.?S\\.? dollars?>|<dollars?>|<доллар(?:а|ов|ы)?\\s+США>|<долл\\.\\s*США>|<JAV\\s+doler(?:iai|ių|ius)>'],
    ['GBP', '£|<GBP>|<pounds?(?:\\s+sterling)?>|<фунт(?:а|ов|ы)?\\s+стерлингов>|<svar(?:ai|ų)\\s+sterling(?:ų)?>'],
    ['RUB', '₽|<RUB>|<руб\\.>|<рубл(?:ь|я|ей|и)>|<(?:roubles?|rubles?)>|<rubli(?:ai|ų)>'],
    ['CHF', '<CHF>|<швейцарск\\p{L}+\\s+франк\\p{L}*>|<Swiss francs?>'],
    ['AED', '<AED>|<dirhams?>|<дирхам\\p{L}*>'],
    ['PLN', '<PLN>|<zlot(?:y|ys)>|<злот\\p{L}*>|<zlot(?:ai|ų)>'],
  ].map(([c, r]) => [c, r.replace(/<(?=[^>]*>)/g, '(?<![\\p{L}\\p{N}])(?:').replace(/>/g, ')(?![\\p{L}])')]);
  const CUR_RE = new RegExp(CURRENCIES.map(([c, r]) => `(?<${c}>${r})`).join('|'), 'giu');
  const MULT = [[/^(млрд|миллиард\p{L}*|billions?|bn|mlrd\.?|milijard\p{L}*)$/iu, 1e9], [/^(млн|миллион\p{L}*|millions?|mln|m|milijon\p{L}*)$/iu, 1e6], [/^(тыс|тысяч\p{L}*|thousands?|k|tūkst)$/iu, 1e3]];
  const scale = (v, mult) => {
    if (mult === 1 || /^ref:/.test(v)) return v;
    const n = Number(v) * mult;
    return Number.isFinite(n) ? canon(...String(Math.round(n * 1e6) / 1e6).split('.')) : v;
  };
  T.extractMoney = (text, nums) => {
    const out = [];
    const used = new Set();
    for (const m of text.matchAll(CUR_RE)) {
      const code = Object.entries(m.groups).find(([, v]) => v !== undefined)[0];
      const s = m.index, e = s + m[0].length;
      let best = null;
      for (let k = 0; k < nums.length; k++) {
        if (used.has(k)) continue;
        const n = nums[k];
        if (n.end <= s) {
          const gap = text.slice(n.end, s);
          const mm = /^\s*(?:\([^)]{0,160}\))?\s*([\p{L}.]+)?\.?\s*(?:\([^)]{0,160}\))?\s*$/u.exec(gap);
          if (mm && gap.length < 200) {
            let mult = 1;
            if (mm[1]) { const f = MULT.find(([re]) => re.test(mm[1].replace(/\.$/, ''))); if (f) mult = f[1]; else if (!/^(of|из)$/i.test(mm[1])) continue; }
            best = { k, mult, d: s - n.end };
          }
        } else if (n.i >= e && n.i - e <= 3 && /^\s*$/.test(text.slice(e, n.i)) && (!best || n.i - e < best.d)) {
          const after = /^\s*([\p{L}]+)/u.exec(text.slice(n.end, n.end + 20));
          let mult = 1;
          if (after) { const f = MULT.find(([re]) => re.test(after[1])); if (f) mult = f[1]; }
          best = { k, mult, d: n.i - e };
          break;
        }
      }
      if (best) {
        used.add(best.k);
        const n = nums[best.k];
        out.push({ v: code + ' ' + scale(n.v, best.mult), alt: n.alt ? code + ' ' + scale(n.alt, best.mult) : null, code, raw: (n.i < s ? text.slice(n.i, e) : text.slice(s, n.end)).replace(/\s+/g, ' '), i: Math.min(n.i, s) });
      }
    }
    return out;
  };

  const DEF_RES = [
    /\((?:[^()]{0,40}?\b)?(?:the|each|a|an|together|collectively|jointly|hereinafter(?:\s+referred\s+to\s+as)?|referred\s+to\s+as)?\s*(?:the\s+)?["“]([^"”]{1,60})["”]\s*(?:[,;][^()]{0,40})?\)/gi,
    /^["“]([^"”]{1,60})["”]\s+(?:means|shall\s+mean|has\s+the\s+meaning|includes|refers\s+to)/gim,
    /(?:именуем\p{L}*|далее(?:\s+по\s+тексту)?)(?:\s+в\s+дальнейшем)?\s*[—–-]?\s*[«"„]([^»"“]{1,60})[»"“]/giu,
    /(?:hereinafter(?:\s+referred\s+to\s+as)?|referred\s+to\s+as)\s+(?:the\s+)?["“]([^"”]{1,60})["”]/gi,
    /^[«"„]([^»"“]{1,60})[»"“]\s*(?:[—–-]|означает|понимается)/gimu,
    /toliau(?:\s+(?:vadinam\p{L}*|[–—-]))?\s*[„"“]([^“"”]{1,60})[“"”]/giu,
    /^[„"]([^“"”]{1,60})[“"”]\s*(?:[—–-]|reiškia)/gimu,
  ];
  T.extractDefs = (paras) => {
    const out = [];
    paras.forEach((p, idx) => {
      for (const re of DEF_RES) for (const m of p.text.matchAll(re)) out.push({ term: m[1].trim(), idx });
    });
    const seen = new Set();
    return out.filter((d) => (seen.has(d.term.toLowerCase()) ? false : seen.add(d.term.toLowerCase())));
  };

  const LEGAL_FORM = 'Limited|Ltd\\.?|LLC|L\\.L\\.C\\.|LLP|PLC|plc|Inc\\.?|Corp\\.?|Corporation|GmbH|AG|S\\.A\\.|B\\.V\\.|N\\.V\\.|SIA|OÜ|SE|S\\.à\\s?r\\.l\\.|Sp\\.\\s?z\\s?o\\.o\\.';
  T.extractEntities = (text, lang) => {
    const out = new Map();
    const add = (name, kind) => { name = name.replace(/\s+/g, ' ').trim(); if (name.length > 2 && !out.has(name)) out.set(name, kind); };
    for (const m of text.matchAll(new RegExp(`((?:[A-Z][\\w&'’.-]*[ \\u00A0]+){1,6}(?:${LEGAL_FORM}))(?![\\w])`, 'g'))) add(m[1], 'company');
    for (const m of text.matchAll(/\b(UAB|AB|MB|VšĮ|IĮ|ŽŪB)\s*[„"“]([^“"”]{2,60})[“"”]/gu)) add(m[2], 'company');
    for (const m of text.matchAll(/(ООО|АО|ПАО|ЗАО|ОАО|НАО|ИП|ТОО|ЧУП)\s*[«"„]([^»"“]{2,60})[»"“]/gu)) add(`${m[1]} «${m[2]}»`, 'ru-company');
    if (lang === 'ru') {
      for (const m of text.matchAll(/[A-Za-z][A-Za-z0-9&'’.-]*(?:[  ]+[A-Za-z0-9&][A-Za-z0-9&'’.-]*)*/g)) {
        const t = m[0].replace(/[.,;:]+$/, '');
        if (t.length >= 3 && /[A-Z]/.test(t) && !/^[IVXLCDM]+$/.test(t)) add(t, 'latin');
      }
    }
    if (lang === 'lt') {
      for (const m of text.matchAll(/(?<=[\p{L},;:]\s+)\p{Lu}\p{Ll}*[ąčęėįšųūžĄČĘĖĮŠŲŪŽ]\p{L}*(?:\s+\p{Lu}\p{L}+)?/gu)) add(m[0], 'lt-name');
    }
    return [...out.entries()].map(([name, kind]) => ({ name, kind }));
  };

  // ---- Matching helpers ----------------------------------------------------------

  T.diffTokens = (A, B) => {
    const usedA = new Array(A.length).fill(false), usedB = new Array(B.length).fill(false);
    const idx = new Map();
    B.forEach((b, i) => { if (!idx.has(b.v)) idx.set(b.v, []); idx.get(b.v).push(i); });
    A.forEach((a, i) => {
      const l = idx.get(a.v);
      if (!l) return;
      const j = l.find((j) => !usedB[j]);
      if (j !== undefined) { usedA[i] = usedB[j] = true; }
    });
    A.forEach((a, i) => {
      if (usedA[i]) return;
      const j = B.findIndex((b, j) => !usedB[j] && ((a.alt && (b.v === a.alt || b.alt === a.alt)) || (b.alt && b.alt === a.v)));
      if (j >= 0) usedA[i] = usedB[j] = true;
    });
    return { missing: A.filter((_, i) => !usedA[i]), extra: B.filter((_, i) => !usedB[i]) };
  };

  const fold = (s) => s.normalize('NFD').replace(/\p{M}/gu, '');
  const normWS = (s) => s.replace(/[\s ]+/g, ' ').trim();

  T.termRegex = (term, lang) => {
    const words = term.trim().split(/\s+/).map((w) => {
      const e = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (/\p{Script=Cyrillic}/u.test(w) || lang === 'lt') return w.length >= 5 ? e.slice(0, -2) + '\\p{L}{0,4}' : e + '\\p{L}{0,3}';
      return e + '(?:s|es|\'s|’s)?';
    });
    return new RegExp('(?<![\\p{L}\\p{N}])' + words.join('[\\s\\u00A0]+') + '(?![\\p{L}\\p{N}])', 'giu');
  };

  T.parseGlossary = (txt) => {
    const out = [];
    for (const line of (txt || '').split(/\r?\n/)) {
      const l = line.trim();
      if (!l || l.startsWith('#')) continue;
      const m = /^(.+?)\s*(?:=|→|->|\t)\s*(.+)$/.exec(l);
      if (!m) continue;
      const alts = m[2].split('|').map((x) => x.trim()).filter(Boolean);
      out.push({ src: m[1].trim(), ok: alts.filter((a) => !a.startsWith('!')), bad: alts.filter((a) => a.startsWith('!')).map((a) => a.slice(1).trim()) });
    }
    return out;
  };

  // ---- Alignment ---------------------------------------------------------------------

  function lcs(a, b) {
    const n = a.length, m = b.length;
    if (!n || !m) return [];
    if (n * m > 12e6) {
      // Large inputs: greedy in-order matching.
      const res = [];
      let j = 0;
      for (let i = 0; i < n && j < m; i++) {
        let k = j;
        while (k < m && b[k] !== a[i] && k - j < 50) k++;
        if (k < m && b[k] === a[i]) { res.push([i, k]); j = k + 1; }
      }
      return res;
    }
    const W = m + 1;
    const dp = new Uint16Array((n + 1) * W);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i * W + j] = a[i] === b[j] ? dp[(i + 1) * W + j + 1] + 1 : Math.max(dp[(i + 1) * W + j], dp[i * W + j + 1]);
    const res = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { res.push([i, j]); i++; j++; }
      else if (dp[(i + 1) * W + j] >= dp[i * W + j + 1]) i++;
      else j++;
    }
    return res;
  }

  // Length-based alignment (Gale–Church style) for documents without numbering.
  function lengthAlign(S, Tg, ratio) {
    const n = S.length, m = Tg.length;
    if (n * m > 4e6) return S.map((_, i) => [[i], i < m ? [i] : []]);
    const INF = 1e9;
    const cost = new Float64Array((n + 1) * (m + 1)).fill(INF);
    const back = new Uint8Array((n + 1) * (m + 1));
    const W = m + 1;
    cost[0] = 0;
    const len = (arr, a, k) => { let s = 0; for (let q = a; q < a + k; q++) s += arr[q]; return s; };
    const sl = S.map((p) => p.length + 1), tl = Tg.map((p) => p.length + 1);
    const pen = (s, t) => Math.abs(Math.log((t * 1) / (s * ratio))) * 4;
    const moves = [[1, 1, 0], [1, 0, 6], [0, 1, 6], [2, 1, 1.5], [1, 2, 1.5]];
    for (let i = 0; i <= n; i++) for (let j = 0; j <= m; j++) {
      const c = cost[i * W + j];
      if (c >= INF) continue;
      moves.forEach(([di, dj, p], k) => {
        if (i + di > n || j + dj > m) return;
        const s = di ? len(sl, i, di) : 0, t = dj ? len(tl, j, dj) : 0;
        const cc = c + p + (di && dj ? pen(s, t) : 0);
        const o = (i + di) * W + j + dj;
        if (cc < cost[o]) { cost[o] = cc; back[o] = k; }
      });
    }
    const pairs = [];
    let i = n, j = m;
    while (i > 0 || j > 0) {
      const [di, dj] = moves[back[i * W + j]];
      pairs.unshift([[...Array(di).keys()].map((q) => i - di + q), [...Array(dj).keys()].map((q) => j - dj + q)]);
      i -= di; j -= dj;
    }
    return pairs;
  }

  // ---- Main ------------------------------------------------------------------------------

  const prepParas = (paras) => paras.map((p) => {
    const text = normWS(((p.label ? p.label + ' ' : '') + (p.text ?? p.runs.map((r) => r.text).join(''))).replace(/­/g, ''));
    return { text, loc: p.loc };
  }).filter((p) => p.text && /[\p{L}\p{N}]/u.test(p.text));

  function analyse(text, lang) {
    const ids = T.extractIds(text);
    const dates = T.extractDates(ids.text, lang);
    const nums = T.extractNumbers(dates.text, lang);
    const money = T.extractMoney(dates.text, nums);
    return { ids: ids.items, dates: dates.items, nums, money };
  }

  T.compare = (srcParasRaw, tgtParasRaw, o = {}) => {
    const S = prepParas(srcParasRaw), Tg = prepParas(tgtParasRaw);
    const srcAll = S.map((p) => p.text).join('\n'), tgtAll = Tg.map((p) => p.text).join('\n');
    const srcLang = o.srcLang && o.srcLang !== 'auto' ? o.srcLang : T.detectLang(srcAll);
    const tgtLang = o.tgtLang && o.tgtLang !== 'auto' ? o.tgtLang : T.detectLang(tgtAll);
    const res = { srcLang, tgtLang, issues: [], blocks: [], structure: { missing: [], extra: [] }, stats: {} };
    const issue = (sev, type, msg, extra = {}) => { const it = { sev, type, msg, ...extra }; res.issues.push(it); return it; };
    res.stats = { srcParas: S.length, tgtParas: Tg.length, srcChars: srcAll.length, tgtChars: tgtAll.length };
    if (!S.length || !Tg.length) return res;
    const ratio = Math.max(0.3, Math.min(3, (tgtAll.length + 1) / (srcAll.length + 1)));
    res.stats.ratio = ratio;
    if (srcLang === tgtLang) issue('warning', 'lang', `Оба текста определены как ${T.LANG_LABEL[srcLang]}. Проверьте, что загружены оригинал и перевод, или укажите языки вручную.`);

    // Labels.
    const labelOf = (arr) => {
      let pk = null, pl = null;
      return arr.map((p) => { const l = T.parseLabel(p.text, pk, pl); if (l) { pk = l.kind; pl = l.letter || pl; } return l; });
    };
    const sl = labelOf(S), tl = labelOf(Tg);
    const sIdx = sl.map((l, i) => (l ? i : -1)).filter((i) => i >= 0), tIdx = tl.map((l, i) => (l ? i : -1)).filter((i) => i >= 0);
    const pairs = lcs(sIdx.map((i) => sl[i].key), tIdx.map((i) => tl[i].key)).map(([a, b]) => [sIdx[a], tIdx[b]]);
    const matchedS = new Set(pairs.map((p) => p[0])), matchedT = new Set(pairs.map((p) => p[1]));
    const useLabels = pairs.length >= 3 && pairs.length >= 0.3 * Math.min(sIdx.length, tIdx.length);
    res.stats.labels = { src: sIdx.length, tgt: tIdx.length, matched: pairs.length, used: useLabels };
    if (useLabels) {
      const tKeys = new Map();
      tIdx.forEach((i) => tKeys.set(tl[i].key, (tKeys.get(tl[i].key) || 0) + 1));
      const sKeys = new Map();
      sIdx.forEach((i) => sKeys.set(sl[i].key, (sKeys.get(sl[i].key) || 0) + 1));
      for (const i of sIdx) if (!matchedS.has(i)) {
        const elsewhere = tKeys.has(sl[i].key);
        res.structure.missing.push({ label: sl[i].raw, text: S[i].text, elsewhere });
        issue('critical', 'structure', `Пункт ${sl[i].raw} оригинала ${elsewhere ? 'стоит в переводе в другом месте или повторяется' : 'отсутствует в переводе'}`, { src: S[i].text });
      }
      for (const j of tIdx) if (!matchedT.has(j)) {
        res.structure.extra.push({ label: tl[j].raw, text: Tg[j].text, elsewhere: sKeys.has(tl[j].key) });
        issue('warning', 'structure', `Пункт ${tl[j].raw} перевода не соответствует нумерации оригинала`, { tgt: Tg[j].text });
      }
    }

    // Blocks.
    let blockPairs = [];
    if (useLabels) {
      const first = pairs[0][0] === 0 && pairs[0][1] === 0;
      const A = first ? pairs : [[0, 0], ...pairs];
      for (let k = 0; k < A.length; k++) {
        const [a, b] = A[k];
        const [a2, b2] = A[k + 1] || [S.length, Tg.length];
        const si = [], ti = [];
        for (let q = a; q < a2; q++) si.push(q);
        for (let q = b; q < b2; q++) ti.push(q);
        if (si.length || ti.length) blockPairs.push([si, ti, k === 0 && !first ? 'Преамбула' : sl[a]?.raw || tl[b]?.raw || '']);
      }
    } else {
      blockPairs = lengthAlign(S.map((p) => p.text), Tg.map((p) => p.text), ratio).map(([si, ti]) => [si, ti, '']);
    }

    // Per-block comparison.
    const gSrc = { nums: [], dates: [], money: [], ids: [] }, gTgt = { nums: [], dates: [], money: [], ids: [] };
    blockPairs.forEach(([si, ti, label], bIdx) => {
      const sText = si.map((i) => S[i].text).join('\n'), tText = ti.map((i) => Tg[i].text).join('\n');
      const block = { id: bIdx + 1, label: label || (si[0] !== undefined ? 'абз. ' + (si[0] + 1) : 'абз. перевода ' + (ti[0] + 1)), src: si.map((i) => S[i].text), tgt: ti.map((i) => Tg[i].text), issues: [] };
      res.blocks.push(block);
      const bi = (sev, type, msg, ex = {}) => block.issues.push(issue(sev, type, msg, { block: block.id, ...ex }));
      // Strip the leading label so clause numbers do not count as values.
      const strip = (arr, idx, labels) => idx.map((i) => (labels[i] ? arr[i].text.slice(arr[i].text.indexOf(labels[i].raw) + labels[i].raw.length) : arr[i].text)).join('\n');
      const as = analyse(strip(S, si, sl), srcLang), at = analyse(strip(Tg, ti, tl), tgtLang);
      for (const k of ['nums', 'dates', 'money', 'ids']) { gSrc[k].push(...as[k]); gTgt[k].push(...at[k]); }

      if (!ti.length) { bi('critical', 'omission', 'Фрагмент оригинала не найден в переводе'); return; }
      if (!si.length) { bi('warning', 'addition', 'В переводе есть фрагмент, которого нет в оригинале'); return; }
      const r = (tText.length + 1) / (sText.length + 1) / ratio;
      if (sText.length > 60 && r < 0.55) bi('warning', 'length', `Перевод заметно короче оригинала (${Math.round(r * 100)}% от ожидаемой длины). Возможен пропуск текста.`);
      else if (sText.length > 60 && r > 1.8) bi('warning', 'length', `Перевод заметно длиннее оригинала (${Math.round(r * 100)}% от ожидаемой длины). Возможна вставка лишнего текста.`);

      const dn = T.diffTokens(as.nums, at.nums);
      if (dn.missing.length) bi('critical', 'numbers', `Числа оригинала, которых нет в переводе: ${dn.missing.map((x) => x.raw).join('; ')}`);
      if (dn.extra.length) bi('critical', 'numbers', `Числа перевода, которых нет в оригинале: ${dn.extra.map((x) => x.raw).join('; ')}`);
      const dd = T.diffTokens(as.dates, at.dates);
      if (dd.missing.length) bi('critical', 'dates', `Даты оригинала, которых нет в переводе: ${dd.missing.map((x) => x.raw).join('; ')}`);
      if (dd.extra.length) bi('critical', 'dates', `Даты перевода, которых нет в оригинале: ${dd.extra.map((x) => x.raw).join('; ')}`);
      const dm = T.diffTokens(as.money, at.money);
      for (const x of dm.missing) {
        const sameNum = dm.extra.find((y) => y.v.split(' ')[1] === x.v.split(' ')[1]);
        if (sameNum) bi('critical', 'money', `Валюта изменена: в оригинале «${x.raw}», в переводе «${sameNum.raw}»`);
        else bi('critical', 'money', `Сумма оригинала не найдена в переводе: «${x.raw}»`);
      }
      for (const y of dm.extra) if (!dm.missing.some((x) => x.v.split(' ')[1] === y.v.split(' ')[1])) bi('warning', 'money', `Сумма в переводе без соответствия в оригинале: «${y.raw}»`);
      const di = T.diffTokens(as.ids, at.ids);
      for (const x of di.missing) bi('critical', 'ids', `${x.type} не совпадает или отсутствует в переводе: ${x.raw}`);

      // Format adaptation.
      for (const d of at.dates) {
        if (tgtLang === 'en' && d.fmt === 'numeric' && d.sep === '.') bi('info', 'format', `Дата «${d.raw}» оставлена в формате ДД.ММ.ГГГГ. Для английского текста однозначнее «${Number(d.v.slice(8))} ${MONTHS.en[+d.v.slice(5, 7) - 1].replace(/^./, (c) => c.toUpperCase())} ${d.v.slice(0, 4)}».`);
        if (d.ambiguous) bi('warning', 'format', `Дата «${d.raw}» читается по-разному в британском и американском формате.`);
        if (tgtLang === 'ru' && d.fmt === 'words' && /[A-Za-z]/.test(d.raw)) bi('warning', 'format', `Дата «${d.raw}» записана по-английски.`);
      }
      for (const n of at.nums) {
        if (tgtLang === 'en' && ['eu-decimal', 'eu-mixed', 'space-thousands', 'dot-thousands'].includes(n.shape) && !/^ref:/.test(n.v)) bi('info', 'format', `Число «${n.raw}» записано по русским или литовским правилам. В английском: «${(() => { const [ip, fp] = n.v.split('.'); return ip.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (fp ? '.' + fp : ''); })()}».`);
        if (tgtLang !== 'en' && ['en-thousands', 'en-mixed'].includes(n.shape)) bi('info', 'format', `Число «${n.raw}» записано по английским правилам. По-русски и по-литовски: «${(() => { const [ip, fp] = n.v.split('.'); return ip.replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + (fp ? ',' + fp : ''); })()}».`);
      }

      // Untranslated text.
      for (const i of ti) {
        const t = Tg[i].text;
        const cyr = (t.match(/\p{Script=Cyrillic}/gu) || []).length, lat = (t.match(/\p{Script=Latin}/gu) || []).length;
        if (tgtLang !== 'ru' && cyr >= 12 && cyr > 0.3 * (cyr + lat)) bi('warning', 'untranslated', 'Абзац перевода содержит текст на кириллице. Возможно, фрагмент не переведён.', { tgt: t });
        if (tgtLang === 'ru' && srcLang !== 'ru' && lat >= 30 && lat > 0.7 * (cyr + lat)) bi('warning', 'untranslated', 'Абзац перевода почти целиком на латинице. Возможно, фрагмент не переведён.', { tgt: t });
        if (srcLang !== tgtLang && t.length >= 25 && si.some((q) => S[q].text.toLowerCase() === t.toLowerCase()) && /\p{L}{4}/u.test(t)) bi('warning', 'untranslated', 'Абзац перевода совпадает с оригиналом дословно.', { tgt: t });
      }

      // Glossary per block.
      for (const g of o.glossary || []) {
        const sre = T.termRegex(g.src, srcLang);
        if (!sre.test(sText)) continue;
        if (g.ok.length && !g.ok.some((t) => T.termRegex(t, tgtLang).test(tText))) bi('warning', 'glossary', `Термин «${g.src}» в этом фрагменте не переведён как ${g.ok.map((x) => '«' + x + '»').join(' или ')}.`);
        for (const b of g.bad) if (T.termRegex(b, tgtLang).test(tText)) bi('warning', 'glossary', `Использован нежелательный вариант «${b}» для термина «${g.src}».`);
      }
    });

    // Global multisets: catch values moved between blocks or lost when alignment is rough.
    res.global = {
      nums: T.diffTokens(gSrc.nums, gTgt.nums),
      dates: T.diffTokens(gSrc.dates, gTgt.dates),
      money: T.diffTokens(gSrc.money, gTgt.money),
      ids: T.diffTokens(gSrc.ids, gTgt.ids),
      counts: { nums: gSrc.nums.length, dates: gSrc.dates.length, money: gSrc.money.length, ids: gSrc.ids.length, tnums: gTgt.nums.length, tdates: gTgt.dates.length, tmoney: gTgt.money.length, tids: gTgt.ids.length },
    };

    // Names and companies.
    const ents = T.extractEntities(T.extractIds(srcAll).text, srcLang);
    const tgtN = normWS(tgtAll), tgtFold = fold(tgtN).toLowerCase();
    res.entities = [];
    for (const e of ents) {
      if (e.kind === 'ru-company') {
        const inGloss = (o.glossary || []).some((g) => g.src.toLowerCase() === e.name.toLowerCase());
        if (tgtLang !== 'ru') res.entities.push({ ...e, status: inGloss ? 'glossary' : 'check' });
        else res.entities.push({ ...e, status: tgtN.includes(e.name) ? 'ok' : 'missing' });
        continue;
      }
      if (e.kind === 'lt-name' && tgtLang === 'ru') continue;
      let status = 'ok';
      if (!tgtN.includes(e.name)) {
        if (tgtN.toLowerCase().includes(e.name.toLowerCase())) status = 'case';
        else if (tgtFold.includes(fold(e.name).toLowerCase())) status = 'diacritics';
        else status = 'missing';
      }
      res.entities.push({ ...e, status });
      if (status === 'missing' && e.kind !== 'lt-name') issue(e.kind === 'company' ? 'critical' : 'warning', 'names', `Наименование «${e.name}» не найдено в переводе в оригинальном написании.`);
      if (status === 'missing' && e.kind === 'lt-name') issue('info', 'names', `Имя «${e.name}» не найдено в переводе в оригинальном написании.`);
      if (status === 'case') issue('warning', 'names', `Наименование «${e.name}» в переводе написано с другим регистром букв.`);
      if (status === 'diacritics') issue('warning', 'names', `В наименовании «${e.name}» в переводе утрачены диакритические знаки.`);
    }

    // Defined terms.
    res.defs = { src: T.extractDefs(S), tgt: T.extractDefs(Tg) };
    if (res.defs.src.length !== res.defs.tgt.length) issue('warning', 'defs', `Определённых терминов: в оригинале ${res.defs.src.length}, в переводе ${res.defs.tgt.length}. Сравните списки ниже.`);

    // Glossary totals.
    res.glossary = (o.glossary || []).map((g) => {
      const sc = (srcAll.match(T.termRegex(g.src, srcLang)) || []).length;
      const tc = g.ok.reduce((n, t) => n + (tgtAll.match(T.termRegex(t, tgtLang)) || []).length, 0);
      const bc = g.bad.reduce((n, t) => n + (tgtAll.match(T.termRegex(t, tgtLang)) || []).length, 0);
      return { ...g, sc, tc, bc };
    });

    // Typography of the target.
    const q = (re) => (tgtAll.match(re) || []).length;
    res.typo = [];
    if (tgtLang === 'ru' && q(/[“”"]/g) > 0 && q(/[«»]/g) === 0) res.typo.push('В русском тексте используются кавычки “…” или "…". Принятые в русской юридической практике кавычки: «…».');
    if (tgtLang === 'lt' && q(/[«»“"]/g) > 0 && q(/„/g) === 0) res.typo.push('В литовском тексте кавычки отличаются от принятых „…“.');
    if (tgtLang === 'en' && q(/[«»„]/g) > 0) res.typo.push('В английском тексте остались кавычки «…» или „…“. В английском используются “…”.');
    const bal = (s, a, b) => (s.split(a).length - 1) - (s.split(b).length - 1);
    if (bal(tgtAll, '(', ')') !== 0) res.typo.push(`Открывающих и закрывающих круглых скобок в переводе разное количество (разница ${bal(tgtAll, '(', ')')}).`);
    for (const t of res.typo) issue('info', 'typo', t);

    res.counts = { critical: 0, warning: 0, info: 0 };
    for (const it of res.issues) res.counts[it.sev]++;
    return res;
  };

  T.textToParas = (txt) => (txt || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((t, k) => ({ text: t, loc: `строка ${k + 1}`, runs: [] }));
})();
