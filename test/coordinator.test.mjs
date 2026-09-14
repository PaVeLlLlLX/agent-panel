/**
 * Проверка координатора: приёмочные критерии, которые можно проверить без
 * VS Code и без живых агентов.
 *
 * Адаптеры подменяются заглушками намеренно. Живой запуск проверяет протокол,
 * а здесь проверяются правила маршрутизации — то есть решения, а не связь.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Coordinator } from "../out/coordinator.js";
import { Journal } from "../out/journal.js";

class Заглушка {
  constructor(id) {
    this.id = id;
    this.busy = false;
    this.sessionId = `${id}-сессия`;
    this.полученное = [];
    this.прерван = 0;
    this.остановлен = 0;
  }
  async start() {}
  async send(prompt) {
    this.полученное.push(prompt);
  }
  async interrupt() {
    this.прерван += 1;
  }
  async stop() {
    this.остановлен += 1;
  }
}

function комната(предел = 3) {
  const каталог = mkdtempSync(join(tmpdir(), "panel-"));
  const журнал = new Journal(join(каталог, "j.sqlite"));
  журнал.ensureRoom("r", каталог);
  const claude = new Заглушка("claude");
  const codex = new Заглушка("codex");
  const события = [];
  const к = new Coordinator(claude, codex, журнал, {
    room: "r",
    cwd: каталог,
    maxAutoRounds: предел,
    onEvent: (е) => события.push(е),
  });
  return { к, claude, codex, журнал, события, каталог };
}

/**
 * Ожидание по условию.
 *
 * Один setImmediate здесь не годится: пересылка материала ждёт снимок
 * версии, а он делается вызовом git. Первая версия этих тестов падала
 * именно на этом, и падение было в тесте, а не в продукте.
 */
