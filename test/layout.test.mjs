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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const корень = join(import.meta.dirname, "..");
const браузер = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].find((путь) => existsSync(путь));

const ШИРИНА = 600;
const медиа = (имя) => pathToFileURL(join(корень, "media", имя)).href;

/**
 * Открыть разметку панели, выполнить скрипт проверки и вернуть то, что он
 * положил в window.итог. С panel.js — вместе со скриптами интерфейса и
 * заглушкой API VS Code, которая копит отправленное в window.отправленное.
 */
function открыть(проверка, { сИнтерфейсом = false } = {}) {
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
<link rel="stylesheet" href="${медиа("panel.css")}"></head><body>${тело}
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
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--allow-file-access-from-files",
        `--user-data-dir=${join(папка, "профиль")}`,
        `--window-size=${ШИРИНА},800`,
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
    rmSync(папка, { recursive: true, force: true });
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

test("длинная задача, причина и лог не расширяют панель", { skip: БЕЗ_БРАУЗЕРА }, () => {
  const { scroll, client, button } = открыть(`
    const лог = "[2026-09-15, 11:41:05 UTC] {taskinstance.py:1776} ERROR - Task failed with exception ".repeat(30);
    по("задача").hidden = false;
    по("задача").textContent = "Задача: " + лог;
    по("удержано").hidden = false;
    по("удержано-причина").textContent = "Claude получил отказы в разрешениях (2): Bash: python -c " + "x".repeat(400);
    const пузырь = document.createElement("div");
    пузырь.className = "пузырь claude";
    const текст = document.createElement("div");
    текст.className = "текст";
    текст.textContent = лог + "a".repeat(500);
    пузырь.append(текст);
    по("беседа").append(пузырь);
    итог.scroll = document.documentElement.scrollWidth;
    итог.client = document.documentElement.clientWidth;
    итог.button = Math.round(по("отправить").getBoundingClientRect().right);
  `);
  assert.ok(client > 0 && client <= ШИРИНА, `ширина окна не измерена: ${client}`);
  assert.ok(scroll <= client, `документ шире окна: ${scroll} > ${client}`);
  assert.ok(button <= client, `кнопка «Отправить» за краем: ${button} > ${client}`);
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

test("модели: список по кнопке, выбор уходит расширению, уровни — от выбранной модели", { skip: БЕЗ_БРАУЗЕРА }, () => {
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
      { id: "", label: "по умолчанию (GPT-Sol)", description: "", efforts: ["low", "high"], defaultEffort: "low" },
    ] });

    const модель = по("модель-claude");
    const уровень = по("уровень-claude");
    итог.модели = [...модель.options].map((о) => о.textContent);
    модель.value = "opus";
    модель.dispatchEvent(new Event("change"));
    итог.уровни = [...уровень.options].map((о) => о.value);
    уровень.value = "max";
    уровень.dispatchEvent(new Event("change"));
    модель.value = "haiku";
    модель.dispatchEvent(new Event("change"));
    итог.уровеньВыключен = уровень.disabled;
    итог.уровеньCodex = [...по("уровень-codex").options].map((о) => о.textContent)[0];
    итог.выборы = window.отправленное.filter((м) => м.type === "setModel");
    итог.сводка = по("модели-сводка").textContent;

    послать({ type: "permissions", mode: "bypassPermissions" });
    итог.режимДо = по("режим-claude").value;
    по("режим-claude").value = "default";
    по("режим-claude").dispatchEvent(new Event("change"));
    итог.режимы = window.отправленное.filter((м) => м.type === "setPermissionMode");
    итог.сводкаРежима = по("модели-сводка").textContent;
  `,
    { сИнтерфейсом: true },
  );
  assert.equal(р.доКнопки, 0, "список моделей не должен запрашиваться при открытии панели");
  assert.equal(р.панельОткрыта, true);
  assert.equal(р.запросовСписка, 1, "повторное открытие не должно заново поднимать агентов");
  assert.deepEqual(р.модели, ["по умолчанию (Sonnet 5)", "Opus", "Haiku"]);
  assert.deepEqual(р.уровни, ["", "low", "high", "max"]);
  assert.equal(р.уровеньВыключен, true, "у модели без уровней выбирать нечего");
  assert.equal(р.уровеньCodex, "по умолчанию (low)");
  assert.deepEqual(р.выборы, [
    { type: "setModel", agent: "claude", model: "opus", effort: "" },
    { type: "setModel", agent: "claude", model: "opus", effort: "max" },
    { type: "setModel", agent: "claude", model: "haiku", effort: "" },
  ]);
  assert.match(р.сводка, /Claude: Haiku/);
  assert.match(р.сводка, /Codex: по умолчанию/);
  assert.equal(р.режимДо, "bypassPermissions", "режим из расширения должен отразиться в переключателе");
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
  assert.deepEqual(р.кнопки, ["Разрешить", "Разрешить в этой сессии", "Больше не спрашивать", "Отклонить"]);
  assert.equal(р.этап, "ждёт разрешения");
  assert.deepEqual(р.отправлено, [{ type: "approval", id: "perm-1", choice: "allowSession" }]);
  assert.equal(р.отключены, true, "повторное нажатие отправило бы второй ответ");
  assert.equal(р.кнопкиПосле, 0);
  assert.match(р.надпись, /разрешено в этой сессии/);
  assert.equal(р.кнопкиИзЖурнала, 0, "на запрос прошлого запуска ответить нельзя");
  assert.deepEqual(р.безВопросов, [{ type: "setPermissionMode", mode: "bypassPermissions" }]);
});
