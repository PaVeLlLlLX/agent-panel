/**
 * Разбор ответа команды поиска по памяти: тот же протокол, что у хука
 * UserPromptSubmit Claude Code, чтобы один поиск служил и сессиям Claude, и
 * панели.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { parseMemoryOutput } from "../out/memory.js";

const lines = (...s) => s.join(String.fromCharCode(10));

test("заметки и их заголовки из additionalContext хука", () => {
  const reply = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: lines("# Заметки памяти по теме вопроса", "", "## Первая", "   путь", "", "## Вторая"),
    },
    suppressOutput: true,
  });
  const p = parseMemoryOutput(reply);
  assert.deepEqual(p.titles, ["Первая", "Вторая"]);
  assert.match(p.text, /## Первая/);
});

test("пустой вывод, не JSON и ответ без контекста — заметок нет", () => {
  assert.equal(parseMemoryOutput(""), undefined);
  assert.equal(parseMemoryOutput("не json"), undefined);
  assert.equal(parseMemoryOutput(JSON.stringify({ hookSpecificOutput: {} })), undefined);
});

import { runMemorySearch } from "../out/memory.js";

test("поиск, который не отвечает, обрывается по сроку, а не держит сообщение", async () => {
  const start = Date.now();
  await assert.rejects(
    runMemorySearch(`"${process.execPath}" -e "setTimeout(() => {}, 60000)"`, process.cwd(), "вопрос", 300),
    /не ответил/,
  );
  assert.ok(Date.now() - start < 5000, "обрыв по сроку занял слишком долго");
});

test("по умолчанию поиск ждёт не больше 10 секунд", async () => {
  const { MEMORY_TIMEOUT_MS } = await import("../out/memory.js");
  assert.equal(MEMORY_TIMEOUT_MS, 10_000);
});