async function дождаться(условие, сообщение, предел = 5000) {
  const начало = Date.now();
  while (Date.now() - начало < предел) {
    if (условие()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail(`не дождались: ${сообщение}`);
}

function событие(agent, kind, доп = {}) {
  return {
    id: `${kind}-${Math.random().toString(36).slice(2)}`,
    agent,
    kind,
    visibility: kind === "text_delta" || kind === "tool_running" ? "stream" : "turn",
    at: Date.now(),
    ...доп,
  };
}

test("сообщение человека доходит обоим агентам", async () => {
  const { к, claude, codex, журнал } = комната();
  await к.fromHuman("проверьте постановку", "both");
  assert.equal(claude.полученное.length, 1);
  assert.equal(codex.полученное.length, 1);
  assert.match(claude.полученное[0].text, /проверьте постановку/);
  assert.equal(claude.полученное[0].from, "human");
  журнал.close();
});

test("адресат учитывается: сообщение одному не уходит второму", async () => {
  const { к, claude, codex, журнал } = комната();
  await к.fromHuman("только тебе", "codex");
  assert.equal(claude.полученное.length, 0);
  assert.equal(codex.полученное.length, 1);
  журнал.close();
});

test("ответ одного доходит до другого без копирования человеком", async () => {
  const { к, claude, codex, журнал } = комната();
  await к.fromHuman("задача", "claude");
  claude.полученное.length = 0;
  к.handle(событие("claude", "message", { text: "я предлагаю подход" }));
  к.handle(событие("claude", "turn_completed"));
  await дождаться(() => codex.полученное.length > 0, "передача рецензенту");
  assert.equal(codex.полученное.length, 1, "передаётся только материал агента");
  assert.match(codex.полученное[0].text, /я предлагаю подход/);
  assert.equal(codex.полученное[0].from, "claude");
  assert.ok(
    !/задача/.test(codex.полученное[0].text),
    "реплика человека не должна пересылаться как материал агента",
  );
  журнал.close();
});

test("поток НЕ передаётся второму агенту", async () => {
  const { к, claude, codex, журнал } = комната();
  await к.fromHuman("задача", "claude");
  codex.полученное.length = 0;
  к.handle(событие("claude", "text_delta", { text: "по" }));
  к.handle(событие("claude", "text_delta", { text: "ток" }));
  к.handle(событие("claude", "turn_completed"));
  await new Promise((r) => setImmediate(r));
  assert.equal(
    codex.полученное.length,
    0,
    "дельты не должны порождать передачу: иначе каждая буква запускала бы ответ",
  );
  журнал.close();
});

test("сырой вывод инструмента передаётся целиком и помечен как сырой", async () => {
  const { к, codex, журнал } = комната();
  await к.fromHuman("задача", "claude");
  codex.полученное.length = 0;
  к.handle(
    событие("claude", "tool_result", {
      tool: "Bash",
      callId: "c1",
      text: "398 passed, 9 deselected",
    }),
  );
  к.handle(событие("claude", "turn_completed"));
  await дождаться(() => codex.полученное.length > 0, "передача сырого вывода");
  const текст = codex.полученное[0].text;
  assert.match(текст, /СЫРОЙ вывод инструмента Bash/);
  assert.match(текст, /398 passed, 9 deselected/);
  журнал.close();
});

test("предел автоматических раундов соблюдается", async () => {
  const { к, claude, codex, журнал, события } = комната(2);
  await к.fromHuman("задача", "claude");
  for (let i = 0; i < 6; i += 1) {
    const кто = i % 2 === 0 ? "claude" : "codex";
    к.handle(событие(кто, "message", { text: `реплика ${i}` }));
    к.handle(событие(кто, "turn_completed"));
    await new Promise((r) => setTimeout(r, 120));
  }
  const передач = claude.полученное.length + codex.полученное.length;
  assert.ok(
    передач <= 1 + 2,
    `передач ${передач}: предел 2 раунда плюс исходное сообщение человека`,
  );
  assert.ok(
    события.some((е) => /Предел автоматических раундов/.test(е.text ?? "")),
    "человек должен увидеть, что автоматика остановилась",
  );
  журнал.close();
});

test("предел ноль отключает автоматику полностью", async () => {
  const { к, codex, журнал } = комната(0);
  await к.fromHuman("задача", "claude");
  codex.полученное.length = 0;
  к.handle(событие("claude", "message", { text: "готово" }));
  к.handle(событие("claude", "turn_completed"));
  await new Promise((r) => setImmediate(r));
  assert.equal(codex.полученное.length, 0);
  журнал.close();
});

test("сообщение человека сбрасывает счётчик раундов", async () => {
  const { к, журнал } = комната(2);
  await к.fromHuman("первая задача", "claude");
  к.handle(событие("claude", "message", { text: "а" }));
  к.handle(событие("claude", "turn_completed"));
  await дождаться(() => к.round === 1, "раунд должен вырасти");
  await к.fromHuman("новая задача", "claude");
  assert.equal(к.round, 0, "новая задача человека начинает счёт заново");
  журнал.close();
});

test("отправка занятому агенту не теряется, а ждёт очереди", async () => {
  const { к, claude, codex, журнал } = комната();
  await к.fromHuman("задача", "claude");
  codex.busy = true;
  codex.полученное.length = 0;
  к.handle(событие("claude", "message", { text: "материал" }));
  к.handle(событие("claude", "turn_completed"));
  await new Promise((r) => setImmediate(r));
  assert.equal(codex.полученное.length, 0, "занятому не отправляем");
  codex.busy = false;
  к.handle(событие("codex", "turn_completed"));
  await дождаться(() => codex.полученное.length === 1, "выгрузка очереди");
  журнал.close();
});

test("остановка останавливает обоих и глушит автоматику", async () => {
  const { к, claude, codex, журнал } = комната();
  await к.stopAll();
  assert.equal(claude.остановлен, 1);
  assert.equal(codex.остановлен, 1);
  к.handle(событие("claude", "message", { text: "после остановки" }));
  к.handle(событие("claude", "turn_completed"));
  await new Promise((r) => setImmediate(r));
  assert.equal(codex.полученное.length, 0);
  журнал.close();
});

test("каждое передаваемое событие помечено версией файлов", async () => {
  const { к, журнал, события } = комната();
  await к.fromHuman("задача", "claude");
  к.handle(событие("claude", "message", { text: "ответ" }));
  const помеченные = события.filter((е) => е.agent === "claude" && е.snapshot);
  assert.ok(
    помеченные.length > 0,
    "без привязки к версии замечания будут относиться к неизвестному состоянию",
  );
  журнал.close();
});

test("история переживает перезапуск вместе с привязкой сессий", async () => {
  const { к, журнал, каталог } = комната();
  await к.fromHuman("запомни это", "claude");
  журнал.bindSessions("r", "claude-s", "codex-t");
  журнал.close();

  const второй = new Journal(join(каталог, "j.sqlite"));
  const история = второй.history("r");
  assert.ok(
    история.some((е) => е.text === "запомни это"),
    "история должна читаться после перезапуска",
  );
  const привязка = второй.binding("r");
  assert.equal(привязка.claudeSessionId, "claude-s");
  assert.equal(привязка.codexThreadId, "codex-t");
  второй.close();
});

test("привязка не перетирается неизвестным значением", async () => {
  const { журнал, каталог } = комната();
  журнал.bindSessions("r", "claude-s", "codex-t");
  журнал.bindSessions("r", undefined, undefined);
  const п = журнал.binding("r");
  assert.equal(п.claudeSessionId, "claude-s", "потеря привязки хуже её отсутствия");
  assert.equal(п.codexThreadId, "codex-t");
  журнал.close();
});

test("материал одного агента не приписывается другому", async () => {
  // Нашла Astra. Один общий накопитель принимал материал обоих агентов, и
  // после завершения хода ВСЁ содержимое уходило от имени завершившего.
  // Сценарий обычный, потому что адресат «Оба» стоит по умолчанию: Codex
  // мог получить свой же комментарий с подписью «от разработчика Claude».
  const { к, claude, codex, журнал } = комната();
  await к.fromHuman("задача", "both");
  claude.полученное.length = 0;
  codex.полученное.length = 0;

  к.handle(событие("codex", "message", { text: "замечание рецензента" }));
  к.handle(событие("claude", "message", { text: "ответ разработчика" }));
  к.handle(событие("claude", "turn_completed"));
  await дождаться(() => codex.полученное.length > 0, "передача рецензенту");

  const текст = codex.полученное[0].text;
  assert.match(текст, /ответ разработчика/);
  assert.ok(
    !/замечание рецензента/.test(текст),
    "рецензенту нельзя возвращать его же реплику от имени разработчика",
  );
  assert.equal(codex.полученное[0].from, "claude");
  журнал.close();
});

test("очередь занятому агенту сохраняет порядок сообщений", async () => {
  // Выгрузка шла с конца массива, поэтому несколько отложенных сообщений
  // приходили в обратном порядке.
  const { к, claude, codex, журнал } = комната(9);
  await к.fromHuman("задача", "claude");
  codex.busy = true;
  codex.полученное.length = 0;

  for (const метка of ["первое", "второе", "третье"]) {
    к.handle(событие("claude", "message", { text: метка }));
    к.handle(событие("claude", "turn_completed"));
    await new Promise((r) => setTimeout(r, 60));
  }
  assert.equal(codex.полученное.length, 0, "занятому не отправляем");

  codex.busy = false;
  к.handle(событие("codex", "turn_completed"));
  await дождаться(() => codex.полученное.length === 3, "выгрузка очереди");
  assert.match(codex.полученное[0].text, /первое/);
  assert.match(codex.полученное[1].text, /второе/);
  assert.match(codex.полученное[2].text, /третье/);
  журнал.close();
});

test("сообщение человека не меняет версию идущего хода агента", async () => {
  // Метка версии была одна на комнату. Реплика человека посреди проверки
  // переписывала её, и замечание оказывалось привязано к состоянию, которого
  // рецензент не видел.
  const { к, журнал, события } = комната();
  await к.fromHuman("первая задача", "claude");
  к.handle(событие("claude", "message", { text: "начал работу" }));
  const версияДо = события.filter((е) => е.agent === "claude").at(-1).snapshot;

  await к.fromHuman("а ещё вот что", "codex");
  к.handle(событие("claude", "message", { text: "продолжаю тот же ход" }));
  const версияПосле = события.filter((е) => е.agent === "claude").at(-1).snapshot;

  assert.equal(
    версияПосле,
    версияДо,
    "версия идущего хода не должна меняться от чужой реплики",
  );
  журнал.close();
});

test("полная запись протокола сохраняется отдельно от показанного текста", async () => {
  // Текст обрезается до 64 000 символов для показа. Первая версия журнала
  // хранила только обрезанное, и окончание большого вывода терялось.
  const { к, журнал } = комната();
  await к.fromHuman("задача", "claude");
  const длинный = "x".repeat(200_000);
  к.handle(
    событие("claude", "tool_result", {
      tool: "Bash",
      callId: "c9",
      text: "обрезано для показа",
      raw: { content: длинный },
    }),
  );
  const события_ = журнал.history("r");
  const запись = события_.find((е) => е.callId === "c9");
  assert.ok(запись, "событие должно быть в журнале");
  const сырое = журнал.rawOf("r", запись.id);
  assert.equal(
    сырое.content.length,
    200_000,
    "полный вывод обязан оставаться доступным",
  );
  журнал.close();
});

test("журнал после закрытия не роняет позднее событие", async () => {
  // Процесс агента может выдать exit уже после закрытия комнаты.
  const { к, журнал } = комната();
  await к.fromHuman("задача", "claude");
  журнал.close();
  assert.doesNotThrow(() => {
    к.handle(событие("claude", "error", { text: "процесс завершился" }));
  }, "закрытая база не должна ронять обработку позднего события");
  assert.deepEqual(журнал.history("r"), []);
});
