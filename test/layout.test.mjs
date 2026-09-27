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

const корень = join(import.meta.dirname, "..");

/**
 * chrome-headless-shell, поставленный `npx @puppeteer/browsers install
 * chrome-headless-shell@stable --path %LOCALAPPDATA%/agent-panel-browser`:
 * безголовый Edge 153 на этой машине вывода не отдаёт.
 */
function безголовыйChrome() {
  const каталог = join(process.env.LOCALAPPDATA ?? "", "agent-panel-browser", "chrome-headless-shell");
  if (!process.env.LOCALAPPDATA || !existsSync(каталог)) return undefined;
  for (const версия of readdirSync(каталог).sort().reverse()) {
    const путь = join(каталог, версия, "chrome-headless-shell-win64", "chrome-headless-shell.exe");
    if (existsSync(путь)) return путь;
  }
  return undefined;
}

const браузер = [
  безголовыйChrome(),
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].find((путь) => путь && existsSync(путь));
/** Безголовой оболочке режим не указывают; обычному браузеру — новый безголовый. */
const безголовый = браузер && /chrome-headless-shell/.test(браузер) ? [] : ["--headless=new"];

const ШИРИНА = 600;
const медиа = (имя) => pathToFileURL(join(корень, "media", имя)).href;

/**
 * Открыть разметку панели, выполнить скрипт проверки и вернуть то, что он
 * положил в window.итог. С panel.js — вместе со скриптами интерфейса и
 * заглушкой API VS Code, которая копит отправленное в window.отправленное.
 */
function открыть(проверка, { сИнтерфейсом = false, ширина = ШИРИНА, тема = "vscode-dark" } = {}) {
  const исходник = readFileSync(join(корень, "src", "extension.ts"), "utf8");
  const тело = исходник.match(/<body>([\s\S]*?)<script nonce/)?.[1];
  assert.ok(тело, "разметка панели не найдена в extension.ts");

  const интерфейс = сИнтерфейсом
    ? `<script>
  window.отправленное = [];
  window.acquireVsCodeApi = () => ({
    postMessage: (м) => window.отправленное.push(м),
    getState: () => undefined,
    setState: () => {},
  });
</script>
<link rel="stylesheet" href="${медиа("vendor/katex/katex.min.css")}">
<script src="${медиа("format.js")}"></script>
<script src="${медиа("thread.js")}"></script>
<script src="${медиа("vendor/markdown.js")}"></script>
<script src="${медиа("panel.js")}"></script>`
    : "";

  const страница = `<!DOCTYPE html><html><head><meta charset="utf-8">
<script>
  // Ошибки страницы — в атрибут корня: иначе упавший скрипт виден только как «не выполнился».
  window.ошибки = [];
  window.addEventListener("error", (е) => {
    window.ошибки.push(е.message);
    document.documentElement.dataset.errors = encodeURIComponent(JSON.stringify(window.ошибки));
  });
</script>
<link rel="stylesheet" href="${медиа("panel.css")}"></head><body class="${тема}">${тело}
${интерфейс}
<script>
  window.итог = {};
  // Синхронная доставка: window.postMessage асинхронен и не успел бы до снимка DOM.
  const послать = (data) => window.dispatchEvent(new MessageEvent("message", { data }));
  // Не «$»: panel.js объявляет её глобально, повторное объявление роняет весь скрипт.
  const по = (id) => document.getElementById(id);
  ${проверка}
  document.body.dataset.result = encodeURIComponent(JSON.stringify(window.итог));
</script></body></html>`;

  const папка = mkdtempSync(join(tmpdir(), "agent-panel-ui-"));
  try {
    const файл = join(папка, "panel.html");
    writeFileSync(файл, страница);
    const dom = execFileSync(
      браузер,
      [
        ...безголовый,
        "--disable-gpu",
        "--no-first-run",
        "--allow-file-access-from-files",
        `--user-data-dir=${join(папка, "профиль")}`,
        `--window-size=${ширина},800`,
        "--dump-dom",
        pathToFileURL(файл).href,
      ],
      { encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "ignore"] },
    );
    const ошибки = dom.match(/data-errors="([^"]*)"/)?.[1];
    const закодированный = dom.match(/data-result="([^"]*)"/)?.[1];
    assert.ok(
      закодированный && !ошибки,
      `скрипт проверки не выполнился: ${ошибки ? decodeURIComponent(ошибки) : "ошибок не поймано"}`,
    );
    return JSON.parse(decodeURIComponent(закодированный));
  } finally {
    // Дочерние процессы браузера отпускают профиль не сразу; мусор во
    // временной папке — не повод ронять проверку интерфейса.
    try {
      rmSync(папка, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      /* останется во временной папке */
    }
  }
}

