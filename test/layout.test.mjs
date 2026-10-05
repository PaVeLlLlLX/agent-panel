/**
 * Интерфейс панели в настоящем браузере.
 *
 * В живом прогоне промпт с логом в одну строку сделал панель шире окна:
 * кнопки уехали за край. Стили и поведение webview без браузера не проверить,
 * поэтому разметка берётся из extension.ts, скрипты — из media/, и страница
 * открывается в безголовом Edge/Chrome. Нет браузера — проверки пропускаются.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = join(import.meta.dirname, "..");

/**
 * Код для браузера хранится строкой, но это код: scripts/ascii-identifiers.mjs
 * проверяет и переименовывает имена в нём. Поэтому он размечен: js`…` — скрипт
 * проверки, html`…` — страница, скрипты которой в <script>. Разметка текст не
 * меняет; open() принимает только размеченную проверку.
 */
class BrowserScript {
  constructor(code) {
    this.code = code;
  }
}
const joinTemplate = (strings, values) =>
  strings.reduce((text, part, i) => text + part + (i < values.length ? String(values[i]) : ""), "");
const js = (strings, ...values) => new BrowserScript(joinTemplate(strings, values));
const html = (strings, ...values) => joinTemplate(strings, values);

/** Скрипт страницы упал: браузер работает, сломана проверка или интерфейс. */
class PageScriptError extends Error {}

/**
 * chrome-headless-shell, поставленный `npx @puppeteer/browsers install
 * chrome-headless-shell@stable --path %LOCALAPPDATA%/agent-panel-browser`:
 * безголовый Edge 153 на этой машине вывода не отдаёт.
 */
function headlessChrome() {
  const catalog = join(process.env.LOCALAPPDATA ?? "", "agent-panel-browser", "chrome-headless-shell");
  if (!process.env.LOCALAPPDATA || !existsSync(catalog)) return undefined;
  for (const version of readdirSync(catalog).sort().reverse()) {
    const filePath = join(catalog, version, "chrome-headless-shell-win64", "chrome-headless-shell.exe");
    if (existsSync(filePath)) return filePath;
  }
  return undefined;
}

const browser = [
  headlessChrome(),
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].find((filePath) => filePath && existsSync(filePath));
/** Безголовой оболочке режим не указывают; обычному браузеру — новый безголовый. */
const headlessArgs = browser && /chrome-headless-shell/.test(browser) ? [] : ["--headless=new"];

const WIDTH = 600;
const media = (name) => pathToFileURL(join(root, "media", name)).href;

/**
 * Открыть разметку панели, выполнить скрипт проверки (js`…`) и вернуть то, что
 * он положил в window.result. С panel.js — вместе со скриптами интерфейса и
 * заглушкой API VS Code, которая копит отправленное в window.sentMessages.
 */
function open(check, { withUi = false, width = WIDTH, theme = "vscode-dark" } = {}) {
  const source = readFileSync(join(root, "src", "extension.ts"), "utf8");
  const body = source.match(/<body>([\s\S]*?)<script nonce/)?.[1];
  assert.ok(body, "разметка панели не найдена в extension.ts");
  assert.ok(check instanceof BrowserScript, "проверку для браузера размечают js`…`: иначе имена в ней не проверяются");

  const ui = withUi
    ? html`<script>
  window.sentMessages = [];
  window.acquireVsCodeApi = () => ({
    postMessage: (m) => window.sentMessages.push(m),
    getState: () => undefined,
    setState: () => {},
  });
</script>
<link rel="stylesheet" href="${media("vendor/katex/katex.min.css")}">
<script src="${media("format.js")}"></script>
<script src="${media("thread.js")}"></script>
<script src="${media("vendor/markdown.js")}"></script>
<script src="${media("panel.js")}"></script>`
    : "";

  const page = html`<!DOCTYPE html><html><head><meta charset="utf-8">
<script>
  // Ошибки страницы — в атрибут корня: иначе упавший скрипт виден только как «не выполнился».
  window.errors = [];
  window.addEventListener("error", (e) => {
    window.errors.push(e.message);
    document.documentElement.dataset.errors = encodeURIComponent(JSON.stringify(window.errors));
  });
</script>
<link rel="stylesheet" href="${media("panel.css")}"></head><body class="${theme}">${body}
${ui}
<script>
  window.result = {};
  // Синхронная доставка: window.postMessage асинхронен и не успел бы до снимка DOM.
  const postToPage = (data) => window.dispatchEvent(new MessageEvent("message", { data }));
  // Не «byId»: panel.js объявляет её глобально, повторное объявление роняет весь скрипт.
  const getById = (id) => document.getElementById(id);
  ${check.code}
  document.body.dataset.result = encodeURIComponent(JSON.stringify(window.result));
</script></body></html>`;

  const dir = mkdtempSync(join(tmpdir(), "agent-panel-ui-"));
  try {
    const file = join(dir, "panel.html");
    writeFileSync(file, page);
    const dom = execFileSync(
      browser,
      [
        ...headlessArgs,
        "--disable-gpu",
        "--no-first-run",
        "--allow-file-access-from-files",
        `--user-data-dir=${join(dir, "профиль")}`,
        `--window-size=${width},800`,
        "--dump-dom",
        pathToFileURL(file).href,
      ],
      { encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "ignore"] },
    );
    const errors = dom.match(/data-errors="([^"]*)"/)?.[1];
    const encoded = dom.match(/data-result="([^"]*)"/)?.[1];
    if (errors) throw new PageScriptError(`скрипт страницы упал: ${decodeURIComponent(errors)}`);
    assert.ok(encoded, "браузер не отдал результат страницы, ошибок не поймано");
    return JSON.parse(decodeURIComponent(encoded));
  } finally {
    // Дочерние процессы браузера отпускают профиль не сразу; мусор во
    // временной папке — не повод ронять проверку интерфейса.
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      /* останется во временной папке */
    }
  }
}

/**
 * Браузер есть — ещё не значит, что он отдаёт вывод: Edge 153 на этой машине
 * молчит даже на --version, хотя код возврата нулевой. Одна пробная страница
 * отличает «нечем проверять» от настоящей поломки. Упавший скрипт пробной
 * страницы — поломка, а не отсутствие браузера: тесты тогда падают, а не
 * пропускаются.
 */
const NO_BROWSER = (() => {
  if (!browser) return "нет Edge/Chrome";
  try {
    open(js`result.probe = 1;`);
    return false;
  } catch (err) {
    if (err instanceof PageScriptError) return false;
    return `браузер не отдаёт вывод: ${(err.message ?? "").slice(0, 80)}`;
  }
})();

