'use strict';
// Shared UI helpers for both apps: storage, library check, clipboard, counts.
(() => {
  const LI = window.LI;
  const $ = (s, r = document) => r.querySelector(s);
  const esc = LI.esc;
  const PDF_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  const store = {
    get(k) { try { return localStorage.getItem('doc-inspector:' + k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem('doc-inspector:' + k, v); } catch {} },
  };

  // ---- Libraries ---------------------------------------------------------------
  const missing = [];
  if (!window.JSZip) missing.push('JSZip (DOCX)');
  if (window.pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc = PDF_WORKER;
  else missing.push('pdf.js (PDF)');
  if (missing.length) {
    const b = $('#libwarn');
    b.hidden = false;
    b.textContent = `Не загрузились библиотеки: ${missing.join(', ')}. Проверка этих форматов недоступна. TXT, DOC и RTF проверяются без них.`;
  }
  $('#lib-versions').textContent = `Библиотеки: pdf.js ${window.pdfjsLib?.version || '—'}, JSZip ${window.JSZip?.version || '—'}.`;
  // ---- Clipboard ------------------------------------------------------------------
  const copy = async (text, host) => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      let ta = host.querySelector('.copy-fallback');
      if (!ta) { ta = document.createElement('textarea'); ta.className = 'copy-fallback'; ta.readOnly = true; host.appendChild(ta); }
      ta.value = text;
      ta.focus();
      ta.select();
      return false;
    }
  };
  const flashLabel = (btn, text) => { const old = btn.textContent; btn.textContent = text; setTimeout(() => (btn.textContent = old), 1800); };
  const htmlToText = (h) => { const d = document.createElement('div'); d.innerHTML = h; d.querySelectorAll('.cp').forEach((c) => (c.textContent = `[${c.textContent}]`)); return d.textContent; };
  const countSev = (fs) => fs.reduce((a, f) => ((a[f.sev] = (a[f.sev] || 0) + 1), a), { critical: 0, warning: 0, info: 0 });
  // Links to the sibling app, injected at build time.
  const otherApp = (key, label) => {
    const url = window.APP_LINKS && window.APP_LINKS[key];
    return url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(label)}</a>` : esc(label);
  };
  const other = $('#other-app');
  if (other) other.innerHTML = otherApp(other.dataset.key, other.dataset.label);
  window.UI = { $, esc, store, copy, flashLabel, htmlToText, countSev, otherApp };
})();
