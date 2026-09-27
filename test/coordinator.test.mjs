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
import { forDisplay } from "../out/adapters/types.js";

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
  async answerApproval(id, решение) {
    this.решения.push([id, решение]);
    return true;
  }
  решения = [];
}

function комната(предел = 3, опции = {}) {
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
    ...опции,
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

test("самостоятельный ход Claude не занимает цель задачи и не идёт рецензенту", async () => {
  // Фоновая команда кончилась, и Claude сам начал ход (живая трасса 28.09).
  // Если его конец придёт, пока ждём работу по задаче, он не должен стать
  // этой работой: итог настоящего хода иначе ушёл бы в никуда.
  const { к, claude, codex, события } = комната();
  await к.fromHuman("сделай отчёт", "review");
  await дождаться(() => claude.полученное.length === 1, "задача у Claude");
  claude.busy = true;
  к.handle(событие("claude", "turn_started", { unsolicited: true, text: "фоновая команда «pytest» закончилась" }));
  ход(к, "claude", "Команда завершена успешно.", { unsolicited: true, usage: { input: 900, cached: 0, output: 9 } });
  await пауза(50);
  assert.equal(codex.полученное.length, 0);
  assert.equal(к.state.stage, "working");
  assert.equal(к.state.usage.task.claude.input, 0);
  assert.ok(системные(события).some((е) => /продолжил сам/.test(е.text) && /pytest/.test(е.text)));

  claude.busy = false;
  ход(к, "claude", "отчёт готов");
  await дождаться(() => codex.полученное.length === 1, "рецензия");
  assert.match(codex.полученное[0].text, /отчёт готов/);
  assert.doesNotMatch(codex.полученное[0].text, /Команда завершена успешно/);
});

test("недельная доля Claude запрашивается после его хода, не чаще раза в период", async () => {
  // Граница владельца — не больше 90% недели Claude; в потоке claude -p доли нет.
  let вызовов = 0;
  const { к } = комната(3, {
    claudeUsage: async () => {
      вызовов += 1;
      return { weekPercent: 4, sessionPercent: 28, weekResets: "Oct 4, 12am" };
    },
    claudeUsageEveryMs: 60_000,
  });
  ход(к, "claude", "ответ");
  await дождаться(() => к.state.usage.limits.claudeWeek?.percent === 4, "доля недели");
  const { at, ...доля } = к.state.usage.limits.claudeWeek;
  assert.deepEqual(доля, { percent: 4, session: 28, resets: "Oct 4, 12am" });
  assert.ok(Date.now() - at < 5000, "время сведения");
  ход(к, "claude", "ещё ответ");
  ход(к, "codex", "ответ Codex");
  await пауза(50);
  assert.equal(вызовов, 1);
});

test("сбой запроса недельной доли — доли нет, работа идёт", async () => {
  const { к, codex } = комната(3, {
    claudeUsage: async () => {
      throw new Error("claude не найден");
    },
  });
  await к.fromHuman("сделай", "review");
  ход(к, "claude", "готово");
  await дождаться(() => codex.полученное.length === 1, "рецензия");
  assert.equal(к.state.usage.limits.claudeWeek, undefined);
});

test("недельную долю можно запросить при открытии панели", async () => {
  const { к } = комната(3, { claudeUsage: async () => ({ weekPercent: 12 }) });
  await к.refreshClaudeUsage();
  assert.equal(к.state.usage.limits.claudeWeek.percent, 12);
  assert.equal(к.state.usage.limits.claudeWeek.stale, undefined);
});

test("неудачный повторный запрос помечает прежнюю долю устаревшей", async () => {
  // Рецензия Codex 28.09 (2febf2e): прежний процент показывался как текущий.
  let вызов = 0;
  const { к } = комната(3, {
    claudeUsage: async () => {
      вызов += 1;
      if (вызов === 1) return { weekPercent: 12 };
      if (вызов === 2) return undefined;
      throw new Error("нет claude");
    },
    claudeUsageEveryMs: 0,
  });
  await к.refreshClaudeUsage();
  await к.refreshClaudeUsage();
  assert.equal(к.state.usage.limits.claudeWeek.percent, 12);
  assert.equal(к.state.usage.limits.claudeWeek.stale, true);
});

test("«Прервать» снимает прямые сообщения из очереди и говорит об этом", async () => {
  // Рецензии Codex 28.09: прямое сообщение ждало конца хода, а после
  // прерывания его не будет — очередь висела. Отправлять его сразу нельзя:
  // человек мог прервать именно чтобы отменить, а поздний конец прерванного
  // хода Codex снял бы цель нового. Снять и назвать — честнее.
  const { к, claude, события } = комната();
  claude.busy = true;
  claude.interrupt = async () => {
    claude.прерван += 1;
    claude.busy = false;
  };
  await к.fromHuman("вопрос", "claude");
  assert.equal(к.state.queued, 1);
  await к.interruptAll();
  assert.equal(claude.прерван, 1);
  assert.equal(к.state.queued, 0);
  assert.equal(claude.полученное.length, 0);
  assert.ok(системные(события).some((е) => /Не отправлено сообщений из очереди: 1/.test(е.text)));
});

test("«Прервать» во время снимка файлов — сообщение не уходит", async () => {
  // Рецензия Codex 28.09: счётчик остановок запоминался после снимка.
  const { к, claude } = комната();
  const отправка = к.fromHuman("вопрос", "claude");
  await к.interruptAll();
  await отправка;
  assert.equal(claude.полученное.length, 0);
});

test("сообщение Claude во время его самостоятельного хода ждёт конца этого хода", async () => {
  const { к, claude } = комната();
  claude.busy = true;
  к.handle(событие("claude", "turn_started", { unsolicited: true, text: "фоновая команда закончилась" }));
  await к.fromHuman("вопрос", "claude");
  assert.equal(claude.полученное.length, 0);
  assert.equal(к.state.queued, 1);
  claude.busy = false;
  ход(к, "claude", "итог фоновой", { unsolicited: true });
  await дождаться(() => claude.полученное.length === 1, "отправка из очереди");
  assert.match(claude.полученное[0].text, /вопрос/);
});

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

test("вердикт НУЖНО РЕШЕНИЕ ЧЕЛОВЕКА останавливает обмен и ждёт человека", async () => {
  // Живой прогон 16 сентября: рецензент считал обмен законченным, но мог
  // поставить только ЕСТЬ ЗАМЕЧАНИЯ, и третья проверка ушла на согласия.
  const { к, claude, codex, журнал, события } = комната();
  await к.fromHuman("задача", "review");
  ход(к, "claude", "сделал");
  await дождаться(() => codex.полученное.length === 1, "передача рецензенту");
  ход(к, "codex", "Без новых исходников продолжать незачем.\nВЕРДИКТ: НУЖНО РЕШЕНИЕ ЧЕЛОВЕКА");
  await дождаться(() => к.state.stage === "held", "удержание");

  assert.equal(claude.полученное.length, 1, "ответ рецензента не должен уходить разработчику сам");
  assert.equal(к.state.verdict, "human");
  assert.equal(к.state.held.to, "claude");
  assert.match(к.state.held.reason, /решени/i);
  assert.ok(системные(события).some((е) => /решени/i.test(е.text ?? "")));
  журнал.close();
});

test("рецензент знает, как помечен неполный вывод и где лежит полный", async () => {
  const { к, codex, журнал } = комната();
  await к.fromHuman("задача", "review");
  ход(к, "claude", "сделал");
  await дождаться(() => codex.полученное.length === 1, "передача рецензенту");
  assert.match(codex.полученное[0].text, /[Нн]еполный/);
  assert.match(codex.полученное[0].text, /журнал/i);
  журнал.close();
});

test("рецензент получает полный вывод, обрезанный только для показа, с отметкой полноты", async () => {
  // Исследование Codex 27.09: рецензенту уходил усечённый показ, и пометка
  // «сырой вывод» завышала полноту переданного.
  const { к, codex, журнал } = комната();
  await к.fromHuman("задача", "review");
  к.handle(событие("claude", "tool_call", { tool: "Bash", callId: "c1", text: "cat big.log" }));
  к.handle(
    событие("claude", "tool_result", {
      tool: "Bash",
      callId: "c1",
      text: "x".repeat(10) + " … обрезано 99 999 символов",
      full: "x".repeat(99_000) + "КОНЕЦ",
    }),
  );
  ход(к, "claude", "прочитал");
  await дождаться(() => codex.полученное.length === 1, "передача рецензенту");
  const т = codex.полученное[0].text;
  assert.match(т, /КОНЕЦ/, "конец вывода до рецензента не дошёл");
  assert.match(т, /вызов c1/);
  assert.match(т, /полный, 99 005 символов/);
  журнал.close();
});

test("рецензент видит, какие действия сделал субагент, а не сам Claude", async () => {
  const { к, codex, журнал } = комната();
  await к.fromHuman("задача", "review");
  к.handle(событие("claude", "tool_call", { tool: "Agent", callId: "toolu_agent", text: "{}" }));
  к.handle(событие("claude", "tool_call", { tool: "Read", callId: "toolu_sub", parentCallId: "toolu_agent", text: "a.txt" }));
  к.handle(событие("claude", "tool_result", { tool: "Read", callId: "toolu_sub", parentCallId: "toolu_agent", text: "alpha" }));
  ход(к, "claude", "итог");
  await дождаться(() => codex.полученное.length === 1, "передача рецензенту");
  const т = codex.полученное[0].text;
  assert.match(т, /вызов инструмента Read · вызов toolu_sub · субагент вызова toolu_agent/);
  assert.match(т, /СЫРОЙ вывод инструмента Read · вызов toolu_sub · субагент вызова toolu_agent/);
  журнал.close();
});

test("выводы больше бюджета проверки режутся поровну: начало и конец, пропуск указан", async () => {
  const { к, codex, журнал } = комната(3, { evidenceBudget: 30_000 });
  await к.fromHuman("задача", "review");
  const вывод = (id, длина, метка) =>
    событие("claude", "tool_result", { tool: "Bash", callId: id, text: "показ", full: метка + "y".repeat(длина - метка.length - 5) + "ХВОСТ" });
  к.handle(вывод("a", 40_000, "ПЕРВЫЙ"));
  к.handle(вывод("b", 40_000, "ВТОРОЙ"));
  к.handle(событие("claude", "tool_result", { tool: "Read", callId: "c", text: "маленький вывод целиком" }));
  ход(к, "claude", "готово");
  await дождаться(() => codex.полученное.length === 1, "передача рецензенту");
  const т = codex.полученное[0].text;
  assert.match(т, /маленький вывод целиком/);
  assert.match(т, /вызов c · полный/);
  assert.equal((т.match(/неполный: показано/g) ?? []).length, 2, "оба длинных вывода помечены неполными");
  assert.match(т, /ПЕРВЫЙ/);
  assert.match(т, /ВТОРОЙ/);
  assert.equal((т.match(/ХВОСТ/g) ?? []).length, 2, "конец длинного вывода показан");
  assert.match(т, /пропущены символы \d/);
  assert.ok(т.length < 45_000, `материал больше бюджета: ${т.length}`);
  журнал.close();
});

// ---------------------------------------------------------------------------
// След цикла для «Дорожки»
// ---------------------------------------------------------------------------

test("след цикла: задача, работа и проверка с отметкой вердикта", async () => {
  const { к, claude, codex, журнал } = комната();
  await к.fromHuman("задача", "review");
  await дождаться(() => claude.полученное.length === 1, "работа у Claude");
  assert.deepEqual(к.state.trail, [{ who: "task" }, { who: "claude" }]);
  ход(к, "claude", "сделал");
  await дождаться(() => codex.полученное.length === 1, "проверка у Codex");
  ход(к, "codex", "Дефект.\nВЕРДИКТ: ЕСТЬ ЗАМЕЧАНИЯ");
  await дождаться(() => claude.полученное.length === 2, "возврат Claude");
  assert.deepEqual(к.state.trail, [
    { who: "task" },
    { who: "claude" },
    { who: "codex", mark: "!" },
    { who: "claude" },
  ]);
  журнал.close();
});

test("след цикла: принятие ставит галочку, удержание добавляет человека", async () => {
  const принятие = комната();
  await принятие.к.fromHuman("задача", "review");
  ход(принятие.к, "claude", "сделал");
  await дождаться(() => принятие.codex.полученное.length === 1, "проверка");
  ход(принятие.к, "codex", "Хорошо.\nВЕРДИКТ: ПРИНЯТО");
  await дождаться(() => принятие.к.state.stage === "accepted", "принятие");
  assert.deepEqual(принятие.к.state.trail.at(-1), { who: "codex", mark: "✓" });
  принятие.журнал.close();

  const удержание = комната();
  await удержание.к.fromHuman("задача", "review");
  ход(удержание.к, "claude", "сделал");
  await дождаться(() => удержание.codex.полученное.length === 1, "проверка");
  ход(удержание.к, "codex", "Нужны данные.\nВЕРДИКТ: НУЖНО РЕШЕНИЕ ЧЕЛОВЕКА");
  await дождаться(() => удержание.к.state.stage === "held", "удержание");
  assert.deepEqual(удержание.к.state.trail.slice(-2), [{ who: "codex", mark: "?" }, { who: "you" }]);
  удержание.журнал.close();
});

test("след цикла: новая задача начинает заново, прямой вопрос его не трогает", async () => {
  const { к, claude, журнал } = комната();
  await к.fromHuman("задача А", "review");
  ход(к, "claude", "сделал");
  await к.fromHuman("вопрос", "codex");
  assert.deepEqual(к.state.trail.map((ш) => ш.who).slice(0, 2), ["task", "claude"]);
  assert.ok(!к.state.trail.some((ш) => ш.who === "codex" && !ш.mark && false));
  await к.fromHuman("задача Б", "review");
  await дождаться(() => claude.полученное.length >= 2, "новая работа");
  assert.deepEqual(к.state.trail, [{ who: "task" }, { who: "claude" }]);
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

test("выключенная автопересылка удерживает передачу", async () => {
  // Слово одно на всю панель: переключатель называется «автопересылка»,
  // и причина удержания должна говорить тем же словом.
  const { к, codex, журнал } = комната();
  к.setAuto(false);
  await к.fromHuman("задача", "review");
  ход(к, "claude", "готово");
  await дождаться(() => к.state.stage === "held", "удержание");
  assert.equal(codex.полученное.length, 0);
  assert.match(к.state.held.reason, /автопересылк/i);
  assert.doesNotMatch(к.state.held.reason, /раунд/i);
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
// Отказы в разрешениях
//
// Живой прогон 15 сентября: команды Claude отклонены на согласовании, Claude
// объяснил блокировку, объяснение ушло на проверку, и три раунда рецензии
// потрачены на спор о причинах блокировки. Отказы — дело человека, а не
// рецензента.
// ---------------------------------------------------------------------------

const ОТКАЗЫ = ["Bash: git -C C:\\agent-panel show d748e88"];

test("работа с отказами в разрешениях не идёт на проверку, а ждёт человека", async () => {
  const { к, codex, журнал, события } = комната();
  await к.fromHuman("покажи коммит", "review");
  к.handle(событие("claude", "message", { text: "команды заблокированы" }));
  к.handle(событие("claude", "turn_completed", { denials: ОТКАЗЫ }));
  await дождаться(() => к.state.stage === "held", "удержание");

  assert.equal(codex.полученное.length, 0, "спорить о блокировке рецензенту незачем");
  assert.equal(к.state.round, 0, "проверка не состоялась — раунд не расходуется");
  assert.equal(к.state.held.to, "claude");
  assert.equal(к.state.held.action, "retry");
  assert.match(к.state.held.reason, /разрешени/i);
  assert.match(к.state.held.reason, /git -C/, "человек должен видеть, что именно отклонено");
  assert.ok(системные(события).some((е) => /разрешени/i.test(е.text ?? "")));
  журнал.close();
});

test("повтор после отказов заново отдаёт Claude исходную задачу", async () => {
  const { к, claude, журнал } = комната();
  await к.fromHuman("покажи коммит", "review");
  к.handle(событие("claude", "message", { text: "заблокировано" }));
  к.handle(событие("claude", "turn_completed", { denials: ОТКАЗЫ }));
  await дождаться(() => к.state.stage === "held", "удержание");

  await к.releaseHeld();
  assert.equal(claude.полученное.length, 2);
  assert.match(claude.полученное[1].text, /покажи коммит/);
  assert.equal(к.state.stage, "working");
  assert.equal(к.state.held, undefined);
  журнал.close();
});

test("успешный повтор после отказов уходит на проверку как обычно", async () => {
  const { к, codex, журнал } = комната();
  await к.fromHuman("покажи коммит", "review");
  к.handle(событие("claude", "message", { text: "заблокировано" }));
  к.handle(событие("claude", "turn_completed", { denials: ОТКАЗЫ }));
  await дождаться(() => к.state.stage === "held", "удержание");
  await к.releaseHeld();

  ход(к, "claude", "вот вывод коммита");
  await дождаться(() => codex.полученное.length === 1, "передача рецензенту");
  assert.match(codex.полученное[0].text, /вот вывод коммита/);
  assert.equal(к.state.round, 1);
  журнал.close();
});

test("отказы в прямом вопросе показываются человеку без удержания", async () => {
  const { к, журнал, события } = комната();
  await к.fromHuman("вопрос", "claude");
  к.handle(событие("claude", "message", { text: "не смог" }));
  к.handle(событие("claude", "turn_completed", { denials: ОТКАЗЫ }));
  await дождаться(
    () => системные(события).some((е) => /разрешени/i.test(е.text ?? "")),
    "уведомление об отказах",
  );
  assert.equal(к.state.held, undefined);
  журнал.close();
});

test("новая задача отменяет ожидающий повтор", async () => {
  const { к, claude, журнал } = комната();
  await к.fromHuman("задача А", "review");
  к.handle(событие("claude", "message", { text: "заблокировано" }));
  к.handle(событие("claude", "turn_completed", { denials: ОТКАЗЫ }));
  await дождаться(() => к.state.stage === "held", "удержание");

  await к.fromHuman("задача Б", "review");
  assert.equal(к.state.held, undefined);
  await к.releaseHeld();
  assert.ok(
    claude.полученное.every((п) => !/задача А/.test(п.text) || п === claude.полученное[0]),
    "отменённый повтор не должен уйти",
  );
  журнал.close();
});

// ---------------------------------------------------------------------------
// Прямые вопросы и вопрос обоим: ничего не пересылается
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Запросы разрешений
// ---------------------------------------------------------------------------

test("открытый запрос разрешения виден в состоянии, пока не решён", () => {
  const { к } = комната();
  к.handle(событие("claude", "approval_requested", { callId: "p1", tool: "Bash", text: "mkdir x" }));
  assert.equal(к.state.approvals, 1);
  к.handle(событие("claude", "approval_decided", { callId: "p1", text: "разрешено" }));
  assert.equal(к.state.approvals, 0);
});

test("решение человека уходит адаптеру того агента, который спросил", async () => {
  const { к, claude, codex } = комната();
  к.handle(событие("claude", "approval_requested", { callId: "p1", tool: "Bash" }));
  await к.answerApproval("p1", "allowSession");
  assert.deepEqual(claude.решения, [["p1", "allowSession"]]);
  assert.deepEqual(codex.решения, []);
});

test("ответ на неизвестный или решённый запрос не отправляется", async () => {
  const { к, claude } = комната();
  await к.answerApproval("нет-такого", "allow");
  к.handle(событие("claude", "approval_requested", { callId: "p1" }));
  к.handle(событие("claude", "approval_decided", { callId: "p1" }));
  await к.answerApproval("p1", "allow");
  assert.deepEqual(claude.решения, []);
});

test("остановка закрывает открытые запросы разрешений", async () => {
  const { к } = комната();
  к.handle(событие("claude", "approval_requested", { callId: "p1" }));
  await к.stopAll();
  assert.equal(к.state.approvals, 0);
});

test("падение процесса закрывает его запросы разрешений", () => {
  const { к } = комната();
  к.handle(событие("claude", "approval_requested", { callId: "p1" }));
  к.handle(событие("claude", "error", { failed: true, text: "процесс завершился" }));
  assert.equal(к.state.approvals, 0);
});

test("запрос разрешения не попадает в материал рецензенту", async () => {
  const { к, claude, codex } = комната();
  await к.fromHuman("создай каталог", "review");
  await дождаться(() => claude.полученное.length === 1, "работа у Claude");
  к.handle(событие("claude", "approval_requested", { callId: "p1", tool: "Bash", text: "СЕКРЕТНАЯ-КОМАНДА" }));
  к.handle(событие("claude", "approval_decided", { callId: "p1", text: "разрешено" }));
  ход(к, "claude", "сделано");
  await дождаться(() => codex.полученное.length === 1, "проверка у Codex");
  assert.doesNotMatch(codex.полученное[0].text, /СЕКРЕТНАЯ-КОМАНДА/);
});

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
// Гонки
//
// Найдены рецензентом и воспроизведены им на настоящем коде. Заглушки выше
// отвечают мгновенно и строго по порядку, поэтому этих гонок не видят. Здесь
// снимок версии управляемый — его можно задержать, как медленный git, — а
// заглушка агента может завершить ход прямо внутри отправки, как быстрый
// настоящий агент, чей ответ приходит одним блоком.
// ---------------------------------------------------------------------------

function управляемаяКомната(предел = 3) {
  const каталог = mkdtempSync(join(tmpdir(), "panel-race-"));
  const журнал = new Journal(join(каталог, "j.sqlite"));
  журнал.ensureRoom("r", каталог);
  const claude = new Заглушка("claude");
  const codex = new Заглушка("codex");
  const события = [];
  let ворота;
  let открыть = () => {};
  const закрыть = () => {
    ворота = new Promise((r) => (открыть = r));
  };
  let номер = 0;
  const к = new Coordinator(claude, codex, журнал, {
    room: "r",
    cwd: каталог,
    maxAutoRounds: предел,
    onEvent: (е) => события.push(е),
    snapshot: async () => {
      if (ворота) await ворота;
      номер += 1;
      return { id: `s${номер}`, commit: undefined, dirty: true, at: Date.now(), source: "filesystem" };
    },
  });
  return { к, claude, codex, журнал, события, закрыть, открыть: () => { ворота = undefined; открыть(); } };
}

test("замечания подписаны версией, которую проверял рецензент, а не текущей", async () => {
  // Найдено рецензентом: после проверки снимался новый снимок и ставился в
  // шапку замечаний. Правки во время проверки делали замечания к старой
  // версии похожими на замечания к новой — ровно обратное обещанному.
  // Здесь каждый снимок новый: дерево «меняется» на каждом шаге.
  const { к, claude, codex, журнал } = управляемаяКомната();
  await к.fromHuman("задача", "review");
  ход(к, "claude", "сделал");
  await дождаться(() => codex.полученное.length === 1, "передача рецензенту");
  ход(к, "codex", "Дефект.\nВЕРДИКТ: ЕСТЬ ЗАМЕЧАНИЯ");
  await дождаться(() => claude.полученное.length === 2, "возврат разработчику");

  const замечания = claude.полученное[1];
  assert.equal(замечания.snapshot, codex.полученное[0].snapshot, "замечания относятся к проверенной версии");
  assert.match(замечания.text, /изменил/i, "разработчик должен видеть, что дерево ушло вперёд");
  журнал.close();
});

test("новая задача, пришедшая во время снимка, не получает материал старой", async () => {
  // Сценарий рецензента: работа A завершилась, координатор ждёт снимок,
  // приходит задача B, и старое продолжение отправляет Codex задачу B с
  // материалом A.
  const { к, claude, codex, журнал, закрыть, открыть } = управляемаяКомната();
  await к.fromHuman("задача A", "review");
  закрыть();
  ход(к, "claude", "работа по A");
  const новая = к.fromHuman("задача B", "review");
  открыть();
  await новая;
  await пауза(150);

  assert.equal(codex.полученное.length, 0, "работа A устарела и не должна уйти на проверку");
  assert.match(claude.полученное.at(-1).text, /задача B/);
  assert.equal(к.state.task, "задача B");
  журнал.close();
});

test("остановка во время снимка не возобновляет цикл", async () => {
  const { к, codex, журнал, закрыть, открыть } = управляемаяКомната();
  await к.fromHuman("задача", "review");
  закрыть();
  ход(к, "claude", "работа");
  await к.stopAll();
  открыть();
  await пауза(150);

  assert.equal(к.state.stage, "stopped", "остановленное не должно ожить");
  assert.equal(codex.полученное.length, 0);
  журнал.close();
});

test("ход, завершившийся прямо во время отправки, засчитан как проверка", async () => {
  // Сценарий рецензента: ответ RPC и все уведомления до turn/completed
  // приходят одним блоком и разбираются раньше, чем завершится send().
  // Если цель регистрируется после send(), проверка считается прямым
  // вопросом, а опоздавшая цель потом закрывает цикл чужим ответом.
  const { к, codex, журнал } = управляемаяКомната();
  codex.send = async function (prompt) {
    this.полученное.push(prompt);
    к.handle(событие("codex", "message", { text: "Всё в порядке.\nВЕРДИКТ: ПРИНЯТО" }));
    к.handle(событие("codex", "turn_completed"));
  };
  await к.fromHuman("задача", "review");
  ход(к, "claude", "работа");
  await дождаться(() => к.state.stage === "accepted", "цикл принят");
  assert.equal(к.state.verdict, "accepted");

  // Прямой вопрос после этого не должен ничего «закрывать» заново.
  codex.send = Заглушка.prototype.send;
  await к.fromHuman("вопрос", "codex");
  ход(к, "codex", "ответ на вопрос");
  await пауза(150);
  assert.equal(к.state.stage, "accepted");
  журнал.close();
});

test("отправка, упавшая после регистрации цели, не оставляет чужую цель", async () => {
  const { к, claude, codex, журнал } = управляемаяКомната();
  claude.send = async () => {
    throw new Error("канал сломан");
  };
  await к.fromHuman("задача", "review");
  assert.equal(к.state.stage, "stopped");

  claude.send = Заглушка.prototype.send;
  await к.fromHuman("вопрос", "claude");
  ход(к, "claude", "ответ на вопрос");
  await пауза(150);
  assert.equal(codex.полученное.length, 0, "прямой ответ не должен уйти на проверку");
  журнал.close();
});

test("прерывание убирает из очереди пересылки прерванного цикла", async () => {
  // Сценарий рецензента: Codex занят, работа Claude ждёт проверки в
  // очереди, человек прерывает — и завершение прерванного хода выгружает
  // отменённую проверку.
  const { к, codex, журнал } = управляемаяКомната();
  await к.fromHuman("вопрос", "codex");
  codex.busy = true;
  await к.fromHuman("задача", "review");
  ход(к, "claude", "работа");
  await дождаться(() => к.state.queued === 1, "проверка в очереди");

  await к.interruptAll();
  assert.equal(к.state.queued, 0);
  codex.busy = false;
  к.handle(событие("codex", "turn_completed"));
  await пауза(150);
  assert.ok(
    codex.полученное.every((п) => !/работа/.test(п.text)),
    "отменённая проверка не должна уйти",
  );
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

test("в webview не уходят запись протокола и полный текст: там только показ", () => {
  const е = { id: "1", agent: "claude", kind: "tool_result", visibility: "turn", at: 0, text: "показ", raw: { big: 1 }, full: "полный" };
  const лёгкое = forDisplay(е);
  assert.equal(лёгкое.raw, undefined);
  assert.equal(лёгкое.full, undefined);
  assert.equal(лёгкое.text, "показ");
  assert.equal(е.full, "полный", "исходное событие не меняется: рецензенту нужен полный");
});

// ---------------------------------------------------------------------------
// Память по теме: заметки к сообщению человека
// ---------------------------------------------------------------------------

const ЗАМЕТКИ = { text: "## Плацебо FOMC всегда попадало на выходные" + String.fromCharCode(10) + "   отрывок", titles: ["Плацебо FOMC всегда попадало на выходные"] };

test("память: заметки по теме приложены к сообщению и названы человеку", async () => {
  // Поручение владельца 28.09: агенты должны память не только писать, но и читать.
  const { к, claude, журнал, события } = комната(3, { memory: async () => ЗАМЕТКИ });
  await к.fromHuman("почему отозвали FOMC", "claude");
  const т = claude.полученное[0].text;
  assert.ok(т.startsWith("почему отозвали FOMC"), "слова человека идут первыми и без изменений");
  assert.match(т, /Плацебо FOMC/);
  assert.match(т, /не слова человека/, "агент должен отличать заметки от поручения");
  assert.ok(
    системные(события).some((е) => /Память/.test(е.text ?? "") && /Плацебо FOMC/.test(е.text ?? "")),
    "человек видит, какие заметки ушли агентам",
  );
  assert.equal(к.state.task, undefined);
  журнал.close();
});

test("память: рецензент получает заметки вместе с задачей, а задача в шапке — без них", async () => {
  const { к, codex, журнал } = комната(3, { memory: async () => ЗАМЕТКИ });
  await к.fromHuman("проверь спецификацию", "review");
  assert.equal(к.state.task, "проверь спецификацию");
  ход(к, "claude", "сделал");
  await дождаться(() => codex.полученное.length === 1, "передача рецензенту");
  assert.match(codex.полученное[0].text, /Плацебо FOMC/);
  журнал.close();
});

test("память: сбой поиска не задерживает сообщение и назван человеку", async () => {
  const { к, claude, журнал, события } = комната(3, {
    memory: async () => {
      throw new Error("qmd не найден");
    },
  });
  await к.fromHuman("вопрос", "claude");
  assert.equal(claude.полученное[0].text, "вопрос");
  assert.ok(системные(события).some((е) => /памяти не удался/.test(е.text ?? "")));
  журнал.close();
});

test("память: ничего не найдено — сообщение как есть, без служебных строк", async () => {
  const { к, claude, журнал, события } = комната(3, { memory: async () => undefined });
  await к.fromHuman("вопрос", "both");
  assert.equal(claude.полученное[0].text, "вопрос");
  assert.equal(системные(события).filter((е) => /Память/.test(е.text ?? "")).length, 0);
  журнал.close();
});

// --- Рецензия Codex ночных коммитов 28.09 ------------------------------------

test("память: «Остановить» во время поиска — сообщение не уходит, и это названо", async () => {
  let отпустить;
  const поиск = new Promise((r) => (отпустить = r));
  const { к, claude, журнал, события } = комната(3, { memory: () => поиск });
  const отправка = к.fromHuman("вопрос", "claude");
  await дождаться(() => события.some((е) => е.agent === "human"), "сообщение человека в журнале");
  await к.stopAll();
  отпустить(ЗАМЕТКИ);
  await отправка;
  assert.equal(claude.полученное.length, 0, "после «Остановить» сообщение ушло");
  assert.ok(системные(события).some((е) => /не отправлено/.test(е.text ?? "")));
  assert.ok(!системные(события).some((е) => /приложены заметки/.test(е.text ?? "")), "названы заметки, которые никому не ушли");
  журнал.close();
});

test("память: заметки названы только для сообщения, которое ушло в текущий цикл", async () => {
  let отпустить;
  const поиск = new Promise((r) => (отпустить = r));
  let вызов = 0;
  const { к, claude, журнал, события } = комната(3, {
    memory: () => (++вызов === 1 ? поиск : Promise.resolve(undefined)),
  });
  const первая = к.fromHuman("первая задача", "review");
  await дождаться(() => события.some((е) => е.agent === "human"), "первая задача в журнале");
  await к.fromHuman("вторая задача", "review");
  отпустить(ЗАМЕТКИ);
  await первая;
  assert.deepEqual(claude.полученное.map((п) => п.text), ["вторая задача"]);
  assert.ok(!системные(события).some((е) => /приложены заметки/.test(е.text ?? "")));
  журнал.close();
});

// --- Расход задачи -------------------------------------------------------------

test("расход: токены копятся по задаче, новая задача начинает счёт заново", async () => {
  const { к, claude, codex, журнал } = комната();
  await к.fromHuman("задача", "review");
  к.handle(событие("claude", "message", { text: "сделал" }));
  к.handle(событие("claude", "turn_completed", { usage: { input: 1000, cached: 800, output: 50 }, limit: { status: "allowed", window: "five_hour" } }));
  await дождаться(() => codex.полученное.length === 1, "передача рецензенту");
  к.handle(событие("codex", "message", { text: "Поправь.\nВЕРДИКТ: ЕСТЬ ЗАМЕЧАНИЯ" }));
  к.handle(событие("codex", "turn_completed", { usage: { input: 500, cached: 100, output: 20 }, limit: { percent: 8, window: "week" } }));
  await дождаться(() => claude.полученное.length === 2, "возврат разработчику");
  к.handle(событие("claude", "turn_completed", { usage: { input: 10, cached: 0, output: 5 } }));
  await дождаться(() => к.state.usage.task.claude.input === 1010, "второй ход Claude учтён");
  assert.deepEqual(к.state.usage.task.claude, { input: 1010, cached: 800, output: 55 });
  assert.deepEqual(к.state.usage.task.codex, { input: 500, cached: 100, output: 20 });
  assert.equal(к.state.usage.limits.codex.percent, 8);
  await к.fromHuman("новая задача", "review");
  assert.deepEqual(к.state.usage.task.claude, { input: 0, cached: 0, output: 0 });
  assert.equal(к.state.usage.limits.codex.percent, 8, "сведения о лимите от задачи не зависят");
  журнал.close();
});

test("расход: предел токенов задачи останавливает автоматическую передачу", async () => {
  const { к, codex, журнал } = комната(3, { taskTokenLimit: 1000 });
  await к.fromHuman("задача", "review");
  к.handle(событие("claude", "message", { text: "сделал" }));
  к.handle(событие("claude", "turn_completed", { usage: { input: 900, cached: 0, output: 200 } }));
  await дождаться(() => к.state.stage === "held", "удержание по расходу");
  assert.equal(codex.полученное.length, 0);
  assert.match(к.state.held.reason, /предел/);
  assert.equal(к.state.held.to, "codex");
  журнал.close();
});

test("расход: поздний ход прежней задачи и прямой вопрос не идут в расход текущей", async () => {
  const { к, журнал } = комната();
  await к.fromHuman("задача А", "review");
  await к.fromHuman("задача Б", "review");
  // Первый конец хода Claude относится к задаче А — она уже не текущая.
  к.handle(событие("claude", "turn_completed", { usage: { input: 1000, cached: 0, output: 10 } }));
  assert.deepEqual(к.state.usage.task.claude, { input: 0, cached: 0, output: 0 });
  await к.fromHuman("прямой вопрос", "codex");
  к.handle(событие("codex", "turn_completed", { usage: { input: 50, cached: 0, output: 5 }, limit: { percent: 9, window: "week" } }));
  assert.deepEqual(к.state.usage.task.codex, { input: 0, cached: 0, output: 0 });
  assert.equal(к.state.usage.limits.codex.percent, 9, "сведения о лимите обновляются с любого хода");
  журнал.close();
});

test("новая сессия: агент забывает сессию, журнал — привязку, человек видит строку", async () => {
  const { к, claude, журнал, события } = комната();
  журнал.bindSessions("r", "claude-старая", "codex-ветка");
  claude.забыто = 0;
  claude.forgetSession = async () => {
    claude.забыто += 1;
  };
  await к.newSession("claude");
  assert.equal(claude.забыто, 1);
  assert.equal(журнал.binding("r").claudeSessionId, undefined);
  assert.equal(журнал.binding("r").codexThreadId, "codex-ветка", "ветку Codex не трогаем");
  assert.ok(системные(события).some((е) => /новая сессия Claude/i.test(е.text ?? "")));
  журнал.close();
});

test("новая сессия посреди хода агента останавливает цикл, а не оставляет его ждать", async () => {
  const { к, claude, журнал } = комната();
  claude.forgetSession = async () => {};
  await к.fromHuman("задача", "review");
  claude.busy = true;
  await к.newSession("claude");
  assert.equal(к.state.stage, "stopped");
  журнал.close();
});

test("новая сессия: очередь сброшенного агента уходит в новую сессию", async () => {
  const { к, claude, журнал } = комната();
  claude.forgetSession = async () => {
    claude.busy = false;
  };
  claude.busy = true;
  await к.fromHuman("вопрос в очереди", "claude");
  assert.equal(claude.полученное.length, 0, "занятому агенту сообщение не уходит сразу");
  await к.newSession("claude");
  await дождаться(() => claude.полученное.length === 1, "очередь выгружена");
  assert.equal(claude.полученное[0].text, "вопрос в очереди");
  журнал.close();
});

test("новая сессия: привязка очищается раньше остановки — закрытие панели её не вернёт", async () => {
  const { к, claude, журнал, каталог } = комната();
  журнал.bindSessions("r", "claude-старая", "codex-ветка");
  claude.forgetSession = async () => {
    журнал.close(); // панель закрыли, пока останавливался процесс
  };
  await к.newSession("claude");
  const заново = new Journal(join(каталог, "j.sqlite"));
  assert.equal(заново.binding("r").claudeSessionId, undefined);
  заново.close();
});

test("новая сессия: удержанная передача этому агенту снимается и названа", async () => {
  const { к, codex, журнал, события } = комната();
  codex.forgetSession = async () => {};
  к.setAuto(false);
  await к.fromHuman("задача", "review");
  ход(к, "claude", "сделал");
  await дождаться(() => к.state.stage === "held", "удержание для рецензента");
  assert.equal(к.state.held.to, "codex");
  await к.newSession("codex");
  assert.equal(к.state.held, undefined);
  assert.ok(системные(события).some((е) => /снята/.test(е.text ?? "")));
  журнал.close();
});