for (const width of [WIDTH, 360]) test(`длинная задача, причина и лог не расширяют панель шириной ${width}`, { skip: NO_BROWSER }, () => {
  const { scroll, client, button, conversation, overflowed } = open(js`
    const logText = "[2026-09-15, 11:41:05 UTC] {taskinstance.py:1776} ERROR - Task failed with exception ".repeat(30);
    const event = (agent, kind, extra) => ({ id: kind + Math.random(), agent, kind, visibility: "turn", at: Date.now(), ...extra });
    // Предел по умолчанию — 5 проверок (04.10), с вилкой пары: самая тесная строка «Эстафеты».
    postToPage({ type: "state", state: { stage: "held", round: 1, maxRounds: 5, approvals: 0, queued: 2, auto: true,
      reviewers: ["codex", "gemini"], task: logText, verdict: "human", trail: [{ who: "task" }, { who: "claude" }, { who: "codex", mark: "?" }, { who: "you" }],
      held: { to: "claude", action: "send", reason: "Claude получил отказы в разрешениях (2): Bash: python -c " + "x".repeat(400) } } });
    getById("эстафета").click();
    postToPage({ type: "event", event: event("human", "message", { text: logText }) });
    postToPage({ type: "event", event: event("claude", "message", { text: logText + "a".repeat(500) }) });
    postToPage({ type: "event", event: event("codex", "message", { text: "Код:" + String.fromCharCode(10, 10) + "    " + logText }) });
    postToPage({ type: "event", event: event("claude", "tool_call", { tool: "Bash", callId: "c1", text: logText }) });
    postToPage({ type: "event", event: event("claude", "approval_requested", { tool: "Bash", callId: "p1", text: logText, sessionRules: ["Bash(" + logText + ")"] }) });
    getById("модели-кнопка").click();
    postToPage({ type: "models", agent: "codex", choice: { model: "", effort: "ultra" }, options: [
      { id: "", label: "по умолчанию " + "(очень длинное название модели) ".repeat(5), efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
    ] });
    getById("диагностика-кнопка").click();
    result.scroll = document.documentElement.scrollWidth;
    result.client = document.documentElement.clientWidth;
    result.conversation = getById("беседа").scrollWidth - getById("беседа").clientWidth;
    result.button = Math.round(getById("отправить").getBoundingClientRect().right);
    // Кто вылез за край — самые внешние из вылезших, чтобы сообщение называло виновника.
    const overflowed = [...document.querySelectorAll("body *")]
      .filter((el) => el.getClientRects().length && el.getBoundingClientRect().right > result.client + 0.5)
      // Внутри блоков с собственной прокруткой вылезать можно.
      .filter((el) => !el.parentElement.closest("pre, table, .формула, .дорожка"));
    result.overflowed = overflowed.filter((el) => !overflowed.includes(el.parentElement)).slice(0, 5)
      .map((el) => el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (el.className && typeof el.className === "string" ? "." + el.className.split(" ").join(".") : ""));
  `, { withUi: true, width });
  assert.ok(client > 0 && client <= width, `ширина окна не измерена: ${client}`);
  assert.ok(scroll <= client, `документ шире окна: ${scroll} > ${client}; за краем: ${overflowed.join(", ")}`);
  assert.ok(button <= client, `кнопка «Отправить» за краем: ${button} > ${client}`);
  assert.ok(conversation <= 0, `беседа прокручивается вбок на ${conversation} px`);
});

test("реплика агента — Markdown с формулой, реплика человека — текст, ссылка — через расширение", { skip: NO_BROWSER }, () => {
  const r = open(
    js`
    const replyEvent = (agent, text) => ({ id: agent + text.length, agent, kind: "message", visibility: "turn", at: Date.now(), text });
    postToPage({ type: "event", event: replyEvent("claude", "**жирно** и $x^2$\\n\\n[док](https://example.com/a)") });
    postToPage({ type: "event", event: replyEvent("human", "**не разметка** $x$") });
    result.bundleLoaded = typeof window.PanelMarkdown?.render === "function";
    result.bold = !!document.querySelector(".пузырь.claude .текст strong");
    result.formula = !!document.querySelector(".пузырь.claude .katex");
    result.human = document.querySelector(".пузырь.human .текст").innerHTML;
    document.querySelector(".пузырь.claude a").click();
    result.links = window.sentMessages.filter((m) => m.type === "openLink");
  `,
    { withUi: true },
  );
  assert.equal(r.bundleLoaded, true, "media/vendor/markdown.js не собран или не загрузился");
  assert.equal(r.bold, true);
  assert.equal(r.formula, true);
  assert.equal(r.human, "**не разметка** $x$");
  assert.deepEqual(r.links, [{ type: "openLink", href: "https://example.com/a" }]);
});

test("модели: список по кнопке, модель — списком, уровень — узлом нити", { skip: NO_BROWSER }, () => {
  const r = open(
    js`
    const listCalls = () => window.sentMessages.filter((m) => m.type === "listModels").length;
    result.beforeButton = listCalls();
    getById("модели-кнопка").click();
    result.panelOpen = !getById("модели-панель").hidden;
    getById("модели-кнопка").click();
    getById("модели-кнопка").click();
    result.listRequests = listCalls();

    postToPage({ type: "models", agent: "claude", choice: { model: "", effort: "" }, options: [
      { id: "", label: "по умолчанию (Sonnet 5)", description: "", efforts: ["low", "high"] },
      { id: "opus", label: "Opus", description: "Opus 5", efforts: ["low", "high", "max"] },
      { id: "haiku", label: "Haiku", description: "Haiku 4.5", efforts: [] },
    ] });
    postToPage({ type: "models", agent: "codex", choice: { model: "", effort: "" }, options: [
      { id: "", label: "по умолчанию (GPT-Sol)", description: "", efforts: ["low", "high", "ultra"], defaultEffort: "low" },
    ] });

    const nodes = (agent) => [...getById("нить-" + agent).querySelectorAll(".нить-узел")];
    const model = getById("модель-claude");
    result.models = [...model.options].map((o) => o.textContent);
    result.claudeWithoutSelection = nodes("claude").every((u) => u.getAttribute("aria-checked") === "false");
    result.claudeCaption = getById("строка-claude").title;
    model.value = "opus";
    model.dispatchEvent(new Event("change"));
    result.levels = nodes("claude").map((u) => u.getAttribute("aria-label"));
    result.tooltip = nodes("claude")[2].title;
    nodes("claude")[2].click();
    result.selected = nodes("claude").map((u) => u.getAttribute("aria-checked"));
    result.captionAfter = getById("строка-claude").title;
    result.ringsAtMax = getById("нить-claude").querySelectorAll(".нить-кольцо").length;
    model.value = "haiku";
    model.dispatchEvent(new Event("change"));
    result.haikuNodes = nodes("claude").length;
    result.haikuCaption = getById("нить-claude").textContent;

    result.codexDefaults = nodes("codex").map((u) => u.getAttribute("aria-checked"));
    result.dash = !!getById("нить-codex").querySelector(".нить-по-умолчанию");
    nodes("codex")[2].click();
    result.forkCount = getById("нить-codex").querySelectorAll(".нить-ветвь").length;
    nodes("codex")[0].click();

    result.choices = window.sentMessages.filter((m) => m.type === "setModel");
    result.summary = getById("модели-кнопка").title;
    const windowLabel = getById("модели-панель").getBoundingClientRect();
    result.threadInsideWindow = [...getById("модели-панель").querySelectorAll(".нить-узел")]
      .every((u) => u.getBoundingClientRect().right <= windowLabel.right + 1 && u.getBoundingClientRect().left >= windowLabel.left - 1);

    postToPage({ type: "permissions", mode: "bypassPermissions" });
    result.modeBefore = getById("без-вопросов").getAttribute("aria-pressed");
    getById("без-вопросов").click();
    result.modeAfter = getById("без-вопросов").textContent;
    result.modes = window.sentMessages.filter((m) => m.type === "setPermissionMode");
    result.modeSummary = getById("модели-кнопка").title;
  `,
    { withUi: true },
  );
  assert.equal(r.beforeButton, 0, "список моделей не должен запрашиваться при открытии панели");
  assert.equal(r.panelOpen, true);
  assert.equal(r.listRequests, 1, "повторное открытие не должно заново поднимать агентов");
  assert.deepEqual(r.models, ["по умолчанию (Sonnet 5)", "Opus", "Haiku"]);
  assert.equal(r.claudeWithoutSelection, true, "умолчание Claude неизвестно — узел наугад не выбирается");
  assert.equal(r.claudeCaption, "Claude: по умолчанию");
  assert.deepEqual(r.levels, ["Низкое", "Высокое", "Максимум"]);
  assert.match(r.tooltip, /Без ограничений на расход/, "определение уровня — в подсказке узла");
  assert.deepEqual(r.selected, ["false", "false", "true"]);
  assert.equal(r.captionAfter, "Claude: Opus · Максимум");
  assert.equal(r.ringsAtMax, 2, "«Максимум» — двойное кольцо");
  assert.equal(r.haikuNodes, 0, "у модели без уровней выбирать нечего");
  assert.equal(r.haikuCaption, "без уровней");
  assert.deepEqual(r.codexDefaults, ["true", "false", "false"], "умолчание из каталога выбрано");
  assert.equal(r.dash, true);
  assert.equal(r.forkCount, 3, "«Ультра» — нить ветвится");
  assert.deepEqual(r.choices, [
    { type: "setModel", agent: "claude", model: "opus", effort: "" },
    { type: "setModel", agent: "claude", model: "opus", effort: "max" },
    { type: "setModel", agent: "claude", model: "haiku", effort: "" },
    { type: "setModel", agent: "codex", model: "", effort: "ultra" },
    { type: "setModel", agent: "codex", model: "", effort: "" },
  ]);
  assert.match(r.summary, /Claude: Haiku/);
  assert.match(r.summary, /Codex: по умолчанию/);
  assert.equal(r.threadInsideWindow, true, "узлы нити не выходят за окно «Модели»");
  assert.equal(r.modeBefore, "true", "режим из расширения должен отразиться на кнопке");
  assert.equal(r.modeAfter, "Спрашивать");
  assert.deepEqual(r.modes, [{ type: "setPermissionMode", mode: "default" }]);
  assert.match(r.modeSummary, /спрашивать/);
});