/**
 * Браузер есть — ещё не значит, что он отдаёт вывод: Edge 153 на этой машине
 * молчит даже на --version, хотя код возврата нулевой. Одна пробная страница
 * отличает «нечем проверять» от настоящей поломки интерфейса.
 */
const БЕЗ_БРАУЗЕРА = (() => {
  if (!браузер) return "нет Edge/Chrome";
  try {
    открыть("итог.проба = 1;");
    return false;
  } catch (беда) {
    return `браузер не отдаёт вывод: ${(беда.message ?? "").slice(0, 80)}`;
  }
})();

for (const ширина of [ШИРИНА, 360]) test(`длинная задача, причина и лог не расширяют панель шириной ${ширина}`, { skip: БЕЗ_БРАУЗЕРА }, () => {
  const { scroll, client, button, беседа, вылезли } = открыть(`
    const лог = "[2026-09-15, 11:41:05 UTC] {taskinstance.py:1776} ERROR - Task failed with exception ".repeat(30);
    const событие = (agent, kind, доп) => ({ id: kind + Math.random(), agent, kind, visibility: "turn", at: Date.now(), ...доп });
    послать({ type: "state", состояние: { stage: "held", round: 1, maxRounds: 3, approvals: 0, queued: 2, auto: true,
      task: лог, verdict: "human", trail: [{ who: "task" }, { who: "claude" }, { who: "codex", mark: "?" }, { who: "you" }],
      held: { to: "claude", action: "send", reason: "Claude получил отказы в разрешениях (2): Bash: python -c " + "x".repeat(400) } } });
    по("эстафета").click();
    послать({ type: "event", событие: событие("human", "message", { text: лог }) });
    послать({ type: "event", событие: событие("claude", "message", { text: лог + "a".repeat(500) }) });
    послать({ type: "event", событие: событие("codex", "message", { text: "Код:" + String.fromCharCode(10, 10) + "    " + лог }) });
    послать({ type: "event", событие: событие("claude", "tool_call", { tool: "Bash", callId: "c1", text: лог }) });
    послать({ type: "event", событие: событие("claude", "approval_requested", { tool: "Bash", callId: "p1", text: лог, sessionRules: ["Bash(" + лог + ")"] }) });
    по("модели-кнопка").click();
    послать({ type: "models", agent: "codex", choice: { model: "", effort: "ultra" }, options: [
      { id: "", label: "по умолчанию " + "(очень длинное название модели) ".repeat(5), efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
    ] });
    по("диагностика-кнопка").click();
    итог.scroll = document.documentElement.scrollWidth;
    итог.client = document.documentElement.clientWidth;
    итог.беседа = по("беседа").scrollWidth - по("беседа").clientWidth;
    итог.button = Math.round(по("отправить").getBoundingClientRect().right);
    // Кто вылез за край — самые внешние из вылезших, чтобы сообщение называло виновника.
    const вылезли = [...document.querySelectorAll("body *")]
      .filter((э) => э.getClientRects().length && э.getBoundingClientRect().right > итог.client + 0.5)
      // Внутри блоков с собственной прокруткой вылезать можно.
      .filter((э) => !э.parentElement.closest("pre, table, .формула, .дорожка"));
    итог.вылезли = вылезли.filter((э) => !вылезли.includes(э.parentElement)).slice(0, 5)
      .map((э) => э.tagName.toLowerCase() + (э.id ? "#" + э.id : "") + (э.className && typeof э.className === "string" ? "." + э.className.split(" ").join(".") : ""));
  `, { сИнтерфейсом: true, ширина });
  assert.ok(client > 0 && client <= ширина, `ширина окна не измерена: ${client}`);
  assert.ok(scroll <= client, `документ шире окна: ${scroll} > ${client}; за краем: ${вылезли.join(", ")}`);
  assert.ok(button <= client, `кнопка «Отправить» за краем: ${button} > ${client}`);
  assert.ok(беседа <= 0, `беседа прокручивается вбок на ${беседа} px`);
});

