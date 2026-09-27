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
 * Запуск: npm run build && node scripts/live-probe.mjs [--codex-turn]
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { ClaudeAdapter } = require("../out/adapters/claude.js");
const { CodexAdapter } = require("../out/adapters/codex.js");
const { resolveCodexCommand } = require("../out/codexBinary.js");
const { readdirSync } = require("node:fs");

const папка = mkdtempSync(join(tmpdir(), "agent-panel-probe-"));
writeFileSync(join(папка, "README.md"), "Временная папка живой пробы agent-panel.\n");
const итог = { папка, claude: {}, codex: {} };

function расширениеChatGPT() {
  const корень = join(homedir(), ".vscode", "extensions");
  const имена = readdirSync(корень).filter((и) => и.startsWith("openai.chatgpt-")).sort();
  return имена.length ? join(корень, имена[имена.length - 1]) : undefined;
}

/** Ход до turn_completed; события копятся для сводки. */
function ход(адаптер, события, текст, предел = 180_000) {
  return new Promise((resolve, reject) => {
    const таймер = setTimeout(() => reject(new Error(`нет turn_completed за ${предел / 1000} с`)), предел);
    события.ждать = (е) => {
      if (е.kind === "turn_completed" || (е.kind === "error" && е.failed)) {
        clearTimeout(таймер);
        resolve(е);
      }
    };
    адаптер.send({ text: текст, from: "human" }).catch(reject);
  });
}

function приёмник(события) {
  return (е) => {
    события.push(е);
    события.ждать?.(е);
  };
}

const ответ = (события) =>
  события.filter((е) => е.kind === "message" && е.agent !== "system").map((е) => е.text).join(" ").trim();

// --- Claude --------------------------------------------------------------------
{
  const события = [];
  const опции = { command: "claude", cwd: папка, settingSources: "project,local", permissionMode: "default" };
  const каталог = await new ClaudeAdapter(опции, приёмник(события)).listModels();
  итог.claude.каталог = каталог.map((м) => ({ id: м.id, label: м.label, efforts: м.efforts }));
  const дешёвая = каталог.find((м) => /haiku/i.test(`${м.id} ${м.label}`))?.id ?? "haiku";

  let сессия;
  const первый = new ClaudeAdapter({ ...опции, model: дешёвая, onSessionId: (id) => (сессия = id) }, приёмник(события));
  const конец1 = await ход(первый, события, "Запомни кодовое слово «янтарь». Ответь одним словом: запомнил.");
  итог.claude.ход1 = { ответ: ответ(события), провал: !!конец1.failed, сессия };
  await первый.stop();

  const события2 = [];
  const второй = new ClaudeAdapter({ ...опции, model: дешёвая, resumeSessionId: сессия }, приёмник(события2));
  const конец2 = await ход(второй, события2, "Какое кодовое слово я просил запомнить? Ответь одним словом.");
  итог.claude.ход2 = {
    ответ: ответ(события2),
    провал: !!конец2.failed,
    помнит: /янтар/i.test(ответ(события2)),
    диагностика: события2.filter((е) => е.kind === "diagnostic").map((е) => е.text).slice(0, 5),
  };
  await второй.stop();
}

// --- Codex ---------------------------------------------------------------------
{
  const запуск = resolveCodexCommand(undefined, расширениеChatGPT());
  итог.codex.запуск = запуск;
  const события = [];
  const codex = new CodexAdapter({ command: запуск.command, shell: запуск.shell, cwd: папка }, приёмник(события));
  const каталог = await codex.listModels();
  итог.codex.каталог = каталог.map((м) => ({ id: м.id, label: м.label, efforts: м.efforts, defaultEffort: м.defaultEffort }));
  if (process.argv.includes("--codex-turn")) {
    const конец = await ход(codex, события, "Ответь одним словом: готов.");
    итог.codex.ход = { ответ: ответ(события), провал: !!конец.failed };
  }
  await codex.stop();
}

console.log(JSON.stringify(итог, null, 2));
process.exit(0);
