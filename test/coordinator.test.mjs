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

class Stub {
  constructor(id) {
    this.id = id;
    this.busy = false;
    this.sessionId = `${id}-сессия`;
    this.received = [];
    this.interrupted = 0;
    this.stopped = 0;
  }
  async start() {}
  async send(prompt) {
    this.received.push(prompt);
  }
  async interrupt() {
    this.interrupted += 1;
  }
  async stop() {
    this.stopped += 1;
  }
  async answerApproval(id, decision) {
    this.decisions.push([id, decision]);
    return true;
  }
  decisions = [];
}

function room(limit = 3, options = {}, { withGemini = false } = {}) {
  const catalog = mkdtempSync(join(tmpdir(), "panel-"));
  const journal = new Journal(join(catalog, "j.sqlite"));
  journal.ensureRoom("r", catalog);
  const claude = new Stub("claude");
  const codex = new Stub("codex");
  const gemini = withGemini ? new Stub("gemini") : undefined;
  const events = [];
  const k = new Coordinator(claude, codex, journal, {
    room: "r",
    cwd: catalog,
    maxAutoRounds: limit,
    onEvent: (e) => events.push(e),
    ...(gemini ? { gemini } : {}),
    ...options,
  });
  return { k, claude, codex, gemini, journal, events, catalog };
}

/**
 * Ожидание по условию. Пересылка ждёт снимок версии файлов, поэтому один
 * тик цикла событий здесь не годится.
 */