test("реплика агента — Markdown с формулой, реплика человека — текст, ссылка — через расширение", { skip: БЕЗ_БРАУЗЕРА }, () => {
  const р = открыть(
    `
    const реплика = (agent, text) => ({ id: agent + text.length, agent, kind: "message", visibility: "turn", at: Date.now(), text });
    послать({ type: "event", событие: реплика("claude", "**жирно** и $x^2$\\n\\n[док](https://example.com/a)") });
    послать({ type: "event", событие: реплика("human", "**не разметка** $x$") });
    итог.сборкаЕсть = typeof window.PanelMarkdown?.render === "function";
    итог.жирный = !!document.querySelector(".пузырь.claude .текст strong");
    итог.формула = !!document.querySelector(".пузырь.claude .katex");
    итог.человек = document.querySelector(".пузырь.human .текст").innerHTML;
    document.querySelector(".пузырь.claude a").click();
    итог.ссылки = window.отправленное.filter((м) => м.type === "openLink");
  `,
    { сИнтерфейсом: true },
  );
  assert.equal(р.сборкаЕсть, true, "media/vendor/markdown.js не собран или не загрузился");
  assert.equal(р.жирный, true);
  assert.equal(р.формула, true);
  assert.equal(р.человек, "**не разметка** $x$");
  assert.deepEqual(р.ссылки, [{ type: "openLink", href: "https://example.com/a" }]);
});

