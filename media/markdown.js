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
  const DOLLAR = 0x24;
  const BACKSLASH = 0x5c;
  const isSpace = (code) => code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
  const isDigit = (code) => code >= 0x30 && code <= 0x39;
  const isAlnum = (symbol) => /[\p{L}\p{N}]/u.test(symbol ?? "");

  /** Экранирован ли символ в позиции: нечётное число обратных черт перед ним. */
  function isEscaped(text, position) {
    let backslashes = 0;
    for (let i = position - 1; i >= 0 && text.charCodeAt(i) === BACKSLASH; i -= 1) backslashes += 1;
    return backslashes % 2 === 1;
  }

  function inlineFormula(state, silent) {
    const text = state.src;
    const start = state.pos;
    if (text.charCodeAt(start) !== DOLLAR) return false;

    // $$…$$ посреди строки — выносная формула внутри абзаца.
    if (text.charCodeAt(start + 1) === DOLLAR) {
      const end = text.indexOf("$$", start + 2);
      if (end < 0 || !text.slice(start + 2, end).trim()) return false;
      if (!silent) {
        const token = state.push("math_display", "math", 0);
        token.content = text.slice(start + 2, end);
      }
      state.pos = end + 2;
      return true;
    }

    if (start > 0 && isAlnum(text[start - 1])) return false;
    if (start + 1 >= state.posMax || isSpace(text.charCodeAt(start + 1))) return false;

    for (let i = start + 1; i < state.posMax; i += 1) {
      if (text.charCodeAt(i) !== DOLLAR || isEscaped(text, i)) continue;
      if (isSpace(text.charCodeAt(i - 1)) || isDigit(text.charCodeAt(i + 1))) continue;
      if (!silent) {
        const token = state.push("math_inline", "math", 0);
        token.content = text.slice(start + 1, i);
      }
      state.pos = i + 1;
      return true;
    }
    return false;
  }

  function displayFormula(state, startLine, endLine, silent) {
    const line = (index) =>
      state.src.slice(state.bMarks[index] + state.tShift[index], state.eMarks[index]);
    if (state.sCount[startLine] - state.blkIndent >= 4) return false;
    const firstLine = line(startLine);
    if (!firstLine.startsWith("$$")) return false;

    let content;
    let last = startLine;
    const tail = firstLine.slice(2);
    if (tail.trimEnd().endsWith("$$") && tail.trim().length > 2) {
      content = tail.trimEnd().slice(0, -2);
    } else if (tail.trim() === "" || !tail.includes("$$")) {
      const parts = tail.trim() ? [tail] : [];
      let found = false;
      for (let index = startLine + 1; index < endLine; index += 1) {
        const s = line(index);
        if (s.trimEnd().endsWith("$$")) {
          parts.push(s.trimEnd().slice(0, -2));
          last = index;
          found = true;
          break;
        }
        parts.push(s);
      }
      if (!found) return false;
      content = parts.join("\n");
    } else {
      return false;
    }
    if (!content.trim()) return false;
    if (silent) return true;

    const token = state.push("math_display", "math", 0);
    token.block = true;
    token.content = content;
    token.map = [startLine, last + 1];
    state.line = last + 1;
    return true;
  }

  function createRenderer(markdownit, katex) {
    const md = markdownit({ html: false, linkify: true, typographer: false });

    const formula = (content, display) => {
      try {
        return katex.renderToString(content, {
          displayMode: display,
          throwOnError: false,
          trust: false,
          strict: "ignore",
          output: "html",
        });
      } catch {
        // throwOnError ловит только ошибки разбора; прочее — показать исходник.
        return `<code>${md.utils.escapeHtml(content)}</code>`;
      }
    };

    md.inline.ruler.before("escape", "math_inline", inlineFormula);
    md.block.ruler.before("fence", "math_display", displayFormula, {
      alt: ["paragraph", "reference", "blockquote", "list"],
    });
    md.renderer.rules.math_inline = (tokens, i) => formula(tokens[i].content, false);
    md.renderer.rules.math_display = (tokens, i) =>
      tokens[i].block
        ? `<div class="формула">${formula(tokens[i].content, true)}</div>\n`
        : formula(tokens[i].content, true);

    return (text) => md.render(text ?? "");
  }

  const api = { createRenderer };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  globalThis.PanelMarkdownApi = api;
})();