async function waitFor(condition, message, limit = 5000) {
  const start = Date.now();
  while (Date.now() - start < limit) {
    if (condition()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  assert.fail(`не дождались: ${message}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function event(agent, kind, extra = {}) {
  return {
    id: `${kind}-${Math.random().toString(36).slice(2)}`,
    agent,
    kind,
    visibility: ["text_delta", "tool_running", "diagnostic"].includes(kind)
      ? "stream"
      : "turn",
    at: Date.now(),
    ...extra,
  };
}

/** Законченный ход агента: реплика и завершение. */
function turn(k, agent, text, extra = {}) {
  k.handle(event(agent, "message", { text: text }));
  k.handle(event(agent, "turn_completed", extra));
}

const systemEvents = (events) => events.filter((e) => e.agent === "system");

// ---------------------------------------------------------------------------
// Рецензия: строгая очерёдность и завершение по вердикту
// ---------------------------------------------------------------------------

test("самостоятельный ход Claude не занимает цель задачи и не идёт рецензенту", async () => {
  // Фоновая команда кончилась, и Claude сам начал ход (живая трасса 28.09).
  // Если его конец придёт, пока ждём работу по задаче, он не должен стать
  // этой работой: итог настоящего хода иначе ушёл бы в никуда.
  const { k, claude, codex, events } = room();
  await k.fromHuman("сделай отчёт", "review");
  await waitFor(() => claude.received.length === 1, "задача у Claude");
  claude.busy = true;
  k.handle(event("claude", "turn_started", { unsolicited: true, text: "фоновая команда «pytest» закончилась" }));
  turn(k, "claude", "Команда завершена успешно.", { unsolicited: true, usage: { input: 900, cached: 0, output: 9 } });
  await sleep(50);
  assert.equal(codex.received.length, 0);
  assert.equal(k.state.stage, "working");
  assert.equal(k.state.usage.task.claude.input, 0);
  assert.ok(systemEvents(events).some((e) => /продолжил сам/.test(e.text) && /pytest/.test(e.text)));

  claude.busy = false;
  turn(k, "claude", "отчёт готов");
  await waitFor(() => codex.received.length === 1, "рецензия");
  assert.match(codex.received[0].text, /отчёт готов/);
  assert.doesNotMatch(codex.received[0].text, /Команда завершена успешно/);
});

test("недельная доля Claude запрашивается после его хода, не чаще раза в период", async () => {
  // Граница владельца — не больше 90% недели Claude; в потоке claude -p доли нет.
  let callCount = 0;
  const { k } = room(3, {
    claudeUsage: async () => {
      callCount += 1;
      return { weekPercent: 4, sessionPercent: 28, weekResets: "Oct 4, 12am" };
    },
    claudeUsageEveryMs: 60_000,
  });
  turn(k, "claude", "ответ");
  await waitFor(() => k.state.usage.limits.claudeWeek?.percent === 4, "доля недели");
  const { at, ...fraction } = k.state.usage.limits.claudeWeek;
  assert.deepEqual(fraction, { percent: 4, session: 28, resets: "Oct 4, 12am" });
  assert.ok(Date.now() - at < 5000, "время сведения");
  turn(k, "claude", "ещё ответ");
  turn(k, "codex", "ответ Codex");
  await sleep(50);
  assert.equal(callCount, 1);
});

test("сбой запроса недельной доли — доли нет, работа идёт", async () => {
  const { k, codex } = room(3, {
    claudeUsage: async () => {
      throw new Error("claude не найден");
    },
  });
  await k.fromHuman("сделай", "review");
  turn(k, "claude", "готово");
  await waitFor(() => codex.received.length === 1, "рецензия");
  assert.equal(k.state.usage.limits.claudeWeek, undefined);
});

test("недельную долю можно запросить при открытии панели", async () => {
  const { k } = room(3, { claudeUsage: async () => ({ weekPercent: 12 }) });
  await k.refreshClaudeUsage();
  assert.equal(k.state.usage.limits.claudeWeek.percent, 12);
  assert.equal(k.state.usage.limits.claudeWeek.stale, undefined);
});

test("неудачный повторный запрос помечает прежнюю долю устаревшей", async () => {
  // Рецензия Codex 28.09 (2febf2e): прежний процент показывался как текущий.
  let call = 0;
  const { k } = room(3, {
    claudeUsage: async () => {
      call += 1;
      if (call === 1) return { weekPercent: 12 };
      if (call === 2) return undefined;
      throw new Error("нет claude");
    },
    claudeUsageEveryMs: 0,
  });
  await k.refreshClaudeUsage();
  await k.refreshClaudeUsage();
  assert.equal(k.state.usage.limits.claudeWeek.percent, 12);
  assert.equal(k.state.usage.limits.claudeWeek.stale, true);
});

test("«Прервать» снимает прямые сообщения из очереди и говорит об этом", async () => {
  // Рецензии Codex 28.09: прямое сообщение ждало конца хода, а после
  // прерывания его не будет — очередь висела. Отправлять его сразу нельзя:
  // человек мог прервать именно чтобы отменить, а поздний конец прерванного
  // хода Codex снял бы цель нового. Снять и назвать — честнее.
  const { k, claude, events } = room();
  claude.busy = true;
  claude.interrupt = async () => {
    claude.interrupted += 1;
    claude.busy = false;
  };
  await k.fromHuman("вопрос", "claude");
  assert.equal(k.state.queued, 1);
  await k.interruptAll();
  assert.equal(claude.interrupted, 1);
  assert.equal(k.state.queued, 0);
  assert.equal(claude.received.length, 0);
  assert.ok(systemEvents(events).some((e) => /Не отправлено сообщений из очереди: 1/.test(e.text)));
});

test("сообщение, написанное пока шло «Прервать», уходит после него", async () => {
  // Рецензия Codex 28.09 (8d38285): пока turn/interrupt ждал ответа, адаптер
  // был занят, новое сообщение вставало в очередь — и висело: конца
  // прерванного хода панель не ждёт.
  const { k, codex } = room();
  codex.busy = true;
  let release;
  codex.interrupt = () =>
    new Promise((done) => {
      release = () => {
        codex.busy = false;
        done();
      };
    });
  const interruption = k.interruptAll();
  await waitFor(() => release, "прерывание началось");
  await k.fromHuman("новый вопрос", "codex");
  assert.equal(k.state.queued, 1);
  release();
  await interruption;
  assert.equal(k.state.queued, 0);
  assert.equal(codex.received.length, 1);
  assert.match(codex.received[0].text, /новый вопрос/);
});

test("«Прервать» во время снимка файлов — сообщение не уходит", async () => {
  // Рецензия Codex 28.09: счётчик остановок запоминался после снимка.
  const { k, claude } = room();
  const outgoing = k.fromHuman("вопрос", "claude");
  await k.interruptAll();
  await outgoing;
  assert.equal(claude.received.length, 0);
});

test("сообщение Claude во время его самостоятельного хода ждёт конца этого хода", async () => {
  const { k, claude } = room();
  claude.busy = true;
  k.handle(event("claude", "turn_started", { unsolicited: true, text: "фоновая команда закончилась" }));
  await k.fromHuman("вопрос", "claude");
  assert.equal(claude.received.length, 0);
  assert.equal(k.state.queued, 1);
  claude.busy = false;
  turn(k, "claude", "итог фоновой", { unsolicited: true });
  await waitFor(() => claude.received.length === 1, "отправка из очереди");
  assert.match(claude.received[0].text, /вопрос/);
});

test("задача с рецензией уходит только разработчику", async () => {
  const { k, claude, codex, journal } = room();
  await k.fromHuman("сделай отчёт", "review");
  assert.equal(claude.received.length, 1);
  assert.equal(codex.received.length, 0, "рецензент не должен работать параллельно");
  assert.equal(claude.received[0].from, "human");
  assert.equal(k.state.stage, "working");
  assert.equal(k.state.task, "сделай отчёт");
  journal.close();
});

test("рецензент получает задачу, материал разработчика и просьбу о вердикте", async () => {
  const { k, codex, journal } = room();
  await k.fromHuman("исходная задача", "review");
  k.handle(event("claude", "message", { text: "сделал" }));
  k.handle(event("claude", "tool_call", { tool: "Bash", callId: "c1", text: "npm test" }));
  k.handle(
    event("claude", "tool_result", { tool: "Bash", callId: "c1", text: "25 passed" }),
  );
  k.handle(event("claude", "turn_completed"));
  await waitFor(() => codex.received.length === 1, "передача рецензенту");

  const p = codex.received[0];
  assert.equal(p.from, "claude");
  assert.match(p.text, /исходная задача/, "без задачи рецензент не знает, что проверять");
  assert.match(p.text, /сделал/);
  assert.match(p.text, /СЫРОЙ вывод инструмента Bash/);
  assert.match(p.text, /25 passed/);
  assert.match(p.text, /ВЕРДИКТ/, "без просьбы о вердикте цикл нечем завершить");
  assert.equal(k.state.round, 1);
  assert.equal(k.state.stage, "reviewing");
  journal.close();
});

test("вердикт ПРИНЯТО завершает цикл", async () => {
  const { k, claude, codex, journal, events } = room();
  await k.fromHuman("задача", "review");
  turn(k, "claude", "сделал");
  await waitFor(() => codex.received.length === 1, "передача рецензенту");
  turn(k, "codex", "Расхождений нет.\nВЕРДИКТ: ПРИНЯТО");
  await waitFor(() => k.state.stage === "accepted", "завершение цикла");

  assert.equal(claude.received.length, 1, "принятую работу не возвращают разработчику");
  assert.equal(k.state.verdict, "accepted");
  assert.ok(
    systemEvents(events).some((e) => /принял/i.test(e.text ?? "")),
    "человек должен увидеть, что работа принята",
  );
  journal.close();
});

test("вердикт ЕСТЬ ЗАМЕЧАНИЯ возвращает работу разработчику", async () => {
  const { k, claude, codex, journal } = room();
  await k.fromHuman("задача", "review");
  turn(k, "claude", "сделал");
  await waitFor(() => codex.received.length === 1, "передача рецензенту");
  turn(k, "codex", "Найден дефект в расчёте.\nВЕРДИКТ: ЕСТЬ ЗАМЕЧАНИЯ");
  await waitFor(() => claude.received.length === 2, "возврат разработчику");

  assert.equal(claude.received[1].from, "codex");
  assert.match(claude.received[1].text, /Найден дефект/);
  assert.equal(k.state.verdict, "remarks");
  assert.equal(k.state.stage, "working");
  journal.close();
});

test("без вердикта ответ рецензента удерживается до решения человека", async () => {
  const { k, claude, codex, journal, events } = room();
  await k.fromHuman("задача", "review");
  turn(k, "claude", "сделал");
  await waitFor(() => codex.received.length === 1, "передача рецензенту");
  turn(k, "codex", "Что-то не нравится, но не уверен.");
  await waitFor(() => k.state.stage === "held", "удержание");

  assert.equal(claude.received.length, 1, "без вердикта нельзя решать за человека");
  assert.equal(k.state.held.to, "claude");
  assert.match(k.state.held.reason, /вердикт/i);
  assert.equal(k.state.verdict, "missing");
  assert.ok(systemEvents(events).some((e) => /вердикт/i.test(e.text ?? "")));
  journal.close();
});

test("вердикт НУЖНО РЕШЕНИЕ ЧЕЛОВЕКА останавливает обмен и ждёт человека", async () => {
  // Живой прогон 16 сентября: рецензент считал обмен законченным, но мог
  // поставить только ЕСТЬ ЗАМЕЧАНИЯ, и третья проверка ушла на согласия.
  const { k, claude, codex, journal, events } = room();
  await k.fromHuman("задача", "review");
  turn(k, "claude", "сделал");
  await waitFor(() => codex.received.length === 1, "передача рецензенту");
  turn(k, "codex", "Без новых исходников продолжать незачем.\nВЕРДИКТ: НУЖНО РЕШЕНИЕ ЧЕЛОВЕКА");
  await waitFor(() => k.state.stage === "held", "удержание");

  assert.equal(claude.received.length, 1, "ответ рецензента не должен уходить разработчику сам");
  assert.equal(k.state.verdict, "human");
  assert.equal(k.state.held.to, "claude");
  assert.match(k.state.held.reason, /решени/i);
  assert.ok(systemEvents(events).some((e) => /решени/i.test(e.text ?? "")));
  journal.close();
});

test("рецензент знает, как помечен неполный вывод и где лежит полный", async () => {
  const { k, codex, journal } = room();
  await k.fromHuman("задача", "review");
  turn(k, "claude", "сделал");
  await waitFor(() => codex.received.length === 1, "передача рецензенту");
  assert.match(codex.received[0].text, /[Нн]еполный/);
  assert.match(codex.received[0].text, /журнал/i);
  journal.close();
});

test("рецензент получает полный вывод, обрезанный только для показа, с отметкой полноты", async () => {
  // Исследование Codex 27.09: рецензенту уходил усечённый показ, и пометка
  // «сырой вывод» завышала полноту переданного.
  const { k, codex, journal } = room();
  await k.fromHuman("задача", "review");
  k.handle(event("claude", "tool_call", { tool: "Bash", callId: "c1", text: "cat big.log" }));
  k.handle(
    event("claude", "tool_result", {
      tool: "Bash",
      callId: "c1",
      text: "x".repeat(10) + " … обрезано 99 999 символов",
      full: "x".repeat(99_000) + "КОНЕЦ",
    }),
  );
  turn(k, "claude", "прочитал");
  await waitFor(() => codex.received.length === 1, "передача рецензенту");
  const t = codex.received[0].text;
  assert.match(t, /КОНЕЦ/, "конец вывода до рецензента не дошёл");
  assert.match(t, /вызов c1/);
  assert.match(t, /полный, 99 005 символов/);
  journal.close();
});

test("рецензент видит, какие действия сделал субагент, а не сам Claude", async () => {
  const { k, codex, journal } = room();
  await k.fromHuman("задача", "review");
  k.handle(event("claude", "tool_call", { tool: "Agent", callId: "toolu_agent", text: "{}" }));
  k.handle(event("claude", "tool_call", { tool: "Read", callId: "toolu_sub", parentCallId: "toolu_agent", text: "a.txt" }));
  k.handle(event("claude", "tool_result", { tool: "Read", callId: "toolu_sub", parentCallId: "toolu_agent", text: "alpha" }));
  turn(k, "claude", "итог");
  await waitFor(() => codex.received.length === 1, "передача рецензенту");
  const t = codex.received[0].text;
  assert.match(t, /вызов инструмента Read · вызов toolu_sub · субагент вызова toolu_agent/);
  assert.match(t, /СЫРОЙ вывод инструмента Read · вызов toolu_sub · субагент вызова toolu_agent/);
  journal.close();
});

test("выводы больше бюджета проверки режутся поровну: начало и конец, пропуск указан", async () => {
  const { k, codex, journal } = room(3, { evidenceBudget: 30_000 });
  await k.fromHuman("задача", "review");
  const output = (id, length, label) =>
    event("claude", "tool_result", { tool: "Bash", callId: id, text: "показ", full: label + "y".repeat(length - label.length - 5) + "ХВОСТ" });
  k.handle(output("a", 40_000, "ПЕРВЫЙ"));
  k.handle(output("b", 40_000, "ВТОРОЙ"));
  k.handle(event("claude", "tool_result", { tool: "Read", callId: "c", text: "маленький вывод целиком" }));
  turn(k, "claude", "готово");
  await waitFor(() => codex.received.length === 1, "передача рецензенту");
  const t = codex.received[0].text;
  assert.match(t, /маленький вывод целиком/);
  assert.match(t, /вызов c · полный/);
  assert.equal((t.match(/неполный: показано/g) ?? []).length, 2, "оба длинных вывода помечены неполными");
  assert.match(t, /ПЕРВЫЙ/);
  assert.match(t, /ВТОРОЙ/);
  assert.equal((t.match(/ХВОСТ/g) ?? []).length, 2, "конец длинного вывода показан");
  assert.match(t, /пропущены символы \d/);
  assert.ok(t.length < 45_000, `материал больше бюджета: ${t.length}`);
  journal.close();
});

// ---------------------------------------------------------------------------
// След цикла для «Дорожки»
// ---------------------------------------------------------------------------

test("след цикла: задача, работа и проверка с отметкой вердикта", async () => {
  const { k, claude, codex, journal } = room();
  await k.fromHuman("задача", "review");
  await waitFor(() => claude.received.length === 1, "работа у Claude");
  assert.deepEqual(k.state.trail, [{ who: "task" }, { who: "claude" }]);
  turn(k, "claude", "сделал");
  await waitFor(() => codex.received.length === 1, "проверка у Codex");
  turn(k, "codex", "Дефект.\nВЕРДИКТ: ЕСТЬ ЗАМЕЧАНИЯ");
  await waitFor(() => claude.received.length === 2, "возврат Claude");
  assert.deepEqual(k.state.trail, [
    { who: "task" },
    { who: "claude" },
    { who: "codex", mark: "!" },
    { who: "claude" },
  ]);
  journal.close();
});

test("след цикла: принятие ставит галочку, удержание добавляет человека", async () => {
  const acceptRoom = room();
  await acceptRoom.k.fromHuman("задача", "review");
  turn(acceptRoom.k, "claude", "сделал");
  await waitFor(() => acceptRoom.codex.received.length === 1, "проверка");
  turn(acceptRoom.k, "codex", "Хорошо.\nВЕРДИКТ: ПРИНЯТО");
  await waitFor(() => acceptRoom.k.state.stage === "accepted", "принятие");
  assert.deepEqual(acceptRoom.k.state.trail.at(-1), { who: "codex", mark: "✓" });
  acceptRoom.journal.close();

  const holdRoom = room();
  await holdRoom.k.fromHuman("задача", "review");
  turn(holdRoom.k, "claude", "сделал");
  await waitFor(() => holdRoom.codex.received.length === 1, "проверка");
  turn(holdRoom.k, "codex", "Нужны данные.\nВЕРДИКТ: НУЖНО РЕШЕНИЕ ЧЕЛОВЕКА");
  await waitFor(() => holdRoom.k.state.stage === "held", "удержание");
  assert.deepEqual(holdRoom.k.state.trail.slice(-2), [{ who: "codex", mark: "?" }, { who: "you" }]);
  holdRoom.journal.close();
});

test("след цикла: новая задача начинает заново, прямой вопрос его не трогает", async () => {
  const { k, claude, journal } = room();
  await k.fromHuman("задача А", "review");
  turn(k, "claude", "сделал");
  await k.fromHuman("вопрос", "codex");
  assert.deepEqual(k.state.trail.map((sh) => sh.who).slice(0, 2), ["task", "claude"]);
  assert.ok(!k.state.trail.some((sh) => sh.who === "codex" && !sh.mark && false));
  await k.fromHuman("задача Б", "review");
  await waitFor(() => claude.received.length >= 2, "новая работа");
  assert.deepEqual(k.state.trail, [{ who: "task" }, { who: "claude" }]);
  journal.close();
});

test("удержанное отправляется по команде человека", async () => {
  const { k, claude, codex, journal } = room();
  await k.fromHuman("задача", "review");
  turn(k, "claude", "сделал");
  await waitFor(() => codex.received.length === 1, "передача рецензенту");
  turn(k, "codex", "Что-то не нравится.");
  await waitFor(() => k.state.stage === "held", "удержание");

  await k.releaseHeld();
  assert.equal(claude.received.length, 2);
  assert.match(claude.received[1].text, /Что-то не нравится/);
  assert.equal(k.state.held, undefined);
  journal.close();
});

test("предел раундов удерживает непроверенные исправления, а не теряет их", async () => {
  const { k, claude, codex, journal, events } = room(1);
  await k.fromHuman("задача", "review");
  turn(k, "claude", "версия один");
  await waitFor(() => codex.received.length === 1, "первая проверка");
  turn(k, "codex", "Плохо.\nВЕРДИКТ: ЕСТЬ ЗАМЕЧАНИЯ");
  await waitFor(() => claude.received.length === 2, "возврат разработчику");
  turn(k, "claude", "версия два");
  await waitFor(() => k.state.stage === "held", "удержание на пределе");

  assert.equal(codex.received.length, 1, "сверх предела рецензент не вызывается");
  assert.equal(k.state.held.to, "codex");
  assert.match(
    k.state.held.reason,
    /не провер/i,
    "человек должен знать, что исправления остались непроверенными",
  );
  assert.ok(systemEvents(events).some((e) => /предел/i.test(e.text ?? "")));

  await k.releaseHeld();
  assert.equal(codex.received.length, 2);
  assert.match(codex.received[1].text, /версия два/);
  journal.close();
});

test("нулевой предел: работа разработчика удерживается, а не пропадает", async () => {
  const { k, codex, journal } = room(0);
  await k.fromHuman("задача", "review");
  turn(k, "claude", "готово");
  await waitFor(() => k.state.stage === "held", "удержание");
  assert.equal(codex.received.length, 0);
  assert.equal(k.state.held.to, "codex");
  journal.close();
});

test("выключенная автопересылка удерживает передачу", async () => {
  // Слово одно на всю панель: переключатель называется «автопересылка»,
  // и причина удержания должна говорить тем же словом.
  const { k, codex, journal } = room();
  k.setAuto(false);
  await k.fromHuman("задача", "review");
  turn(k, "claude", "готово");
  await waitFor(() => k.state.stage === "held", "удержание");
  assert.equal(codex.received.length, 0);
  assert.match(k.state.held.reason, /автопересылк/i);
  assert.doesNotMatch(k.state.held.reason, /раунд/i);
  journal.close();
});

test("проваленный ход разработчика останавливает цикл без пересылки", async () => {
  const { k, codex, journal, events } = room();
  await k.fromHuman("задача", "review");
  k.handle(event("claude", "message", { text: "начал" }));
  k.handle(event("claude", "turn_completed", { failed: true }));
  await waitFor(() => k.state.stage === "stopped", "остановка цикла");
  assert.equal(codex.received.length, 0);
  assert.ok(systemEvents(events).some((e) => /ошибк/i.test(e.text ?? "")));
  journal.close();
});

test("падение процесса агента посреди цикла прекращает ожидание", async () => {
  const { k, codex, journal } = room();
  await k.fromHuman("задача", "review");
  k.handle(event("claude", "error", { failed: true, text: "процесс упал" }));
  await waitFor(() => k.state.stage === "stopped", "остановка цикла");
  assert.equal(codex.received.length, 0, "ждать ответа от мёртвого процесса нельзя");
  journal.close();
});

test("поток без законченной реплики нечего отдавать на проверку", async () => {
  const { k, codex, journal } = room();
  await k.fromHuman("задача", "review");
  k.handle(event("claude", "text_delta", { text: "по" }));
  k.handle(event("claude", "text_delta", { text: "ток" }));
  k.handle(event("claude", "turn_completed"));
  await waitFor(() => k.state.stage === "stopped", "остановка цикла");
  assert.equal(
    codex.received.length,
    0,
    "дельты не передаются: иначе каждая буква запускала бы ответ",
  );
  journal.close();
});

// ---------------------------------------------------------------------------
// Отказы в разрешениях
//
// Живой прогон 15 сентября: команды Claude отклонены на согласовании, Claude
// объяснил блокировку, объяснение ушло на проверку, и три раунда рецензии
// потрачены на спор о причинах блокировки. Отказы — дело человека, а не
// рецензента.
// ---------------------------------------------------------------------------

const DENIALS = ["Bash: git -C C:\\agent-panel show d748e88"];

test("работа с отказами в разрешениях не идёт на проверку, а ждёт человека", async () => {
  const { k, codex, journal, events } = room();
  await k.fromHuman("покажи коммит", "review");
  k.handle(event("claude", "message", { text: "команды заблокированы" }));
  k.handle(event("claude", "turn_completed", { denials: DENIALS }));
  await waitFor(() => k.state.stage === "held", "удержание");

  assert.equal(codex.received.length, 0, "спорить о блокировке рецензенту незачем");
  assert.equal(k.state.round, 0, "проверка не состоялась — раунд не расходуется");
  assert.equal(k.state.held.to, "claude");
  assert.equal(k.state.held.action, "retry");
  assert.match(k.state.held.reason, /разрешени/i);
  assert.match(k.state.held.reason, /git -C/, "человек должен видеть, что именно отклонено");
  assert.ok(systemEvents(events).some((e) => /разрешени/i.test(e.text ?? "")));
  journal.close();
});

test("повтор после отказов заново отдаёт Claude исходную задачу", async () => {
  const { k, claude, journal } = room();
  await k.fromHuman("покажи коммит", "review");
  k.handle(event("claude", "message", { text: "заблокировано" }));
  k.handle(event("claude", "turn_completed", { denials: DENIALS }));
  await waitFor(() => k.state.stage === "held", "удержание");

  await k.releaseHeld();
  assert.equal(claude.received.length, 2);
  assert.match(claude.received[1].text, /покажи коммит/);
  assert.equal(k.state.stage, "working");
  assert.equal(k.state.held, undefined);
  journal.close();
});

test("успешный повтор после отказов уходит на проверку как обычно", async () => {
  const { k, codex, journal } = room();
  await k.fromHuman("покажи коммит", "review");
  k.handle(event("claude", "message", { text: "заблокировано" }));
  k.handle(event("claude", "turn_completed", { denials: DENIALS }));
  await waitFor(() => k.state.stage === "held", "удержание");
  await k.releaseHeld();

  turn(k, "claude", "вот вывод коммита");
  await waitFor(() => codex.received.length === 1, "передача рецензенту");
  assert.match(codex.received[0].text, /вот вывод коммита/);
  assert.equal(k.state.round, 1);
  journal.close();
});

test("отказы в прямом вопросе показываются человеку без удержания", async () => {
  const { k, journal, events } = room();
  await k.fromHuman("вопрос", "claude");
  k.handle(event("claude", "message", { text: "не смог" }));
  k.handle(event("claude", "turn_completed", { denials: DENIALS }));
  await waitFor(
    () => systemEvents(events).some((e) => /разрешени/i.test(e.text ?? "")),
    "уведомление об отказах",
  );
  assert.equal(k.state.held, undefined);
  journal.close();
});

test("новая задача отменяет ожидающий повтор", async () => {
  const { k, claude, journal } = room();
  await k.fromHuman("задача А", "review");
  k.handle(event("claude", "message", { text: "заблокировано" }));
  k.handle(event("claude", "turn_completed", { denials: DENIALS }));
  await waitFor(() => k.state.stage === "held", "удержание");

  await k.fromHuman("задача Б", "review");
  assert.equal(k.state.held, undefined);
  await k.releaseHeld();
  assert.ok(
    claude.received.every((p) => !/задача А/.test(p.text) || p === claude.received[0]),
    "отменённый повтор не должен уйти",
  );
  journal.close();
});

// ---------------------------------------------------------------------------
// Прямые вопросы и вопрос обоим: ничего не пересылается
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Запросы разрешений
// ---------------------------------------------------------------------------

test("открытый запрос разрешения виден в состоянии, пока не решён", () => {
  const { k } = room();
  k.handle(event("claude", "approval_requested", { callId: "p1", tool: "Bash", text: "mkdir x" }));
  assert.equal(k.state.approvals, 1);
  k.handle(event("claude", "approval_decided", { callId: "p1", text: "разрешено" }));
  assert.equal(k.state.approvals, 0);
});

test("решение человека уходит адаптеру того агента, который спросил", async () => {
  const { k, claude, codex } = room();
  k.handle(event("claude", "approval_requested", { callId: "p1", tool: "Bash" }));
  await k.answerApproval("p1", "allowSession");
  assert.deepEqual(claude.decisions, [["p1", "allowSession"]]);
  assert.deepEqual(codex.decisions, []);
});

test("ответ на неизвестный или решённый запрос не отправляется", async () => {
  const { k, claude } = room();
  await k.answerApproval("нет-такого", "allow");
  k.handle(event("claude", "approval_requested", { callId: "p1" }));
  k.handle(event("claude", "approval_decided", { callId: "p1" }));
  await k.answerApproval("p1", "allow");
  assert.deepEqual(claude.decisions, []);
});

test("остановка закрывает открытые запросы разрешений", async () => {
  const { k } = room();
  k.handle(event("claude", "approval_requested", { callId: "p1" }));
  await k.stopAll();
  assert.equal(k.state.approvals, 0);
});

test("падение процесса закрывает его запросы разрешений", () => {
  const { k } = room();
  k.handle(event("claude", "approval_requested", { callId: "p1" }));
  k.handle(event("claude", "error", { failed: true, text: "процесс завершился" }));
  assert.equal(k.state.approvals, 0);
});

test("запрос разрешения не попадает в материал рецензенту", async () => {
  const { k, claude, codex } = room();
  await k.fromHuman("создай каталог", "review");
  await waitFor(() => claude.received.length === 1, "работа у Claude");
  k.handle(event("claude", "approval_requested", { callId: "p1", tool: "Bash", text: "СЕКРЕТНАЯ-КОМАНДА" }));
  k.handle(event("claude", "approval_decided", { callId: "p1", text: "разрешено" }));
  turn(k, "claude", "сделано");
  await waitFor(() => codex.received.length === 1, "проверка у Codex");
  assert.doesNotMatch(codex.received[0].text, /СЕКРЕТНАЯ-КОМАНДА/);
});

test("спросить обоих: оба отвечают, друг другу ничего не пересылается", async () => {
  const { k, claude, codex, journal } = room();
  await k.fromHuman("ваше мнение?", "all");
  assert.equal(claude.received.length, 1);
  assert.equal(codex.received.length, 1);
  turn(k, "codex", "мнение Codex");
  turn(k, "claude", "мнение Claude");
  await sleep(150);
  assert.equal(claude.received.length, 1, "именно здесь разошлись ответы в живом прогоне");
  assert.equal(codex.received.length, 1);
  journal.close();
});

test("прямой вопрос рецензенту не запускает пересылку", async () => {
  const { k, claude, codex, journal } = room();
  await k.fromHuman("вопрос", "codex");
  assert.equal(codex.received.length, 1);
  turn(k, "codex", "ответ");
  await sleep(150);
  assert.equal(claude.received.length, 0);
  journal.close();
});

test("ход прямого вопроса не путается с ходом цикла", async () => {
  const { k, claude, codex, journal } = room();
  await k.fromHuman("задача", "review");
  claude.busy = true;
  await k.fromHuman("вопрос мимоходом", "claude");
  assert.equal(claude.received.length, 1, "занятому не отправляем");
  assert.equal(k.state.queued, 1);

  claude.busy = false;
  turn(k, "claude", "работа сделана");
  await waitFor(
    () => codex.received.length === 1 && claude.received.length === 2,
    "пересылка работы и выдача отложенного вопроса",
  );
  assert.match(codex.received[0].text, /работа сделана/);

  turn(k, "claude", "ответ на вопрос");
  await sleep(150);
  assert.equal(codex.received.length, 1, "ответ на прямой вопрос не идёт на проверку");
  assert.ok(!/ответ на вопрос/.test(codex.received[0].text));
  journal.close();
});

test("материал прямого ответа не попадает в пересылку цикла", async () => {
  // Родственник дефекта с общим накопителем: материал предыдущего хода,
  // не предназначенного для проверки, не должен уходить рецензенту.
  const { k, codex, journal } = room();
  await k.fromHuman("вопрос", "claude");
  turn(k, "claude", "постороннее рассуждение");
  await sleep(100);
  await k.fromHuman("задача", "review");
  turn(k, "claude", "работа по задаче");
  await waitFor(() => codex.received.length === 1, "передача рецензенту");
  assert.match(codex.received[0].text, /работа по задаче/);
  assert.ok(!/постороннее/.test(codex.received[0].text));
  journal.close();
});

// ---------------------------------------------------------------------------
// Устаревшее и очередь
// ---------------------------------------------------------------------------

test("новая задача отменяет устаревшие пересылки прежней", async () => {
  const { k, claude, codex, journal, events } = room();
  await k.fromHuman("задача А", "review");
  codex.busy = true;
  turn(k, "claude", "работа по задаче А");
  await waitFor(() => k.state.queued === 1, "пересылка встала в очередь");

  await k.fromHuman("задача Б", "review");
  assert.equal(k.state.queued, 0, "пересылка по задаче А устарела");
  assert.match(claude.received.at(-1).text, /задача Б/);
  assert.ok(
    systemEvents(events).some((e) => /устаревш/i.test(e.text ?? "")),
    "человек должен знать, что что-то не доставлено",
  );

  codex.busy = false;
  k.handle(event("codex", "turn_completed"));
  await sleep(150);
  assert.ok(codex.received.every((p) => !/работа по задаче А/.test(p.text)));
  journal.close();
});

test("очередь занятому агенту сохраняет порядок прямых сообщений", async () => {
  const { k, codex, journal } = room();
  codex.busy = true;
  for (const label of ["первое", "второе", "третье"]) {
    await k.fromHuman(label, "codex");
  }
  assert.equal(codex.received.length, 0);
  assert.equal(k.state.queued, 3);

  codex.busy = false;
  k.handle(event("codex", "turn_completed"));
  await waitFor(() => codex.received.length === 3, "выгрузка очереди");
  assert.match(codex.received[0].text, /первое/);
  assert.match(codex.received[1].text, /второе/);
  assert.match(codex.received[2].text, /третье/);
  journal.close();
});

test("остановка останавливает обоих, поздний ход ничего не пересылает", async () => {
  const { k, claude, codex, journal } = room();
  await k.fromHuman("задача", "review");
  await k.stopAll();
  assert.equal(claude.stopped, 1);
  assert.equal(codex.stopped, 1);
  assert.equal(k.state.stage, "stopped");
  turn(k, "claude", "после остановки");
  await sleep(150);
  assert.equal(codex.received.length, 0);
  journal.close();
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

function controlledRoom(limit = 3) {
  const catalog = mkdtempSync(join(tmpdir(), "panel-race-"));
  const journal = new Journal(join(catalog, "j.sqlite"));
  journal.ensureRoom("r", catalog);
  const claude = new Stub("claude");
  const codex = new Stub("codex");
  const events = [];
  let gate;
  let open = () => {};
  const close = () => {
    gate = new Promise((r) => (open = r));
  };
  let index = 0;
  const k = new Coordinator(claude, codex, journal, {
    room: "r",
    cwd: catalog,
    maxAutoRounds: limit,
    onEvent: (e) => events.push(e),
    snapshot: async () => {
      if (gate) await gate;
      index += 1;
      return { id: `s${index}`, commit: undefined, dirty: true, at: Date.now(), source: "filesystem" };
    },
  });
  return { k, claude, codex, journal, events, close, open: () => { gate = undefined; open(); } };
}

test("замечания подписаны версией, которую проверял рецензент, а не текущей", async () => {
  // Найдено рецензентом: после проверки снимался новый снимок и ставился в
  // шапку замечаний. Правки во время проверки делали замечания к старой
  // версии похожими на замечания к новой — ровно обратное обещанному.
  // Здесь каждый снимок новый: дерево «меняется» на каждом шаге.
  const { k, claude, codex, journal } = controlledRoom();
  await k.fromHuman("задача", "review");
  turn(k, "claude", "сделал");
  await waitFor(() => codex.received.length === 1, "передача рецензенту");
  turn(k, "codex", "Дефект.\nВЕРДИКТ: ЕСТЬ ЗАМЕЧАНИЯ");
  await waitFor(() => claude.received.length === 2, "возврат разработчику");

  const remarks = claude.received[1];
  assert.equal(remarks.snapshot, codex.received[0].snapshot, "замечания относятся к проверенной версии");
  assert.match(remarks.text, /изменил/i, "разработчик должен видеть, что дерево ушло вперёд");
  journal.close();
});

test("новая задача, пришедшая во время снимка, не получает материал старой", async () => {
  // Сценарий рецензента: работа A завершилась, координатор ждёт снимок,
  // приходит задача B, и старое продолжение отправляет Codex задачу B с
  // материалом A.
  const { k, claude, codex, journal, close, open } = controlledRoom();
  await k.fromHuman("задача A", "review");
  close();
  turn(k, "claude", "работа по A");
  const newTask = k.fromHuman("задача B", "review");
  open();
  await newTask;
  await sleep(150);

  assert.equal(codex.received.length, 0, "работа A устарела и не должна уйти на проверку");
  assert.match(claude.received.at(-1).text, /задача B/);
  assert.equal(k.state.task, "задача B");
  journal.close();
});

test("остановка во время снимка не возобновляет цикл", async () => {
  const { k, codex, journal, close, open } = controlledRoom();
  await k.fromHuman("задача", "review");
  close();
  turn(k, "claude", "работа");
  await k.stopAll();
  open();
  await sleep(150);

  assert.equal(k.state.stage, "stopped", "остановленное не должно ожить");
  assert.equal(codex.received.length, 0);
  journal.close();
});

test("ход, завершившийся прямо во время отправки, засчитан как проверка", async () => {
  // Сценарий рецензента: ответ RPC и все уведомления до turn/completed
  // приходят одним блоком и разбираются раньше, чем завершится send().
  // Если цель регистрируется после send(), проверка считается прямым
  // вопросом, а опоздавшая цель потом закрывает цикл чужим ответом.
  const { k, codex, journal } = controlledRoom();
  codex.send = async function (prompt) {
    this.received.push(prompt);
    k.handle(event("codex", "message", { text: "Всё в порядке.\nВЕРДИКТ: ПРИНЯТО" }));
    k.handle(event("codex", "turn_completed"));
  };
  await k.fromHuman("задача", "review");
  turn(k, "claude", "работа");
  await waitFor(() => k.state.stage === "accepted", "цикл принят");
  assert.equal(k.state.verdict, "accepted");

  // Прямой вопрос после этого не должен ничего «закрывать» заново.
  codex.send = Stub.prototype.send;
  await k.fromHuman("вопрос", "codex");
  turn(k, "codex", "ответ на вопрос");
  await sleep(150);
  assert.equal(k.state.stage, "accepted");
  journal.close();
});

test("отправка, упавшая после регистрации цели, не оставляет чужую цель", async () => {
  const { k, claude, codex, journal } = controlledRoom();
  claude.send = async () => {
    throw new Error("канал сломан");
  };
  await k.fromHuman("задача", "review");
  assert.equal(k.state.stage, "stopped");

  claude.send = Stub.prototype.send;
  await k.fromHuman("вопрос", "claude");
  turn(k, "claude", "ответ на вопрос");
  await sleep(150);
  assert.equal(codex.received.length, 0, "прямой ответ не должен уйти на проверку");
  journal.close();
});

test("прерывание убирает из очереди пересылки прерванного цикла", async () => {
  // Сценарий рецензента: Codex занят, работа Claude ждёт проверки в
  // очереди, человек прерывает — и завершение прерванного хода выгружает
  // отменённую проверку.
  const { k, codex, journal } = controlledRoom();
  await k.fromHuman("вопрос", "codex");
  codex.busy = true;
  await k.fromHuman("задача", "review");
  turn(k, "claude", "работа");
  await waitFor(() => k.state.queued === 1, "проверка в очереди");

  await k.interruptAll();
  assert.equal(k.state.queued, 0);
  codex.busy = false;
  k.handle(event("codex", "turn_completed"));
  await sleep(150);
  assert.ok(
    codex.received.every((p) => !/работа/.test(p.text)),
    "отменённая проверка не должна уйти",
  );
  journal.close();
});

// ---------------------------------------------------------------------------
// Подпись, версия, журнал
// ---------------------------------------------------------------------------

test("служебные сообщения подписаны панелью, а не человеком", async () => {
  // В живом прогоне «Предел автоматических раундов» показывался как «Вы».
  const { k, codex, journal, events } = room();
  await k.fromHuman("задача", "review");
  turn(k, "claude", "сделал");
  await waitFor(() => codex.received.length === 1, "передача рецензенту");
  turn(k, "codex", "ВЕРДИКТ: ПРИНЯТО");
  await waitFor(() => k.state.stage === "accepted", "завершение");
  assert.ok(systemEvents(events).length > 0);
  const humanEvents = events.filter((e) => e.agent === "human");
  assert.ok(
    humanEvents.every((e) => e.text === "задача"),
    "от имени человека — только то, что он написал",
  );
  journal.close();
});

test("реплика человека не меняет версию идущего хода агента", async () => {
  const { k, journal, events, catalog } = room();
  await k.fromHuman("первая задача", "review");
  k.handle(event("claude", "message", { text: "начал работу" }));
  const versionBefore = events.filter((e) => e.agent === "claude").at(-1).snapshot;

  writeFileSync(join(catalog, "изменение.txt"), "другое состояние");
  await k.fromHuman("а вот вопрос", "codex");
  assert.notEqual(k.snapshot.id, versionBefore, "иначе проверка ничего не доказывает");

  k.handle(event("claude", "message", { text: "продолжаю тот же ход" }));
  const versionAfter = events.filter((e) => e.agent === "claude").at(-1).snapshot;
  assert.equal(versionAfter, versionBefore);
  journal.close();
});

test("события агента помечены версией файлов", async () => {
  const { k, journal, events } = room();
  await k.fromHuman("задача", "review");
  k.handle(event("claude", "message", { text: "ответ" }));
  assert.ok(events.some((e) => e.agent === "claude" && e.snapshot));
  journal.close();
});

test("история переживает перезапуск вместе с привязкой сессий", async () => {
  const { k, journal, catalog } = room();
  await k.fromHuman("запомни это", "claude");
  journal.bindSessions("r", "claude-s", "codex-t");
  journal.close();

  const second = new Journal(join(catalog, "j.sqlite"));
  assert.ok(second.history("r").some((e) => e.text === "запомни это"));
  const binding = second.binding("r");
  assert.equal(binding.claudeSessionId, "claude-s");
  assert.equal(binding.codexThreadId, "codex-t");
  second.close();
});

test("привязка не перетирается неизвестным значением", async () => {
  const { journal } = room();
  journal.bindSessions("r", "claude-s", "codex-t");
  journal.bindSessions("r", undefined, undefined);
  const p = journal.binding("r");
  assert.equal(p.claudeSessionId, "claude-s");
  assert.equal(p.codexThreadId, "codex-t");
  journal.close();
});

test("полная запись протокола сохраняется отдельно от показанного текста", async () => {
  const { k, journal } = room();
  await k.fromHuman("задача", "claude");
  k.handle(
    event("claude", "tool_result", {
      tool: "Bash",
      callId: "c9",
      text: "обрезано для показа",
      raw: { content: "x".repeat(200_000) },
    }),
  );
  const record = journal.history("r").find((e) => e.callId === "c9");
  assert.ok(record);
  assert.equal(journal.rawOf("r", record.id).content.length, 200_000);
  journal.close();
});

test("журнал после закрытия не роняет позднее событие", async () => {
  const { k, journal } = room();
  await k.fromHuman("задача", "claude");
  journal.close();
  assert.doesNotThrow(() => {
    k.handle(event("claude", "error", { failed: true, text: "процесс завершился" }));
  });
  assert.deepEqual(journal.history("r"), []);
});

test("в webview не уходят запись протокола и полный текст: там только показ", () => {
  const e = { id: "1", agent: "claude", kind: "tool_result", visibility: "turn", at: 0, text: "показ", raw: { big: 1 }, full: "полный" };
  const light = forDisplay(e);
  assert.equal(light.raw, undefined);
  assert.equal(light.full, undefined);
  assert.equal(light.text, "показ");
  assert.equal(e.full, "полный", "исходное событие не меняется: рецензенту нужен полный");
});

// ---------------------------------------------------------------------------
// Память по теме: заметки к сообщению человека
// ---------------------------------------------------------------------------

const NOTES = { text: "## Плацебо FOMC всегда попадало на выходные" + String.fromCharCode(10) + "   отрывок", titles: ["Плацебо FOMC всегда попадало на выходные"] };

test("память: заметки по теме приложены к сообщению и названы человеку", async () => {
  // Поручение владельца 28.09: агенты должны память не только писать, но и читать.
  const { k, claude, journal, events } = room(3, { memory: async () => NOTES });
  await k.fromHuman("почему отозвали FOMC", "claude");
  const t = claude.received[0].text;
  assert.ok(t.startsWith("почему отозвали FOMC"), "слова человека идут первыми и без изменений");
  assert.match(t, /Плацебо FOMC/);
  assert.match(t, /не слова человека/, "агент должен отличать заметки от поручения");
  assert.ok(
    systemEvents(events).some((e) => /Память/.test(e.text ?? "") && /Плацебо FOMC/.test(e.text ?? "")),
    "человек видит, какие заметки ушли агентам",
  );
  assert.equal(k.state.task, undefined);
  journal.close();
});

test("память: рецензент получает заметки вместе с задачей, а задача в шапке — без них", async () => {
  const { k, codex, journal } = room(3, { memory: async () => NOTES });
  await k.fromHuman("проверь спецификацию", "review");
  assert.equal(k.state.task, "проверь спецификацию");
  turn(k, "claude", "сделал");
  await waitFor(() => codex.received.length === 1, "передача рецензенту");
  assert.match(codex.received[0].text, /Плацебо FOMC/);
  journal.close();
});

test("память: сбой поиска не задерживает сообщение и назван человеку", async () => {
  const { k, claude, journal, events } = room(3, {
    memory: async () => {
      throw new Error("qmd не найден");
    },
  });
  await k.fromHuman("вопрос", "claude");
  assert.equal(claude.received[0].text, "вопрос");
  assert.ok(systemEvents(events).some((e) => /памяти не удался/.test(e.text ?? "")));
  journal.close();
});

test("память: ничего не найдено — сообщение как есть, без служебных строк", async () => {
  const { k, claude, journal, events } = room(3, { memory: async () => undefined });
  await k.fromHuman("вопрос", "all");
  assert.equal(claude.received[0].text, "вопрос");
  assert.equal(systemEvents(events).filter((e) => /Память/.test(e.text ?? "")).length, 0);
  journal.close();
});

// --- Рецензия Codex ночных коммитов 28.09 ------------------------------------

test("память: «Остановить» во время поиска — сообщение не уходит, и это названо", async () => {
  let release;
  const search = new Promise((r) => (release = r));
  const { k, claude, journal, events } = room(3, { memory: () => search });
  const outgoing = k.fromHuman("вопрос", "claude");
  await waitFor(() => events.some((e) => e.agent === "human"), "сообщение человека в журнале");
  await k.stopAll();
  release(NOTES);
  await outgoing;
  assert.equal(claude.received.length, 0, "после «Остановить» сообщение ушло");
  assert.ok(systemEvents(events).some((e) => /не отправлено/.test(e.text ?? "")));
  assert.ok(!systemEvents(events).some((e) => /приложены заметки/.test(e.text ?? "")), "названы заметки, которые никому не ушли");
  journal.close();
});

test("память: заметки названы только для сообщения, которое ушло в текущий цикл", async () => {
  let release;
  const search = new Promise((r) => (release = r));
  let call = 0;
  const { k, claude, journal, events } = room(3, {
    memory: () => (++call === 1 ? search : Promise.resolve(undefined)),
  });
  const firstLine = k.fromHuman("первая задача", "review");
  await waitFor(() => events.some((e) => e.agent === "human"), "первая задача в журнале");
  await k.fromHuman("вторая задача", "review");
  release(NOTES);
  await firstLine;
  assert.deepEqual(claude.received.map((p) => p.text), ["вторая задача"]);
  assert.ok(!systemEvents(events).some((e) => /приложены заметки/.test(e.text ?? "")));
  journal.close();
});

// --- Расход задачи -------------------------------------------------------------

test("расход: токены копятся по задаче, новая задача начинает счёт заново", async () => {
  const { k, claude, codex, journal } = room();
  await k.fromHuman("задача", "review");
  k.handle(event("claude", "message", { text: "сделал" }));
  k.handle(event("claude", "turn_completed", { usage: { input: 1000, cached: 800, output: 50 }, limit: { status: "allowed", window: "five_hour" } }));
  await waitFor(() => codex.received.length === 1, "передача рецензенту");
  k.handle(event("codex", "message", { text: "Поправь.\nВЕРДИКТ: ЕСТЬ ЗАМЕЧАНИЯ" }));
  k.handle(event("codex", "turn_completed", { usage: { input: 500, cached: 100, output: 20 }, limit: { percent: 8, window: "week" } }));
  await waitFor(() => claude.received.length === 2, "возврат разработчику");
  k.handle(event("claude", "turn_completed", { usage: { input: 10, cached: 0, output: 5 } }));
  await waitFor(() => k.state.usage.task.claude.input === 1010, "второй ход Claude учтён");
  assert.deepEqual(k.state.usage.task.claude, { input: 1010, cached: 800, output: 55 });
  assert.deepEqual(k.state.usage.task.codex, { input: 500, cached: 100, output: 20 });
  assert.equal(k.state.usage.limits.codex.percent, 8);
  await k.fromHuman("новая задача", "review");
  assert.deepEqual(k.state.usage.task.claude, { input: 0, cached: 0, output: 0 });
  assert.equal(k.state.usage.limits.codex.percent, 8, "сведения о лимите от задачи не зависят");
  journal.close();
});

test("расход: предел токенов задачи останавливает автоматическую передачу", async () => {
  const { k, codex, journal } = room(3, { taskTokenLimit: 1000 });
  await k.fromHuman("задача", "review");
  k.handle(event("claude", "message", { text: "сделал" }));
  k.handle(event("claude", "turn_completed", { usage: { input: 900, cached: 0, output: 200 } }));
  await waitFor(() => k.state.stage === "held", "удержание по расходу");
  assert.equal(codex.received.length, 0);
  assert.match(k.state.held.reason, /предел/);
  assert.equal(k.state.held.to, "codex");
  journal.close();
});

test("расход: поздний ход прежней задачи и прямой вопрос не идут в расход текущей", async () => {
  const { k, journal } = room();
  await k.fromHuman("задача А", "review");
  await k.fromHuman("задача Б", "review");
  // Первый конец хода Claude относится к задаче А — она уже не текущая.
  k.handle(event("claude", "turn_completed", { usage: { input: 1000, cached: 0, output: 10 } }));
  assert.deepEqual(k.state.usage.task.claude, { input: 0, cached: 0, output: 0 });
  await k.fromHuman("прямой вопрос", "codex");
  k.handle(event("codex", "turn_completed", { usage: { input: 50, cached: 0, output: 5 }, limit: { percent: 9, window: "week" } }));
  assert.deepEqual(k.state.usage.task.codex, { input: 0, cached: 0, output: 0 });
  assert.equal(k.state.usage.limits.codex.percent, 9, "сведения о лимите обновляются с любого хода");
  journal.close();
});

test("новая сессия: агент забывает сессию, журнал — привязку, человек видит строку", async () => {
  const { k, claude, journal, events } = room();
  journal.bindSessions("r", "claude-старая", "codex-ветка");
  claude.forgotten = 0;
  claude.forgetSession = async () => {
    claude.forgotten += 1;
  };
  await k.newSession("claude");
  assert.equal(claude.forgotten, 1);
  assert.equal(journal.binding("r").claudeSessionId, undefined);
  assert.equal(journal.binding("r").codexThreadId, "codex-ветка", "ветку Codex не трогаем");
  assert.ok(systemEvents(events).some((e) => /новая сессия Claude/i.test(e.text ?? "")));
  journal.close();
});

test("новая сессия посреди хода агента останавливает цикл, а не оставляет его ждать", async () => {
  const { k, claude, journal } = room();
  claude.forgetSession = async () => {};
  await k.fromHuman("задача", "review");
  claude.busy = true;
  await k.newSession("claude");
  assert.equal(k.state.stage, "stopped");
  journal.close();
});

test("новая сессия: очередь сброшенного агента уходит в новую сессию", async () => {
  const { k, claude, journal } = room();
  claude.forgetSession = async () => {
    claude.busy = false;
  };
  claude.busy = true;
  await k.fromHuman("вопрос в очереди", "claude");
  assert.equal(claude.received.length, 0, "занятому агенту сообщение не уходит сразу");
  await k.newSession("claude");
  await waitFor(() => claude.received.length === 1, "очередь выгружена");
  assert.equal(claude.received[0].text, "вопрос в очереди");
  journal.close();
});

test("новая сессия: привязка очищается раньше остановки — закрытие панели её не вернёт", async () => {
  const { k, claude, journal, catalog } = room();
  journal.bindSessions("r", "claude-старая", "codex-ветка");
  claude.forgetSession = async () => {
    journal.close(); // панель закрыли, пока останавливался процесс
  };
  await k.newSession("claude");
  const reopened = new Journal(join(catalog, "j.sqlite"));
  assert.equal(reopened.binding("r").claudeSessionId, undefined);
  reopened.close();
});

test("новая сессия: удержанная передача этому агенту снимается и названа", async () => {
  const { k, codex, journal, events } = room();
  codex.forgetSession = async () => {};
  k.setAuto(false);
  await k.fromHuman("задача", "review");
  turn(k, "claude", "сделал");
  await waitFor(() => k.state.stage === "held", "удержание для рецензента");
  assert.equal(k.state.held.to, "codex");
  await k.newSession("codex");
  assert.equal(k.state.held, undefined);
  assert.ok(systemEvents(events).some((e) => /снята/.test(e.text ?? "")));
  journal.close();
});

// ---------------------------------------------------------------------------
// Gemini вне цикла рецензии
// ---------------------------------------------------------------------------

test("«Спросить всех» — трём агентам независимо, друг другу ничего не передаётся", async () => {
  const { k, claude, codex, gemini, journal } = room(3, {}, { withGemini: true });
  await k.fromHuman("какой бейзлайн взять?", "all");
  assert.equal(claude.received.length, 1);
  assert.equal(codex.received.length, 1);
  assert.equal(gemini.received.length, 1);
  turn(k, "gemini", "логистическая регрессия");
  await sleep(30);
  assert.equal(claude.received.length, 1, "ответ Gemini никому не пересылается");
  assert.deepEqual(k.state.reviewers, ["codex", "gemini"]);
  journal.close();
});

test("без Gemini «Спросить всех» — двоим, «Только Gemini» — объяснение", async () => {
  const { k, claude, codex, events, journal } = room();
  await k.fromHuman("вопрос", "all");
  assert.equal(claude.received.length, 1);
  assert.equal(codex.received.length, 1);
  await k.fromHuman("вопрос Gemini", "gemini");
  assert.ok(systemEvents(events).some((e) => /Gemini не подключён/.test(e.text)));
  assert.deepEqual(k.state.reviewers, ["codex"]);
  assert.equal(k.state.geminiBusy, false);
  journal.close();
});

test("«Прервать», «Остановить» и новая сессия касаются и Gemini", async () => {
  const { k, gemini, journal } = room(3, {}, { withGemini: true });
  journal.bindGeminiConversation("r", "g-1");
  await k.interruptAll();
  assert.equal(gemini.interrupted, 1);
  await k.stopAll();
  assert.equal(gemini.stopped, 1);
  await k.newSession("gemini");
  assert.equal(journal.binding("r").geminiConversationId, undefined);
  journal.close();
});

test("занятость Gemini видна в состоянии комнаты", async () => {
  const { k, gemini, journal } = room(3, {}, { withGemini: true });
  gemini.busy = true;
  assert.equal(k.state.geminiBusy, true);
  journal.close();
});

test("квота Gemini запрашивается после его хода, не чаще раза в период", async () => {
  let calls = 0;
  const { k, journal } = room(
    3,
    { geminiUsage: async () => ((calls += 1), { weekPercent: 3, windowPercent: 11 }), geminiUsageEveryMs: 60_000 },
    { withGemini: true },
  );
  turn(k, "gemini", "ответ");
  await waitFor(() => k.state.usage.limits.geminiWeek?.percent === 3, "квота Gemini");
  assert.equal(k.state.usage.limits.geminiWeek.session, 11);
  turn(k, "gemini", "ещё ответ");
  await sleep(30);
  assert.equal(calls, 1);
  journal.close();
});

test("неудачный повторный запрос квоты Gemini помечает прежнюю устаревшей", async () => {
  let call = 0;
  const { k, journal } = room(
    3,
    { geminiUsage: async () => ((call += 1), call === 1 ? { weekPercent: 3 } : undefined), geminiUsageEveryMs: 0 },
    { withGemini: true },
  );
  await k.refreshGeminiUsage();
  await k.refreshGeminiUsage();
  assert.equal(k.state.usage.limits.geminiWeek.percent, 3);
  assert.equal(k.state.usage.limits.geminiWeek.stale, true);
  journal.close();
});
