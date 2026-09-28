/**
 * Недельная доля лимита Claude из `/usage`: в потоке `claude -p` её нет,
 * а граница владельца (не больше 90% недели) требует видеть её в панели.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { readdirSync } from "node:fs";
import { parseClaudeUsage, parseUsageOutput, fetchClaudeUsage, usageDirectory } from "../out/claudeUsage.js";

const NL = String.fromCharCode(10);
const FAKE_CLAUDE = fileURLToPath(new URL("../fixtures/fake-claude.mjs", import.meta.url));

// Ответ CLI 2.1.220 на `claude -p "/usage"`, снят 28.09.2026.
const RESPONSE = [
  "You are currently using your subscription to power your Claude Code usage",
  "",
  "Current session: 28% used · resets Sep 28, 6:50am (Asia/Novosibirsk)",
  "Current week (all models): 4% used · resets Oct 4, 12am (Asia/Novosibirsk)",
  "Current week (Fable): 0% used · resets Oct 4, 12am (Asia/Novosibirsk)",
].join(NL);

test("неделя и окно сессии из ответа /usage", () => {
  assert.deepEqual(parseClaudeUsage(RESPONSE), {
    weekPercent: 4,
    sessionPercent: 28,
    weekResets: "Oct 4, 12am (Asia/Novosibirsk)",
  });
});

test("незнакомая форма ответа — доля неизвестна, а не ноль", () => {
  assert.equal(parseClaudeUsage(""), undefined);
  assert.equal(parseClaudeUsage("Usage information is unavailable"), undefined);
  // Строка одной модели не принимается за общую неделю.
  assert.equal(parseClaudeUsage("Current week (Fable): 0% used"), undefined);
});

test("ответ --output-format json: доля — из поля result, ошибка — неизвестно", () => {
  assert.equal(parseUsageOutput(JSON.stringify({ type: "result", is_error: false, result: RESPONSE }))?.weekPercent, 4);
  assert.equal(parseUsageOutput(JSON.stringify({ type: "result", is_error: true, result: RESPONSE })), undefined);
  assert.equal(parseUsageOutput("не json"), undefined);
});

test("запрос /usage: без файла сессии, ответ — доля недели", async () => {
  const fraction = await fetchClaudeUsage({ command: process.execPath, commandArgs: [FAKE_CLAUDE], cwd: process.cwd(), shell: false });
  assert.equal(fraction?.weekPercent, 4);
});

test("/usage спрашивается из пустого каталога, а не из проекта", () => {
  // Замер 28.09: /usage запускает хук SessionStart настроек проекта.
  const catalog = usageDirectory();
  assert.notEqual(catalog, process.cwd());
  assert.deepEqual(readdirSync(catalog), []);
  assert.equal(usageDirectory(), catalog, "один каталог на процесс");
});

test("запрос /usage, который не отвечает, обрывается по сроку", async () => {
  const start = Date.now();
  await assert.rejects(
    fetchClaudeUsage({
      command: process.execPath,
      commandArgs: [FAKE_CLAUDE, "--hang-usage"],
      cwd: process.cwd(),
      shell: false,
      timeoutMs: 300,
    }),
    /не ответил/,
  );
  assert.ok(Date.now() - start < 5000);
});
