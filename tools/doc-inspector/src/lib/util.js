'use strict';
// Shared helpers: escaping, XML access, colours, text decoding, findings.
const LI = (window.LI = window.LI || {});

LI.W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
LI.R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

LI.esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

LI.hex = (n, w = 4) => n.toString(16).toUpperCase().padStart(w, '0');

LI.fmtSize = (n) => {
  if (n == null) return '';
  if (n < 1024) return n + ' Б';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1).replace('.', ',') + ' КБ';
  return (n / 1024 / 1024).toFixed(1).replace('.', ',') + ' МБ';
};

LI.fmtNum = (x, d = 2) => Number(x).toFixed(d).replace('.', ',');

LI.sha256 = async (buf) => {
  try {
    const h = await crypto.subtle.digest('SHA-256', buf);
    return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return '';
  }
};

LI.clip = (s, n = 280) => {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n) + ' […]' : s;
};

LI.yieldUI = () => new Promise((r) => setTimeout(r, 0));

// ---- XML -------------------------------------------------------------------

LI.parseXml = (s) => {
  const d = new DOMParser().parseFromString(s, 'application/xml');
  if (d.getElementsByTagName('parsererror').length) throw new Error('XML не разобран');
  return d;
};
LI.kids = (el, name) => (el ? [...el.children].filter((c) => c.localName === name) : []);
LI.kid = (el, name) => (el ? [...el.children].find((c) => c.localName === name) || null : null);
LI.desc = (el, name) => (el ? [...el.getElementsByTagNameNS('*', name)] : []);
LI.wattr = (el, name) => {
  if (!el) return null;
  const v = el.getAttributeNS(LI.W_NS, name);
  if (v !== null && v !== '') return v;
  const v2 = el.getAttribute('w:' + name);
  return v2 !== null ? v2 : null;
};
LI.rattr = (el, name) => {
  if (!el) return null;
  return el.getAttributeNS(LI.R_NS, name) || el.getAttribute('r:' + name);
};
LI.wbool = (el) => {
  if (!el) return undefined;
  const v = LI.wattr(el, 'val');
  return v === null || !/^(0|false|off)$/i.test(v);
};
LI.textOf = (el) => (el ? el.textContent || '' : '');

// ---- Colours ---------------------------------------------------------------

