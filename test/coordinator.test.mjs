/**
 * Проверка координатора: порядок разговора и пересылка.
 *
 * Адаптеры подменяются заглушками намеренно — здесь проверяются решения
 * маршрутизации, а связь с живыми агентами проверяется в adapters.test.mjs
 * на фальшивых процессах.
 *
 * Почему правила именно такие. Живой прогон 14 сентября показал, что при
 * отправке «обоим» ответы агентов расходятся по времени: Claude пять секунд
 * спорил с замечанием, которое Codex уже отозвал, и построил проверку того,
 * что было подтверждено. Отсюда три маршрута с разным смыслом, строгая
 * очерёдность в рецензии, завершение цикла по вердикту и явное удержание
 * всего, что не доставлено, вместо молчаливой потери.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
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
 * Ожидание по условию. Пересылка ждёт снимок версии файлов, поэтому один
 * тик цикла событий здесь не годится.
 */
async function дождаться(условие, сообщение, предел = 5000) {
  const начало = Date.now();
  while (Date.now() - начало < предел) {
    if (условие()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  assert.fail(`не дождались: ${сообщение}`);
}

const пауза = (мс) => new Promise((r) => setTimeout(r, мс));

function событие(agent, kind, доп = {}) {
  return {
    id: `${kind}-${Math.random().toString(36).slice(2)}`,
    agent,
    kind,
    visibility: ["text_delta", "tool_running", "diagnostic"].includes(kind)
      ? "stream"
      : "turn",
    at: Date.now(),
    ...доп,
  };
}

/** Законченный ход агента: реплика и завершение. */
function ход(к, агент, текст, доп = {}) {
  к.handle(событие(агент, "message", { text: текст }));
  к.handle(событие(агент, "turn_completed", доп));
}

const системные = (события) => события.filter((е) => е.agent === "system");

// ---------------------------------------------------------------------------
// Рецензия: строгая очерёдность и завершение по вердикту
// ---------------------------------------------------------------------------

test("задача с рецензией уходит только разработчику", async () => {
  const { к, claude, codex, журнал } = комната();
  await к.fromHuman("сделай отчёт", "review");
  assert.equal(claude.полученное.length, 1);
  assert.equal(codex.полученное.length, 0, "рецензент не должен работать параллельно");
  assert.equal(claude.полученное[0].from, "human");
  assert.equal(к.state.stage, "working");
  assert.equal(к.state.task, "сделай отчёт");
  журнал.close();
});

test("рецензент получает задачу, материал разработчика и просьбу о вердикте", async () => {
  const { к, codex, журнал } = комната();
  await к.fromHuman("исходная задача", "review");
  к.handle(событие("claude", "message", { text: "сделал" }));
  к.handle(событие("claude", "tool_call", { tool: "Bash", callId: "c1", text: "npm test" }));
  к.handle(
    событие("claude", "tool_result", { tool: "Bash", callId: "c1", text: "25 passed" }),
  );
  к.handle(событие("claude", "turn_completed"));
  await дождаться(() => codex.полученное.length === 1, "передача рецензенту");

  const п = codex.полученное[0];
  assert.equal(п.from, "claude");
  assert.match(п.text, /исходная задача/, "без задачи рецензент не знает, что проверять");
  assert.match(п.text, /сделал/);
  assert.match(п.text, /СЫРОЙ вывод инструмента Bash/);
  assert.match(п.text, /25 passed/);
  assert.match(п.text, /ВЕРДИКТ/, "без просьбы о вердикте цикл нечем завершить");
  assert.equal(к.state.round, 1);
  assert.equal(к.state.stage, "reviewing");
  журнал.close();
});

test("вердикт ПРИНЯТО завершает цикл", async () => {
  const { к, claude, codex, журнал, события } = комната();
  await к.fromHuman("задача", "review");
  ход(к, "claude", "сделал");
  await дождаться(() => codex.полученное.length === 1, "передача рецензенту");
  ход(к, "codex", "Расхождений нет.\nВЕРДИКТ: ПРИНЯТО");
  await дождаться(() => к.state.stage === "accepted", "завершение цикла");

  assert.equal(claude.полученное.length, 1, "принятую работу не возвращают разработчику");
  assert.equal(к.state.verdict, "accepted");
  assert.ok(
    системные(события).some((е) => /принял/i.test(е.text ?? "")),
    "человек должен увидеть, что работа принята",
  );
  журнал.close();
});

test("вердикт ЕСТЬ ЗАМЕЧАНИЯ возвращает работу разработчику", async () => {
  const { к, claude, codex, журнал } = комната();
  await к.fromHuman("задача", "review");
  ход(к, "claude", "сделал");
  await дождаться(() => codex.полученное.length === 1, "передача рецензенту");
  ход(к, "codex", "Найден дефект в расчёте.\nВЕРДИКТ: ЕСТЬ ЗАМЕЧАНИЯ");
  await дождаться(() => claude.полученное.length === 2, "возврат разработчику");

  assert.equal(claude.полученное[1].from, "codex");
  assert.match(claude.полученное[1].text, /Найден дефект/);
  assert.equal(к.state.verdict, "remarks");
  assert.equal(к.state.stage, "working");
  журнал.close();
});

test("без вердикта ответ рецензента удерживается до решения человека", async () => {
  const { к, claude, codex, журнал, события } = комната();
  await к.fromHuman("задача", "review");
  ход(к, "claude", "сделал");
  await дождаться(() => codex.полученное.length === 1, "передача рецензенту");
  ход(к, "codex", "Что-то не нравится, но не уверен.");
  await дождаться(() => к.state.stage === "held", "удержание");

  assert.equal(claude.полученное.length, 1, "без вердикта нельзя решать за человека");
  assert.equal(к.state.held.to, "claude");
  assert.match(к.state.held.reason, /вердикт/i);
  assert.equal(к.state.verdict, "missing");
  assert.ok(системные(события).some((е) => /вердикт/i.test(е.text ?? "")));
  журнал.close();
});

test("удержанное отправляется по команде человека", async () => {
  const { к, claude, codex, журнал } = комната();
  await к.fromHuman("задача", "review");
  ход(к, "claude", "сделал");
  await дождаться(() => codex.полученное.length === 1, "передача рецензенту");
  ход(к, "codex", "Что-то не нравится.");
  await дождаться(() => к.state.stage === "held", "удержание");

  await к.releaseHeld();
  assert.equal(claude.полученное.length, 2);
  assert.match(claude.полученное[1].text, /Что-то не нравится/);
  assert.equal(к.state.held, undefined);
  журнал.close();
});

test("предел раундов удерживает непроверенные исправления, а не теряет их", async () => {
  const { к, claude, codex, журнал, события } = комната(1);
  await к.fromHuman("задача", "review");
  ход(к, "claude", "версия один");
  await дождаться(() => codex.полученное.length === 1, "первая проверка");
  ход(к, "codex", "Плохо.\nВЕРДИКТ: ЕСТЬ ЗАМЕЧАНИЯ");
  await дождаться(() => claude.полученное.length === 2, "возврат разработчику");
  ход(к, "claude", "версия два");
  await дождаться(() => к.state.stage === "held", "удержание на пределе");

  assert.equal(codex.полученное.length, 1, "сверх предела рецензент не вызывается");
  assert.equal(к.state.held.to, "codex");
  assert.match(
    к.state.held.reason,
    /не провер/i,
    "человек должен знать, что исправления остались непроверенными",
  );
  assert.ok(системные(события).some((е) => /предел/i.test(е.text ?? "")));

  await к.releaseHeld();
  assert.equal(codex.полученное.length, 2);
  assert.match(codex.полученное[1].text, /версия два/);
  журнал.close();
});

test("нулевой предел: работа разработчика удерживается, а не пропадает", async () => {
  const { к, codex, журнал } = комната(0);
  await к.fromHuman("задача", "review");
  ход(к, "claude", "готово");
  await дождаться(() => к.state.stage === "held", "удержание");
  assert.equal(codex.полученное.length, 0);
  assert.equal(к.state.held.to, "codex");
  журнал.close();
});

test("выключенные автораунды удерживают пересылку", async () => {
  const { к, codex, журнал } = комната();
  к.setAuto(false);
  await к.fromHuman("задача", "review");
  ход(к, "claude", "готово");
  await дождаться(() => к.state.stage === "held", "удержание");
  assert.equal(codex.полученное.length, 0);
  assert.match(к.state.held.reason, /автораунд/i);
  журнал.close();
});

test("проваленный ход разработчика останавливает цикл без пересылки", async () => {
  const { к, codex, журнал, события } = комната();
  await к.fromHuman("задача", "review");
  к.handle(событие("claude", "message", { text: "начал" }));
  к.handle(событие("claude", "turn_completed", { failed: true }));
  await дождаться(() => к.state.stage === "stopped", "остановка цикла");
  assert.equal(codex.полученное.length, 0);
  assert.ok(системные(события).some((е) => /ошибк/i.test(е.text ?? "")));
  журнал.close();
});

test("падение процесса агента посреди цикла прекращает ожидание", async () => {
  const { к, codex, журнал } = комната();
  await к.fromHuman("задача", "review");
  к.handle(событие("claude", "error", { failed: true, text: "процесс упал" }));
  await дождаться(() => к.state.stage === "stopped", "остановка цикла");
  assert.equal(codex.полученное.length, 0, "ждать ответа от мёртвого процесса нельзя");
  журнал.close();
});

test("поток без законченной реплики нечего отдавать на проверку", async () => {
  const { к, codex, журнал } = комната();
  await к.fromHuman("задача", "review");
  к.handle(событие("claude", "text_delta", { text: "по" }));
  к.handle(событие("claude", "text_delta", { text: "ток" }));
  к.handle(событие("claude", "turn_completed"));
  await дождаться(() => к.state.stage === "stopped", "остановка цикла");
  assert.equal(
    codex.полученное.length,
    0,
    "дельты не передаются: иначе каждая буква запускала бы ответ",
  );
  журнал.close();
});

// ---------------------------------------------------------------------------
// Прямые вопросы и вопрос обоим: ничего не пересылается
// ---------------------------------------------------------------------------

test("спросить обоих: оба отвечают, друг другу ничего не пересылается", async () => {
  const { к, claude, codex, журнал } = комната();
  await к.fromHuman("ваше мнение?", "both");
  assert.equal(claude.полученное.length, 1);
  assert.equal(codex.полученное.length, 1);
  ход(к, "codex", "мнение Codex");
  ход(к, "claude", "мнение Claude");
  await пауза(150);
  assert.equal(claude.полученное.length, 1, "именно здесь разошлись ответы в живом прогоне");
  assert.equal(codex.полученное.length, 1);
  журнал.close();
});

test("прямой вопрос рецензенту не запускает пересылку", async () => {
  const { к, claude, codex, журнал } = комната();
  await к.fromHuman("вопрос", "codex");
  assert.equal(codex.полученное.length, 1);
  ход(к, "codex", "ответ");
  await пауза(150);
  assert.equal(claude.полученное.length, 0);
  журнал.close();
});

test("ход прямого вопроса не путается с ходом цикла", async () => {
  const { к, claude, codex, журнал } = комната();
  await к.fromHuman("задача", "review");
  claude.busy = true;
  await к.fromHuman("вопрос мимоходом", "claude");
  assert.equal(claude.полученное.length, 1, "занятому не отправляем");
  assert.equal(к.state.queued, 1);

  claude.busy = false;
  ход(к, "claude", "работа сделана");
  await дождаться(
    () => codex.полученное.length === 1 && claude.полученное.length === 2,
    "пересылка работы и выдача отложенного вопроса",
  );
  assert.match(codex.полученное[0].text, /работа сделана/);

  ход(к, "claude", "ответ на вопрос");
  await пауза(150);
  assert.equal(codex.полученное.length, 1, "ответ на прямой вопрос не идёт на проверку");
  assert.ok(!/ответ на вопрос/.test(codex.полученное[0].text));
  журнал.close();
});

test("материал прямого ответа не попадает в пересылку цикла", async () => {
  // Родственник дефекта с общим накопителем: материал предыдущего хода,
  // не предназначенного для проверки, не должен уходить рецензенту.
  const { к, codex, журнал } = комната();
  await к.fromHuman("вопрос", "claude");
  ход(к, "claude", "постороннее рассуждение");
  await пауза(100);
  await к.fromHuman("задача", "review");
  ход(к, "claude", "работа по задаче");
  await дождаться(() => codex.полученное.length === 1, "передача рецензенту");
  assert.match(codex.полученное[0].text, /работа по задаче/);
  assert.ok(!/постороннее/.test(codex.полученное[0].text));
  журнал.close();
});

// ---------------------------------------------------------------------------
// Устаревшее и очередь
// ---------------------------------------------------------------------------

test("новая задача отменяет устаревшие пересылки прежней", async () => {
  const { к, claude, codex, журнал, события } = комната();
  await к.fromHuman("задача А", "review");
  codex.busy = true;
  ход(к, "claude", "работа по задаче А");
  await дождаться(() => к.state.queued === 1, "пересылка встала в очередь");

  await к.fromHuman("задача Б", "review");
  assert.equal(к.state.queued, 0, "пересылка по задаче А устарела");
  assert.match(claude.полученное.at(-1).text, /задача Б/);
  assert.ok(
    системные(события).some((е) => /устаревш/i.test(е.text ?? "")),
    "человек должен знать, что что-то не доставлено",
  );

  codex.busy = false;
  к.handle(событие("codex", "turn_completed"));
  await пауза(150);
  assert.ok(codex.полученное.every((п) => !/работа по задаче А/.test(п.text)));
  журнал.close();
});

test("очередь занятому агенту сохраняет порядок прямых сообщений", async () => {
  const { к, codex, журнал } = комната();
  codex.busy = true;
  for (const метка of ["первое", "второе", "третье"]) {
    await к.fromHuman(метка, "codex");
  }
  assert.equal(codex.полученное.length, 0);
  assert.equal(к.state.queued, 3);

  codex.busy = false;
  к.handle(событие("codex", "turn_completed"));
  await дождаться(() => codex.полученное.length === 3, "выгрузка очереди");
  assert.match(codex.полученное[0].text, /первое/);
  assert.match(codex.полученное[1].text, /второе/);
  assert.match(codex.полученное[2].text, /третье/);
  журнал.close();
});

test("остановка останавливает обоих, поздний ход ничего не пересылает", async () => {
  const { к, claude, codex, журнал } = комната();
  await к.fromHuman("задача", "review");
  await к.stopAll();
  assert.equal(claude.остановлен, 1);
  assert.equal(codex.остановлен, 1);
  assert.equal(к.state.stage, "stopped");
  ход(к, "claude", "после остановки");
  await пауза(150);
  assert.equal(codex.полученное.length, 0);
  журнал.close();
});

// ---------------------------------------------------------------------------
// Подпись, версия, журнал
// ---------------------------------------------------------------------------

test("служебные сообщения подписаны панелью, а не человеком", async () => {
  // В живом прогоне «Предел автоматических раундов» показывался как «Вы».
  const { к, codex, журнал, события } = комната();
  await к.fromHuman("задача", "review");
  ход(к, "claude", "сделал");
  await дождаться(() => codex.полученное.length === 1, "передача рецензенту");
  ход(к, "codex", "ВЕРДИКТ: ПРИНЯТО");
  await дождаться(() => к.state.stage === "accepted", "завершение");
  assert.ok(системные(события).length > 0);
  const отЧеловека = события.filter((е) => е.agent === "human");
  assert.ok(
    отЧеловека.every((е) => е.text === "задача"),
    "от имени человека — только то, что он написал",
  );
  журнал.close();
});

test("реплика человека не меняет версию идущего хода агента", async () => {
  const { к, журнал, события, каталог } = комната();
  await к.fromHuman("первая задача", "review");
  к.handle(событие("claude", "message", { text: "начал работу" }));
  const версияДо = события.filter((е) => е.agent === "claude").at(-1).snapshot;

  writeFileSync(join(каталог, "изменение.txt"), "другое состояние");
  await к.fromHuman("а вот вопрос", "codex");
  assert.notEqual(к.snapshot.id, версияДо, "иначе проверка ничего не доказывает");

  к.handle(событие("claude", "message", { text: "продолжаю тот же ход" }));
  const версияПосле = события.filter((е) => е.agent === "claude").at(-1).snapshot;
  assert.equal(версияПосле, версияДо);
  журнал.close();
});

test("события агента помечены версией файлов", async () => {
  const { к, журнал, события } = комната();
  await к.fromHuman("задача", "review");
  к.handle(событие("claude", "message", { text: "ответ" }));
  assert.ok(события.some((е) => е.agent === "claude" && е.snapshot));
  журнал.close();
});

test("история переживает перезапуск вместе с привязкой сессий", async () => {
  const { к, журнал, каталог } = комната();
  await к.fromHuman("запомни это", "claude");
  журнал.bindSessions("r", "claude-s", "codex-t");
  журнал.close();

  const второй = new Journal(join(каталог, "j.sqlite"));
  assert.ok(второй.history("r").some((е) => е.text === "запомни это"));
  const привязка = второй.binding("r");
  assert.equal(привязка.claudeSessionId, "claude-s");
  assert.equal(привязка.codexThreadId, "codex-t");
  второй.close();
});

test("привязка не перетирается неизвестным значением", async () => {
  const { журнал } = комната();
  журнал.bindSessions("r", "claude-s", "codex-t");
  журнал.bindSessions("r", undefined, undefined);
  const п = журнал.binding("r");
  assert.equal(п.claudeSessionId, "claude-s");
  assert.equal(п.codexThreadId, "codex-t");
  журнал.close();
});

test("полная запись протокола сохраняется отдельно от показанного текста", async () => {
  const { к, журнал } = комната();
  await к.fromHuman("задача", "claude");
  к.handle(
    событие("claude", "tool_result", {
      tool: "Bash",
      callId: "c9",
      text: "обрезано для показа",
      raw: { content: "x".repeat(200_000) },
    }),
  );
  const запись = журнал.history("r").find((е) => е.callId === "c9");
  assert.ok(запись);
  assert.equal(журнал.rawOf("r", запись.id).content.length, 200_000);
  журнал.close();
});

test("журнал после закрытия не роняет позднее событие", async () => {
  const { к, журнал } = комната();
  await к.fromHuman("задача", "claude");
  журнал.close();
  assert.doesNotThrow(() => {
    к.handle(событие("claude", "error", { failed: true, text: "процесс завершился" }));
  });
  assert.deepEqual(журнал.history("r"), []);
});
