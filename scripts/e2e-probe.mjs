/**
 * Сквозная живая проба: настоящий координатор с настоящими агентами проходит
 * один цикл «задача с рецензией» во временном git-репозитории.
 *
 * Офлайн-тесты проверяют координатор с заглушками и адаптеры с фальшивыми
 * процессами по отдельности; стык «настоящий Claude → материал → настоящий
 * Codex → вердикт» виден только так. Дешёвые модели: haiku и низкий уровень
 * Codex. Временная папка; комнаты и ветки владельца не трогаются.
 *
 * Запуск: npm run build && node scripts/e2e-probe.mjs
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

const папка = mkdtempSync(join(tmpdir(), "agent-panel-e2e-"));
writeFileSync(join(папка, "README.md"), "Проба agent-panel.\n");
execFileSync("git", ["init", "-q"], { cwd: папка });
execFileSync("git", ["-c", "user.email=probe@local", "-c", "user.name=probe", "commit", "-qam", "init", "--allow-empty"], { cwd: папка });
execFileSync("git", ["add", "."], { cwd: папка });

const корень = join(homedir(), ".vscode", "extensions");
const chatgpt = readdirSync(корень).filter((и) => и.startsWith("openai.chatgpt-")).sort().pop();
const запуск = resolveCodexCommand(undefined, chatgpt ? join(корень, chatgpt) : undefined);

const t0 = Date.now();
const время = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const журнал = new Journal(join(папка, "journal.sqlite"));
журнал.ensureRoom("e2e", папка);
let координатор;
const принять = (е) => координатор.handle(е);
const claude = new ClaudeAdapter(
  { command: "claude", cwd: папка, model: "haiku", permissionMode: "bypassPermissions", settingSources: "project,local" },
  принять,
);
const codex = new CodexAdapter(
  { command: запуск.command, shell: запуск.shell, cwd: папка, model: "gpt-6-luna", effort: "low" },
  принять,
);
let последнееСостояние;
координатор = new Coordinator(claude, codex, журнал, {
  room: "e2e",
  cwd: папка,
  maxAutoRounds: 2,
  onEvent: (е) => {
    if (["message", "turn_completed", "error"].includes(е.kind) || (е.kind === "tool_call" && !е.parentCallId)) {
      const хвост = е.kind === "turn_completed" && е.usage ? ` usage=${JSON.stringify(е.usage)}` : "";
      console.log(время(), е.agent, е.kind, (е.tool ? `[${е.tool}] ` : "") + (е.text ?? "").slice(0, 90).replace(/\s+/g, " ") + хвост);
    }
  },
  onState: (с) => {
    if (с.stage !== последнееСостояние?.stage) console.log(время(), "ЭТАП", с.stage, с.verdict ?? "");
    последнееСостояние = с;
  },
});

await координатор.fromHuman(
  "Создай файл hello.txt с одной строкой: привет. Покажи его содержимое командой cat. Больше ничего не делай.",
  "review",
);
const конец = Date.now() + 6 * 60_000;
while (Date.now() < конец && !["accepted", "held", "stopped"].includes(последнееСостояние?.stage)) {
  await new Promise((r) => setTimeout(r, 500));
}
console.log(время(), "ИТОГ", JSON.stringify({
  stage: последнееСостояние?.stage,
  verdict: последнееСостояние?.verdict,
  round: последнееСостояние?.round,
  held: последнееСостояние?.held?.reason,
  trail: последнееСостояние?.trail,
  usage: последнееСостояние?.usage,
}, null, 1));
await координатор.stopAll();
журнал.close();
process.exit(0);
