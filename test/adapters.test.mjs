/**
 * Проверка адаптеров на фальшивых процессах, воспроизводящих протокол.
 *
 * Зачем отдельно от координатора. Тесты координатора подменяют агентов
 * заглушками и поэтому не видели ни одной ошибки самих адаптеров: чтение
 * threadId вместо thread.id, agent_message вместо agentMessage, отсутствие
 * обработчика дельт. Всё это нашёл рецензент чтением кода. Здесь адаптер
 * запускает настоящий дочерний процесс и разбирает настоящие строки.
 *
 * И свойства, которые показал живой прогон панели:
 *   * служебный лог агента из stderr показывался красной репликой в беседе,
 *     вместе с цветовыми кодами;
 *   * обычное закрытие комнаты порождало «процесс завершился: SIGTERM» как
 *     ошибку;
 *   * пользовательские хуки Claude срабатывали внутри сессии панели.
 *
 * Каждый тест останавливает процесс в finally: оставшийся жить фальшивый
 * агент держит открытые каналы, и весь прогон повисает.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ClaudeAdapter } from "../out/adapters/claude.js";
import { CodexAdapter } from "../out/adapters/codex.js";

const фальшивка = (имя) => fileURLToPath(new URL(`../fixtures/${имя}`, import.meta.url));
const ФАЛЬШИВЫЙ_CLAUDE = фальшивка("fake-claude.mjs");
const ФАЛЬШИВЫЙ_CODEX = фальшивка("fake-codex.mjs");
const НЕТ_ТАКОЙ_КОМАНДЫ = "nesushchestvuyushchaya-komanda-agent-panel";

function собиратель() {
  const события = [];
  return { события, sink: (е) => события.push(е) };
}

async function дождаться(условие, сообщение, предел = 10000) {
  const начало = Date.now();
  while (Date.now() - начало < предел) {
    if (условие()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail(`не дождались: ${сообщение}`);
}

const каталог = () => mkdtempSync(join(tmpdir(), "adapter-"));
const ошибки = (события) => события.filter((е) => е.kind === "error");

function claude(с, доп = {}) {
  return new ClaudeAdapter(
    { command: "node", commandArgs: [ФАЛЬШИВЫЙ_CLAUDE], cwd: каталог(), ...доп },
    с.sink,
  );
}

function codex(с, доп = {}) {
  return new CodexAdapter(
    { command: "node", commandArgs: [ФАЛЬШИВЫЙ_CODEX], cwd: каталог(), ...доп },
    с.sink,
  );
}

// ---------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------

test("Claude: процесс поднимается сам при первой отправке, ответ и поток доходят", async () => {
  const с = собиратель();
  const а = claude(с);
  try {
    await а.send({ text: "здравствуй", from: "human" });
    await дождаться(() => с.события.some((е) => е.kind === "turn_completed"), "конец хода");
    assert.ok(с.события.some((е) => е.kind === "message" && е.text === "привет"));
    assert.deepEqual(
      с.события.filter((е) => е.kind === "text_delta").map((е) => е.text),
      ["при", "вет"],
    );
    assert.equal(а.sessionId, "fake-claude-session");
  } finally {
    await а.stop();
  }
});

test("Claude: пользовательские настройки с хуками по умолчанию не загружаются", async () => {
  const с = собиратель();
  const а = claude(с);
  try {
    await а.start();
    await дождаться(() => с.события.some((е) => е.raw?.argv), "запись запуска");
    const argv = с.события.find((е) => е.raw?.argv).raw.argv;
    const i = argv.indexOf("--setting-sources");
    assert.ok(i >= 0, "без флага в сессии панели срабатывают хуки владельца");
    assert.equal(argv[i + 1], "project,local");
  } finally {
    await а.stop();
  }
});

test("Claude: stderr — диагностика без цветовых кодов, а не ошибка в беседе", async () => {
  const с = собиратель();
  const а = claude(с);
  try {
    await а.start();
    await дождаться(
      () => с.события.some((е) => е.kind === "diagnostic" && /WARN/.test(е.text ?? "")),
      "диагностика",
    );
    const д = с.события.filter((е) => е.kind === "diagnostic");
    assert.ok(д.every((е) => !/\x1b\[/.test(е.text ?? "")), "цветовые коды не вычищены");
    assert.ok(д.every((е) => е.visibility === "stream"), "диагностика не передаётся агенту");
    assert.deepEqual(ошибки(с.события), []);
  } finally {
    await а.stop();
  }
});

test("Claude: ход с ошибкой — завершение хода с отметкой провала", async () => {
  const с = собиратель();
  const а = claude(с);
  try {
    await а.send({ text: "ОШИБКА-ХОДА", from: "human" });
    await дождаться(() => с.события.some((е) => е.kind === "turn_completed"), "конец хода");
    const конец = с.события.find((е) => е.kind === "turn_completed");
    assert.equal(конец.failed, true);
    assert.equal(а.busy, false);
  } finally {
    await а.stop();
  }
});

test("Claude: отказы в разрешениях приходят в завершении хода, ход не провален", async () => {
  // Отказы приходят при is_error: false, поэтому по failed их не отличить.
  const с = собиратель();
  const а = claude(с);
  try {
    await а.send({ text: "ОТКАЗ", from: "human" });
    await дождаться(() => с.события.some((е) => е.kind === "turn_completed"), "конец хода");
    const конец = с.события.find((е) => е.kind === "turn_completed");
    assert.notEqual(конец.failed, true);
    assert.deepEqual(конец.denials, ["Bash: git -C C:\\agent-panel show d748e88"]);
  } finally {
    await а.stop();
  }
});

test("Claude: плановая остановка не показывается как ошибка", async () => {
  const с = собиратель();
  const а = claude(с);
  try {
    await а.send({ text: "здравствуй", from: "human" });
    await дождаться(() => с.события.some((е) => е.kind === "turn_completed"), "конец хода");
    await а.stop();
    await дождаться(
      () => с.события.some((е) => е.kind === "diagnostic" && /остановлен/.test(е.text ?? "")),
      "отметка об остановке",
    );
    assert.deepEqual(ошибки(с.события), [], "закрытие комнаты — не авария");
  } finally {
    await а.stop();
  }
});

test("Claude: внезапное падение — ошибка с отметкой, следующая отправка поднимает ту же сессию", async () => {
  const с = собиратель();
  const а = claude(с);
  try {
    await а.send({ text: "здравствуй", from: "human" });
    await дождаться(() => с.события.some((е) => е.kind === "turn_completed"), "первый ход");
    await а.send({ text: "УПАСТЬ", from: "human" });
    await дождаться(() => ошибки(с.события).length > 0, "ошибка падения");
    assert.equal(ошибки(с.события)[0].failed, true);
    assert.equal(а.busy, false, "мёртвый процесс не может оставаться занятым");

    await а.send({ text: "здравствуй снова", from: "human" });
    await дождаться(
      () => с.события.filter((е) => е.kind === "message").length === 2,
      "ответ после перезапуска",
    );
    const второй = с.события.filter((е) => е.raw?.argv).at(-1).raw.argv;
    const i = второй.indexOf("--resume");
    assert.ok(i >= 0, "без --resume перезапуск потерял бы историю");
    assert.equal(второй[i + 1], "fake-claude-session");
  } finally {
    await а.stop();
  }
});

test("Claude: session_id сообщается обратным вызовом", async () => {
  const с = собиратель();
  const полученные = [];
  const а = claude(с, { onSessionId: (id) => полученные.push(id) });
  try {
    await а.start();
    await дождаться(() => полученные.length > 0, "обратный вызов");
    assert.deepEqual(полученные, ["fake-claude-session"]);
  } finally {
    await а.stop();
  }
});

test("Claude: несуществующая команда — ошибка с отметкой, а не падение панели", async () => {
  // Без обработчиков error на процессе и его stdin необработанное
  // исключение уронило бы хост расширений VS Code целиком.
  const с = собиратель();
  const а = new ClaudeAdapter({ command: НЕТ_ТАКОЙ_КОМАНДЫ, cwd: каталог() }, с.sink);
  try {
    try {
      await а.send({ text: "здравствуй", from: "human" });
    } catch {
      // Отказ отправки допустим; недопустимо падение процесса.
    }
    await дождаться(
      () => ошибки(с.события).some((е) => е.failed === true),
      "ошибка запуска",
    );
    assert.equal(а.busy, false);
  } finally {
    await а.stop();
  }
});

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

test("Codex: ветка из thread.id, процесс поднимается сам, ответ и поток доходят", async () => {
  const с = собиратель();
  const а = codex(с);
  try {
    await а.send({ text: "здравствуй", from: "human" });
    await дождаться(() => с.события.some((е) => е.kind === "turn_completed"), "конец хода");
    assert.equal(а.sessionId, "fake-thread-1");
    assert.ok(с.события.some((е) => е.kind === "message" && е.text === "привет"));
    assert.deepEqual(
      с.события.filter((е) => е.kind === "text_delta").map((е) => е.text),
      ["при", "вет"],
    );
  } finally {
    await а.stop();
  }
});

test("Codex: ход со статусом failed — завершение с отметкой провала", async () => {
  const с = собиратель();
  const а = codex(с);
  try {
    await а.send({ text: "ОШИБКА-ХОДА", from: "human" });
    await дождаться(() => с.события.some((е) => е.kind === "turn_completed"), "конец хода");
    const конец = с.события.find((е) => е.kind === "turn_completed");
    assert.equal(конец.failed, true);
    assert.match(конец.text ?? "", /сбой модели/);
    assert.equal(а.busy, false);
  } finally {
    await а.stop();
  }
});

test("Codex: stderr — диагностика без цветовых кодов, а не ошибка в беседе", async () => {
  // Ровно та строка, что в живом прогоне показалась красной репликой.
  const с = собиратель();
  const а = codex(с);
  try {
    await а.start();
    await дождаться(
      () => с.события.some((е) => е.kind === "diagnostic" && /ERROR/.test(е.text ?? "")),
      "диагностика",
    );
    const д = с.события.filter((е) => е.kind === "diagnostic");
    assert.ok(д.every((е) => !/\x1b\[/.test(е.text ?? "")));
    assert.deepEqual(ошибки(с.события), []);
  } finally {
    await а.stop();
  }
});

test("Codex: запрос на изменение файла отклоняется панелью", async () => {
  const с = собиратель();
  const а = codex(с);
  try {
    await а.send({ text: "ЗАПИСАТЬ", from: "human" });
    await дождаться(() => с.события.some((е) => е.kind === "approval_decided"), "решение");
    assert.equal(а.решения[0].allow, false);
    await дождаться(
      () => с.события.some((е) => /ответ клиента: error/.test(е.text ?? "")),
      "фальшивый сервер получил отказ",
    );
  } finally {
    await а.stop();
  }
});

test("Codex: плановая остановка не показывается как ошибка", async () => {
  const с = собиратель();
  const а = codex(с);
  try {
    await а.send({ text: "здравствуй", from: "human" });
    await дождаться(() => с.события.some((е) => е.kind === "turn_completed"), "конец хода");
    await а.stop();
    await дождаться(
      () => с.события.some((е) => е.kind === "diagnostic" && /остановлен/.test(е.text ?? "")),
      "отметка об остановке",
    );
    assert.deepEqual(ошибки(с.события), []);
  } finally {
    await а.stop();
  }
});

test("Codex: идентификатор ветки сообщается обратным вызовом", async () => {
  const с = собиратель();
  const полученные = [];
  const а = codex(с, { onSessionId: (id) => полученные.push(id) });
  try {
    await а.start();
    await дождаться(() => полученные.length > 0, "обратный вызов");
    assert.equal(полученные[0], "fake-thread-1");
  } finally {
    await а.stop();
  }
});

test("Codex: несуществующая команда — отправка отклоняется, панель не падает", async () => {
  const с = собиратель();
  const а = new CodexAdapter({ command: НЕТ_ТАКОЙ_КОМАНДЫ, cwd: каталог() }, с.sink);
  try {
    await assert.rejects(а.send({ text: "здравствуй", from: "human" }));
    await дождаться(
      () => ошибки(с.события).some((е) => е.failed === true),
      "ошибка запуска",
    );
    assert.equal(а.busy, false, "отказ запуска не должен оставлять агента занятым");
  } finally {
    await а.stop();
  }
});