test("модели: список по кнопке, модель — списком, уровень — узлом нити", { skip: БЕЗ_БРАУЗЕРА }, () => {
  const р = открыть(
    `
    const списки = () => window.отправленное.filter((м) => м.type === "listModels").length;
    итог.доКнопки = списки();
    по("модели-кнопка").click();
    итог.панельОткрыта = !по("модели-панель").hidden;
    по("модели-кнопка").click();
    по("модели-кнопка").click();
    итог.запросовСписка = списки();

    послать({ type: "models", agent: "claude", choice: { model: "", effort: "" }, options: [
      { id: "", label: "по умолчанию (Sonnet 5)", description: "", efforts: ["low", "high"] },
      { id: "opus", label: "Opus", description: "Opus 5", efforts: ["low", "high", "max"] },
      { id: "haiku", label: "Haiku", description: "Haiku 4.5", efforts: [] },
    ] });
    послать({ type: "models", agent: "codex", choice: { model: "", effort: "" }, options: [
      { id: "", label: "по умолчанию (GPT-Sol)", description: "", efforts: ["low", "high", "ultra"], defaultEffort: "low" },
    ] });

    const узлы = (агент) => [...по("нить-" + агент).querySelectorAll(".нить-узел")];
    const модель = по("модель-claude");
    итог.модели = [...модель.options].map((о) => о.textContent);
    итог.claudeБезВыбора = узлы("claude").every((у) => у.getAttribute("aria-checked") === "false");
    итог.claudeПодпись = по("нить-уровень-claude").textContent;
    модель.value = "opus";
    модель.dispatchEvent(new Event("change"));
    итог.уровни = узлы("claude").map((у) => у.getAttribute("aria-label"));
    итог.подсказка = узлы("claude")[2].title;
    узлы("claude")[2].click();
    итог.выбран = узлы("claude").map((у) => у.getAttribute("aria-checked"));
    итог.подписьПосле = по("нить-уровень-claude").textContent;
    итог.колецНаМаксимуме = по("нить-claude").querySelectorAll(".нить-кольцо").length;
    модель.value = "haiku";
    модель.dispatchEvent(new Event("change"));
    итог.узловУHaiku = узлы("claude").length;
    итог.подписьHaiku = по("нить-уровень-claude").textContent;

    итог.codexПоУмолчанию = узлы("codex").map((у) => у.getAttribute("aria-checked"));
    итог.чёрточка = !!по("нить-codex").querySelector(".нить-по-умолчанию");
    узлы("codex")[2].click();
    итог.ветвей = по("нить-codex").querySelectorAll(".нить-ветвь").length;
    узлы("codex")[0].click();

    итог.выборы = window.отправленное.filter((м) => м.type === "setModel");
    итог.сводка = по("модели-кнопка").title;
    const окно = по("модели-панель").getBoundingClientRect();
    итог.нитьВнутриОкна = [...по("модели-панель").querySelectorAll(".нить-узел")]
      .every((у) => у.getBoundingClientRect().right <= окно.right + 1 && у.getBoundingClientRect().left >= окно.left - 1);

    послать({ type: "permissions", mode: "bypassPermissions" });
    итог.режимДо = по("без-вопросов").getAttribute("aria-pressed");
    по("без-вопросов").click();
    итог.режимПосле = по("без-вопросов").textContent;
    итог.режимы = window.отправленное.filter((м) => м.type === "setPermissionMode");
    итог.сводкаРежима = по("модели-кнопка").title;
  `,
    { сИнтерфейсом: true },
  );
  assert.equal(р.доКнопки, 0, "список моделей не должен запрашиваться при открытии панели");
  assert.equal(р.панельОткрыта, true);
  assert.equal(р.запросовСписка, 1, "повторное открытие не должно заново поднимать агентов");
  assert.deepEqual(р.модели, ["по умолчанию (Sonnet 5)", "Opus", "Haiku"]);
  assert.equal(р.claudeБезВыбора, true, "умолчание Claude неизвестно — узел наугад не выбирается");
  assert.equal(р.claudeПодпись, "По умолчанию");
  assert.deepEqual(р.уровни, ["Низкое", "Высокое", "Максимум"]);
  assert.match(р.подсказка, /Без ограничений на расход/, "определение уровня — в подсказке узла");
  assert.deepEqual(р.выбран, ["false", "false", "true"]);
  assert.equal(р.подписьПосле, "Максимум");
  assert.equal(р.колецНаМаксимуме, 2, "«Максимум» — двойное кольцо");
  assert.equal(р.узловУHaiku, 0, "у модели без уровней выбирать нечего");
  assert.equal(р.подписьHaiku, "Без уровней");
  assert.deepEqual(р.codexПоУмолчанию, ["true", "false", "false"], "умолчание из каталога выбрано");
  assert.equal(р.чёрточка, true);
  assert.equal(р.ветвей, 3, "«Ультра» — нить ветвится");
  assert.deepEqual(р.выборы, [
    { type: "setModel", agent: "claude", model: "opus", effort: "" },
    { type: "setModel", agent: "claude", model: "opus", effort: "max" },
    { type: "setModel", agent: "claude", model: "haiku", effort: "" },
    { type: "setModel", agent: "codex", model: "", effort: "ultra" },
    { type: "setModel", agent: "codex", model: "", effort: "" },
  ]);
  assert.match(р.сводка, /Claude: Haiku/);
  assert.match(р.сводка, /Codex: по умолчанию/);
  assert.equal(р.нитьВнутриОкна, true, "узлы нити не выходят за окно «Модели»");
  assert.equal(р.режимДо, "true", "режим из расширения должен отразиться на кнопке");
  assert.equal(р.режимПосле, "Спрашивать");
  assert.deepEqual(р.режимы, [{ type: "setPermissionMode", mode: "default" }]);
  assert.match(р.сводкаРежима, /спрашивать/);
});