test("карточка разрешения: кнопки, ответ уходит расширению, решение закрывает карточку", { skip: NO_BROWSER }, () => {
  const r = open(
    js`
    const request = (callId, extra = {}) => ({
      id: callId, agent: "claude", kind: "approval_requested", visibility: "turn", at: Date.now(),
      tool: "Bash", callId, text: "mkdir probe-dir", sessionRules: ["Bash(mkdir probe-dir *)"], ...extra,
    });
    postToPage({ type: "event", event: request("perm-1") });
    postToPage({ type: "state", state: { stage: "working", round: 0, maxRounds: 3, approvals: 1, queued: 0, auto: true } });
    const card = document.querySelector(".разрешение");
    result.buttons = [...card.querySelectorAll("button")].map((k) => k.textContent);
    result.stage = getById("этап").textContent;

    card.querySelectorAll("button")[1].click();
    result.sent = window.sentMessages.filter((m) => m.type === "approval");
    result.disabled = [...card.querySelectorAll("button")].every((k) => k.disabled);

    postToPage({ type: "event", event: {
      id: "d1", agent: "claude", kind: "approval_decided", visibility: "turn", at: Date.now(),
      callId: "perm-1", text: "разрешено в этой сессии: Bash(mkdir probe-dir *)",
    } });
    result.buttonsAfter = card.querySelectorAll("button").length;
    result.labelText = card.querySelector(".итог").textContent;

    postToPage({ type: "event", history: true, event: request("old-1") });
    result.buttonsFromJournal = document.querySelectorAll(".разрешение")[1].querySelectorAll("button").length;

    postToPage({ type: "event", event: request("perm-2") });
    const cards = document.querySelectorAll(".разрешение");
    const noQuestions = [...cards[cards.length - 1].querySelectorAll("button")]
      .find((k) => k.textContent === "Больше не спрашивать");
    const sentBefore = window.sentMessages.length;
    noQuestions.click();
    result.noQuestions = window.sentMessages.slice(sentBefore);
  `,
    { withUi: true },
  );
  assert.deepEqual(r.buttons, ["Разрешить", "В этой сессии", "Больше не спрашивать", "Отклонить"]);
  assert.equal(r.stage, "Ждёт разрешения");
  assert.deepEqual(r.sent, [{ type: "approval", id: "perm-1", choice: "allowSession" }]);
  assert.equal(r.disabled, true, "повторное нажатие отправило бы второй ответ");
  assert.equal(r.buttonsAfter, 0);
  assert.match(r.labelText, /разрешено в этой сессии/);
  assert.equal(r.buttonsFromJournal, 0, "на запрос прошлого запуска ответить нельзя");
  // Свой запрос карточка разрешает сама: запрос, требующий человека, режим
  // не разрешает, и без этого карточка застыла бы с неактивными кнопками.
  assert.deepEqual(r.noQuestions, [
    { type: "approval", id: "perm-2", choice: "allow" },
    { type: "setPermissionMode", mode: "bypassPermissions" },
  ]);
});

