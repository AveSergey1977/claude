'use strict';
// Checks that work on extracted text from any format: invisible and smuggled
// characters, mixed-script words, instructions aimed at AI tools, layout tricks.
(() => {
  const LI = window.LI;

  // Instructions addressed to an AI model, EN / RU / LT. Matched on text with
  // invisible characters removed and whitespace collapsed.
  const AI_PATTERNS = [
    [/\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|any|preceding|system)\b[^.\n]{0,30}\b(instructions?|prompts?|rules|directions|guidelines|context)\b/i, 'Требование игнорировать прежние инструкции'],
    [/\b(you are|act as|you're)\s+(now\s+)?(an?\s+)?(AI|A\.I\.|assistant|language model|LLM|chatbot|ChatGPT|Claude|GPT|Gemini|Copilot)\b/i, 'Обращение к ИИ-модели'],
    [/\b(as an? (AI|language model|LLM))\b/i, 'Обращение к ИИ-модели'],
    [/\bsystem\s+(prompt|message|instructions?)\b|\bdeveloper\s+(prompt|message)\b/i, 'Упоминание системных инструкций'],
    [/\b(do not|don't|never)\s+(tell|inform|mention|reveal|disclose|show|alert|notify)\b[^.\n]{0,40}\b(user|reader|client|human|anyone)\b/i, 'Требование скрыть информацию от пользователя'],
    [/\b(AI|A\.I\.|LLM|ChatGPT|Claude|Copilot|Gemini|GPT)s?\b[^.\n]{0,25}\b(must|should|shall|are instructed to|is instructed to|need to)\b/, 'Инструкция для ИИ'],
    [/\b(note|message|instructions?)\s+(to|for)\s+(the\s+)?(AI|A\.I\.|LLM|assistant|model|reviewers?|summari[sz]er)\b/i, 'Инструкция для ИИ'],
    [/\bwhen\s+(summari[sz]ing|reviewing|analy[sz]ing|translating|evaluating|processing)\s+(this|the)\s+(document|contract|agreement|text|file|cv|resume)/i, 'Указание, как обрабатывать документ'],
    [/\b(rate|score|evaluate|assess|classify|mark)\s+(this|the)\s+(document|contract|agreement|candidate|deal|risk)\b[^.\n]{0,40}\b(as|highly|positive|low|favou?rabl|acceptable)/i, 'Попытка задать оценку документа'],
    [/\b(respond|reply|answer|output)\s+only\s+(with|in)\b/i, 'Требование к формату ответа ИИ'],
    [/\bnew\s+instructions?\s*:/i, 'Новые инструкции'],
    [/<\|?(im_start|im_end|system|endoftext)\|?>|\[\/?INST\]|<<\/?SYS>>|^\s*#{2,}\s*(system|instruction)/im, 'Служебная разметка промптов'],
    [/\b(jailbreak|prompt injection)\b/i, 'Упоминание jailbreak / prompt injection'],

    [/(игнорир|не\s+учитыва|забуд|отмен)\p{L}*\s+(\p{L}+\s+){0,3}(предыдущ|прежн|вышеуказанн|ранее\s+данн|вс[еёя]|системн)\p{L}*\s+(\p{L}+\s+){0,2}(инструкц|указани|команд|правил|промпт|подсказ)/iu, 'Требование игнорировать прежние инструкции'],
    [/(^|[^\p{L}])(ты|вы)\s+(теперь\s+)?(—|–|-)?\s*(ии|ассистент|языков\p{L}*\s+модел|нейросет|искусственн\p{L}*\s+интеллект|chatgpt|claude)/iu, 'Обращение к ИИ-модели'],
    [/как\s+(языковая\s+модель|ии|искусственный\s+интеллект|нейросеть)/iu, 'Обращение к ИИ-модели'],
    [/системн\p{L}*\s+(промпт|подсказк|инструкц|сообщени)/iu, 'Упоминание системных инструкций'],
    [/не\s+(сообщай|говори|упоминай|раскрывай|показывай|сообщайте|говорите|упоминайте|раскрывайте|показывайте)\p{L}*\s+(\p{L}+\s+){0,3}(пользовател|клиент|читател|заказчик|человек)/iu, 'Требование скрыть информацию от пользователя'],
    [/(^|[^\p{L}])(ИИ|нейросет\p{L}*|ChatGPT|Claude|GPT)[,\s]+(\p{L}+\s+){0,2}(должн|обязан|следует|необходимо)/u, 'Инструкция для ИИ'],
    [/(примечание|инструкци\p{L}*|указани\p{L}*|сообщение)\s+для\s+(ии|нейросет|модел|ассистент|chatgpt|claude|gpt|искусственн)/iu, 'Инструкция для ИИ'],
    [/при\s+(анализе|проверке|переводе|резюмировании|суммаризации|обработке|оценке)\s+(этого|данного|настоящего)\s+(документа|договора|текста|соглашения|файла)/iu, 'Указание, как обрабатывать документ'],
    [/(оцени|оцените|признай|признайте|классифицируй)\s+(этот|данный|настоящий)\s+(документ|договор|риск|контракт)/iu, 'Попытка задать оценку документа'],
    [/новые\s+инструкции\s*:/iu, 'Новые инструкции'],
    [/(отвечай|отвечайте)\s+только/iu, 'Требование к формату ответа ИИ'],

    [/(ignoruok|nepaisyk|pamiršk)\p{L}*\s+(\p{L}+\s+){0,3}(ankstesn|ankstesnius|visas|sistemos)\p{L}*\s+(\p{L}+\s+){0,2}(instrukcij|nurodym|taisykl)/iu, 'Требование игнорировать прежние инструкции'],
    [/(tu\s+esi|jūs\s+esate)\s+(dabar\s+)?(dirbtinis\s+intelektas|DI|asistentas|kalbos\s+modelis)/iu, 'Обращение к ИИ-модели'],
    [/sistemos\s+(instrukcij|raginim|nurodym)/iu, 'Упоминание системных инструкций'],
    [/nesakyk\p{L}*\s+(\p{L}+\s+){0,3}(vartotoj|naudotoj|klient)/iu, 'Требование скрыть информацию от пользователя'],
    [/(dirbtinis\s+intelektas|DI)\s+(turi|privalo)/u, 'Инструкция для ИИ'],
  ];

  const stripInvisible = (s) => {
    let o = '';
    for (const ch of s) if (!LI.isInvisibleCp(ch.codePointAt(0)) || ch === '\n' || ch === '\t') o += ch;
    return o;
  };

  // Variation-selector smuggling: byte b is written as VS(b) after a visible base character.
  const vsByte = (cp) => (cp >= 0xfe00 && cp <= 0xfe0f ? cp - 0xfe00 : cp >= 0xe0100 && cp <= 0xe01ef ? cp - 0xe0100 + 16 : -1);

  const SCRIPT = {
    cyr: /\p{Script=Cyrillic}/u,
    lat: /\p{Script=Latin}/u,
    grk: /\p{Script=Greek}/u,
  };

  LI.textChecks = (rep, opts = {}) => {
    const agg = new Map(); // key -> {sev, title, detail, count, samples:[], locs:Set}
    const bump = (key, sev, title, detail, seg, text, i, len) => {
      let a = agg.get(key);
      if (!a) agg.set(key, (a = { sev, title, detail, count: 0, samples: [], locs: new Set() }));
      a.count++;
      if (seg.loc) a.locs.add(seg.loc);
      if (a.samples.length < 4) a.samples.push(LI.context(text, i, i + len, 40).html);
      if (seg.hidden && LI.SEV_RANK[sev] > LI.SEV_RANK[a.sev]) a.sev = sev;
    };
    const mixed = new Map();
    const aiSeen = new Set();

    for (const seg of rep.segments) {
      const text = seg.text || '';
      if (!text) continue;

      // Character-level scan.
      let i = 0;
      const cps = [...text];
      let pos = 0; // UTF-16 index
      while (i < cps.length) {
        const ch = cps[i], cp = ch.codePointAt(0);
        if (cp >= 0xe0000 && cp <= 0xe007f) {
          // Unicode tag run: decode the hidden ASCII.
          let j = i, msg = '', start = pos, p2 = pos;
          while (j < cps.length) {
            const c = cps[j].codePointAt(0);
            if (c < 0xe0000 || c > 0xe007f) break;
            if (c >= 0xe0020 && c <= 0xe007e) msg += String.fromCharCode(c - 0xe0000);
            p2 += cps[j].length;
            j++;
          }
          LI.add(rep, 'critical', 'ai', 'Текст, закодированный невидимыми символами-тегами Unicode', {
            loc: seg.loc,
            excerpt: msg || '(пустая последовательность)',
            detail: `Последовательность из ${j - i} символов U+E0000–U+E007F. Человек их не видит, а ИИ-модель читает как обычный текст. Выше показан расшифрованный текст.`,
          });
          i = j; pos = p2; continue;
        }
        const vb = vsByte(cp);
        if (vb >= 0) {
          let j = i, bytes = [], p2 = pos;
          while (j < cps.length && vsByte(cps[j].codePointAt(0)) >= 0) {
            bytes.push(vsByte(cps[j].codePointAt(0)));
            p2 += cps[j].length;
            j++;
          }
          if (bytes.length >= 4) {
            const decoded = LI.decode(new Uint8Array(bytes), 'utf-8');
            LI.add(rep, 'critical', 'ai', 'Данные, спрятанные в селекторах вариантов Unicode', {
              loc: seg.loc,
              excerpt: decoded,
              detail: `После символа «${LI.clip(cps[i - 1] || '', 2)}» идут ${bytes.length} невидимых селекторов вариантов. Так в один видимый символ прячут произвольные данные. Выше показан результат расшифровки как UTF-8.`,
            });
          } else bump('vs', 'info', 'Селекторы вариантов (U+FE00–FE0F)', 'Обычно сопровождают эмодзи и некоторые символы. Одиночные селекторы безопасны.', seg, text, pos, p2 - pos);
          i = j; pos = p2; continue;
        }
        if (cp === 0x202a || cp === 0x202b || cp === 0x202d || cp === 0x202e || (cp >= 0x2066 && cp <= 0x2069)) {
          bump('bidi', 'critical', 'Управляющие символы направления текста (bidi)',
            'Символы RLO/LRO/RLE/LRE/RLI/LRI/FSI меняют порядок отображения: на экране можно увидеть «001» вместо «100» или переставленные слова. Отображаемый текст может расходиться с тем, что записано в файле.', seg, text, pos, ch.length);
        } else if (cp === 0x200e || cp === 0x200f || cp === 0x061c || cp === 0x202c) {
          bump('lrm', 'info', 'Метки направления текста (LRM/RLM/PDF)', 'Обычны для текста с арабским или ивритом. В остальных случаях им нет объяснения.', seg, text, pos, ch.length);
        } else if (cp === 0x00ad) {
          bump('shy', 'info', 'Мягкие переносы', 'Невидимы до переноса строки. Внутри слова мешают поиску по тексту: «Займо­давец» не найдётся по запросу «Займодавец».', seg, text, pos, 1);
        } else if (cp === 0xfeff && pos > 0) {
          bump('zw', 'warning', 'Символы нулевой ширины', 'Не видны и не занимают места. Разрывают слова для поиска и сравнения, могут служить водяным знаком или носителем скрытых данных.', seg, text, pos, 1);
        } else if ((cp >= 0x200b && cp <= 0x200d) || (cp >= 0x2060 && cp <= 0x2064) || cp === 0x034f || cp === 0x180e || cp === 0x115f || cp === 0x1160 || cp === 0x3164 || cp === 0xffa0) {
          bump('zw', 'warning', 'Символы нулевой ширины', 'Не видны и не занимают места. Разрывают слова для поиска и сравнения, могут служить водяным знаком или носителем скрытых данных.', seg, text, pos, ch.length);
        } else if ((cp < 0x20 && cp !== 9 && cp !== 10 && cp !== 13) || (cp >= 0x7f && cp <= 0x9f)) {
          bump('ctl', 'warning', 'Управляющие символы', 'Непечатаемые служебные символы в тексте. В нормальном документе их нет.', seg, text, pos, ch.length);
        } else if (cp >= 0xe000 && cp <= 0xf8ff) {
          bump('pua', 'info', 'Символы из области частного использования (PUA)', 'Значение зависит от шрифта. Обычно это маркеры списков из шрифтов Symbol и Wingdings.', seg, text, pos, ch.length);
        } else if ((cp >= 0x2000 && cp <= 0x200a) || cp === 0x205f || cp === 0x3000 || cp === 0x1680) {
          bump('sp', 'info', 'Нестандартные пробелы', 'Пробелы особой ширины. Безвредны, но мешают точному поиску.', seg, text, pos, ch.length);
        }
        pos += ch.length;
        i++;
      }

      // Mixed-script words (homoglyphs).
      for (const m of text.matchAll(/[\p{L}\p{M}]{2,}/gu)) {
        const w = m[0];
        const c = SCRIPT.cyr.test(w), l = SCRIPT.lat.test(w), g = SCRIPT.grk.test(w);
        if ((c && l) || (c && g) || (l && g)) {
          const key = w;
          const e = mixed.get(key) || { count: 0, locs: new Set(), seg };
          e.count++;
          if (seg.loc) e.locs.add(seg.loc);
          mixed.set(key, e);
        }
      }

      // AI-directed instructions.
      const clean = stripInvisible(text).normalize('NFKC').replace(/[ \t ]+/g, ' ');
      for (const [re, title] of AI_PATTERNS) {
        const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
        for (const m of clean.matchAll(g)) {
          const k = (seg.loc || '') + '|' + m.index;
          if (aiSeen.has(k)) continue;
          aiSeen.add(k);
          const sev = seg.hidden ? 'critical' : 'warning';
          LI.add(rep, sev, 'ai', title, {
            loc: seg.loc,
            excerptHtml: LI.context(clean, m.index, m.index + m[0].length, 120).html,
            detail: seg.hidden
              ? 'Фраза находится в скрытом от читателя месте документа. Это типичный приём prompt injection: человек её не видит, а ИИ-инструмент исполнит.'
              : 'Фраза видна читателю, но адресована ИИ-инструменту. Проверьте, зачем она в документе.',
          });
        }
      }

      // Layout tricks in plain text.
      for (const m of text.matchAll(/[ \t ]{80,}(?=\S)/g)) {
        LI.add(rep, 'warning', 'hidden', 'Текст сдвинут далеко вправо пробелами', {
          loc: seg.loc,
          excerpt: LI.clip(text.slice(m.index + m[0].length).split('\n')[0], 300),
          detail: `Перед текстом ${m[0].length} пробелов или табуляций. В обычном окне он окажется за правым краем.`,
        });
      }
      for (const m of text.matchAll(/(?:\r?\n[ \t]*){25,}(?=\S)/g)) {
        LI.add(rep, 'warning', 'hidden', 'Текст отделён большим количеством пустых строк', {
          loc: seg.loc,
          excerpt: LI.clip(text.slice(m.index + m[0].length), 300),
          detail: `Перед текстом ${m[0].split('\n').length - 1} пустых строк. Читатель может решить, что документ закончился раньше.`,
        });
      }

      // Base64 blobs: decode, show, re-check for instructions.
      for (const m of text.matchAll(/[A-Za-z0-9+/]{160,}={0,2}/g)) {
        let dec = '';
        try {
          const bin = atob(m[0].slice(0, 20000).replace(/=+$/, '').slice(0, Math.floor(m[0].length / 4) * 4));
          const u8 = Uint8Array.from(bin, (c) => c.charCodeAt(0));
          dec = LI.decode(u8, 'utf-8');
        } catch {}
        const printable = dec && dec.replace(/[\p{L}\p{N}\p{P}\p{Zs}\n\r\t]/gu, '').length / dec.length < 0.1;
        if (printable) {
          const inj = AI_PATTERNS.some(([re]) => re.test(dec));
          LI.add(rep, inj ? 'critical' : 'info', inj ? 'ai' : 'hidden', inj ? 'Инструкция для ИИ внутри строки Base64' : 'Текст, закодированный в Base64', {
            loc: seg.loc,
            excerpt: LI.clip(dec, 400),
            detail: `Строка Base64 длиной ${m[0].length} символов раскодирована в текст.`,
          });
        }
      }
    }

    for (const a of agg.values()) {
      LI.add(rep, a.sev, 'chars', `${a.title}: ${a.count}`, {
        loc: [...a.locs].slice(0, 4).join('; ') + (a.locs.size > 4 ? ` и ещё ${a.locs.size - 4}` : ''),
        excerptHtml: a.samples.join('<br>'),
        detail: a.detail,
      });
    }
    if (mixed.size) {
      const items = [...mixed.entries()].sort((a, b) => b[1].count - a[1].count);
      const html = items.slice(0, 40).map(([w, e]) => {
        let o = '';
        for (const ch of w) {
          if (SCRIPT.cyr.test(ch)) o += `<span class="sc-cyr">${LI.esc(ch)}</span>`;
          else if (SCRIPT.grk.test(ch)) o += `<span class="sc-grk">${LI.esc(ch)}</span>`;
          else o += LI.esc(ch);
        }
        return `<code>${o}</code>${e.count > 1 ? ' ×' + e.count : ''}`;
      }).join(', ');
      LI.add(rep, 'warning', 'chars', `Слова из букв разных алфавитов: ${items.length}`, {
        loc: [...new Set(items.flatMap(([, e]) => [...e.locs]))].slice(0, 4).join('; '),
        excerptHtml: html + (items.length > 40 ? ` и ещё ${items.length - 40}` : ''),
        detail: 'Кириллические буквы подчёркнуты. Внешне такие слова не отличаются от правильных, но поиск, реестры и сравнение их не находят. Типичный пример — латинское название компании с кириллической «о» или «а».',
      });
    }
  };

  LI.AI_PATTERNS = AI_PATTERNS;
})();