test("карточка разрешения: кнопки, ответ уходит расширению, решение закрывает карточку", { skip: БЕЗ_БРАУЗЕРА }, () => {
  const р = открыть(
    `
    const запрос = (callId, доп = {}) => ({
      id: callId, agent: "claude", kind: "approval_requested", visibility: "turn", at: Date.now(),
      tool: "Bash", callId, text: "mkdir probe-dir", sessionRules: ["Bash(mkdir probe-dir *)"], ...доп,
    });
    послать({ type: "event", событие: запрос("perm-1") });
    послать({ type: "state", состояние: { stage: "working", round: 0, maxRounds: 3, approvals: 1, queued: 0, auto: true } });
    const карточка = document.querySelector(".разрешение");
    итог.кнопки = [...карточка.querySelectorAll("button")].map((к) => к.textContent);
    итог.этап = по("этап").textContent;

    карточка.querySelectorAll("button")[1].click();
    итог.отправлено = window.отправленное.filter((м) => м.type === "approval");
    итог.отключены = [...карточка.querySelectorAll("button")].every((к) => к.disabled);

    послать({ type: "event", событие: {
      id: "d1", agent: "claude", kind: "approval_decided", visibility: "turn", at: Date.now(),
      callId: "perm-1", text: "разрешено в этой сессии: Bash(mkdir probe-dir *)",
    } });
    итог.кнопкиПосле = карточка.querySelectorAll("button").length;
    итог.надпись = карточка.querySelector(".итог").textContent;

    послать({ type: "event", история: true, событие: запрос("old-1") });
    итог.кнопкиИзЖурнала = document.querySelectorAll(".разрешение")[1].querySelectorAll("button").length;

    послать({ type: "event", событие: запрос("perm-2") });
    const карточки = document.querySelectorAll(".разрешение");
    const безВопросов = [...карточки[карточки.length - 1].querySelectorAll("button")]
      .find((к) => к.textContent === "Больше не спрашивать");
    безВопросов.click();
    итог.безВопросов = window.отправленное.filter((м) => м.type === "setPermissionMode");
  `,
    { сИнтерфейсом: true },
  );
  assert.deepEqual(р.кнопки, ["Разрешить", "В этой сессии", "Больше не спрашивать", "Отклонить"]);
  assert.equal(р.этап, "Ждёт разрешения");
  assert.deepEqual(р.отправлено, [{ type: "approval", id: "perm-1", choice: "allowSession" }]);
  assert.equal(р.отключены, true, "повторное нажатие отправило бы второй ответ");
  assert.equal(р.кнопкиПосле, 0);
  assert.match(р.надпись, /разрешено в этой сессии/);
  assert.equal(р.кнопкиИзЖурнала, 0, "на запрос прошлого запуска ответить нельзя");
  assert.deepEqual(р.безВопросов, [{ type: "setPermissionMode", mode: "bypassPermissions" }]);
});