test("карточка вопроса Claude: варианты, свой ответ, «Ответить» шлёт answers, ширина 360 без переполнения", { skip: NO_BROWSER }, () => {
  const r = open(
    js`
    const longText = "длинное пояснение варианта ".repeat(12) + "x".repeat(300);
    const ask = (callId, extra = {}) => ({
      id: callId, agent: "claude", kind: "approval_requested", visibility: "turn", at: Date.now(),
      tool: "AskUserQuestion", callId, toolCallId: "toolu_q", text: "Выбор: Какой вариант? (а / б)", sessionRules: [],
      questions: [
        { question: "Какой вариант?", header: "Выбор", options: [{ label: "а", description: longText }, { label: "б" }], multiSelect: false },
        { question: "Что проверить? " + longText, options: [{ label: "тесты" }, { label: "сборку" }, { label: longText }], multiSelect: true },
      ],
      ...extra,
    });
    const answerButton = (card) => [...card.querySelectorAll("button")].find((k) => k.textContent === "Ответить");
    const sentAnswers = () => window.sentMessages.filter((m) => m.type === "answerQuestion");

    postToPage({ type: "event", event: ask("ask-1") });
    postToPage({ type: "state", state: { stage: "working", round: 0, maxRounds: 3, approvals: 0, questions: 1, queued: 0, auto: true } });
    const card = document.querySelector(".разрешение.вопрос");
    result.stage = getById("этап").textContent;
    result.header = card.querySelector(".заголовок").textContent;
    result.buttons = [...card.querySelectorAll(".кнопки button")].map((k) => k.textContent);
    result.legends = [...card.querySelectorAll("legend")].map((k) => k.textContent);
    result.radios = [...card.querySelectorAll("input[type=radio]")].map((k) => k.value);
    result.boxes = card.querySelectorAll("input[type=checkbox]").length;
    result.ownFields = card.querySelectorAll(".свой-ответ").length;
    result.emptyDisabled = answerButton(card).disabled;

    result.client = document.documentElement.clientWidth;
    result.scroll = document.documentElement.scrollWidth;
    const overflowed = [...card.querySelectorAll("*")]
      .filter((el) => el.getClientRects().length && el.getBoundingClientRect().right > result.client + 0.5);
    result.overflowed = overflowed.slice(0, 5).map((el) => el.tagName.toLowerCase() + "." + String(el.className).split(" ").join("."));

    card.querySelectorAll("input[type=radio]")[1].click();
    result.halfDisabled = answerButton(card).disabled;
    const boxes = card.querySelectorAll("input[type=checkbox]");
    boxes[0].click();
    boxes[1].click();
    result.fullDisabled = answerButton(card).disabled;
    answerButton(card).click();
    result.sent = sentAnswers();
    result.locked = [...card.querySelectorAll("button, input")].every((k) => k.disabled);

    postToPage({ type: "event", event: {
      id: "d1", agent: "claude", kind: "approval_decided", visibility: "turn", at: Date.now(),
      callId: "ask-1", toolCallId: "toolu_q", text: "ответ человека: Какой вариант? — б",
    } });
    result.buttonsAfter = card.querySelectorAll("button").length;
    result.closedClass = card.className;
    result.labelText = card.querySelector(".итог").textContent;

    // Свой текст важнее выбранного варианта.
    postToPage({ type: "event", event: ask("ask-2", { questions: [{ question: "Какой вариант?", options: [{ label: "а" }, { label: "б" }] }] }) });
    let cards = document.querySelectorAll(".разрешение.вопрос");
    const second = cards[cards.length - 1];
    second.querySelector("input[type=radio]").click();
    const own = second.querySelector(".свой-ответ");
    own.value = "  свой вариант  ";
    own.dispatchEvent(new Event("input", { bubbles: true }));
    answerButton(second).click();
    result.sentOwn = sentAnswers().slice(1);

    // «Не отвечать» — отказ, а не «разрешить».
    postToPage({ type: "event", event: ask("ask-3") });
    cards = document.querySelectorAll(".разрешение.вопрос");
    [...cards[cards.length - 1].querySelectorAll("button")].find((k) => k.textContent === "Не отвечать").click();
    result.declined = window.sentMessages.filter((m) => m.type === "approval");

    // Из журнала вопросы не восстанавливаются: текст карточки, без кнопок и полей.
    postToPage({ type: "event", history: true, event: ask("old-1", { questions: undefined }) });
    cards = document.querySelectorAll(".разрешение.вопрос");
    const old = cards[cards.length - 1];
    result.journalControls = old.querySelectorAll("button, input").length;
    result.journalText = old.textContent;
  `,
    { withUi: true, width: 360 },
  );
  assert.equal(r.stage, "Ждёт ответа на вопрос");
  assert.match(r.header, /Claude спрашивает/);
  assert.deepEqual(r.buttons, ["Ответить", "Не отвечать"]);
  assert.equal(r.legends.length, 2);
  assert.match(r.legends[0], /Выбор/);
  assert.match(r.legends[0], /Какой вариант\?/);
  assert.deepEqual(r.radios, ["а", "б"]);
  assert.equal(r.boxes, 3, "несколько вариантов — флажками");
  assert.equal(r.ownFields, 2, "у каждого вопроса поле «Свой ответ»");
  assert.ok(r.client > 0 && r.client <= 360, `ширина окна не измерена: ${r.client}`);
  assert.ok(r.scroll <= r.client, `документ шире окна: ${r.scroll} > ${r.client}; за краем: ${r.overflowed.join(", ")}`);
  assert.deepEqual(r.overflowed, []);
  assert.equal(r.emptyDisabled, true, "без ответа отправлять нечего");
  assert.equal(r.halfDisabled, true, "ответ нужен на каждый вопрос");
  assert.equal(r.fullDisabled, false);
  const longQuestion = r.sent[0]?.answers && Object.keys(r.sent[0].answers)[1];
  assert.deepEqual(r.sent, [{ type: "answerQuestion", id: "ask-1", answers: { "Какой вариант?": "б", [longQuestion]: "тесты, сборку" } }]);
  assert.match(longQuestion, /^Что проверить\? /);
  assert.equal(r.locked, true, "повторное нажатие отправило бы второй ответ");
  assert.equal(r.buttonsAfter, 0);
  assert.match(r.closedClass, /решено/);
  assert.match(r.labelText, /ответ человека: Какой вариант\? — б/);
  assert.deepEqual(r.sentOwn, [{ type: "answerQuestion", id: "ask-2", answers: { "Какой вариант?": "свой вариант" } }]);
  assert.deepEqual(r.declined, [{ type: "approval", id: "ask-3", choice: "deny" }]);
  assert.equal(r.journalControls, 0, "на вопрос прошлого запуска ответить нельзя");
  assert.match(r.journalText, /Какой вариант\?/);
  assert.match(r.journalText, /прошлого запуска/);
});

test("вердикт рецензента: значок и слова, исходная строка видна, текст выше — разметкой", { skip: NO_BROWSER }, () => {
  const r = open(
    js`
    const newline = String.fromCharCode(10);
    const replyEvent = (agent, text) => ({ id: agent + text.length, agent, kind: "message", visibility: "turn", at: Date.now(), text });
    postToPage({ type: "event", event: replyEvent("codex", ["**Два** замечания.", "", "ВЕРДИКТ: ЕСТЬ ЗАМЕЧАНИЯ"].join(newline)) });
    postToPage({ type: "event", event: replyEvent("claude", ["Итог.", "ВЕРДИКТ: ПРИНЯТО"].join(newline)) });
    const codex = document.querySelector(".пузырь.codex");
    result.word = codex.querySelector(".вердикт-строка .слово")?.textContent;
    result.originalLine = codex.querySelector(".вердикт-строка .исходная")?.textContent;
    result.className = codex.querySelector(".вердикт-строка")?.className;
    result.textWithoutLine = !codex.querySelector(".текст").textContent.includes("ВЕРДИКТ");
    result.bold = !!codex.querySelector(".текст strong");
    result.onClaude = !!document.querySelector(".пузырь.claude .вердикт-строка");
  `,
    { withUi: true },
  );
  assert.equal(r.word, "Есть замечания");
  assert.equal(r.originalLine, "ВЕРДИКТ: ЕСТЬ ЗАМЕЧАНИЯ");
  assert.match(r.className, /remarks/);
  assert.equal(r.textWithoutLine, true);
  assert.equal(r.bold, true);
  assert.equal(r.onClaude, false, "вердикт выносит только рецензент");
});

test("действия хода: бусина на вызов, форма по виду, счётчики и отказ", { skip: NO_BROWSER }, () => {
  const r = open(
    js`
    const s = (kind, extra) => ({ id: kind + Math.random(), agent: "claude", kind, visibility: "turn", at: Date.now(), ...extra });
    postToPage({ type: "event", event: s("tool_call", { tool: "Read", callId: "r1", text: "docs/a.md" }) });
    postToPage({ type: "event", event: s("tool_result", { tool: "Read", callId: "r1", text: "ok" }) });
    postToPage({ type: "event", event: s("tool_call", { tool: "Bash", callId: "b1", text: "python -m pytest -q" }) });
    postToPage({ type: "event", event: s("tool_running", { tool: "Bash", callId: "b1" }) });
    result.inProgress = document.querySelector(".действия .идёт-сейчас").textContent;
    postToPage({ type: "event", event: s("tool_result", { tool: "Bash", callId: "b1", text: "5 passed" }) });
    postToPage({ type: "event", event: s("tool_call", { tool: "Bash", callId: "b2", text: "git push" }) });
    postToPage({ type: "event", event: s("approval_decided", { callId: "b2", text: "отказано: git push" }) });
    postToPage({ type: "event", event: s("tool_call", { tool: "Edit", callId: "e1", text: "src/x.ts" }) });
    result.beadClasses = [...document.querySelectorAll(".действия .чётки .бусина")].map((b) => b.className);
    result.counters = [...document.querySelectorAll(".действия .счётчик")].map((s) => s.title + " " + s.textContent);
    result.inProgressAfter = document.querySelector(".действия .идёт-сейчас").hidden;
    result.lineCount = document.querySelectorAll(".действия .вызов").length;
    result.deniedRow = document.querySelector(".действия .вызов.отказ .метка")?.textContent;
  `,
    { withUi: true },
  );
  assert.equal(r.inProgress, "выполняется: python -m pytest -q");
  assert.deepEqual(r.beadClasses, ["бусина ring done", "бусина square done", "бусина square denied", "бусина diamond formed"]);
  assert.deepEqual(r.counters, ["Команды 2", "Чтения и поиск 1", "Правки 1", "Отказано 1"]);
  assert.equal(r.inProgressAfter, true);
  assert.equal(r.lineCount, 4);
  assert.equal(r.deniedRow, "отказано");
});

