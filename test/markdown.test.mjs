/**
 * Отрисовка реплик агентов: Markdown и формулы.
 *
 * Агенты пишут Markdown с формулами, а панель показывала его сырым текстом.
 * Отрисовка — это HTML из текста, который написал не человек, поэтому
 * проверяется не только красота, но и то, что из реплики нельзя выполнить
 * код, и что обычный текст с долларами не превращается в формулы.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const markdownit = require_("markdown-it");
const katex = require_("katex");
const { createRenderer } = require_("../media/markdown.js");

const render = createRenderer(markdownit, katex);

test("разметка: заголовки, жирный, списки, таблицы", () => {
  const html = render("## Итог\n\n**важно**\n\n- раз\n- два\n\n| a | b |\n|---|---|\n| 1 | 2 |");
  assert.match(html, /<h2>Итог<\/h2>/);
  assert.match(html, /<strong>важно<\/strong>/);
  assert.match(html, /<li>раз<\/li>/);
  assert.match(html, /<table>/);
});

test("сырой HTML из реплики не проходит", () => {
  const html = render('<script>alert(1)</script><img src=x onerror="alert(1)">');
  assert.doesNotMatch(html, /<script/);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;script&gt;/);
});

test("ссылка javascript: не становится ссылкой", () => {
  const html = render("[жми](javascript:alert(1))");
  assert.doesNotMatch(html, /href="javascript:/i);
});

test("обычная ссылка остаётся ссылкой", () => {
  assert.match(render("[док](https://example.com/a)"), /<a href="https:\/\/example\.com\/a">док<\/a>/);
});

test("строчная формула $…$", () => {
  const html = render("энергия $E = mc^2$ сохраняется");
  assert.match(html, /class="katex"/);
  assert.match(html, /энергия /);
  assert.match(html, / сохраняется/);
});

test("выносная формула $$…$$, в том числе на нескольких строках", () => {
  assert.match(render("$$\\sum_{i=1}^n i$$"), /katex-display/);
  assert.match(render("до\n\n$$\n\\frac{a}{b}\n$$\n\nпосле"), /katex-display/);
});

test("доллары в обычном тексте — не формула", () => {
  for (const text of ["стоит $5 и $10", "цена $5, а не $ 10", "переменная $PATH и $HOME", "итого 5$ и 10$"]) {
    assert.doesNotMatch(render(text), /katex/, text);
  }
});

test("в коде формулы не отрисовываются", () => {
  assert.doesNotMatch(render("`$x^2$`"), /katex/);
  assert.doesNotMatch(render("```\n$x^2$\n```"), /katex/);
});

test("ошибка в формуле не роняет отрисовку и не теряет текст", () => {
  const html = render("до $\\frac{a$ после");
  assert.match(html, /до/);
  assert.match(html, /после/);
});

test("команды KaTeX, выводящие ссылки и HTML, запрещены", () => {
  // При trust: false KaTeX показывает такую команду исходным текстом —
  // слово в тексте безопасно, опасны ссылка и атрибут.
  const html = render("$\\href{javascript:alert(1)}{x}$ и $\\htmlClass{evil}{x}$");
  assert.doesNotMatch(html, /href="javascript:/i);
  assert.doesNotMatch(html, /class="[^"]*\bevil\b/);
});

test("экранированный доллар остаётся долларом", () => {
  const html = render("стоимость \\$5 и \\$6");
  assert.doesNotMatch(html, /katex/);
  assert.match(html, /\$5/);
});