test("вердикт рецензента: значок и слова, исходная строка видна, текст выше — разметкой", { skip: БЕЗ_БРАУЗЕРА }, () => {
  const р = открыть(
    `
    const перевод = String.fromCharCode(10);
    const реплика = (agent, text) => ({ id: agent + text.length, agent, kind: "message", visibility: "turn", at: Date.now(), text });
    послать({ type: "event", событие: реплика("codex", ["**Два** замечания.", "", "ВЕРДИКТ: ЕСТЬ ЗАМЕЧАНИЯ"].join(перевод)) });
    послать({ type: "event", событие: реплика("claude", ["Итог.", "ВЕРДИКТ: ПРИНЯТО"].join(перевод)) });
    const codex = document.querySelector(".пузырь.codex");
    итог.слово = codex.querySelector(".вердикт-строка .слово")?.textContent;
    итог.исходная = codex.querySelector(".вердикт-строка .исходная")?.textContent;
    итог.класс = codex.querySelector(".вердикт-строка")?.className;
    итог.текстБезСтроки = !codex.querySelector(".текст").textContent.includes("ВЕРДИКТ");
    итог.жирный = !!codex.querySelector(".текст strong");
    итог.уClaude = !!document.querySelector(".пузырь.claude .вердикт-строка");
  `,
    { сИнтерфейсом: true },
  );
  assert.equal(р.слово, "Есть замечания");
  assert.equal(р.исходная, "ВЕРДИКТ: ЕСТЬ ЗАМЕЧАНИЯ");
  assert.match(р.класс, /remarks/);
  assert.equal(р.текстБезСтроки, true);
  assert.equal(р.жирный, true);
  assert.equal(р.уClaude, false, "вердикт выносит только рецензент");
});

test("действия хода: бусина на вызов, форма по виду, счётчики и отказ", { skip: БЕЗ_БРАУЗЕРА }, () => {
  const р = открыть(
    `
    const с = (kind, доп) => ({ id: kind + Math.random(), agent: "claude", kind, visibility: "turn", at: Date.now(), ...доп });
    послать({ type: "event", событие: с("tool_call", { tool: "Read", callId: "r1", text: "docs/a.md" }) });
    послать({ type: "event", событие: с("tool_result", { tool: "Read", callId: "r1", text: "ok" }) });
    послать({ type: "event", событие: с("tool_call", { tool: "Bash", callId: "b1", text: "python -m pytest -q" }) });
    послать({ type: "event", событие: с("tool_running", { tool: "Bash", callId: "b1" }) });
    итог.идёт = document.querySelector(".действия .идёт-сейчас").textContent;
    послать({ type: "event", событие: с("tool_result", { tool: "Bash", callId: "b1", text: "5 passed" }) });
    послать({ type: "event", событие: с("tool_call", { tool: "Bash", callId: "b2", text: "git push" }) });
    послать({ type: "event", событие: с("approval_decided", { callId: "b2", text: "отказано: git push" }) });
    послать({ type: "event", событие: с("tool_call", { tool: "Edit", callId: "e1", text: "src/x.ts" }) });
    итог.бусины = [...document.querySelectorAll(".действия .чётки .бусина")].map((б) => б.className);
    итог.счётчики = [...document.querySelectorAll(".действия .счётчик")].map((с) => с.title + " " + с.textContent);
    итог.идётПосле = document.querySelector(".действия .идёт-сейчас").hidden;
    итог.строк = document.querySelectorAll(".действия .вызов").length;
    итог.отказСтрока = document.querySelector(".действия .вызов.отказ .метка")?.textContent;
  `,
    { сИнтерфейсом: true },
  );
  assert.equal(р.идёт, "выполняется: python -m pytest -q");
  assert.deepEqual(р.бусины, ["бусина ring done", "бусина square done", "бусина square denied", "бусина diamond formed"]);
  assert.deepEqual(р.счётчики, ["Команды 2", "Чтения и поиск 1", "Правки 1", "Отказано 1"]);
  assert.equal(р.идётПосле, true);
  assert.equal(р.строк, 4);
  assert.equal(р.отказСтрока, "отказано");
});