test("эстафета и дорожка цикла: кто работает, счёт проверок, след по клику", { skip: NO_BROWSER }, () => {
  const r = open(
    js`
    const state = (extra) => ({ stage: "idle", round: 0, maxRounds: 3, approvals: 0, queued: 0, auto: true,
      claudeBusy: false, codexBusy: false, trail: [], ...extra });
    postToPage({ type: "state", state: state({ stage: "reviewing", round: 2, verdict: "remarks", task: "Спецификация",
      trail: [{ who: "task" }, { who: "claude" }, { who: "codex", mark: "!" }, { who: "claude" }, { who: "codex" }] }) });
    result.active = getById("нить-статус").dataset.active;
    result.flow = getById("нить-статус").dataset.flow;
    result.stage = getById("этап").textContent;
    result.hint = getById("этап-пояснение").textContent;
    result.dots = [...getById("раунд").children].map((t) => t.className);
    result.trackBefore = getById("дорожка").hidden;
    getById("эстафета").click();
    result.trackAfter = getById("дорожка").hidden;
    result.steps = [...getById("дорожка").querySelectorAll(".шаг-узел")].map((u) => u.getAttribute("class"));
    result.marks = [...getById("дорожка").querySelectorAll(".шаг-отметка")].map((o) => o.textContent);
    postToPage({ type: "state", state: state({ stage: "held", verdict: "human",
      held: { to: "claude", reason: "Рецензент просит решения", action: "send" } }) });
    result.human = getById("нить-статус").dataset.active;
    result.banner = !getById("удержано").hidden;
    result.button = getById("отпустить").textContent;
  `,
    { withUi: true },
  );
  assert.equal(r.active, "codex");
  assert.equal(r.flow, "to-codex");
  assert.equal(r.stage, "Codex проверяет");
  assert.equal(r.hint, "есть замечания");
  assert.deepEqual(r.dots, ["пройдена", "пройдена", ""]);
  assert.equal(r.trackBefore, true, "дорожка раскрывается по клику");
  assert.equal(r.trackAfter, false);
  assert.deepEqual(r.steps, [
    "шаг-узел task", "шаг-узел claude", "шаг-узел codex", "шаг-узел claude", "шаг-узел codex текущий",
    "шаг-узел claude пустой", "шаг-узел codex пустой",
  ]);
  assert.deepEqual(r.marks, ["!"]);
  assert.equal(r.human, "human");
  assert.equal(r.banner, true);
  assert.equal(r.button, "Отправить Claude");
});

test("эстафета пары: вилка, горит Gemini, отметка Codex; дорожка — ромб с «не проверял»", { skip: NO_BROWSER }, () => {
  const r = open(
    js`
    const base = { round: 2, maxRounds: 3, approvals: 0, queued: 0, auto: true, claudeBusy: false, codexBusy: false,
      geminiBusy: false, reviewers: ["codex", "gemini"] };
    postToPage({ type: "state", state: { ...base, stage: "reviewing", verdict: "remarks",
      pair: { round: 2, sides: { codex: { state: "done", verdict: "accepted" }, gemini: { state: "waiting" } } },
      trail: [{ who: "task" }, { who: "claude" }, { who: "codex", round: 1, mark: "!" }, { who: "gemini", round: 1, unchecked: "не успел" },
        { who: "claude" }, { who: "codex", round: 2, mark: "✓" }, { who: "gemini", round: 2 }] } });
    const relay = getById("нить-статус");
    result.active = relay.dataset.active;
    result.flow = relay.dataset.flow;
    result.pairMode = relay.dataset.pair;
    result.geminiLit = relay.querySelector(".ст-огонёк.gemini").classList.contains("горит");
    result.codexLit = relay.querySelector(".ст-огонёк.codex").classList.contains("горит");
    result.codexMark = getById("ст-отметка-codex").hidden ? "" : getById("ст-отметка-codex").textContent;
    result.stage = getById("этап").textContent;
    result.hint = getById("этап-пояснение").textContent;
    getById("эстафета").click();
    const nodes = [...getById("дорожка").querySelectorAll(".шаг-узел")];
    result.classes = nodes.map((u) => u.getAttribute("class"));
    result.unchecked = nodes.find((u) => u.classList.contains("не-проверял"))?.querySelector("title")?.textContent;
    const topNode = nodes.find((u) => u.getAttribute("class") === "шаг-узел codex");
    const bottom = nodes.find((u) => u.getAttribute("class").startsWith("шаг-узел gemini не-проверял"));
    result.sameColumn = topNode.getAttribute("cx") === bottom.getAttribute("cx");
  `,
    { withUi: true },
  );
  assert.equal(r.active, "gemini");
  assert.equal(r.flow, "to-gemini");
  assert.equal(r.pairMode, "yes");
  assert.equal(r.geminiLit, true);
  assert.equal(r.codexLit, false);
  assert.equal(r.codexMark, "✓");
  assert.equal(r.stage, "Gemini проверяет");
  assert.equal(r.hint, "Codex: принято");
  assert.ok(r.classes.includes("шаг-узел gemini текущий"), r.classes.join("; "));
  assert.ok(r.classes.includes("шаг-узел gemini пустой"));
  assert.equal(r.unchecked, "Gemini не проверял: не успел");
  assert.equal(r.sameColumn, true, "Codex и Gemini одной проверки — в одном столбце");
});

test("расход и квота Gemini видны в дорожке цикла", { skip: NO_BROWSER }, () => {
  const r = open(
    js`
    postToPage({ type: "state", state: { stage: "idle", round: 0, maxRounds: 3, approvals: 0, queued: 0, auto: true, trail: [],
      reviewers: ["codex", "gemini"],
      usage: { task: { claude: { input: 0, cached: 0, output: 0 }, codex: { input: 0, cached: 0, output: 0 }, gemini: { input: 95000, cached: 0, output: 1200 } },
               limits: { geminiWeek: { percent: 3, session: 11 } } } } });
    getById("эстафета").click();
    result.usage = getById("расход").textContent;
  `,
    { withUi: true },
  );
  assert.match(r.usage, /Gemini 96,2 тыс\./);
  assert.match(r.usage, /Gemini: неделя 3%, окно 5 ч 11%/);
});

test("светлая тема: у Gemini свой цвет, различимый на белом", { skip: NO_BROWSER }, () => {
  const dark = open(js`result.gemini = getComputedStyle(document.body).getPropertyValue("--gemini").trim();`, { withUi: true });
  const light = open(js`result.gemini = getComputedStyle(document.body).getPropertyValue("--gemini").trim();`, { withUi: true, theme: "vscode-light" });
  assert.equal(dark.gemini, "#A78BFA");
  assert.equal(light.gemini, "#7652D6");
});

