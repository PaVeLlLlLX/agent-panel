/**
 * Сквозная живая проба: настоящий координатор с настоящими агентами проходит
 * один цикл «задача с рецензией» во временном git-репозитории.
 *
 * Офлайн-тесты проверяют координатор с заглушками и адаптеры с фальшивыми
 * процессами по отдельности; стык «настоящий Claude → материал → настоящий
 * Codex → вердикт» виден только так. Дешёвые модели: haiku и низкий уровень
 * Codex. Временная папка; комнаты и ветки владельца не трогаются.
 *
 * Запуск: npm run build && node scripts/e2e-probe.mjs [--subagent | --two-subagents] [--memory <команда>]
 *   --subagent — Claude поручают сделать работу фоновым субагентом;
 *   --two-subagents — двум сразу, один заметно дольше другого;
 *   --background-bash — фоновая команда кончается, пока идёт рецензия;
 *   --memory   — «Память по теме»: команда поиска с каталогом Trading.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { ClaudeAdapter } = require("../out/adapters/claude.js");
const { CodexAdapter } = require("../out/adapters/codex.js");
const { Coordinator } = require("../out/coordinator.js");
const { Journal } = require("../out/journal.js");
const { resolveCodexCommand } = require("../out/codexBinary.js");
const { runMemorySearch } = require("../out/memory.js");

const SUBAGENT = process.argv.includes("--subagent");
const TWO = process.argv.includes("--two-subagents");
const BACKGROUND = process.argv.includes("--background-bash");
const parents = new Set();
let claudeTurns = 0;
let autonomousEnds = 0;
const memoryIndex = process.argv.indexOf("--memory");
const memoryCommand = memoryIndex > 0 ? process.argv[memoryIndex + 1] : "";

const dir = mkdtempSync(join(tmpdir(), "agent-panel-e2e-"));
writeFileSync(join(dir, "README.md"), "Проба agent-panel.\n");
execFileSync("git", ["init", "-q"], { cwd: dir });
execFileSync("git", ["-c", "user.email=probe@local", "-c", "user.name=probe", "commit", "-qam", "init", "--allow-empty"], { cwd: dir });
execFileSync("git", ["add", "."], { cwd: dir });

const root = join(homedir(), ".vscode", "extensions");
const chatgpt = readdirSync(root).filter((it) => it.startsWith("openai.chatgpt-")).sort().pop();
const launch = resolveCodexCommand(undefined, chatgpt ? join(root, chatgpt) : undefined);

const t0 = Date.now();
const time = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const journal = new Journal(join(dir, "journal.sqlite"));
journal.ensureRoom("e2e", dir);
let coordinator;
const accept = (e) => coordinator.handle(e);
const claude = new ClaudeAdapter(
  { command: "claude", cwd: dir, model: "haiku", permissionMode: "bypassPermissions", settingSources: "project,local" },
  accept,
);
const codex = new CodexAdapter(
  { command: launch.command, shell: launch.shell, cwd: dir, model: "gpt-6-luna", effort: "low" },
  accept,
);
let lastState;
coordinator = new Coordinator(claude, codex, journal, {
  room: "e2e",
  cwd: dir,
  maxAutoRounds: 2,
  ...(memoryCommand
    ? { memory: (text) => runMemorySearch(memoryCommand, "C:/Users/21435/source/Trading", text) }
    : {}),
  onEvent: (e) => {
    if (e.parentCallId) parents.add(e.parentCallId);
    if (e.agent === "claude" && e.kind === "turn_completed") claudeTurns++;
    if (e.kind === "turn_completed" && e.unsolicited) autonomousEnds++;
    if (e.kind === "turn_started" && e.unsolicited) console.log(time(), e.agent, "САМ НАЧАЛ ХОД", e.text ?? "");
    if (["message", "turn_completed", "error"].includes(e.kind) || e.kind === "tool_call" || (e.kind === "diagnostic" && /субагент/.test(e.text ?? ""))) {
      const tail = e.kind === "turn_completed" && e.usage ? ` usage=${JSON.stringify(e.usage)}` : "";
      const whose = e.parentCallId ? "(субагент) " : "";
      console.log(time(), e.agent, e.kind, whose + (e.tool ? `[${e.tool}] ` : "") + (e.text ?? "").slice(0, 90).replace(/\s+/g, " ") + tail);
    }
  },
  onState: (s) => {
    if (s.stage !== lastState?.stage) console.log(time(), "ЭТАП", s.stage, s.verdict ?? "");
    lastState = s;
  },
});

await coordinator.fromHuman(
  BACKGROUND
    ? "Запусти инструментом Bash с параметром run_in_background: true команду: sleep 15; echo поздно > late.txt\nНе жди её и ничего не проверяй. Сразу ответь одной фразой: команда запущена в фоне, файл late.txt появится через 15 секунд."
    : TWO
    ? "Одним сообщением запусти двух субагентов параллельно (два вызова инструмента Agent, subagent_type general-purpose). Первый создаёт файл one.txt с одной строкой «один». Второй сначала выполняет команду sleep 25, затем создаёт файл two.txt с одной строкой «два». Сам файлы не трогай. Когда закончат оба, покажи оба файла командой cat и одной фразой скажи, что сделано."
    : SUBAGENT
    ? "Поручи ровно одному субагенту (инструмент Agent, subagent_type general-purpose) создать файл hello.txt с одной строкой «привет» и показать его командой cat. Сам файлы не трогай. Когда субагент закончит, одной фразой скажи, что сделано. Для справки: почему в проекте отозвали эффект FOMC?"
    : "Создай файл hello.txt с одной строкой: привет. Покажи его содержимое командой cat. Больше ничего не делай.",
  "review",
);
const end = Date.now() + 6 * 60_000;
while (Date.now() < end && !["accepted", "held", "stopped"].includes(lastState?.stage)) {
  await new Promise((r) => setTimeout(r, 500));
}
// Фоновая команда кончается позже цикла: ждём самостоятельный ход Claude.
const backgroundDeadline = Date.now() + 90_000;
while (BACKGROUND && autonomousEnds === 0 && Date.now() < backgroundDeadline) {
  await new Promise((r) => setTimeout(r, 500));
}
console.log(time(), "ИТОГ", JSON.stringify({
  stage: lastState?.stage,
  verdict: lastState?.verdict,
  round: lastState?.round,
  held: lastState?.held?.reason,
  trail: lastState?.trail,
  usage: lastState?.usage,
  ...(TWO || SUBAGENT || BACKGROUND
    ? { subagentParents: parents.size, claudeTurns, autonomousEnds, files: readdirSync(dir).filter((it) => it.endsWith(".txt")) }
    : {}),
}, null, 1));
await coordinator.stopAll();
journal.close();
process.exit(0);
