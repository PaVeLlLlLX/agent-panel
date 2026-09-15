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
const БЕЗ_БРАУЗЕРА = !браузер && "нет Edge/Chrome";

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
<script src="${медиа("format.js")}"></script>
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
  `,
    { сИнтерфейсом: true },
  );
  assert.deepEqual(р.кнопки, ["Разрешить", "Разрешить в этой сессии", "Отклонить"]);
  assert.equal(р.этап, "ждёт разрешения");
  assert.deepEqual(р.отправлено, [{ type: "approval", id: "perm-1", choice: "allowSession" }]);
  assert.equal(р.отключены, true, "повторное нажатие отправило бы второй ответ");
  assert.equal(р.кнопкиПосле, 0);
  assert.match(р.надпись, /разрешено в этой сессии/);
  assert.equal(р.кнопкиИзЖурнала, 0, "на запрос прошлого запуска ответить нельзя");
});