test("режим отправки: переключатель, меню по названию, выбор уходит с сообщением", { skip: NO_BROWSER }, () => {
  const r = open(
    js`
    result.buttonCount = getById("режимы").querySelectorAll("[role=radio]").length;
    result.title = getById("маршрут-название").textContent;
    getById("режимы").querySelector("[data-route=all]").click();
    result.afterToggle = getById("маршрут-название").textContent;
    getById("маршрут").click();
    result.menuOpen = !getById("маршрут-меню").hidden;
    getById("маршрут-меню").querySelector("[data-route=codex]").click();
    result.menuClosed = getById("маршрут-меню").hidden;
    result.checked = getById("режимы").querySelector("[aria-checked=true]").dataset.route;
    getById("ввод").value = "вопрос";
    getById("отправить").click();
    result.sent = window.sentMessages.filter((m) => m.type === "send");
  `,
    { withUi: true },
  );
  assert.equal(r.buttonCount, 4);
  assert.equal(r.title, "Задача с рецензией");
  assert.equal(r.afterToggle, "Спросить всех");
  assert.equal(r.menuOpen, true);
  assert.equal(r.menuClosed, true);
  assert.equal(r.checked, "codex");
  assert.deepEqual(r.sent, [{ type: "send", text: "вопрос", route: "codex" }]);
});

test("светлая тема: у агентов свои цвета, различимые на белом", { skip: NO_BROWSER }, () => {
  const r = open(
    js`
    const style = getComputedStyle(document.body);
    result.claude = style.getPropertyValue("--claude").trim();
    result.codex = style.getPropertyValue("--codex").trim();
  `,
    { withUi: true, theme: "vscode-light" },
  );
  assert.equal(r.claude, "#B8702F");
  assert.equal(r.codex, "#1E8C96");
});

test("отказ человека в карточке окрашивает бусину вызова по tool_use_id", { skip: NO_BROWSER }, () => {
  const r = open(
    js`
    const s = (kind, extra) => ({ id: kind + Math.random(), agent: "claude", kind, visibility: "turn", at: Date.now(), ...extra });
    postToPage({ type: "event", event: s("tool_call", { tool: "Bash", callId: "toolu_1", text: "git push" }) });
    postToPage({ type: "event", event: s("approval_requested", { tool: "Bash", callId: "perm-1", toolCallId: "toolu_1", text: "git push" }) });
    postToPage({ type: "event", event: s("approval_decided", { callId: "perm-1", toolCallId: "toolu_1", text: "отклонено человеком" }) });
    postToPage({ type: "event", event: s("tool_result", { tool: "Bash", callId: "toolu_1", text: "Отклонено человеком в панели." }) });
    result.beadClasses = [...document.querySelectorAll(".действия .чётки .бусина")].map((b) => b.className);
    result.counters = [...document.querySelectorAll(".действия .счётчик")].map((s) => s.title + " " + s.textContent);
    result.card = document.querySelector(".разрешение").className;
  `,
    { withUi: true },
  );
  assert.deepEqual(r.beadClasses, ["бусина square denied"]);
  assert.deepEqual(r.counters, ["Команды 1", "Отказано 1"]);
  assert.match(r.card, /отклонено/);
});

test("режим: после выбора фокус остаётся на переключателе или возвращается на название", { skip: NO_BROWSER }, () => {
  const r = open(
    js`
    getById("режимы").querySelector("[data-route=all]").focus();
    getById("режимы").querySelector("[data-route=all]").click();
    result.afterToggle = document.activeElement?.dataset?.route;
    getById("маршрут").click();
    getById("маршрут-меню").querySelector("[data-route=codex]").focus();
    getById("маршрут-меню").querySelector("[data-route=codex]").click();
    result.afterMenu = document.activeElement?.id;
    getById("маршрут").click();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    result.afterEscape = document.activeElement?.id;
    result.menuClosed = getById("маршрут-меню").hidden;
  `,
    { withUi: true },
  );
  assert.equal(r.afterToggle, "all");
  assert.equal(r.afterMenu, "маршрут");
  assert.equal(r.afterEscape, "маршрут");
  assert.equal(r.menuClosed, true);
});

test("уровень рассуждения можно вернуть к умолчанию агента", { skip: NO_BROWSER }, () => {
  // Рецензия Codex 28.09: у Claude умолчание неизвестно, и после выбора узла
  // вернуть «по умолчанию» было нечем — прежний список это позволял.
  const r = open(
    js`
    getById("модели-кнопка").click();
    postToPage({ type: "models", agent: "claude", choice: { model: "", effort: "" }, options: [
      { id: "", label: "по умолчанию", description: "", efforts: ["low", "high", "max"] },
    ] });
    const resetButton = getById("нить-сброс-claude");
    result.resetBefore = resetButton.hidden;
    getById("нить-claude").querySelectorAll(".нить-узел")[1].click();
    result.resetAfter = resetButton.hidden;
    resetButton.click();
    result.selected = [...getById("нить-claude").querySelectorAll(".нить-узел")].some((u) => u.getAttribute("aria-checked") === "true");
    result.resetAtEnd = resetButton.hidden;
    result.choices = window.sentMessages.filter((m) => m.type === "setModel").map((m) => m.effort);
  `,
    { withUi: true },
  );
  assert.equal(r.resetBefore, true, "при умолчании сбрасывать нечего");
  assert.equal(r.resetAfter, false);
  assert.equal(r.selected, false);
  assert.equal(r.resetAtEnd, true);
  assert.deepEqual(r.choices, ["high", ""]);
});

test("действия субагента отмечены в чётках и в списке", { skip: NO_BROWSER }, () => {
  const r = open(
    js`
    const s = (kind, extra) => ({ id: kind + Math.random(), agent: "claude", kind, visibility: "turn", at: Date.now(), ...extra });
    postToPage({ type: "event", event: s("tool_call", { tool: "Agent", callId: "toolu_agent", text: "{}" }) });
    postToPage({ type: "event", event: s("tool_call", { tool: "Read", callId: "toolu_sub", parentCallId: "toolu_agent", text: "a.txt" }) });
    postToPage({ type: "event", event: s("tool_result", { tool: "Read", callId: "toolu_sub", parentCallId: "toolu_agent", text: "alpha" }) });
    result.beadClasses = [...document.querySelectorAll(".действия .чётки .бусина")].map((b) => b.classList.contains("субагент"));
    result.labels = [...document.querySelectorAll(".действия .вызов .кто")].map((m) => m.textContent);
  `,
    { withUi: true },
  );
  assert.deepEqual(r.beadClasses, [false, true]);
  assert.deepEqual(r.labels, ["субагент"]);
});

test("реплика самостоятельного хода Claude помечена «сам», следующая — нет", { skip: NO_BROWSER }, () => {
  // Снимок сцены 28.09 и рецензия Codex: реплика хода, который Claude начал
  // сам после фоновой команды, выглядела как работа по задаче.
  const r = open(
    js`
    const s = (kind, extra) => ({ id: kind + Math.random(), agent: "claude", kind, visibility: "turn", at: Date.now(), ...extra });
    postToPage({ type: "event", event: s("turn_started", { unsolicited: true, text: "фоновая задача закончилась: pytest" }) });
    postToPage({ type: "event", event: s("text_delta", { text: "Тесты" }) });
    postToPage({ type: "event", event: s("message", { text: "Тесты прошли." }) });
    postToPage({ type: "event", event: s("turn_completed", { unsolicited: true }) });
    postToPage({ type: "event", event: s("message", { text: "Ответ по задаче." }) });
    result.bubbles = [...document.querySelectorAll(".пузырь.claude")].map((p) => [p.classList.contains("сам"), p.querySelector(".автор .имя").textContent]);
  `,
    { withUi: true },
  );
  assert.deepEqual(r.bubbles, [[true, "Claude · сам"], [false, "Claude"]]);
});

