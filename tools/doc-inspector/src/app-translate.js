'use strict';
// Legal translation check app.
(() => {
  const LI = window.LI, T = LI.TR;
  const { $, esc, store, copy, flashLabel, htmlToText, countSev, otherApp } = window.UI;

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
        const r = await LI.scanFile(f.name, buf, {});
        const paras = r.rep.paragraphs.filter((p) => p.partKind === 'main' || p.partKind === 'footnote');
        sides[side].paras = paras;
        sides[side].report = r;
        $('#src-text').dataset.sample = '';
        ta.value = paras.map((p) => ((p.label ? p.label + ' ' : '') + (p.text ?? '')).replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
        const c = countSev(r.rep.findings);
        const top = r.rep.findings.filter((x) => x.sev !== 'info');
        info.innerHTML = `${esc(f.name)}: абзацев ${paras.length}. ` + (top.length
          ? `<details class="filewarn"><summary>${c.critical ? `скрытое содержимое: критичных замечаний ${c.critical}` : `замечаний по файлу: ${c.warning}`}</summary>
              <ul class="f-list">${top.slice(0, 8).map((x) => `<li><span class="sev ${x.sev}">${LI.SEV_LABEL[x.sev]}</span> ${esc(x.title)}${x.loc ? ', ' + esc(x.loc) : ''}</li>`).join('')}${top.length > 8 ? `<li>и ещё ${top.length - 8}</li>` : ''}</ul>
              <p class="small muted">Скрытый и удалённый текст в сравнение не включён. Полный отчёт по файлу: ${otherApp('scanner', 'сканер скрытого содержимого')}.</p></details>`
          : 'Скрытого содержимого не найдено.');
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

  // Open in a working state with the built-in example.
  loadTrSample();

  window.DocInspector = { runTr };
})();
