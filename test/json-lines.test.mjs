/**
 * Строки JSON-протокола из stdout агента.
 *
 * Живой прогон 02.10: Codex возобновлял ветку с историей на 14 МБ, в тексте
 * были U+2028 и U+2029. JSON их не экранирует, а readline считает концом
 * строки — ответ thread/resume разрезало на три куска, ни один не
 * разобрался, и запуск ждал ответа вечно.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";

import { readJsonLines } from "../out/adapters/jsonLines.js";

function feed(chunks) {
  const input = new PassThrough();
  const lines = [];
  readJsonLines(input, (line) => lines.push(line));
  for (const chunk of chunks) input.write(chunk);
  input.end();
  return new Promise((resolve) => input.on("end", () => setImmediate(() => resolve(lines))));
}

test("строка делится только по \\n: U+2028, U+2029 и одиночный \\r остаются внутри", async () => {
  const record = JSON.stringify({ text: "до после конец\rещё" });
  assert.deepEqual(await feed([`${record}\n{"b":2}\n`]), [record, '{"b":2}']);
});

test("\\r перед \\n отрезается, как у readline", async () => {
  assert.deepEqual(await feed(['{"a":1}\r\n{"b":2}\r\n']), ['{"a":1}', '{"b":2}']);
});

test("строка, разорванная между кусками, и буква UTF-8 на границе собираются", async () => {
  const bytes = Buffer.from('{"t":"жук"}\n', "utf8");
  // Граница проходит посреди двухбайтовой «ж».
  const cut = bytes.indexOf(0xd0) + 1;
  assert.deepEqual(await feed([bytes.subarray(0, cut), bytes.subarray(cut)]), ['{"t":"жук"}']);
});

test("последняя строка без \\n отдаётся по концу потока", async () => {
  assert.deepEqual(await feed(['{"a":1}\n{"b":2}']), ['{"a":1}', '{"b":2}']);
});

test("после close строки больше не приходят", async () => {
  const input = new PassThrough();
  const lines = [];
  const reader = readJsonLines(input, (line) => lines.push(line));
  input.write('{"a":1}\n');
  await new Promise((resolve) => setImmediate(resolve));
  reader.close();
  input.write('{"b":2}\n');
  input.end();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(lines, ['{"a":1}']);
});