test("действие человека — строка ленты «Вы: …», материал рецензенту лента не рисует", { skip: NO_BROWSER }, () => {
  // Журнал хранит, что сделал человек (отправил удержанное, выключил
  // автопересылку), и материал проверки целиком. Первое лента показывает
  // служебной строкой, второе — только журнал.
  const r = open(
    js`
    const s = (agent, kind, extra) => ({ id: kind + Math.random(), agent, kind, visibility: "turn", at: Date.now(), ...extra });
    const before = getById("беседа").childElementCount;
    postToPage({ type: "event", event: s("human", "action", { text: "Автопересылка выключена" }) });
    postToPage({ type: "event", event: s("codex", "material", { visibility: "stream", text: "Материал разработчика: порог 0.4" }) });
    postToPage({ type: "event", event: s("human", "action", { text: "Отправлено Claude вручную: Автопересылка выключена" }), history: true });
    result.added = getById("беседа").childElementCount - before;
    result.notices = [...getById("беседа").querySelectorAll(".уведомление")].map((n) => n.textContent);
    result.bubbles = getById("беседа").querySelectorAll(".пузырь").length;
  `,
    { withUi: true },
  );
  assert.deepEqual(r.notices, ["Вы: Автопересылка выключена", "Вы: Отправлено Claude вручную: Автопересылка выключена"]);
  assert.equal(r.added, 2, "материал ничего не добавляет в ленту");
  assert.equal(r.bubbles, 0, "действие — не реплика человека");
});

test("реплика субагента — отдельный приглушённый блок, пузырь Claude не трогает", { skip: NO_BROWSER }, () => {
  // Живая трасса 28.09: текст фонового субагента приходит в поток и без
  // --forward-subagent-text, с parent_tool_use_id.
  const r = open(
    js`
    const s = (kind, extra) => ({ id: kind + Math.random(), agent: "claude", kind, visibility: "turn", at: Date.now(), ...extra });
    postToPage({ type: "event", event: s("text_delta", { text: "Claude пишет" }) });
    postToPage({ type: "event", event: s("message", { text: "Прочитал файл.", parentCallId: "toolu_agent" }) });
    postToPage({ type: "event", event: s("message", { text: "Claude пишет итог" }) });
    result.subagent = [...document.querySelectorAll(".пузырь.субагент")].map((p) => p.querySelector(".автор .имя").textContent + ": " + p.querySelector(".текст").textContent.trim());
    result.claude = [...document.querySelectorAll(".пузырь.claude:not(.субагент)")].map((p) => p.querySelector(".текст").textContent.trim());
  `,
    { withUi: true },
  );
  assert.deepEqual(r.subagent, ["Субагент: Прочитал файл."]);
  assert.deepEqual(r.claude, ["Claude пишет итог"]);
});

test("расход задачи и недельный лимит Codex видны в дорожке цикла", { skip: NO_BROWSER }, () => {
  const r = open(
    js`
    postToPage({ type: "state", state: { stage: "working", round: 0, maxRounds: 3, approvals: 0, queued: 0, auto: true,
      trail: [{ who: "task" }, { who: "claude" }],
      usage: { task: { claude: { input: 1250000, cached: 1100000, output: 12000 }, codex: { input: 17522, cached: 7936, output: 5 } },
               limits: { codex: { percent: 8, window: "week" }, claude: { status: "allowed", window: "five_hour" } } } } });
    getById("эстафета").click();
    result.usage = getById("расход").textContent;
  `,
    { withUi: true },
  );
  assert.match(r.usage, /Claude 1,26 млн/);
  assert.match(r.usage, /из кеша 1,1 млн/);
  assert.match(r.usage, /Codex 17,5 тыс\./);
  assert.match(r.usage, /неделя 8%/);
});

test("недельная доля Claude и окно сессии видны рядом с лимитом Codex", { skip: NO_BROWSER }, () => {
  const r = open(
    js`
    postToPage({ type: "state", state: { stage: "idle", round: 0, maxRounds: 3, approvals: 0, queued: 0, auto: true,
      trail: [],
      usage: { task: {},
               limits: { codex: { percent: 8, window: "week" },
                         claude: { status: "allowed_warning", window: "five_hour" },
                         claudeWeek: { percent: 4, session: 28 } } } } });
    getById("эстафета").click();
    result.usage = getById("расход").textContent;
  `,
    { withUi: true },
  );
  assert.match(r.usage, /Claude: неделя 4%, окно 5 ч 28%, близко к пределу/);
  assert.doesNotMatch(r.usage, /на \d/);
  assert.match(r.usage, /Codex: неделя 8%/);
});

test("устаревшая недельная доля Claude показана со временем сведения", { skip: NO_BROWSER }, () => {
  const r = open(
    js`
    const at = new Date(2026, 8, 20, 5, 14).getTime();
    postToPage({ type: "state", state: { stage: "idle", round: 0, maxRounds: 3, approvals: 0, queued: 0, auto: true,
      trail: [], usage: { task: {}, limits: { claudeWeek: { percent: 4, at, stale: true } } } } });
    getById("эстафета").click();
    result.usage = getById("расход").textContent;
  `,
    { withUi: true },
  );
  assert.match(r.usage, /Claude: неделя 4% \(на 20\.09 05:14\)/);
});

test("«Ультра»: ветки и пульс узла не выходят за строку агента", { skip: NO_BROWSER }, () => {
  const r = open(
    js`
    getById("модели-кнопка").click();
    postToPage({ type: "models", agent: "codex", choice: { model: "", effort: "ultra" }, options: [
      { id: "", label: "по умолчанию", description: "", efforts: ["low", "high", "ultra"] },
    ] });
    const row = getById("строка-codex").getBoundingClientRect();
    const dots = [...getById("нить-codex").querySelectorAll(".нить-субагент")].map((d) => d.getBoundingClientRect());
    result.inside = dots.every((d) => d.top >= row.top - 0.5 && d.bottom <= row.bottom + 0.5);
    result.dotCount = dots.length;
  `,
    { withUi: true },
  );
  assert.equal(r.dotCount, 3, "«Ультра» — три ветки, три бусины субагента");
  assert.equal(r.inside, true, "бусины веток не выходят за строку агента");
});

test("ссылка «новая сессия…» просит расширение спросить, для какого агента", { skip: NO_BROWSER }, () => {
  const r = open(
    js`
    getById("модели-кнопка").click();
    getById("новая-сессия").click();
    result.requests = window.sentMessages.filter((m) => m.type === "newSession");
  `,
    { withUi: true },
  );
  assert.deepEqual(r.requests, [{ type: "newSession" }]);
});

test("«Модели» с Gemini: три строки в одной карточке, ниже нынешней карточки одного агента", { skip: NO_BROWSER }, () => {
  const r = open(
    js`
    postToPage({ type: "gemini", present: true, rules: { ok: true } });
    getById("модели-кнопка").click();
    postToPage({ type: "models", agent: "gemini", choice: { model: "gemini-3.1-pro", effort: "" }, options: [
      { id: "", label: "по умолчанию (модель из настроек agy)", description: "", efforts: [] },
      { id: "gemini-3.1-pro", label: "Gemini 3.1 Pro", description: "", efforts: ["low", "high"], defaultEffort: "high" },
    ] });
    result.rows = [...document.querySelectorAll(".модели-строка")].filter((s) => !s.hidden).map((s) => s.dataset.agent);
    result.height = Math.round(document.querySelector(".модели-карточка").getBoundingClientRect().height);
    const nodes = [...getById("нить-gemini").querySelectorAll(".нить-узел")];
    result.levels = nodes.map((u) => u.getAttribute("aria-label"));
    result.selected = nodes.map((u) => u.getAttribute("aria-checked"));
    nodes[0].click();
    result.choice = window.sentMessages.filter((m) => m.type === "setModel").at(-1);
    result.stripes = document.querySelectorAll("#модели-кнопка .полоски span").length;
    result.text = document.querySelector(".модели-карточка").textContent;
  `,
    { withUi: true },
  );
  assert.deepEqual(r.rows, ["claude", "codex", "gemini"]);
  assert.ok(r.height <= 145, `карточка выше 145 px: ${r.height}`);
  assert.deepEqual(r.levels, ["Низкое", "Высокое"]);
  assert.deepEqual(r.selected, ["false", "true"], "умолчание семейства — «Высокое»");
  assert.deepEqual(r.choice, { type: "setModel", agent: "gemini", model: "gemini-3.1-pro", effort: "low" });
  assert.equal(r.stripes, 3);
  assert.doesNotMatch(r.text, /у Pro|у Flash|уровня/, "пояснений о числе уровней нет");
});

