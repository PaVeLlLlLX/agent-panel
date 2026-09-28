/**
 * Сводка действий агента в одну строку.
 *
 * Зачем. В живом прогоне колонка действий заняла половину панели: 22 вызова
 * инструментов и 44 тысячи символов вывода за 9 минут, каждый вызов отдельной
 * карточкой с аргументами и выводом. Человеку нужен не протокол, а итог хода:
 * «Claude: 9 команд, 2 чтения, 3 записи в память». Подробности — по клику.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const { plural, toolCategory, summarizeTools, stickToBottom } = require_("../media/format.js");

test("склонение числительных по правилам русского языка", () => {
  const forms = ["команда", "команды", "команд"];
  const waiter = {
    1: "команда", 2: "команды", 4: "команды", 5: "команд", 11: "команд",
    12: "команд", 14: "команд", 21: "команда", 22: "команды", 25: "команд",
    111: "команд", 0: "команд",
  };
  for (const [n, form] of Object.entries(waiter)) {
    assert.equal(plural(Number(n), forms), form, `для ${n}`);
  }
});

test("инструменты Claude раскладываются по видам", () => {
  assert.equal(toolCategory("Bash"), "command");
  assert.equal(toolCategory("Read"), "read");
  assert.equal(toolCategory("Write"), "edit");
  assert.equal(toolCategory("Edit"), "edit");
  assert.equal(toolCategory("Glob"), "search");
  assert.equal(toolCategory("Grep"), "search");
  assert.equal(toolCategory("mcp__om__remember"), "memory");
  assert.equal(toolCategory("mcp__om__record_work"), "memory");
  assert.equal(toolCategory("mcp__om__search"), "mcp");
  assert.equal(toolCategory("ToolSearch"), "other");
});

test("элементы Codex раскладываются по видам", () => {
  assert.equal(toolCategory("commandExecution"), "command");
  assert.equal(toolCategory("fileChange"), "edit");
  assert.equal(toolCategory("mcpToolCall"), "mcp");
  assert.equal(toolCategory("webSearch"), "search");
  assert.equal(toolCategory("что-то новое"), "other");
});

test("сводка на реальных числах из журнала живого прогона", () => {
  const calls = [
    ...Array(9).fill("Bash"),
    ...Array(2).fill("Read"),
    ...Array(3).fill("mcp__om__remember"),
  ];
  assert.equal(summarizeTools(calls), "9 команд, 2 чтения, 3 записи в память");
});

test("порядок видов в сводке не зависит от порядка вызовов", () => {
  assert.equal(
    summarizeTools(["mcp__om__remember", "Read", "Bash"]),
    summarizeTools(["Bash", "Read", "mcp__om__remember"]),
  );
});

test("прочие и MCP идут в конце", () => {
  assert.equal(
    summarizeTools(["ToolSearch", "mcp__om__search"]),
    "1 обращение к MCP, 1 прочее действие",
  );
});

test("единственное число и двадцать одно", () => {
  assert.equal(summarizeTools(["Write"]), "1 правка");
  assert.equal(summarizeTools(Array(21).fill("Read")), "21 чтение");
});

test("без вызовов — пустая сводка", () => {
  assert.equal(summarizeTools([]), "");
});

test("прокрутка следует за текстом, только если человек уже внизу", () => {
  // Жалоба владельца 27.09: во время генерации прокрутка силой утягивала вниз,
  // и нельзя было читать текст выше.
  assert.equal(stickToBottom(2000, 1500, 500), true, "ровно внизу");
  assert.equal(stickToBottom(2000, 1460, 500), true, "в 40 px от низа — ещё внизу");
  assert.equal(stickToBottom(2000, 1200, 500), false, "читает выше — не трогать");
  assert.equal(stickToBottom(400, 0, 500), true, "всё помещается — внизу");
});
