/**
 * Отрисовка реплик агентов: Markdown (markdown-it) и формулы (KaTeX).
 *
 * Библиотеки передаются снаружи: в тестах — из node_modules, в webview —
 * из сборки scripts/vendor.mjs, которая кладёт готовый PanelMarkdown в
 * глобальную область. Обращений к DOM здесь нет.
 *
 * Безопасность. Текст пишет агент, а результат вставляется как HTML:
 *   * html: false — сырой HTML экранируется;
 *   * ссылки javascript: и data: markdown-it не пропускает сам;
 *   * KaTeX с trust: false — \href, \htmlClass и подобные выводятся текстом.
 *
 * Правило для $…$ написано здесь, а не взято плагином: готовый плагин есть
 * только в виде CommonJS с устаревшей KaTeX, а границы формулы важнее всего —
 * «стоит $5 и $10» формулой становиться не должно. Правило как у Pandoc:
 * после открывающего $ не пробел, перед закрывающим не пробел, за
 * закрывающим не цифра; перед открывающим не буква и не цифра.
 */
(function () {
  const ДОЛЛАР = 0x24;
  const ОБРАТНАЯ_ЧЕРТА = 0x5c;
  const пробел = (код) => код === 0x20 || код === 0x09 || код === 0x0a || код === 0x0d;
  const цифра = (код) => код >= 0x30 && код <= 0x39;
  const букваИлиЦифра = (символ) => /[\p{L}\p{N}]/u.test(символ ?? "");

  /** Экранирован ли символ в позиции: нечётное число обратных черт перед ним. */
  function экранирован(текст, позиция) {
    let черт = 0;
    for (let i = позиция - 1; i >= 0 && текст.charCodeAt(i) === ОБРАТНАЯ_ЧЕРТА; i -= 1) черт += 1;
    return черт % 2 === 1;
  }

  function строчнаяФормула(state, silent) {
    const текст = state.src;
    const начало = state.pos;
    if (текст.charCodeAt(начало) !== ДОЛЛАР) return false;

    // $$…$$ посреди строки — выносная формула внутри абзаца.
    if (текст.charCodeAt(начало + 1) === ДОЛЛАР) {
      const конец = текст.indexOf("$$", начало + 2);
      if (конец < 0 || !текст.slice(начало + 2, конец).trim()) return false;
      if (!silent) {
        const токен = state.push("math_display", "math", 0);
        токен.content = текст.slice(начало + 2, конец);
      }
      state.pos = конец + 2;
      return true;
    }

    if (начало > 0 && букваИлиЦифра(текст[начало - 1])) return false;
    if (начало + 1 >= state.posMax || пробел(текст.charCodeAt(начало + 1))) return false;

    for (let i = начало + 1; i < state.posMax; i += 1) {
      if (текст.charCodeAt(i) !== ДОЛЛАР || экранирован(текст, i)) continue;
      if (пробел(текст.charCodeAt(i - 1)) || цифра(текст.charCodeAt(i + 1))) continue;
      if (!silent) {
        const токен = state.push("math_inline", "math", 0);
        токен.content = текст.slice(начало + 1, i);
      }
      state.pos = i + 1;
      return true;
    }
    return false;
  }

  function выноснаяФормула(state, startLine, endLine, silent) {
    const строка = (номер) =>
      state.src.slice(state.bMarks[номер] + state.tShift[номер], state.eMarks[номер]);
    if (state.sCount[startLine] - state.blkIndent >= 4) return false;
    const первая = строка(startLine);
    if (!первая.startsWith("$$")) return false;

    let содержимое;
    let последняя = startLine;
    const хвост = первая.slice(2);
    if (хвост.trimEnd().endsWith("$$") && хвост.trim().length > 2) {
      содержимое = хвост.trimEnd().slice(0, -2);
    } else if (хвост.trim() === "" || !хвост.includes("$$")) {
      const части = хвост.trim() ? [хвост] : [];
      let найдено = false;
      for (let номер = startLine + 1; номер < endLine; номер += 1) {
        const с = строка(номер);
        if (с.trimEnd().endsWith("$$")) {
          части.push(с.trimEnd().slice(0, -2));
          последняя = номер;
          найдено = true;
          break;
        }
        части.push(с);
      }
      if (!найдено) return false;
      содержимое = части.join("\n");
    } else {
      return false;
    }
    if (!содержимое.trim()) return false;
    if (silent) return true;

    const токен = state.push("math_display", "math", 0);
    токен.block = true;
    токен.content = содержимое;
    токен.map = [startLine, последняя + 1];
    state.line = последняя + 1;
    return true;
  }

  function createRenderer(markdownit, katex) {
    const md = markdownit({ html: false, linkify: true, typographer: false });

    const формула = (содержимое, выносная) => {
      try {
        return katex.renderToString(содержимое, {
          displayMode: выносная,
          throwOnError: false,
          trust: false,
          strict: "ignore",
          output: "html",
        });
      } catch {
        // throwOnError ловит только ошибки разбора; прочее — показать исходник.
        return `<code>${md.utils.escapeHtml(содержимое)}</code>`;
      }
    };

    md.inline.ruler.before("escape", "math_inline", строчнаяФормула);
    md.block.ruler.before("fence", "math_display", выноснаяФормула, {
      alt: ["paragraph", "reference", "blockquote", "list"],
    });
    md.renderer.rules.math_inline = (токены, i) => формула(токены[i].content, false);
    md.renderer.rules.math_display = (токены, i) =>
      токены[i].block
        ? `<div class="формула">${формула(токены[i].content, true)}</div>\n`
        : формула(токены[i].content, true);

    return (текст) => md.render(текст ?? "");
  }

  const api = { createRenderer };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  globalThis.PanelMarkdownApi = api;
})();