LI.parseHex = (h) => {
  if (!h) return null;
  h = String(h).replace('#', '').trim();
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (!/^[0-9a-f]{6}$/i.test(h)) return null;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
};
LI.toHex = (rgb) => '#' + rgb.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('').toUpperCase();
LI.lum = ([r, g, b]) => {
  const f = (c) => {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
LI.contrast = (a, b) => {
  const L1 = LI.lum(a), L2 = LI.lum(b);
  return (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
};
// Word highlight names and the 16-colour index used by .doc and RTF \highlight.
LI.HIGHLIGHT = {
  black: '000000', blue: '0000FF', cyan: '00FFFF', green: '00FF00', magenta: 'FF00FF', red: 'FF0000',
  yellow: 'FFFF00', white: 'FFFFFF', darkBlue: '000080', darkCyan: '008080', darkGreen: '008000',
  darkMagenta: '800080', darkRed: '800000', darkYellow: '808000', darkGray: '808080', lightGray: 'C0C0C0',
};
LI.ICO = [null, '000000', '0000FF', '00FFFF', '00FF00', 'FF00FF', 'FF0000', 'FFFF00', 'FFFFFF',
  '000080', '008080', '008000', '800080', '800000', '808000', '808080', 'C0C0C0'];

// Classifies a foreground/background pair. Returns null when legible.
LI.colorIssue = (fg, bg, opts) => {
  if (!fg) return null;
  bg = bg || [255, 255, 255];
  const ratio = LI.contrast(fg, bg);
  if (ratio < opts.invisibleContrast) return { flag: 'color', ratio, fg, bg };
  if (ratio < opts.lowContrast) return { flag: 'lowcontrast', ratio, fg, bg };
  return null;
};

// ---- Text decoding ---------------------------------------------------------

LI.CODEPAGES = {
  1250: 'windows-1250', 1251: 'windows-1251', 1252: 'windows-1252', 1253: 'windows-1253', 1254: 'windows-1254',
  1257: 'windows-1257', 866: 'ibm866', 20866: 'koi8-r', 21866: 'koi8-u', 10007: 'x-mac-cyrillic',
  65001: 'utf-8', 1200: 'utf-16le', 1201: 'utf-16be', 28591: 'iso-8859-1', 28595: 'iso-8859-5', 28603: 'iso-8859-13',
};
LI.decode = (bytes, label) => {
  try {
    return new TextDecoder(label || 'utf-8').decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
};

// Plain-text encoding detection: BOM, strict UTF-8, then a Cyrillic/Baltic guess.
LI.detectEncoding = (bytes) => {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8';
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return 'utf-8';
  } catch {}
  // Without a BOM, many zero bytes in alternating positions mean UTF-16.
  let z0 = 0, z1 = 0;
  const n = Math.min(bytes.length, 4000);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) i % 2 ? z1++ : z0++;
  if (z1 > n / 6) return 'utf-16le';
  if (z0 > n / 6) return 'utf-16be';
  // High bytes surrounded by ASCII letters suggest a Latin code page (Lithuanian),
  // runs of high bytes suggest Cyrillic.
  let hi = 0, mixed = 0;
  for (let i = 1; i < n - 1; i++) {
    if (bytes[i] >= 0xc0) {
      hi++;
      const a = bytes[i - 1], b = bytes[i + 1];
      const asciiL = (x) => (x >= 65 && x <= 90) || (x >= 97 && x <= 122);
      if (asciiL(a) || asciiL(b)) mixed++;
    }
  }
  if (hi && mixed / hi > 0.5) return 'windows-1257';
  return 'windows-1251';
};

// ---- Findings --------------------------------------------------------------

LI.SEV_RANK = { critical: 3, warning: 2, info: 1 };
LI.SEV_LABEL = { critical: 'критично', warning: 'внимание', info: 'сведения' };
LI.CATS = {
  hidden: 'Скрытый текст',
  ai: 'Инструкции для ИИ',
  chars: 'Невидимые и подменённые символы',
  revisions: 'Правки и комментарии',
  active: 'Активное содержимое и внешние ссылки',
  meta: 'Метаданные',
  structure: 'Структура файла',
};

LI.newReport = (kind) => ({
  kind,
  paragraphs: [], // {part, text, runs:[{text, flags:[], note}], label}
  segments: [], // {text, loc, hidden, src} — everything fed to the text checks
  findings: [],
  meta: [], // [label, value]
  structure: [], // {name, size, note}
  notes: [], // limitations of the analysis for this file
});

LI.add = (rep, sev, cat, title, o = {}) => {
  rep.findings.push({
    sev, cat, title,
    loc: o.loc || '',
    excerpt: o.excerpt || '',
    excerptHtml: o.excerptHtml || '',
    detail: o.detail || '',
    list: o.list || null,
  });
};

// Human-readable rendering of invisible characters inside an excerpt.
LI.CHAR_NAMES = {
  0x00ad: 'мягкий перенос', 0x034f: 'CGJ', 0x061c: 'ALM', 0x115f: 'HANGUL FILLER', 0x1160: 'HANGUL FILLER',
  0x180e: 'MVS', 0x200b: 'ZWSP', 0x200c: 'ZWNJ', 0x200d: 'ZWJ', 0x200e: 'LRM', 0x200f: 'RLM',
  0x202a: 'LRE', 0x202b: 'RLE', 0x202c: 'PDF', 0x202d: 'LRO', 0x202e: 'RLO', 0x2060: 'WJ',
  0x2061: 'FUNCTION APPLICATION', 0x2062: 'INVISIBLE TIMES', 0x2063: 'INVISIBLE SEPARATOR', 0x2064: 'INVISIBLE PLUS',
  0x2066: 'LRI', 0x2067: 'RLI', 0x2068: 'FSI', 0x2069: 'PDI', 0x3164: 'HANGUL FILLER', 0xfeff: 'BOM/ZWNBSP', 0xffa0: 'HALFWIDTH FILLER',
};
LI.isInvisibleCp = (cp) =>
  cp === 0x00ad || cp === 0x034f || cp === 0x061c || cp === 0x115f || cp === 0x1160 || cp === 0x180e ||
  (cp >= 0x200b && cp <= 0x200f) || (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2060 && cp <= 0x2064) ||
  (cp >= 0x2066 && cp <= 0x2069) || cp === 0x3164 || cp === 0xfeff || cp === 0xffa0 ||
  (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0000 && cp <= 0xe007f) || (cp >= 0xe0100 && cp <= 0xe01ef) ||
  (cp < 0x20 && cp !== 9 && cp !== 10 && cp !== 13) || (cp >= 0x7f && cp <= 0x9f);
LI.cpLabel = (cp) => 'U+' + LI.hex(cp) + (LI.CHAR_NAMES[cp] ? ' ' + LI.CHAR_NAMES[cp] : '');

LI.visualize = (s) => {
  let out = '';
  for (const ch of String(s)) {
    const cp = ch.codePointAt(0);
    if (LI.isInvisibleCp(cp)) out += '<span class="cp">' + LI.esc(LI.cpLabel(cp)) + '</span>';
    else if (cp === 10) out += '<span class="cp">¶</span> ';
    else out += LI.esc(ch);
  }
  return out;
};

LI.context = (text, start, end, pad = 70) => {
  const a = Math.max(0, start - pad), b = Math.min(text.length, end + pad);
  return {
    html: (a > 0 ? '…' : '') + LI.visualize(text.slice(a, start)) + '<mark>' + LI.visualize(text.slice(start, end)) + '</mark>' +
      LI.visualize(text.slice(end, b)) + (b < text.length ? '…' : ''),
  };
};
