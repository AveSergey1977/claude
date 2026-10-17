'use strict';
// UI: tabs, the scanner reports and the translation check.
(() => {
  const LI = window.LI, T = LI.TR;
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

  // ---- Tabs ---------------------------------------------------------------------
  const tabs = [['scan', $('#tab-scan'), $('#panel-scan')], ['translate', $('#tab-translate'), $('#panel-translate')]];
  const selectTab = (name, focus) => {
    for (const [n, t, p] of tabs) {
      const on = n === name;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      p.hidden = !on;
      if (on && focus) t.focus();
    }
    store.set('tab', name);
  };
  tabs.forEach(([n, t], i) => {
    t.addEventListener('click', () => selectTab(n));
    t.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') selectTab(tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length][0], true);
    });
  });
  selectTab(location.hash === '#translate' ? 'translate' : location.hash === '#scan' ? 'scan' : store.get('tab') || 'scan');

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

  // ---- Scanner ----------------------------------------------------------------------
  const opts = () => ({
    tinyPt: parseFloat($('#opt-tinyPt').value) || 5,
    invisibleContrast: parseFloat($('#opt-invisibleContrast').value) || 1.25,
    lowContrast: parseFloat($('#opt-lowContrast').value) || 1.6,
    pdfRender: $('#opt-pdfRender').checked,
    password: $('#opt-password').value,
  });
  const CAT_ORDER = ['hidden', 'ai', 'chars', 'revisions', 'active', 'meta', 'structure'];
  const FLAG_LABEL = { hidden: 'скрыт атрибутом', color: 'цвет фона / не виден', tiny: 'микрошрифт', offpage: 'за пределами страницы', tinybox: 'надпись нулевого размера', deleted: 'удалён (исправление)', inserted: 'вставлен (исправление)', lowcontrast: 'низкий контраст', small: 'очень мелкий', scaled: 'сжат по ширине', shifted: 'смещён по вертикали' };

  const verdictOf = (c) =>
    c.critical ? ['crit', 'Найдено скрытое или потенциально опасное содержимое', 'Разберите замечания с отметкой «критично» до того, как передавать файл ИИ-инструменту, подписывать или отправлять его.']
      : c.warning ? ['', 'Скрытого текста не найдено, но есть замечания', 'Проверьте замечания с отметкой «внимание»: исправления, комментарии, внешние ссылки.']
        : ['', 'Скрытого содержимого не найдено', 'В пределах выполненных проверок. Ограничения перечислены ниже.'];

  function renderFinding(f) {
    const parts = [];
    if (f.excerptHtml) parts.push(`<div class="excerpt">${f.excerptHtml}</div>`);
    else if (f.excerpt) parts.push(`<div class="excerpt">${LI.visualize(f.excerpt)}</div>`);
    if (f.list && f.list.length) parts.push(`<ul class="f-list">${f.list.map((x) => `<li>${LI.visualize(x)}</li>`).join('')}</ul>`);
    if (f.detail) parts.push(`<div class="f-detail">${esc(f.detail)}</div>`);
    return `<div class="finding ${f.sev}" data-sev="${f.sev}"><span class="sev ${f.sev}">${LI.SEV_LABEL[f.sev]}</span><div class="f-body"><div><div class="f-title">${esc(f.title)}</div>${f.loc ? `<div class="f-loc">${esc(f.loc)}</div>` : ''}</div>${parts.join('')}</div></div>`;
  }

  function renderTextView(rep) {
    const paras = rep.kind === 'pdf' ? (rep.pageRuns || []) : rep.paragraphs;
    const flagged = paras.filter((p) => p.runs.some((r) => r.flags && r.flags.length));
    if (!flagged.length) return '';
    const shown = flagged.slice(0, 300);
    const body = shown.map((p) => `<div class="p"><span class="ploc">${esc(p.loc)}</span>${p.runs.map((r) => {
      const f = (r.flags || []).filter((x) => FLAG_LABEL[x]);
      return f.length ? `<span class="${f.map((x) => 'f-' + x).join(' ')}" title="${esc(f.map((x) => FLAG_LABEL[x]).join(', ') + (r.note ? ': ' + r.note : ''))}">${LI.visualize(r.text)}</span>` : LI.visualize(r.text);
    }).join('')}</div>`).join('');
    return `<details><summary>текст с отметками: абзацев ${flagged.length}${flagged.length > shown.length ? ', показаны первые ' + shown.length : ''}</summary><div>
      <div class="legend"><span><span class="f-hidden">&nbsp;скрытый&nbsp;</span> не виден читателю</span><span><span class="f-deleted">удалённый</span> исправление</span><span><span class="f-inserted">вставленный</span> исправление</span><span><span class="f-small">&nbsp;мелкий / бледный&nbsp;</span> плохо читается</span></div>
      <div class="textview">${body}</div></div></details>`;
  }

  function reportMarkdown(r) {
    const c = countSev(r.rep.findings);
    const [, title] = verdictOf(c);
    const lines = [`# Проверка файла «${r.name}»`, '', `Формат: ${LI.KIND_LABEL[r.kind] || r.kind}; размер: ${LI.fmtSize(r.size)}${r.sha ? `; SHA-256: ${r.sha}` : ''}`, `Итог: ${title}. Критично: ${c.critical}, внимание: ${c.warning}, сведения: ${c.info}.`, ''];
    for (const cat of CAT_ORDER) {
      const fs = r.rep.findings.filter((f) => f.cat === cat);
      if (!fs.length) continue;
      lines.push(`## ${LI.CATS[cat]}`, '');
      for (const f of fs) {
        lines.push(`- [${LI.SEV_LABEL[f.sev]}] ${f.title}${f.loc ? ` (${f.loc})` : ''}`);
        const ex = f.excerptHtml ? htmlToText(f.excerptHtml) : f.excerpt;
        if (ex) lines.push(`  > ${ex.replace(/\n/g, ' ').slice(0, 600)}`);
        if (f.list) for (const x of f.list.slice(0, 20)) lines.push(`  - ${x}`);
        if (f.detail) lines.push(`  ${f.detail}`);
      }
      lines.push('');
    }
    if (r.rep.meta.length) { lines.push('## Свойства файла', ''); for (const [k, v] of r.rep.meta) lines.push(`- ${k}: ${v}`); lines.push(''); }
    if (r.rep.notes.length) { lines.push('## Ограничения проверки', ''); for (const n of r.rep.notes) lines.push(`- ${n}`); }
    return lines.join('\n');
  }

  const countSev = (fs) => fs.reduce((a, f) => ((a[f.sev] = (a[f.sev] || 0) + 1), a), { critical: 0, warning: 0, info: 0 });

  function renderReport(r, sample) {
    const el = document.createElement('article');
    el.className = 'report';
    const c = countSev(r.rep.findings);
    const [vcls, vtitle, vsub] = verdictOf(c);
    const cats = CAT_ORDER.map((cat) => {
      const fs = r.rep.findings.filter((f) => f.cat === cat);
      if (!fs.length) return '';
      const LIMIT = 25;
      return `<section class="cat" data-cat="${cat}"><div class="cat-head"><h4>${esc(LI.CATS[cat])}</h4><span class="n">${fs.length}</span></div>
        ${fs.map((f, i) => (i < LIMIT ? renderFinding(f) : renderFinding(f).replace('class="finding', 'hidden class="finding extra'))).join('')}
        ${fs.length > LIMIT ? `<button class="btn small ghost more" type="button">показать ещё ${fs.length - LIMIT}</button>` : ''}</section>`;
    }).join('');
    const meta = r.rep.meta.length ? `<details><summary>свойства файла: ${r.rep.meta.length}</summary><div class="tablewrap"><table><tbody>${r.rep.meta.map(([k, v]) => `<tr><th scope="row">${esc(k)}</th><td>${LI.visualize(v)}</td></tr>`).join('')}</tbody></table></div></details>` : '';
    const struct = r.rep.structure.length ? `<details><summary>структура файла: частей ${r.rep.structure.length}</summary><div class="tablewrap"><table><thead><tr><th>часть</th><th>размер</th></tr></thead><tbody>${r.rep.structure.slice(0, 400).map((s) => `<tr><td class="mono">${esc(s.name)}</td><td class="num">${s.size == null ? '' : LI.fmtSize(s.size)}</td></tr>`).join('')}</tbody></table></div></details>` : '';
    const notes = r.rep.notes.length ? `<details><summary>ограничения проверки</summary><div><ul class="f-list">${r.rep.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></div></details>` : '';
    el.innerHTML = `
      <div class="report-head">
        <div style="min-width:0">
          <h3>${esc(r.name)}${sample ? '<span class="tag-example">пример</span>' : ''}</h3>
          <div class="meta"><span>${esc(LI.KIND_LABEL[r.kind] || r.kind)}</span><span>${LI.fmtSize(r.size)}</span>${r.sha ? `<span>SHA-256 <span class="hash">${r.sha}</span></span>` : ''}</div>
        </div>
        <div class="row"><button class="btn small" type="button" data-act="copy">скопировать отчёт</button><button class="btn small ghost" type="button" data-act="remove">убрать</button></div>
      </div>
      <div class="verdict ${vcls}">
        <div><div class="v-title">${esc(vtitle)}</div><div class="v-sub">${esc(vsub)}</div></div>
        <div class="counts" role="group" aria-label="Фильтр по важности">
          ${['critical', 'warning', 'info'].map((s) => `<button type="button" class="sev ${s}${c[s] ? '' : ' zero'}" data-filter="${s}" aria-pressed="true" ${c[s] ? '' : 'disabled'}>${LI.SEV_LABEL[s]} ${c[s]}</button>`).join('')}
        </div>
      </div>
      ${cats || '<p class="muted">Замечаний нет.</p>'}
      <div class="sub">${renderTextView(r.rep)}${meta}${struct}${notes}</div>`;
    el.addEventListener('click', async (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.act === 'remove') el.remove();
      if (b.dataset.act === 'copy') flashLabel(b, (await copy(reportMarkdown(r), el)) ? 'скопировано' : 'выделите и скопируйте текст ниже');
      if (b.classList.contains('more')) { b.parentElement.querySelectorAll('.finding.extra').forEach((x) => (x.hidden = false)); b.remove(); }
      if (b.dataset.filter) {
        b.setAttribute('aria-pressed', b.getAttribute('aria-pressed') === 'true' ? 'false' : 'true');
        const on = new Set([...el.querySelectorAll('[data-filter][aria-pressed="true"]')].map((x) => x.dataset.filter));
        el.querySelectorAll('.finding').forEach((f) => { if (!f.classList.contains('extra')) f.hidden = !on.has(f.dataset.sev); });
        el.querySelectorAll('.cat').forEach((cat) => (cat.hidden = ![...cat.querySelectorAll('.finding')].some((f) => !f.hidden || (f.classList.contains('extra') && on.has(f.dataset.sev)))));
      }
    });
    return el;
  }

  const status = $('#scan-status');
  let queue = Promise.resolve();
  const scanBuffers = (items) => {
    queue = queue.then(async () => {
      for (const { name, buf, sample } of items) {
        status.className = 'status busy';
        status.textContent = `Проверяю «${name}»…`;
        await LI.yieldUI();
        try {
          const r = await LI.scanFile(name, buf, opts());
          $('#reports').prepend(renderReport(r, sample));
        } catch (e) {
          const el = document.createElement('article');
          el.className = 'report';
          el.innerHTML = `<div class="report-head"><h3>${esc(name)}</h3></div><div class="verdict crit"><div><div class="v-title">Файл не удалось разобрать</div><div class="v-sub">${esc(e && e.message ? e.message : String(e))}. Возможно, файл повреждён, зашифрован или имеет неподдерживаемый формат.</div></div></div>`;
          $('#reports').prepend(el);
        }
      }
      status.className = 'status';
      status.textContent = '';
    });
    return queue;
  };
  const scanFiles = async (files) => {
    const items = [];
    for (const f of files) items.push({ name: f.name, buf: await f.arrayBuffer() });
    return scanBuffers(items);
  };
  $('#scan-input').addEventListener('change', (e) => { scanFiles([...e.target.files]); e.target.value = ''; });
  const drop = $('#drop');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); scanFiles([...e.dataTransfer.files]); });
  const runSample = async () => {
    if (!window.JSZip) return;
    scanBuffers([{ name: 'пример-договор-займа.docx', buf: await LI.buildSampleDocx(), sample: true }]);
  };
  $('#scan-sample').addEventListener('click', runSample);

  // ---- Translation -------------------------------------------------------------------
  const sides = { src: { paras: null, report: null }, tgt: { paras: null, report: null } };
  const glossEl = $('#gloss-text');
  glossEl.value = store.get('glossary') ?? LI.SAMPLE_GLOSSARY;
  glossEl.addEventListener('input', () => store.set('glossary', glossEl.value));

  for (const side of ['src', 'tgt']) {
    const ta = $(`#${side}-text`), info = $(`#${side}-info`);
    // Text edited after a file load is checked as typed.
    ta.addEventListener('input', () => { sides[side].paras = null; });
    $(`#${side}-file`).addEventListener('change', async (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (!f) return;
      info.textContent = `Читаю «${f.name}»…`;
      try {
        const buf = await f.arrayBuffer();
        const r = await LI.scanFile(f.name, buf, opts());
        const paras = r.rep.paragraphs.filter((p) => p.partKind === 'main' || p.partKind === 'footnote');
        sides[side].paras = paras;
        sides[side].report = r;
        ta.value = paras.map((p) => ((p.label ? p.label + ' ' : '') + (p.text ?? '')).replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
        const c = countSev(r.rep.findings);
        info.innerHTML = `${esc(f.name)}: абзацев ${paras.length}. ` + (c.critical ? `<button class="warnlink" type="button">скрытое содержимое: критичных замечаний ${c.critical}</button>` : c.warning ? `<button class="warnlink" type="button">замечаний по файлу: ${c.warning}</button>` : 'Скрытого содержимого не найдено.');
        const link = info.querySelector('.warnlink');
        if (link) link.addEventListener('click', () => { $('#reports').prepend(renderReport(r)); selectTab('scan'); window.scrollTo({ top: 0 }); });
      } catch (err) {
        info.textContent = `Не удалось прочитать «${f.name}»: ${err.message || err}`;
      }
    });
  }

  const ISSUE_TYPE = { structure: 'Нумерация', omission: 'Пропуск', addition: 'Добавление', length: 'Объём', numbers: 'Числа', dates: 'Даты', money: 'Суммы и валюты', ids: 'Реквизиты', names: 'Наименования', defs: 'Определения', glossary: 'Глоссарий', untranslated: 'Не переведено', format: 'Формат', typo: 'Типографика', lang: 'Языки' };

  function trMarkdown(res) {
    const L = [`# Проверка перевода`, '', `Оригинал: ${T.LANG_LABEL[res.srcLang]}, абзацев ${res.stats.srcParas}. Перевод: ${T.LANG_LABEL[res.tgtLang]}, абзацев ${res.stats.tgtParas}.`, `Критично: ${res.counts.critical}, внимание: ${res.counts.warning}, сведения: ${res.counts.info}.`, ''];
    for (const it of res.issues) {
      const b = it.block ? res.blocks[it.block - 1] : null;
      L.push(`- [${LI.SEV_LABEL[it.sev]}] ${ISSUE_TYPE[it.type] || it.type}${b ? ` (${b.label})` : ''}: ${it.msg}`);
    }
    return L.join('\n');
  }

  function renderTr(res) {
    const host = $('#tr-result');
    if (!res.blocks.length) { host.innerHTML = '<p class="muted">Введите текст оригинала и перевода.</p>'; return; }
    const c = res.counts;
    const blockSev = (b) => (b.issues.some((i) => i.sev === 'critical') ? 'has-crit' : b.issues.some((i) => i.sev === 'warning') ? 'has-warn' : '');
    const sorted = [...res.issues].sort((a, b) => LI.SEV_RANK[b.sev] - LI.SEV_RANK[a.sev]);
    const gl = res.global;
    const sevMax = c.critical ? 'crit' : '';
    host.innerHTML = `
      <div class="report" style="border-top-color:var(--ink-1)">
        <div class="report-head">
          <div><h3>Результат проверки${$('#src-text').dataset.sample === '1' ? '<span class="tag-example">пример</span>' : ''}</h3>
          <div class="meta"><span>оригинал: ${T.LANG_LABEL[res.srcLang]}</span><span>перевод: ${T.LANG_LABEL[res.tgtLang]}</span><span>выравнивание: ${res.stats.labels.used ? 'по нумерации пунктов' : 'по длине абзацев'}</span></div></div>
          <button class="btn small" type="button" id="tr-copy">скопировать отчёт</button>
        </div>
        <div class="verdict ${sevMax}"><div><div class="v-title">${c.critical ? 'Перевод расходится с оригиналом' : c.warning ? 'Существенных расхождений не найдено, есть замечания' : 'Расхождений не найдено'}</div><div class="v-sub">Проверены нумерация, числа, даты, суммы, валюты, реквизиты, наименования, определённые термины и глоссарий. Смысл и стиль перевода не оцениваются.</div></div>
          <div class="counts">${['critical', 'warning', 'info'].map((s) => `<span class="sev ${s}${c[s] ? '' : ' zero'}">${LI.SEV_LABEL[s]} ${c[s]}</span>`).join('')}</div></div>
        <div class="tr-summary">
          <div><span class="k">пункты</span><span class="v">${res.stats.labels.matched}<small> из ${res.stats.labels.src} сопоставлены</small></span></div>
          <div><span class="k">числа</span><span class="v">${gl.counts.nums - gl.nums.missing.length}<small> из ${gl.counts.nums} совпали</small></span></div>
          <div><span class="k">даты</span><span class="v">${gl.counts.dates - gl.dates.missing.length}<small> из ${gl.counts.dates}</small></span></div>
          <div><span class="k">суммы</span><span class="v">${gl.counts.money - gl.money.missing.length}<small> из ${gl.counts.money}</small></span></div>
          <div><span class="k">реквизиты</span><span class="v">${gl.counts.ids - gl.ids.missing.length}<small> из ${gl.counts.ids}</small></span></div>
          <div><span class="k">объём</span><span class="v">${Math.round((res.stats.ratio || 1) * 100)}%<small> от оригинала</small></span></div>
        </div>
        <section class="cat"><div class="cat-head"><h4>Замечания</h4><span class="n">${res.issues.length}</span></div>
          <div class="issues">${sorted.map((it) => {
            const b = it.block ? res.blocks[it.block - 1] : null;
            const q = it.src || it.tgt;
            return `<div class="issue"><span class="sev ${it.sev}">${LI.SEV_LABEL[it.sev]}</span><div class="msg"><span class="eyebrow">${esc(ISSUE_TYPE[it.type] || it.type)}${b ? ' · ' + esc(b.label) : ''}</span><br>${esc(it.msg)}</div>${b ? `<button class="go" type="button" data-block="${b.id}">к пункту</button>` : '<span></span>'}${q ? `<div class="quote">${esc(LI.clip(q, 260))}</div>` : ''}</div>`;
          }).join('') || '<p class="muted">Замечаний нет.</p>'}</div>
        </section>
        <div class="sub">
          <details open><summary>сопоставление пунктов: ${res.blocks.length}</summary><div>
            <label class="inline small" style="margin-bottom:10px"><input type="checkbox" id="tr-only"> только пункты с замечаниями</label>
            <div class="tablewrap"><table class="align"><colgroup><col><col class="c-src"><col class="c-tgt"></colgroup><thead><tr><th>пункт</th><th>оригинал</th><th>перевод</th></tr></thead><tbody>
            ${res.blocks.map((b) => `<tr id="blk-${b.id}" class="${blockSev(b)}" data-issues="${b.issues.length}"><td class="num">${esc(b.label)}</td><td>${b.src.map((t) => `<div class="p">${esc(t)}</div>`).join('') || '<span class="st-bad">нет</span>'}</td><td>${b.tgt.map((t) => `<div class="p">${esc(t)}</div>`).join('') || '<span class="st-bad">нет</span>'}${b.issues.length ? `<div class="blk-issues">${b.issues.map((i) => `<span class="sev ${i.sev}">${esc(ISSUE_TYPE[i.type] || i.type)}</span> <span>${esc(i.msg)}</span>`).join('<br>')}</div>` : ''}</td></tr>`).join('')}
            </tbody></table></div></div></details>
          <details><summary>наименования и имена: ${res.entities.length}</summary><div><div class="tablewrap"><table><thead><tr><th>в оригинале</th><th>в переводе</th></tr></thead><tbody>
            ${res.entities.map((e) => `<tr><td>${esc(e.name)}</td><td>${{ ok: '<span class="st-ok">найдено без изменений</span>', missing: '<span class="st-bad">не найдено в оригинальном написании</span>', case: '<span class="st-warn">другой регистр букв</span>', diacritics: '<span class="st-warn">утрачена диакритика</span>', check: '<span class="st-warn">проверьте транслитерацию: добавьте пару в глоссарий</span>', glossary: '<span class="st-ok">задано в глоссарии</span>' }[e.status]}</td></tr>`).join('') || '<tr><td colspan="2" class="muted">Наименований не найдено.</td></tr>'}
          </tbody></table></div></div></details>
          <details><summary>определённые термины: ${res.defs.src.length} / ${res.defs.tgt.length}</summary><div class="defs">
            <div><span class="eyebrow">оригинал</span><ol>${res.defs.src.map((d) => `<li>${esc(d.term)}</li>`).join('') || '<li class="muted">не найдено</li>'}</ol></div>
            <div><span class="eyebrow">перевод</span><ol>${res.defs.tgt.map((d) => `<li>${esc(d.term)}</li>`).join('') || '<li class="muted">не найдено</li>'}</ol></div>
          </div></details>
          ${res.glossary.length ? `<details><summary>глоссарий: терминов ${res.glossary.length}</summary><div><div class="tablewrap"><table><thead><tr><th>термин</th><th>перевод</th><th>в оригинале</th><th>в переводе</th><th>нежелательных</th></tr></thead><tbody>
            ${res.glossary.map((g) => `<tr><td>${esc(g.src)}</td><td>${esc(g.ok.join(' | '))}${g.bad.length ? `<br><span class="muted small">не использовать: ${esc(g.bad.join(', '))}</span>` : ''}</td><td class="num">${g.sc}</td><td class="num ${g.sc && !g.tc ? 'st-bad' : ''}">${g.tc}</td><td class="num ${g.bc ? 'st-bad' : ''}">${g.bc}</td></tr>`).join('')}
          </tbody></table></div></div></details>` : ''}
          <details><summary>числа, даты и суммы без пары</summary><div class="defs">
            <div><span class="eyebrow">есть в оригинале, нет в переводе</span><ol>${[...gl.nums.missing, ...gl.dates.missing, ...gl.money.missing, ...gl.ids.missing].map((x) => `<li>${esc(x.raw)}</li>`).join('') || '<li class="muted">нет</li>'}</ol></div>
            <div><span class="eyebrow">есть в переводе, нет в оригинале</span><ol>${[...gl.nums.extra, ...gl.dates.extra, ...gl.money.extra, ...gl.ids.extra].map((x) => `<li>${esc(x.raw)}</li>`).join('') || '<li class="muted">нет</li>'}</ol></div>
          </div></details>
        </div>
      </div>`;
    host.querySelector('#tr-copy').addEventListener('click', async (e) => flashLabel(e.target, (await copy(trMarkdown(res), host)) ? 'скопировано' : 'выделите и скопируйте текст ниже'));
    host.querySelector('#tr-only').addEventListener('change', (e) => host.querySelectorAll('.align tbody tr').forEach((tr) => (tr.hidden = e.target.checked && tr.dataset.issues === '0')));
    host.querySelectorAll('.go').forEach((g) => g.addEventListener('click', () => {
      const row = host.querySelector('#blk-' + g.dataset.block);
      if (!row) return;
      row.closest('details').open = true;
      row.hidden = false;
      row.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
      row.classList.add('flash');
      setTimeout(() => row.classList.remove('flash'), 1200);
    }));
  }

  const runTr = () => {
    const st = $('#tr-status');
    const srcText = $('#src-text').value, tgtText = $('#tgt-text').value;
    if (!srcText.trim() || !tgtText.trim()) { st.textContent = 'Нужны оба текста: оригинал и перевод.'; return; }
    st.textContent = '';
    const parasFrom = (side, text) => sides[side].paras || T.textToParas(text);
    const res = T.compare(parasFrom('src', srcText), parasFrom('tgt', tgtText), { srcLang: $('#src-lang').value, tgtLang: $('#tgt-lang').value, glossary: T.parseGlossary(glossEl.value) });
    renderTr(res);
  };
  $('#tr-run').addEventListener('click', runTr);
  const loadTrSample = () => {
    $('#src-text').value = LI.SAMPLE_SRC;
    $('#tgt-text').value = LI.SAMPLE_TGT;
    $('#src-text').dataset.sample = '1';
    sides.src.paras = sides.tgt.paras = null;
    $('#src-info').textContent = 'Пример: фрагмент договора займа с намеренными ошибками в переводе.';
    $('#tgt-info').textContent = '';
    if (!glossEl.value.trim()) glossEl.value = LI.SAMPLE_GLOSSARY;
    runTr();
  };
  $('#tr-sample').addEventListener('click', loadTrSample);
  $('#src-text').addEventListener('input', () => ($('#src-text').dataset.sample = ''));
  $('#tgt-text').addEventListener('input', () => ($('#src-text').dataset.sample = ''));
  $('#tr-clear').addEventListener('click', () => {
    for (const s of ['src', 'tgt']) { $(`#${s}-text`).value = ''; $(`#${s}-info`).textContent = ''; sides[s].paras = null; }
    $('#src-text').dataset.sample = '';
    $('#tr-result').innerHTML = '';
  });

  // Open in a working state: both tools show their built-in example.
  loadTrSample();
  runSample();

  window.DocInspector = { scanBuffers, runTr };
})();
