/**
 * Блоки «проверка» в ответе Gemini (спецификация 05.10, ступень 3).
 *
 * Скрипт Gemini панель выполняет сама — значит, разбор решает, какой код
 * будет запущен. Поэтому он строгий: только блок с заголовком «проверка
 * python», только закрытый (оборванный ответ не запускается наполовину),
 * не внутри другого блока кода (пример в разметке — не поручение) и не больше
 * трёх.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { MAX_CHECK_BLOCKS, parseCheckBlocks, readCheckBlocks } from "../out/checkBlocks.js";

const FENCE = "```";

test("блок «проверка»: имя — из первой строки «# имя: …», код — весь блок вместе с ней", () => {
  const text = [
    "Просадку проверю скриптом.",
    "",
    `${FENCE}проверка python`,
    "# имя: просадка на отрезке [-0.2, 0]",
    "import numpy as np",
    "print(np.minimum.accumulate([0, -0.2]))",
    FENCE,
    "",
    "Замечание: просадка посчитана неверно.",
    "ВЕРДИКТ: ЕСТЬ ЗАМЕЧАНИЯ",
  ].join("\n");
  assert.deepEqual(parseCheckBlocks(text), [
    {
      name: "просадка на отрезке [-0.2, 0]",
      code: "# имя: просадка на отрезке [-0.2, 0]\nimport numpy as np\nprint(np.minimum.accumulate([0, -0.2]))",
    },
  ]);
});

test("блок без строки имени — «проверка N» по порядку блоков", () => {
  const text = [`${FENCE}проверка python`, "print(1)", FENCE, "текст", `${FENCE}проверка python`, "# имя: вторая", "print(2)", FENCE, `${FENCE}проверка python`, "print(3)", FENCE].join("\n");
  assert.deepEqual(
    parseCheckBlocks(text).map((b) => b.name),
    ["проверка 1", "вторая", "проверка 3"],
  );
});

test("больше трёх блоков — выполняются первые три, лишние названы числом", () => {
  const block = (i) => [`${FENCE}проверка python`, `print(${i})`, FENCE].join("\n");
  const text = [1, 2, 3, 4, 5].map(block).join("\n\n");
  assert.equal(MAX_CHECK_BLOCKS, 3);
  const { blocks, dropped } = readCheckBlocks(text);
  assert.deepEqual(blocks.map((b) => b.code), ["print(1)", "print(2)", "print(3)"]);
  assert.equal(dropped, 2);
  assert.equal(parseCheckBlocks(text).length, 3);
});

test("обычные блоки кода и примеры внутри другого блока — не «проверка»", () => {
  const text = [
    `${FENCE}python`,
    "print('пример разработчика')",
    FENCE,
    // Пример формата в разметке: блок «проверка» внутри четырёх кавычек.
    "````markdown",
    `${FENCE}проверка python`,
    "print('пример внутри')",
    FENCE,
    "````",
    `${FENCE}проверкаpython`,
    "print('слитно — не заголовок')",
    FENCE,
  ].join("\n");
  assert.deepEqual(parseCheckBlocks(text), []);
});

test("незакрытый блок не запускается: оборванный ответ — не скрипт", () => {
  const text = ["Начало.", `${FENCE}проверка python`, "# имя: оборван", "for i in range(3):"].join("\n");
  assert.deepEqual(parseCheckBlocks(text), []);
});

test("ограда — по виду и длине: ```` закрывается только ````, ~~~ — тоже ограда; регистр и CRLF не мешают", () => {
  const text = [
    "````Проверка Python",
    "# имя: с вложенной оградой",
    "print('```')",
    FENCE,
    "````",
    "~~~проверка python",
    "print('тильды')",
    "~~~",
  ].join("\r\n");
  assert.deepEqual(parseCheckBlocks(text), [
    { name: "с вложенной оградой", code: "# имя: с вложенной оградой\nprint('```')\n```" },
    { name: "проверка 2", code: "print('тильды')" },
  ]);
});

test("ответ без блоков — пусто, ничего не отброшено", () => {
  assert.deepEqual(readCheckBlocks("Всё в порядке.\nВЕРДИКТ: ПРИНЯТО"), { blocks: [], dropped: 0 });
});
