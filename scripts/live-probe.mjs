/**
 * Живая проба агентов панели вне VS Code: каталоги моделей и короткий ход.
 *
 * Зачем. Офлайн-тесты гоняют фальшивых агентов из fixtures/; сменился ли
 * протокол настоящего CLI, аккаунт или каталог моделей, видно только живым
 * запуском. Первый повод — смена аккаунта Claude 28.09.2026.
 *
 * Что делает (расход — несколько коротких ходов):
 *   1. каталог моделей Claude (initialize) и Codex (model/list);
 *   2. ход Claude на самой дешёвой модели каталога в новой сессии;
 *   3. тот же адаптер заново с --resume этой сессии: помнит ли она ход 2.
 * Сессии заводятся в отдельной временной папке; комнаты владельца и его
 * ветки не трогаются.
 *
 * claude и codex берутся так же, как в панели: из расширений VS Code, иначе из PATH.
 *
 * Запуск: npm run build && node scripts/live-probe.mjs [--codex-turn] [--claude-model <id>]
 * (по умолчанию ход Claude — на самой дешёвой модели каталога)
 */
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { ClaudeAdapter } = require("../out/adapters/claude.js");
const { CodexAdapter } = require("../out/adapters/codex.js");
const { resolveCodexCommand } = require("../out/codexBinary.js");
const { resolveClaudeCommand } = require("../out/claudeBinary.js");
const { readdirSync } = require("node:fs");

const dir = mkdtempSync(join(tmpdir(), "agent-panel-probe-"));
writeFileSync(join(dir, "README.md"), "Временная папка живой пробы agent-panel.\n");
const result = { dir, claude: {}, codex: {} };

/**
 * Папка расширения с наибольшей версией: VS Code оставляет старые до перезапуска.
 * Панель берёт путь у самого VS Code (активную версию), поэтому проба
 * подтверждает работу бинарника, а не выбор папки панелью.
 */
function extensionDir(prefix) {
  const root = join(homedir(), ".vscode", "extensions");
  if (!existsSync(root)) return undefined;
  const names = readdirSync(root)
    .filter((it) => it.startsWith(prefix))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return names.length ? join(root, names[names.length - 1]) : undefined;
}
const chatgptExtension = () => extensionDir("openai.chatgpt-");
const arg = (name) => {
  const it = process.argv.indexOf(name);
  return it >= 0 ? process.argv[it + 1] : undefined;
};

/** Ход до turn_completed; события копятся для сводки. */
function turn(adapter, events, text, limit = 180_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`нет turn_completed за ${limit / 1000} с`)), limit);
    events.wait = (e) => {
      if (e.kind === "turn_completed" || (e.kind === "error" && e.failed)) {
        clearTimeout(timer);
        resolve(e);
      }
    };
    adapter.send({ text: text, from: "human" }).catch(reject);
  });
}

function sink(events) {
  return (e) => {
    events.push(e);
    events.wait?.(e);
  };
}

const reply = (events) =>
  events.filter((e) => e.kind === "message" && e.agent !== "system").map((e) => e.text).join(" ").trim();

// --- Claude --------------------------------------------------------------------
{
  const events = [];
  const launch = resolveClaudeCommand(undefined, extensionDir("anthropic.claude-code-"));
  result.claude.launch = launch;
  const options = {
    command: launch.command,
    ...(launch.shell !== undefined ? { shell: launch.shell } : {}),
    cwd: dir,
    settingSources: "project,local",
    permissionMode: "default",
  };
  const catalog = await new ClaudeAdapter(options, sink(events)).listModels();
  result.claude.catalog = catalog.map((m) => ({ id: m.id, label: m.label, efforts: m.efforts }));
  const cheapModel =
    arg("--claude-model") ?? catalog.find((m) => /haiku/i.test(`${m.id} ${m.label}`))?.id ?? "haiku";
  result.claude.model = cheapModel;

  let session;
  const first = new ClaudeAdapter({ ...options, model: cheapModel, onSessionId: (id) => (session = id) }, sink(events));
  const end1 = await turn(first, events, "Запомни кодовое слово «янтарь». Ответь одним словом: запомнил.");
  result.claude.turn1 = { reply: reply(events), failed: !!end1.failed, session };
  await first.stop();

  const events2 = [];
  const second = new ClaudeAdapter({ ...options, model: cheapModel, resumeSessionId: session }, sink(events2));
  const end2 = await turn(second, events2, "Какое кодовое слово я просил запомнить? Ответь одним словом.");
  result.claude.turn2 = {
    reply: reply(events2),
    failed: !!end2.failed,
    remembers: /янтар/i.test(reply(events2)),
    diagnostics: events2.filter((e) => e.kind === "diagnostic").map((e) => e.text).slice(0, 5),
  };
  await second.stop();
}

// --- Codex ---------------------------------------------------------------------
{
  const launch = resolveCodexCommand(undefined, chatgptExtension());
  result.codex.launch = launch;
  const events = [];
  const codex = new CodexAdapter({ command: launch.command, shell: launch.shell, cwd: dir }, sink(events));
  const catalog = await codex.listModels();
  result.codex.catalog = catalog.map((m) => ({ id: m.id, label: m.label, efforts: m.efforts, defaultEffort: m.defaultEffort }));
  if (process.argv.includes("--codex-turn")) {
    const end = await turn(codex, events, "Ответь одним словом: готов.");
    result.codex.turn = { reply: reply(events), failed: !!end.failed };
  }
  await codex.stop();
}

console.log(JSON.stringify(result, null, 2));
process.exit(0);