test("с Gemini пять режимов, без него — четыре; «Задача с рецензией» называет обоих рецензентов", { skip: NO_BROWSER }, () => {
  const r = open(
    js`
    result.without = [...getById("режимы").querySelectorAll("[role=radio]")].map((k) => k.dataset.route);
    postToPage({ type: "gemini", present: true, rules: { ok: true } });
    result.with = [...getById("режимы").querySelectorAll("[role=radio]")].map((k) => k.dataset.route);
    result.hint = getById("маршрут").title;
    getById("режимы").querySelector("[data-route=gemini]").click();
    getById("ввод").value = "вопрос";
    getById("отправить").click();
    result.sent = window.sentMessages.filter((m) => m.type === "send");
    postToPage({ type: "gemini", present: false, rules: { ok: true } });
    result.fallback = getById("маршрут-название").textContent;
  `,
    { withUi: true },
  );
  assert.deepEqual(r.without, ["review", "all", "claude", "codex"]);
  assert.deepEqual(r.with, ["review", "all", "claude", "codex", "gemini"]);
  assert.match(r.hint, /Codex и Gemini проверят/);
  assert.deepEqual(r.sent, [{ type: "send", text: "вопрос", route: "gemini" }]);
  assert.equal(r.fallback, "Задача с рецензией", "без agy режим «Только Gemini» уходит");
});

test("реплика Gemini — разметкой, вердикт значком; действия — бусины его цвета", { skip: NO_BROWSER }, () => {
  const r = open(
    js`
    const e = (kind, extra) => ({ id: kind + Math.random(), agent: "gemini", kind, visibility: "turn", at: Date.now(), ...extra });
    postToPage({ type: "event", event: e("tool_call", { tool: "view_file", callId: "g:1", text: "{}" }) });
    postToPage({ type: "event", event: e("tool_result", { tool: "view_file", callId: "g:1", text: "2 lines, 21 bytes" }) });
    postToPage({ type: "event", event: e("message", { text: "**Пробел**: нет F1 на test.\\nВЕРДИКТ: ЕСТЬ ЗАМЕЧАНИЯ" }) });
    result.name = document.querySelector(".пузырь.gemini .автор .имя").textContent;
    result.bold = !!document.querySelector(".пузырь.gemini .текст strong");
    result.verdict = document.querySelector(".пузырь.gemini .вердикт-строка")?.className;
    result.bead = document.querySelector(".действия.gemini .чётки .бусина")?.className;
  `,
    { withUi: true },
  );
  assert.equal(r.name, "Gemini");
  assert.equal(r.bold, true);
  assert.equal(r.verdict, "вердикт-строка remarks");
  assert.match(r.bead, /ring/);
});

test("ошибка agy после ответа — уведомлением в ленте, и после перезапуска; обычный конец хода — без уведомления", { skip: NO_BROWSER }, () => {
  // Рецензия 04.10, F1: ход Gemini с ответом и status ERROR не провален, и
  // лента, показывающая текст конца хода только у провала, ошибку теряла —
  // она оставалась в «Диагностике» и журнале.
  const r = open(
    js`
    const e = (kind, extra) => ({ id: kind + Math.random(), agent: "gemini", kind, visibility: "turn", at: Date.now(), ...extra });
    const late = "agy сообщил об ошибке после ответа: ERROR — API error (attempt 2): EOF";
    postToPage({ type: "event", event: e("message", { text: "Принято.\\nВЕРДИКТ: ПРИНЯТО" }) });
    postToPage({ type: "event", event: e("turn_completed", { text: "ход завершён, ходов в разговоре 6; " + late, lateError: late }) });
    postToPage({ type: "event", event: e("turn_completed", { text: "ход завершён, ходов в разговоре 7" }) });
    postToPage({ type: "event", history: true, event: e("turn_completed", { text: "ход завершён, ходов в разговоре 5; " + late, lateError: late }) });
    postToPage({ type: "event", event: e("turn_completed", { text: "ход завершён: ERROR — нет ответа", failed: true }) });
    result.notices = [...document.querySelectorAll(".уведомление")].map((n) => [n.className, n.textContent]);
  `,
    { withUi: true },
  );
  const late = "Gemini: agy сообщил об ошибке после ответа: ERROR — API error (attempt 2): EOF";
  assert.deepEqual(r.notices, [
    ["уведомление внимание", late],
    ["уведомление внимание", late],
    ["уведомление ошибка", "Gemini: ход завершён: ERROR — нет ответа"],
  ]);
});

test("плашка правил: причина и кнопка «Добавить правила»; удержанная пара — «Отправить на проверку»", { skip: NO_BROWSER }, () => {
  const r = open(
    js`
    postToPage({ type: "gemini", present: true, rules: { ok: false, reason: "нет режима «только чтение» в настройках agy: нет запрета записи: deny write_file(*)" } });
    result.plate = !getById("правила-gemini").hidden;
    result.reason = getById("правила-gemini-причина").textContent;
    getById("добавить-правила").click();
    result.asked = window.sentMessages.filter((m) => m.type === "addGeminiRules").length;
    postToPage({ type: "gemini", present: true, rules: { ok: true } });
    result.plateAfter = !getById("правила-gemini").hidden;
    postToPage({ type: "state", state: { stage: "held", round: 3, maxRounds: 3, approvals: 0, queued: 0, auto: true, trail: [],
      reviewers: ["codex", "gemini"], held: { to: "codex", action: "review", reason: "Предел проверок" } } });
    result.button = getById("отпустить").textContent;
  `,
    { withUi: true },
  );
  assert.equal(r.plate, true);
  assert.match(r.reason, /deny write_file\(\*\)\. Пока правил нет, работу проверяет один Codex\.$/);
  assert.equal(r.asked, 1);
  assert.equal(r.plateAfter, false);
  assert.equal(r.button, "Отправить на проверку");
});

test("сохранённый режим «gemini» без agy — показывается и уходит «Задача с рецензией»", { skip: NO_BROWSER }, () => {
  const r = open(
    js`
    route = "gemini";
    showRoute();
    result.checked = [...getById("режимы").querySelectorAll("[role=radio][aria-checked=true]")]
      .map((k) => k.dataset.route);
    result.name = getById("маршрут-название").textContent;
    getById("ввод").value = "вопрос";
    getById("отправить").click();
    result.sent = window.sentMessages.filter((m) => m.type === "send");
  `,
    { withUi: true },
  );
  assert.deepEqual(r.checked, ["review"]);
  assert.equal(r.name, "Задача с рецензией");
  assert.deepEqual(r.sent, [{ type: "send", text: "вопрос", route: "review" }]);
});
