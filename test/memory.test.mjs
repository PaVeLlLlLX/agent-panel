/**
 * Разбор ответа команды поиска по памяти: тот же протокол, что у хука
 * UserPromptSubmit Claude Code, чтобы один поиск служил и сессиям Claude, и
 * панели.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { parseMemoryOutput } from "../out/memory.js";

const строки = (...с) => с.join(String.fromCharCode(10));

test("заметки и их заголовки из additionalContext хука", () => {
  const ответ = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: строки("# Заметки памяти по теме вопроса", "", "## Первая", "   путь", "", "## Вторая"),
    },
    suppressOutput: true,
  });
  const п = parseMemoryOutput(ответ);
  assert.deepEqual(п.titles, ["Первая", "Вторая"]);
  assert.match(п.text, /## Первая/);
});

test("пустой вывод, не JSON и ответ без контекста — заметок нет", () => {
  assert.equal(parseMemoryOutput(""), undefined);
  assert.equal(parseMemoryOutput("не json"), undefined);
  assert.equal(parseMemoryOutput(JSON.stringify({ hookSpecificOutput: {} })), undefined);
});
