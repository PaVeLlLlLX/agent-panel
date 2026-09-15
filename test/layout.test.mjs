/**
 * Раскладка панели в настоящем браузере.
 *
 * В живом прогоне промпт с логом в одну строку сделал панель шире окна:
 * кнопки уехали за край. Стили без браузера не проверить, поэтому разметка
 * берётся из extension.ts, заполняется длинными строками и открывается в
 * безголовом Edge/Chrome. Нет браузера — проверка пропускается.
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

function измерить() {
  const исходник = readFileSync(join(корень, "src", "extension.ts"), "utf8");
  const тело = исходник.match(/<body>([\s\S]*?)<script nonce/)?.[1];
  assert.ok(тело, "разметка панели не найдена в extension.ts");
  const стили = pathToFileURL(join(корень, "media", "panel.css")).href;

  const страница = `<!DOCTYPE html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="${стили}"></head><body>${тело}
<script>
  const лог = "[2026-09-15, 11:41:05 UTC] {taskinstance.py:1776} ERROR - Task failed with exception ".repeat(30);
  const $ = (id) => document.getElementById(id);
  $("задача").hidden = false;
  $("задача").textContent = "Задача: " + лог;
  $("удержано").hidden = false;
  $("удержано-причина").textContent = "Claude получил отказы в разрешениях (2): Bash: python -c " + "x".repeat(400);
  const пузырь = document.createElement("div");
  пузырь.className = "пузырь claude";
  const текст = document.createElement("div");
  текст.className = "текст";
  текст.textContent = лог + "a".repeat(500);
  пузырь.append(текст);
  $("беседа").append(пузырь);
  const корень = document.documentElement;
  const кнопка = $("отправить").getBoundingClientRect();
  document.body.dataset.scroll = корень.scrollWidth;
  document.body.dataset.client = корень.clientWidth;
  document.body.dataset.button = Math.round(кнопка.right);
</script></body></html>`;

  const папка = mkdtempSync(join(tmpdir(), "agent-panel-layout-"));
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
    const число = (имя) => Number(dom.match(new RegExp(`data-${имя}="(\\d+)"`))?.[1]);
    return { scroll: число("scroll"), client: число("client"), button: число("button") };
  } finally {
    rmSync(папка, { recursive: true, force: true });
  }
}

test("длинная задача, причина и лог не расширяют панель", { skip: !браузер && "нет Edge/Chrome" }, () => {
  const { scroll, client, button } = измерить();
  assert.ok(client > 0 && client <= ШИРИНА, `ширина окна не измерена: ${client}`);
  assert.ok(scroll <= client, `документ шире окна: ${scroll} > ${client}`);
  assert.ok(button <= client, `кнопка «Отправить» за краем: ${button} > ${client}`);
});
