'use strict';
// Hidden-content scanner app.
(() => {
  const LI = window.LI, T = LI.TR;
  const { $, esc, store, copy, flashLabel, htmlToText, countSev, otherApp } = window.UI;

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


  // Open in a working state with the built-in example.
  runSample();

  window.DocInspector = { scanBuffers };
})();