test("эстафета и дорожка цикла: кто работает, счёт проверок, след по клику", { skip: БЕЗ_БРАУЗЕРА }, () => {
  const р = открыть(
    `
    const состояние = (доп) => ({ stage: "idle", round: 0, maxRounds: 3, approvals: 0, queued: 0, auto: true,
      claudeBusy: false, codexBusy: false, trail: [], ...доп });
    послать({ type: "state", состояние: состояние({ stage: "reviewing", round: 2, verdict: "remarks", task: "Спецификация",
      trail: [{ who: "task" }, { who: "claude" }, { who: "codex", mark: "!" }, { who: "claude" }, { who: "codex" }] }) });
    итог.активен = по("нить-статус").dataset.active;
    итог.поток = по("нить-статус").dataset.flow;
    итог.этап = по("этап").textContent;
    итог.пояснение = по("этап-пояснение").textContent;
    итог.точки = [...по("раунд").children].map((т) => т.className);
    итог.дорожкаДо = по("дорожка").hidden;
    по("эстафета").click();
    итог.дорожкаПосле = по("дорожка").hidden;
    итог.шаги = [...по("дорожка").querySelectorAll(".шаг-узел")].map((у) => у.className);
    итог.отметки = [...по("дорожка").querySelectorAll(".шаг-отметка")].map((о) => о.textContent);
    послать({ type: "state", состояние: состояние({ stage: "held", verdict: "human",
      held: { to: "claude", reason: "Рецензент просит решения", action: "send" } }) });
    итог.человек = по("нить-статус").dataset.active;
    итог.плашка = !по("удержано").hidden;
    итог.кнопка = по("отпустить").textContent;
  `,
    { сИнтерфейсом: true },
  );
  assert.equal(р.активен, "codex");
  assert.equal(р.поток, "to-codex");
  assert.equal(р.этап, "Codex проверяет");
  assert.equal(р.пояснение, "есть замечания");
  assert.deepEqual(р.точки, ["пройдена", "пройдена", ""]);
  assert.equal(р.дорожкаДо, true, "дорожка раскрывается по клику");
  assert.equal(р.дорожкаПосле, false);
  assert.deepEqual(р.шаги, [
    "шаг-узел task", "шаг-узел claude", "шаг-узел codex", "шаг-узел claude", "шаг-узел codex текущий",
    "шаг-узел claude пустой", "шаг-узел codex пустой",
  ]);
  assert.deepEqual(р.отметки, ["!"]);
  assert.equal(р.человек, "human");
  assert.equal(р.плашка, true);
  assert.equal(р.кнопка, "Отправить Claude");
});

test("режим отправки: переключатель, меню по названию, выбор уходит с сообщением", { skip: БЕЗ_БРАУЗЕРА }, () => {
  const р = открыть(
    `
    итог.кнопок = по("режимы").querySelectorAll("[role=radio]").length;
    итог.название = по("маршрут-название").textContent;
    по("режимы").querySelector("[data-маршрут=both]").click();
    итог.послеПереключателя = по("маршрут-название").textContent;
    по("маршрут").click();
    итог.менюОткрыто = !по("маршрут-меню").hidden;
    по("маршрут-меню").querySelector("[data-маршрут=codex]").click();
    итог.менюЗакрыто = по("маршрут-меню").hidden;
    итог.отмечен = по("режимы").querySelector("[aria-checked=true]").dataset.маршрут;
    по("ввод").value = "вопрос";
    по("отправить").click();
    итог.отправлено = window.отправленное.filter((м) => м.type === "send");
  `,
    { сИнтерфейсом: true },
  );
  assert.equal(р.кнопок, 4);
  assert.equal(р.название, "Задача с рецензией");
  assert.equal(р.послеПереключателя, "Спросить обоих");
  assert.equal(р.менюОткрыто, true);
  assert.equal(р.менюЗакрыто, true);
  assert.equal(р.отмечен, "codex");
  assert.deepEqual(р.отправлено, [{ type: "send", text: "вопрос", route: "codex" }]);
});

test("светлая тема: у агентов свои цвета, различимые на белом", { skip: БЕЗ_БРАУЗЕРА }, () => {
  const р = открыть(
    `
    const стиль = getComputedStyle(document.body);
    итог.claude = стиль.getPropertyValue("--claude").trim();
    итог.codex = стиль.getPropertyValue("--codex").trim();
  `,
    { сИнтерфейсом: true, тема: "vscode-light" },
  );
  assert.equal(р.claude, "#B8702F");
  assert.equal(р.codex, "#1E8C96");
});
