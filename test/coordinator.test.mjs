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
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Coordinator, GEMINI_SILENCE_MS } from "../out/coordinator.js";
import { GeminiAdapter } from "../out/adapters/gemini.js";
import { CodexAdapter } from "../out/adapters/codex.js";

const FAKE_AGY = fileURLToPath(new URL("../fixtures/fake-agy.mjs", import.meta.url));
const FAKE_CODEX = fileURLToPath(new URL("../fixtures/fake-codex.mjs", import.meta.url));
import { Journal } from "../out/journal.js";
import { forDisplay, questionAnswers } from "../out/adapters/types.js";
import { takeSnapshot } from "../out/snapshot.js";

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
  async answerQuestion(id, answers) {
    this.answers.push([id, answers]);
    return true;
  }
  decisions = [];
  answers = [];
}

/**
 * Gemini, занятый, как настоящий адаптер: от отправки до конца хода;
 * «Прервать», «Остановить» и новая сессия снимают занятость сразу (у
 * GeminiAdapter это синхронная часть stop). Признак жизни lastOutputAt и
 * расход идущего хода partial задаёт тест. Остальные тесты пользуются
 * прежней заглушкой: их поведение не меняется.
 */
class LiveGemini extends Stub {
  constructor() {
    super("gemini");
    this.lastOutputAt = undefined;
    this.partial = undefined;
    this.forgotten = 0;
  }
  async send(prompt) {
    this.received.push(prompt);
    this.busy = true;
  }
  async interrupt() {
    this.interrupted += 1;
    this.busy = false;
  }
  async stop() {
    this.stopped += 1;
    this.busy = false;
  }
  async forgetSession() {
    this.forgotten += 1;
    this.busy = false;
  }
  get pendingUsage() {
    return this.busy ? this.partial : undefined;
  }
}

function room(limit = 3, options = {}, { withGemini = false, liveGemini = false } = {}) {
  const catalog = mkdtempSync(join(tmpdir(), "panel-"));
  const journal = new Journal(join(catalog, "j.sqlite"));
  journal.ensureRoom("r", catalog);
  const claude = new Stub("claude");
  const codex = new Stub("codex");
  const gemini = liveGemini ? new LiveGemini() : withGemini ? new Stub("gemini") : undefined;
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

test("пояснение к полноте говорит о доле бюджета: неполным бывает и вывод короче всего бюджета", async () => {
  // Бюджет делится между выводами: два вывода по 20 000 при бюджете 30 000
  // режутся оба, хотя каждый короче бюджета. Прежнее «длиннее бюджета
  // проверки» с этим расходилось (рецензия Trading 03.10).
  const { k, codex, journal } = room(3, { evidenceBudget: 30_000 });
  await k.fromHuman("задача", "review");
  for (const id of ["a", "b"]) {
    k.handle(event("claude", "tool_result", { tool: "Bash", callId: id, text: "показ", full: "z".repeat(20_000) }));
  }
  turn(k, "claude", "готово");
  await waitFor(() => codex.received.length === 1, "передача рецензенту");
  const t = codex.received[0].text;
  assert.equal((t.match(/неполный: показано/g) ?? []).length, 2, "оба вывода короче бюджета, но режутся");
  assert.match(t, /«Неполный» — вывод не поместился в свою долю бюджета проверки/);
  assert.doesNotMatch(t, /длиннее бюджета проверки/);
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
    { who: "codex", round: 1, mark: "!" },
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
  assert.deepEqual(acceptRoom.k.state.trail.at(-1), { who: "codex", round: 1, mark: "✓" });
  acceptRoom.journal.close();

  const holdRoom = room();
  await holdRoom.k.fromHuman("задача", "review");
  turn(holdRoom.k, "claude", "сделал");
  await waitFor(() => holdRoom.codex.received.length === 1, "проверка");
  turn(holdRoom.k, "codex", "Нужны данные.\nВЕРДИКТ: НУЖНО РЕШЕНИЕ ЧЕЛОВЕКА");
  await waitFor(() => holdRoom.k.state.stage === "held", "удержание");
  assert.deepEqual(holdRoom.k.state.trail.slice(-2), [{ who: "codex", round: 1, mark: "?" }, { who: "you" }]);
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

// --- Вопрос Claude человеку (AskUserQuestion) ------------------------------------

const QUESTION = [{ question: "Какой вариант?", options: [{ label: "а" }, { label: "б" }] }];
const askEvent = (callId = "q1") =>
  event("claude", "approval_requested", { callId, tool: "AskUserQuestion", text: "Какой вариант?", questions: QUESTION });

test("открытый вопрос Claude виден в состоянии отдельно от разрешений", () => {
  const { k } = room();
  k.handle(askEvent());
  assert.equal(k.state.questions, 1);
  assert.equal(k.state.approvals, 0, "этап «Ждёт разрешения» был бы неправдой");
  k.handle(event("claude", "approval_requested", { callId: "p1", tool: "Bash" }));
  assert.equal(k.state.approvals, 1);
  assert.equal(k.state.questions, 1);
  k.handle(event("claude", "approval_decided", { callId: "q1", text: "ответ человека: Какой вариант? — б" }));
  assert.equal(k.state.questions, 0);
  assert.equal(k.state.approvals, 1);
});

test("ответ на вопрос уходит адаптеру того агента, который спросил, — ответами", async () => {
  const { k, claude, codex } = room();
  k.handle(askEvent());
  await k.answerQuestion("q1", { "Какой вариант?": "б" });
  assert.deepEqual(claude.answers, [["q1", { "Какой вариант?": "б" }]]);
  assert.deepEqual(codex.answers, []);
  assert.deepEqual(claude.decisions, []);
});

test("ответы — только на вопрос; «разрешить» на вопрос не уходит, «не отвечать» уходит", async () => {
  const { k, claude } = room();
  k.handle(event("claude", "approval_requested", { callId: "p1", tool: "Bash" }));
  await k.answerQuestion("p1", { x: "y" });
  await k.answerQuestion("нет-такого", { x: "y" });
  assert.deepEqual(claude.answers, []);
  assert.equal(k.state.approvals, 1, "запрос разрешения остаётся открытым");

  k.handle(askEvent());
  await k.answerApproval("q1", "allow");
  assert.deepEqual(claude.decisions, [], "без ответов Claude прочёл бы «человек не ответил»");
  assert.equal(k.state.questions, 1, "вопрос остаётся открытым");
  await k.answerApproval("q1", "deny");
  assert.deepEqual(claude.decisions, [["q1", "deny"]]);
});

test("пустой ответ на вопрос адаптеру не уходит, вопрос остаётся открытым", async () => {
  // Адаптер его не примет и вопрос не закроет; снятый здесь вопрос разошёлся
  // бы с адаптером, как «разрешить» на вопрос.
  const { k, claude } = room();
  k.handle(askEvent());
  await k.answerQuestion("q1", {});
  assert.deepEqual(claude.answers, []);
  assert.equal(k.state.questions, 1);
});

test("ответ, который адаптер не принял, снимает вопрос: карточка не должна висеть", async () => {
  const { k, claude } = room();
  claude.answerQuestion = async () => false;
  k.handle(askEvent());
  await k.answerQuestion("q1", { "Какой вариант?": "а" });
  assert.equal(k.state.questions, 0);
});

test("«Прервать», «Остановить» и падение процесса закрывают открытый вопрос", async () => {
  for (const close of [(k) => k.interruptAll(), (k) => k.stopAll(), (k) => k.handle(event("claude", "error", { failed: true, text: "процесс завершился" }))]) {
    const { k } = room();
    k.handle(askEvent());
    await close(k);
    assert.equal(k.state.questions, 0);
  }
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

test("вопрос Claude доходит до webview с вариантами: forDisplay их сохраняет", () => {
  const questions = [{ question: "Какой вариант?", header: "Выбор", options: [{ label: "а" }, { label: "б" }], multiSelect: false }];
  const e = { id: "1", agent: "claude", kind: "approval_requested", visibility: "turn", at: 0, tool: "AskUserQuestion", callId: "q1", text: "Какой вариант?", questions, raw: { big: 1 } };
  const light = forDisplay(e);
  assert.equal(light.raw, undefined);
  assert.deepEqual(light.questions, questions);
});

test("ответы из webview: только непустой объект строк не длиннее 4000 символов", () => {
  assert.deepEqual(questionAnswers({ "Какой вариант?": "б", "Ещё?": "а, б" }), { "Какой вариант?": "б", "Ещё?": "а, б" });
  // Пустой объект — «человек не ответил»: ровно то, от чего избавляет карточка.
  for (const bad of [undefined, null, "б", 1, ["б"], {}, { "Какой вариант?": 1 }, { "Какой вариант?": "x".repeat(4001) }]) {
    assert.equal(questionAnswers(bad), undefined, JSON.stringify(bad)?.slice(0, 40));
  }
  assert.deepEqual(questionAnswers({ q: "x".repeat(4000) }), { q: "x".repeat(4000) });
});

// ---------------------------------------------------------------------------
// Журнал: действия человека и материал рецензентам
//
// Журнал 04–05.10: по нему нельзя было понять, что человек отправил
// удержанное или выключил автопересылку, и что именно получил рецензент —
// материал проверки собирается панелью и нигде не хранился.
// ---------------------------------------------------------------------------

const actions = (journal) => journal.history("r").filter((e) => e.kind === "action");

test("журнал: «Отправить» удержанное — действие человека с причиной и текстом ушедшей передачи", async () => {
  const { k, claude, codex, journal, events } = room();
  await k.fromHuman("задача", "review");
  turn(k, "claude", "сделал");
  await waitFor(() => codex.received.length === 1, "передача рецензенту");
  turn(k, "codex", "Что-то не нравится.");
  await waitFor(() => k.state.stage === "held", "удержание");
  const reason = k.state.held.reason;
  assert.deepEqual(actions(journal), [], "удержание — решение панели, не действие человека");

  await k.releaseHeld();
  assert.equal(claude.received.length, 2);
  const [action] = actions(journal);
  assert.equal(action.agent, "human");
  assert.equal(action.visibility, "turn");
  assert.equal(action.text, `Отправлено Claude вручную: ${reason}`);
  assert.deepEqual(journal.rawOf("r", action.id), { to: "claude", text: claude.received[1].text });
  // Лента показывает действие строкой; запись протокола в webview не уходит (forDisplay).
  assert.equal(events.filter((e) => e.kind === "action").length, 1);
  assert.equal(forDisplay(events.find((e) => e.kind === "action")).raw, undefined);

  await k.releaseHeld();
  assert.equal(actions(journal).length, 1, "нечего отправлять — нечего и записывать");
  journal.close();
});

test("журнал: «Отправить на проверку» удержанную пару — действие называет обоих рецензентов", async () => {
  const { k, codex, gemini, journal } = room(0, {}, { withGemini: true });
  await k.fromHuman("задача", "review");
  turn(k, "claude", "сделал");
  await waitFor(() => k.state.stage === "held", "удержание по пределу");
  const reason = k.state.held.reason;
  await k.releaseHeld();
  const [action] = actions(journal);
  assert.equal(action.text, `Отправлено Codex и Gemini вручную: ${reason}`);
  assert.deepEqual(journal.rawOf("r", action.id), {
    to: "codex",
    text: codex.received[0].text,
    companion: { to: "gemini", text: gemini.received[0].text },
  });
  journal.close();
});

test("журнал: автопересылку выключил и включил человек — по действию на каждое переключение", async () => {
  const { k, journal, events } = room();
  k.setAuto(false);
  k.setAuto(false);
  k.setAuto(true);
  assert.deepEqual(actions(journal).map((e) => [e.agent, e.text]), [
    ["human", "Автопересылка выключена"],
    ["human", "Автопересылка включена"],
  ]);
  assert.equal(events.filter((e) => e.kind === "action").length, 2, "и в ленте");
  journal.close();
});

test("журнал: материал проверки — по событию на каждого рецензента с полным текстом, в ленту не уходит", async () => {
  const r = room(3, {}, { withGemini: true });
  const { k, codex, gemini, journal, events } = r;
  await k.fromHuman("задача", "review");
  // Длиннее предела показа (64 000): журнал хранит материал целиком.
  turn(k, "claude", `итог: ${"ф".repeat(70_000)}`);
  await waitFor(() => codex.received.length === 1 && gemini.received.length === 1, "проверка у обоих");
  const materials = journal.history("r").filter((e) => e.kind === "material");
  assert.deepEqual(materials.map((e) => e.agent).sort(), ["codex", "gemini"]);
  assert.ok(materials.every((e) => e.visibility === "stream"));
  assert.equal(materials.find((e) => e.agent === "codex").text, codex.received[0].text);
  assert.equal(materials.find((e) => e.agent === "gemini").text, gemini.received[0].text);
  assert.ok(codex.received[0].text.length > 70_000);
  assert.equal(events.some((e) => e.kind === "material"), false, "материал — только журнал");
  // Прямой вопрос рецензенту — не материал: его слова уже в журнале репликой человека.
  turn(k, "codex", "Хорошо.\nВЕРДИКТ: ПРИНЯТО");
  turn(k, "gemini", "Хорошо.\nВЕРДИКТ: ПРИНЯТО");
  await waitFor(() => k.state.stage === "accepted", "принято");
  await k.fromHuman("а что с порогом?", "codex");
  await waitFor(() => codex.received.length === 2, "прямой вопрос");
  assert.equal(journal.history("r").filter((e) => e.kind === "material").length, 2);
  journal.close();
});

test("журнал: материал, ждавший занятого рецензента, записан, когда ушёл, а не когда встал в очередь", async () => {
  const { k, claude, gemini, journal } = room(3, {}, { liveGemini: true });
  await k.fromHuman("вопрос Gemini", "gemini");
  assert.equal(gemini.busy, true);
  await k.fromHuman("задача", "review");
  turn(k, "claude", "сделал");
  await waitFor(() => k.state.stage === "reviewing", "проверка");
  const materialsFor = (agent) => journal.history("r").filter((e) => e.kind === "material" && e.agent === agent);
  assert.equal(materialsFor("gemini").length, 0, "материал в очереди ещё не ушёл");
  gemini.busy = false;
  turn(k, "gemini", "ответ на вопрос");
  await waitFor(() => gemini.received.length === 2, "материал у Gemini");
  assert.equal(materialsFor("gemini").length, 1);
  assert.equal(materialsFor("gemini")[0].text, gemini.received[1].text);
  assert.equal(claude.received.length, 1);
  journal.close();
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
  journal.bindCodexReviewThread("r", "codex-рецензент");
  claude.forgotten = 0;
  claude.forgetSession = async () => {
    claude.forgotten += 1;
  };
  await k.newSession("claude");
  assert.equal(claude.forgotten, 1);
  assert.equal(journal.binding("r").claudeSessionId, undefined);
  assert.equal(journal.binding("r").codexThreadId, "codex-ветка", "ветку Codex не трогаем");
  assert.equal(journal.binding("r").codexReviewThreadId, "codex-рецензент", "и его ветку рецензента");
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

test("новая сессия Gemini без прежней не пишет «сохранена в истории»", async () => {
  // Журнал 04–05.10: новая сессия Gemini без прежней сообщала, что прежняя
  // «сохранена в истории», — сохранять было нечего.
  const { k, gemini, journal, events } = room(3, {}, { withGemini: true });
  gemini.sessionId = undefined;
  await k.newSession("gemini");
  const lines = systemEvents(events).filter((e) => /^Новая сессия Gemini/.test(e.text ?? ""));
  assert.deepEqual(
    lines.map((e) => e.text),
    ["Новая сессия Gemini: прежней не было — следующий ход начнёт новую."],
  );
  journal.close();
});

test("новая сессия Gemini с прежней называет её и говорит, что она сохранена", async () => {
  const { k, gemini, journal, events } = room(3, {}, { withGemini: true });
  gemini.sessionId = "g-1234567890";
  journal.bindGeminiConversation("r", "g-1234567890");
  await k.newSession("gemini");
  const lines = systemEvents(events).filter((e) => /^Новая сессия Gemini/.test(e.text ?? ""));
  assert.equal(lines.length, 1);
  assert.match(lines[0].text, /^Новая сессия Gemini: прежняя \(g-123456\) сохранена в истории Gemini, но следующий ход её не продолжит/);
  journal.close();
});

test("новая сессия Codex до его первого хода: прежняя ветка комнаты названа, а не «не было»", async () => {
  // Codex поднимает ветку лениво, при первой отправке: до неё sessionId
  // адаптера пуст, хотя комната привязана к ветке и следующий ход её бы
  // продолжил. Прежняя — по журналу.
  const { k, codex, journal, events } = room();
  journal.bindCodexReviewThread("r", "codex-ветка-1");
  codex.sessionId = undefined;
  await k.newSession("codex");
  const lines = systemEvents(events).filter((e) => /^Новая сессия Codex/.test(e.text ?? ""));
  assert.equal(lines.length, 1);
  assert.match(lines[0].text, /^Новая сессия Codex: прежняя \(codex-ве\) сохранена в истории Codex/);
  assert.equal(journal.binding("r").codexReviewThreadId, undefined);
  journal.close();
});

test("новая сессия Codex в комнате, привязанной к чату владельца: чат не назван прежней сессией", async () => {
  // Чат владельца (codex_thread) панель больше не продолжает (решение 05.10):
  // назвать его прежней сессией значило бы сказать, что следующий ход его
  // продолжил бы. Привязка к нему тоже забывается.
  const { k, codex, journal, events } = room();
  journal.bindSessions("r", undefined, "owner-chat");
  codex.sessionId = undefined;
  await k.newSession("codex");
  const lines = systemEvents(events).filter((e) => /^Новая сессия Codex/.test(e.text ?? ""));
  assert.deepEqual(
    lines.map((e) => e.text),
    ["Новая сессия Codex: прежней не было — следующий ход начнёт новую."],
  );
  assert.equal(journal.binding("r").codexThreadId, undefined);
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

// ---------------------------------------------------------------------------
// Пара рецензентов: Codex и Gemini
// ---------------------------------------------------------------------------

async function pairRoom(options = {}, limit = 3, { liveGemini = false } = {}) {
  const r = room(limit, options, { withGemini: true, liveGemini });
  await r.k.fromHuman("подобрать порог классификатора", "review");
  turn(r.k, "claude", "порог 0.4, F1 на валидации 0.71");
  await waitFor(() => r.codex.received.length === 1 && r.gemini.received.length === 1, "проверка у обоих");
  return r;
}

/** Конец хода Gemini, как у адаптера: занятость снимается раньше turn_completed. */
function geminiTurn(k, gemini, text, extra = {}) {
  gemini.busy = false;
  turn(k, "gemini", text, extra);
}

/** Строки панели, подходящие под образец. */
const said = (events, pattern) => systemEvents(events).filter((e) => pattern.test(e.text ?? ""));

test("проверка пары: один материал и версия у обоих, счётчик +1 за пару", async () => {
  const { k, codex, gemini, journal } = await pairRoom();
  assert.match(codex.received[0].text, /порог 0\.4/);
  assert.match(gemini.received[0].text, /порог 0\.4/);
  assert.match(gemini.received[0].text, /методологию эксперимента/);
  // I1: Gemini не должен сам закрывать глаза на свой же «пробел» — правило
  // явно идёт в тексте хода, а не только в agent.md.
  assert.match(gemini.received[0].text, /пробел.*ВЕРДИКТ: ЕСТЬ ЗАМЕЧАНИЯ/s);
  assert.match(gemini.received[0].text, /предписанный самим поручением человека.*ВЕРДИКТ: НУЖНО РЕШЕНИЕ ЧЕЛОВЕКА/s);
  // Бюджет веба — та же фраза, что в agent.md (живой прогон 03.10: ~40 обращений к вебу за проверку).
  // Повтор проверки Trading 04.10: при «~15» Flash high обратился к вебу 21 раз — бюджет считаемый.
  assert.match(gemini.received[0].text, /не больше двух попыток на один сайт, всего не больше 15 обращений к вебу за проверку/);
  assert.match(gemini.received[0].text, /после 15-го к вебу больше не обращайся, а оставшиеся факты помечай «не проверено: бюджет исчерпан»/);
  // Повтор 04.10: ни Flash high, ни Pro high не потребовали полноты
  // отрицательного поиска, сочтя строгие ворота кода достаточными (M16).
  assert.ok(
    gemini.received[0].text.includes(
      "Отрицательный результат поиска без показанной полноты — «пробел: …», даже если код ворот строгий; " +
        "процедура такого поиска, которая не требует покрытия окна, всех страниц выдачи и цитаты, — тоже «пробел: …»; " +
        "поля окна и цитаты в журнале — ещё не покрытие окна.",
    ),
    "напоминание о полноте отрицательного поиска, его процедуре и покрытии окна (повторы 2–3, 04.10)",
  );
  assert.match(gemini.received[0].text, /Сначала — факты, на которых держится вывод; на второстепенный факт — одно обращение к вебу, не больше\./);
  assert.match(gemini.received[0].text, /пиши «не проверено: <адрес> — <причина>»/);
  assert.match(gemini.received[0].text, /Непроверенный факт, на котором держится вывод, — это «пробел: …»/);
  // Проверка Trading 02.10: Gemini не открыл правил проекта, а пункты, которых
  // шаг не касался, закрыл натянутыми «свидетельствами». Живой прогон 04.10:
  // файл правил называет строка шапки «[правила проекта: …]» — напоминание
  // указывает на неё, а не на имена файлов.
  assert.ok(
    gemini.received[0].text.includes(
      "Правила проекта: если в этом разговоре ты ещё не открывал файл из строки «[правила проекта: …]» шапки — открой его до проверки.",
    ),
    "напоминание открыть файл правил из шапки",
  );
  assert.match(gemini.received[0].text, /«пробел: …» или «не относится: <почему>»/);
  assert.match(gemini.received[0].text, /датой проверки из шапки «\[дата: …\]»/);
  assert.doesNotMatch(codex.received[0].text, /методологию эксперимента/, "Codex проверяет как прежде");
  assert.doesNotMatch(codex.received[0].text, /правила проекта/i, "Codex правила Gemini не получает");
  assert.equal(gemini.received[0].heading, "[материал проверки от панели]");
  assert.equal(codex.received[0].snapshot, gemini.received[0].snapshot);
  assert.equal(k.state.round, 1);
  assert.equal(k.state.stage, "reviewing");
  assert.deepEqual(k.state.pair, { round: 1, sides: { codex: { state: "waiting" }, gemini: { state: "waiting" } } });
  assert.deepEqual(k.state.trail.slice(-2), [{ who: "codex", round: 1 }, { who: "gemini", round: 1 }]);
  journal.close();
});

test("запуск Codex повис — Gemini всё равно получает материал, панель видит проверку", async () => {
  // Живой прогон 03.10: ответ thread/resume не разобрался, отправка Codex не
  // завершалась. Gemini ждал её и материала не получил, а панель до конца
  // показывала «Claude работает»: состояние уходило только после обеих отправок.
  const states = [];
  const { k, codex, gemini, journal } = room(3, { onState: (s) => states.push(s) }, { withGemini: true });
  codex.send = (prompt) => {
    codex.received.push(prompt);
    return new Promise(() => {});
  };
  await k.fromHuman("подобрать порог классификатора", "review");
  turn(k, "claude", "порог 0.4, F1 на валидации 0.71");
  await waitFor(() => gemini.received.length === 1, "материал у Gemini");
  await waitFor(() => states.some((s) => s.stage === "reviewing"), "состояние проверки у панели");
  const shown = states.filter((s) => s.stage === "reviewing").at(-1);
  assert.deepEqual(shown.pair, { round: 1, sides: { codex: { state: "waiting" }, gemini: { state: "waiting" } } });
  journal.close();
});

test("сведение: оба приняли — задача принята, Claude ничего не получает", async () => {
  const { k, claude, events, journal } = await pairRoom();
  turn(k, "codex", "Код верен.\nВЕРДИКТ: ПРИНЯТО");
  await sleep(30);
  assert.equal(k.state.stage, "reviewing", "ждём Gemini");
  assert.deepEqual(k.state.pair.sides.codex, { state: "done", verdict: "accepted" });
  turn(k, "gemini", "Утечек нет: свидетельство — вызов c1.\nВЕРДИКТ: ПРИНЯТО");
  await waitFor(() => k.state.stage === "accepted", "принятие");
  assert.equal(claude.received.length, 1);
  assert.equal(k.state.verdict, "accepted");
  assert.ok(systemEvents(events).some((e) => /Итог проверки 1: Codex — принято, Gemini — принято/.test(e.text)));
  assert.deepEqual(k.state.trail.slice(-2), [
    { who: "codex", round: 1, mark: "✓" },
    { who: "gemini", round: 1, mark: "✓" },
  ]);
  journal.close();
});

// Итог приёмки. Журнал 04–05.10: при «принято» Claude ничего не получал,
// дважды записал ложную «историю приёмки» (seq 66891, 71500) и потерял
// неблокирующие пометки рецензентов (65693, 72034, 65944). Отдельный ход
// Claude не нужен — он правил бы файлы мимо рецензии, поэтому итог уходит
// первым блоком следующего сообщения человека Claude.

/** Пара приняла работу: Codex — с пометкой, Gemini — чек-лист закрыт. */
async function acceptedPair() {
  const r = await pairRoom();
  turn(r.k, "codex", "Код верен. Пометка: проверить даты весов позже.\nВЕРДИКТ: ПРИНЯТО");
  turn(r.k, "gemini", "Чек-лист закрыт.\nВЕРДИКТ: ПРИНЯТО");
  await waitFor(() => r.k.state.stage === "accepted", "принято");
  return r;
}

test("итог приёмки — первым блоком следующего сообщения Claude, один раз", async () => {
  const { k, claude, journal } = await pairRoom();
  turn(k, "codex", "Код верен. Пометка: проверить даты весов позже.\nВЕРДИКТ: ПРИНЯТО");
  turn(k, "gemini", "Чек-лист закрыт.\nВЕРДИКТ: ПРИНЯТО");
  await waitFor(() => k.state.stage === "accepted", "принято");
  await k.fromHuman("Делайте следующий шаг", "review");
  await waitFor(() => claude.received.length === 2, "новая задача у Claude");
  const text = claude.received[1].text;
  assert.match(text, /^\[итог прошлой проверки\]/);
  assert.match(text, /Проверка 1 принята: Codex — принято, Gemini — принято/);
  assert.match(text, /проверить даты весов позже/);
  assert.match(text, /Делайте следующий шаг/);
  await k.fromHuman("ещё вопрос", "claude");
  await waitFor(() => claude.received.length === 3, "следующее");
  assert.doesNotMatch(claude.received[2].text, /итог прошлой проверки/);
  journal.close();
});

test("итог приёмки: форма блока — отзывы обоих рецензентов как пометки, затем пустая строка и слова человека", async () => {
  const { k, claude, events, journal } = await acceptedPair();
  await k.fromHuman("Делайте следующий шаг", "review");
  await waitFor(() => claude.received.length === 2, "новая задача у Claude");
  assert.equal(
    claude.received[1].text,
    "[итог прошлой проверки]\n" +
      "Проверка 1 принята: Codex — принято, Gemini — принято.\n" +
      "Отзывы рецензентов — пометки без требования исправлять; учти их в истории приёмки:\n" +
      "— Codex: Код верен. Пометка: проверить даты весов позже.\nВЕРДИКТ: ПРИНЯТО\n" +
      "— Gemini: Чек-лист закрыт.\nВЕРДИКТ: ПРИНЯТО\n" +
      "\n" +
      "Делайте следующий шаг",
  );
  // Задача человека для рецензентов и журнал — его слова, без блока панели.
  assert.equal(k.state.task, "Делайте следующий шаг");
  const human = journal.history("r").filter((e) => e.agent === "human").at(-1);
  assert.equal(human.text, "Делайте следующий шаг");
  // Человек видит, что Claude получил итог вместе с его сообщением.
  assert.equal(said(events, /^К сообщению Claude приложен итог проверки 1/).length, 1);
  journal.close();
});

test("итог приёмки: Gemini не проверял — в строке итога причина, отзыв только Codex", async () => {
  const { k, claude, journal } = await pairRoom();
  turn(k, "codex", "Код верен.\nВЕРДИКТ: ПРИНЯТО");
  k.handle(event("gemini", "turn_completed", { incomplete: "пустой ответ" }));
  await waitFor(() => k.state.stage === "accepted", "принятие по Codex");
  await k.fromHuman("дальше", "claude");
  await waitFor(() => claude.received.length === 2, "сообщение у Claude");
  const text = claude.received[1].text;
  assert.match(text, /^\[итог прошлой проверки\]\nПроверка 1 принята: Codex — принято, Gemini — не проверял \(пустой ответ\)\.\n/);
  assert.match(text, /— Codex: Код верен\./);
  assert.doesNotMatch(text, /— Gemini:/);
  journal.close();
});

test("итог приёмки: комната без Gemini — строка только про Codex; длинный отзыв обрезан с пометкой", async () => {
  const { k, claude, codex, journal } = room();
  await k.fromHuman("подобрать порог классификатора", "review");
  turn(k, "claude", "порог 0.4");
  await waitFor(() => codex.received.length === 1, "материал у Codex");
  const long = `Начало отзыва. ${"п".repeat(6000)} Конец отзыва.\nВЕРДИКТ: ПРИНЯТО`;
  turn(k, "codex", long);
  await waitFor(() => k.state.stage === "accepted", "принято");
  await k.fromHuman("Делайте следующий шаг", "review");
  await waitFor(() => claude.received.length === 2, "новая задача у Claude");
  const text = claude.received[1].text;
  assert.match(text, /^\[итог прошлой проверки\]\nПроверка 1 принята: Codex — принято\.\n/);
  assert.doesNotMatch(text, /Gemini/);
  const codexLine = text.slice(text.indexOf("— Codex: "), text.indexOf("\n\nДелайте следующий шаг"));
  assert.match(codexLine, /^— Codex: Начало отзыва\./);
  assert.match(codexLine, /\[… пропущены символы/);
  assert.match(codexLine, /ВЕРДИКТ: ПРИНЯТО$/);
  assert.ok(codexLine.length < 4200, `отзыв обрезан до ~4000 знаков, а не ${codexLine.length}`);
  assert.match(text, /\n\nДелайте следующий шаг$/);
  journal.close();
});

test("итог приёмки: «Остановить» сбрасывает его — следующее сообщение Claude без блока", async () => {
  const { k, claude, journal } = await acceptedPair();
  await k.stopAll();
  await k.fromHuman("Делайте следующий шаг", "review");
  await waitFor(() => claude.received.length === 2, "новая задача у Claude");
  assert.equal(claude.received[1].text, "Делайте следующий шаг");
  journal.close();
});

test("итог приёмки: новая сессия Claude сбрасывает его — новая сессия не знает прежней задачи", async () => {
  const { k, claude, journal } = await acceptedPair();
  await k.newSession("claude");
  await k.fromHuman("Делайте следующий шаг", "claude");
  await waitFor(() => claude.received.length === 2, "сообщение у Claude");
  assert.equal(claude.received[1].text, "Делайте следующий шаг");
  journal.close();
});

test("итог приёмки: прямой вопрос Codex блок не забирает — он уходит Claude со следующим сообщением", async () => {
  const { k, claude, codex, journal } = await acceptedPair();
  await k.fromHuman("почему принял?", "codex");
  await waitFor(() => codex.received.length === 2, "вопрос у Codex");
  assert.equal(codex.received[1].text, "почему принял?");
  assert.equal(claude.received.length, 1);
  await k.fromHuman("Делайте следующий шаг", "claude");
  await waitFor(() => claude.received.length === 2, "сообщение у Claude");
  assert.match(claude.received[1].text, /^\[итог прошлой проверки\]\nПроверка 1 принята/);
  assert.match(claude.received[1].text, /\n\nДелайте следующий шаг$/);
  journal.close();
});

test("итог приёмки: сообщение всем — блок только у Claude", async () => {
  const { k, claude, codex, gemini, journal } = await acceptedPair();
  await k.fromHuman("что дальше?", "all");
  await waitFor(() => claude.received.length === 2 && codex.received.length === 2 && gemini.received.length === 2, "у всех");
  assert.match(claude.received[1].text, /^\[итог прошлой проверки\]/);
  assert.equal(codex.received[1].text, "что дальше?");
  assert.equal(gemini.received[1].text, "что дальше?");
  journal.close();
});

test("сведение: замечания у одного — Claude получает одно сообщение с обоими отзывами", async () => {
  const { k, claude, journal } = await pairRoom();
  turn(k, "gemini", "Пробел: пересечение id train/test не показано.\nВЕРДИКТ: ЕСТЬ ЗАМЕЧАНИЯ");
  turn(k, "codex", "Код верен.\nВЕРДИКТ: ПРИНЯТО");
  await waitFor(() => claude.received.length === 2, "возврат Claude");
  const back = claude.received[1];
  assert.equal(back.heading, "[замечания рецензентов Codex и Gemini]");
  assert.match(back.text, /— Codex — код — принято/);
  assert.match(back.text, /— Gemini — методология и факты —\nПробел: пересечение/);
  assert.equal(k.state.stage, "working");
  assert.equal(k.state.verdict, "remarks");
  journal.close();
});

test("сведение: Gemini просит решения человека — обмен ждёт вас", async () => {
  const { k, claude, journal } = await pairRoom();
  turn(k, "codex", "Код верен.\nВЕРДИКТ: ПРИНЯТО");
  turn(k, "gemini", "Нужен доступ к данным.\nВЕРДИКТ: НУЖНО РЕШЕНИЕ ЧЕЛОВЕКА");
  await waitFor(() => k.state.stage === "held", "удержание");
  assert.match(k.state.held.reason, /^Gemini просит вашего решения/);
  assert.equal(k.state.held.to, "claude");
  assert.equal(claude.received.length, 1);
  journal.close();
});

test("сведение: Gemini просит решения, Codex принял — причина удержания называет разногласие", async () => {
  // Журнал 04–05.10: строка «Gemini просит вашего решения» молчала о том,
  // что Codex работу принял, — разногласия рецензентов не было видно.
  const { k, journal } = await pairRoom();
  turn(k, "codex", "Код верен.\nВЕРДИКТ: ПРИНЯТО");
  turn(k, "gemini", "Нужен доступ к данным.\nВЕРДИКТ: НУЖНО РЕШЕНИЕ ЧЕЛОВЕКА");
  await waitFor(() => k.state.stage === "held", "удержание");
  assert.ok(k.state.held.reason.includes("Gemini просит вашего решения"), k.state.held.reason);
  assert.ok(k.state.held.reason.includes("Codex решения не просит (вердикт: принято)"), k.state.held.reason);
  journal.close();
});

test("сведение: Gemini просит решения, у Codex замечания — причина удержания называет и их", async () => {
  const { k, journal } = await pairRoom();
  turn(k, "codex", "Дефект в пороге.\nВЕРДИКТ: ЕСТЬ ЗАМЕЧАНИЯ");
  turn(k, "gemini", "Нужен доступ к данным.\nВЕРДИКТ: НУЖНО РЕШЕНИЕ ЧЕЛОВЕКА");
  await waitFor(() => k.state.stage === "held", "удержание");
  assert.ok(k.state.held.reason.includes("Gemini просит вашего решения"), k.state.held.reason);
  assert.ok(k.state.held.reason.includes("Codex: есть замечания"), k.state.held.reason);
  assert.ok(!k.state.held.reason.includes("решения не просит (вердикт: принято)"), k.state.held.reason);
  journal.close();
});

test("сведение: оба просят решения — одна строка на двоих", async () => {
  const { k, journal } = await pairRoom();
  turn(k, "codex", "Нужно решение по данным.\nВЕРДИКТ: НУЖНО РЕШЕНИЕ ЧЕЛОВЕКА");
  turn(k, "gemini", "Нужен доступ к данным.\nВЕРДИКТ: НУЖНО РЕШЕНИЕ ЧЕЛОВЕКА");
  await waitFor(() => k.state.stage === "held", "удержание");
  assert.match(k.state.held.reason, /^Codex и Gemini просят вашего решения/);
  assert.ok(!k.state.held.reason.includes("не просит"), k.state.held.reason);
  journal.close();
});

test("сведение: Gemini без вердикта — ждём вас", async () => {
  const { k, journal } = await pairRoom();
  turn(k, "codex", "Код верен.\nВЕРДИКТ: ПРИНЯТО");
  turn(k, "gemini", "Посмотрел, вроде нормально.");
  await waitFor(() => k.state.stage === "held", "удержание");
  assert.match(k.state.held.reason, /^Gemini не вынес вердикт/);
  journal.close();
});

test("Gemini не проверял — пустой ответ, ошибка хода, падение процесса — итог по Codex", async () => {
  const endings = [
    { fn: (k) => k.handle(event("gemini", "turn_completed", { incomplete: "пустой ответ" })), reason: /пустой ответ/ },
    { fn: (k) => k.handle(event("gemini", "turn_completed", { failed: true, text: "ход завершён: ERROR — model error" })), reason: /model error/ },
    {
      fn: (k) => k.handle(event("gemini", "error", { failed: true, text: "процесс Gemini завершился неожиданно (код 3)" })),
      reason: /процесс Gemini завершился неожиданно \(код 3\)/,
    },
  ];
  for (const { fn, reason } of endings) {
    const { k, events, journal } = await pairRoom();
    turn(k, "codex", "Код верен.\nВЕРДИКТ: ПРИНЯТО");
    fn(k);
    await waitFor(() => k.state.stage === "accepted", "принятие по Codex");
    // T7-crash: причина хода самой ошибки — в ленте, а не общая заглушка.
    assert.ok(systemEvents(events).some((e) => /^Gemini не проверял: /.test(e.text) && reason.test(e.text)));
    assert.equal(k.state.pair.sides.gemini.state, "unchecked");
    assert.ok(k.state.trail.at(-1).unchecked, "причина — в следе для дорожки");
    journal.close();
  }
});

test("Gemini: ERROR после полного ответа — отзыв входит в проверку с его вердиктом (живой прогон 04.10)", async () => {
  // Живой прогон 04.10: agy вернул status ERROR («API error (attempt 2): …
  // EOF») вместе с полным ответом, кончавшимся вердиктом. Прежде такой ход
  // был failed, и проверка засчитала бы Gemini «не проверял». Здесь Gemini —
  // настоящий адаптер на фальшивом agy: проверяется сама форма его хода.
  const catalog = mkdtempSync(join(tmpdir(), "panel-"));
  const journal = new Journal(join(catalog, "j.sqlite"));
  journal.ensureRoom("r", catalog);
  const claude = new Stub("claude");
  const codex = new Stub("codex");
  const events = [];
  let k;
  const gemini = new GeminiAdapter({ command: "node", commandArgs: [FAKE_AGY], cwd: catalog }, (e) => k.handle(e));
  k = new Coordinator(claude, codex, journal, { room: "r", cwd: catalog, maxAutoRounds: 3, onEvent: (e) => events.push(e), gemini });
  try {
    await k.fromHuman("подобрать порог классификатора ОШИБКА-ПОСЛЕ-ОТВЕТА", "review");
    turn(k, "claude", "порог 0.4, F1 на валидации 0.71");
    await waitFor(() => codex.received.length === 1, "материал у Codex");
    turn(k, "codex", "Код верен.\nВЕРДИКТ: ПРИНЯТО");
    await waitFor(() => k.state.stage === "accepted", "принятие", 10_000);
    assert.ok(systemEvents(events).some((e) => /Итог проверки 1: Codex — принято, Gemini — принято/.test(e.text)));
    assert.ok(systemEvents(events).some((e) => /^Рецензенты приняли работу/.test(e.text)));
    assert.ok(!systemEvents(events).some((e) => /Gemini не проверял/.test(e.text ?? "")));
    assert.deepEqual(k.state.trail.find((sh) => sh.who === "gemini" && sh.round === 1), { who: "gemini", round: 1, mark: "✓" });
    const done = events.find((e) => e.agent === "gemini" && e.kind === "turn_completed");
    assert.match(done.text, /agy сообщил об ошибке после ответа: ERROR — API error/, "ошибка остаётся в конце хода");
    // Отметка для ленты доходит до панели и до журнала: уведомление переживает перезапуск.
    assert.match(done.lateError ?? "", /^agy сообщил об ошибке после ответа: ERROR — API error/);
    const kept = journal.history("r").find((e) => e.agent === "gemini" && e.kind === "turn_completed");
    assert.equal(kept.lateError, done.lateError);
  } finally {
    await gemini.stop();
    journal.close();
  }
});

// ---------------------------------------------------------------------------
// Повтор хода Gemini при сетевом сбое (журнал 05.10, seq 70995–70998)
// ---------------------------------------------------------------------------

/**
 * Конец хода проверки при сетевом сбое, как в журнале 05.10 00:38: agy
 * ответил Bad Gateway с пустым ответом. Через 11 минут тот же Gemini
 * отработал нормально.
 */
const NETWORK_FAILURE = { failed: true, text: "ход завершён: ERROR — Bad Gateway" };

/** Ход Gemini кончился сетевым сбоем; agy после этого сам выходит кодом 3. */
function geminiNetworkFailure(k, gemini, text = NETWORK_FAILURE.text) {
  gemini.busy = false;
  k.handle(event("gemini", "turn_completed", { failed: true, text }));
  k.handle(event("gemini", "error", { failed: true, text: "процесс Gemini завершился неожиданно (код 3, сигнал null): Bad Gateway" }));
}

test("Gemini: сбой сети в проверке — пара ждёт его, через geminiRetryMs тот же материал уходит снова, второй ответ сводится обычно", async () => {
  const { k, claude, gemini, events, journal } = await pairRoom({ geminiRetryMs: 40 }, 3, { liveGemini: true });
  geminiNetworkFailure(k, gemini);
  await waitFor(() => said(events, /^Gemini: сбой сети/).length === 1, "строка о повторе");
  assert.equal(said(events, /^Gemini: сбой сети \(Bad Gateway\) — повтор через 1 с\.$/).length, 1);
  // Выход agy кодом 3 после сбоя — не «не проверял»: пара ждёт повтора.
  assert.deepEqual(k.state.pair.sides.gemini, { state: "waiting" });
  assert.equal(said(events, /Gemini не проверял/).length, 0);
  assert.equal(gemini.received.length, 1, "повтор — не сразу");
  turn(k, "codex", "Дефект в пороге.\nВЕРДИКТ: ЕСТЬ ЗАМЕЧАНИЯ");
  await waitFor(() => gemini.received.length === 2, "повторный ход Gemini");
  assert.equal(gemini.received[1].text, gemini.received[0].text, "тот же материал");
  assert.equal(gemini.received[1].heading, "[материал проверки от панели]");
  assert.equal(gemini.received[1].snapshot, gemini.received[0].snapshot, "та же версия");
  geminiTurn(k, gemini, "Пробел в разбиении.\nВЕРДИКТ: ЕСТЬ ЗАМЕЧАНИЯ");
  await waitFor(() => claude.received.length === 2, "сведённые замечания у Claude");
  assert.match(claude.received[1].text, /— Gemini — методология и факты —\nПробел в разбиении\./);
  assert.equal(said(events, /^Итог проверки 1: Codex — есть замечания, Gemini — есть замечания\.$/).length, 1);
  assert.deepEqual(k.state.trail.find((sh) => sh.who === "gemini" && sh.round === 1), { who: "gemini", round: 1, mark: "!" });
  const materials = journal.history("r").filter((e) => e.kind === "material" && e.agent === "gemini");
  assert.equal(materials.length, 2, "в журнале — оба раза, когда материал ушёл Gemini");
  journal.close();
});

test("Gemini: сетевой сбой узнаётся по словам ошибки без учёта регистра", async () => {
  const texts = [
    "ход завершён: ERROR — request failed: Post \"https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse\": EOF",
    "ход завершён: ERROR — upstream 502",
    "ход завершён: ERROR — 503 service unavailable",
    "ход завершён: ERROR — status 504",
    "ход завершён: ERROR — rpc error: code = Unavailable",
    "ход завершён: ERROR — read tcp: Connection reset by peer",
    "ход завершён: ERROR — i/o TIMEOUT",
  ];
  for (const text of texts) {
    const { k, gemini, events, journal } = await pairRoom({ geminiRetryMs: 40 }, 3, { liveGemini: true });
    geminiNetworkFailure(k, gemini, text);
    await waitFor(() => gemini.received.length === 2, `повтор: ${text}`);
    assert.equal(said(events, /^Gemini: сбой сети \(.+\) — повтор через 1 с\.$/).length, 1, text);
    journal.close();
  }
});

test("Gemini: повтор после сбоя сети один — второй сбой даёт «не проверял: … (повтор тоже не удался)», итог по Codex", async () => {
  const { k, gemini, events, journal } = await pairRoom({ geminiRetryMs: 40 }, 3, { liveGemini: true });
  turn(k, "codex", "Код верен.\nВЕРДИКТ: ПРИНЯТО");
  geminiNetworkFailure(k, gemini);
  await waitFor(() => gemini.received.length === 2, "повторный ход");
  geminiNetworkFailure(k, gemini, "ход завершён: ERROR — EOF");
  await waitFor(() => k.state.stage === "accepted", "итог по Codex");
  assert.equal(k.state.pair.sides.gemini.reason, "ход завершён: ERROR — EOF (повтор тоже не удался)");
  assert.equal(
    said(events, /^Gemini не проверял: ход завершён: ERROR — EOF \(повтор тоже не удался\)\. Итог — по вердикту Codex\.$/).length,
    1,
  );
  assert.equal(said(events, /^Codex принял работу \(Gemini не проверял\)\. Цикл завершён\./).length, 1);
  await sleep(150);
  assert.equal(gemini.received.length, 2, "третьего хода нет");
  assert.equal(said(events, /^Gemini: сбой сети/).length, 1, "строка о повторе — одна");
  journal.close();
});

test("Gemini: повтор не запустился (или процесс упал в повторном ходе) — тоже «(повтор тоже не удался)»", async () => {
  {
    const { k, gemini, events, journal } = await pairRoom({ geminiRetryMs: 40 }, 3, { liveGemini: true });
    turn(k, "codex", "Код верен.\nВЕРДИКТ: ПРИНЯТО");
    geminiNetworkFailure(k, gemini);
    gemini.send = async (prompt) => {
      gemini.received.push(prompt);
      throw new Error("agy не найден");
    };
    await waitFor(() => k.state.stage === "accepted", "итог по Codex");
    assert.equal(k.state.pair.sides.gemini.reason, "agy не найден (повтор тоже не удался)");
    assert.equal(gemini.received.length, 2);
    journal.close();
  }
  {
    const { k, gemini, journal } = await pairRoom({ geminiRetryMs: 40 }, 3, { liveGemini: true });
    turn(k, "codex", "Код верен.\nВЕРДИКТ: ПРИНЯТО");
    geminiNetworkFailure(k, gemini);
    await waitFor(() => gemini.received.length === 2, "повторный ход");
    gemini.busy = false;
    k.handle(event("gemini", "error", { failed: true, text: "процесс Gemini завершился неожиданно (код 3, сигнал null)" }));
    await waitFor(() => k.state.stage === "accepted", "итог по Codex");
    assert.equal(k.state.pair.sides.gemini.reason, "процесс Gemini завершился неожиданно (код 3, сигнал null) (повтор тоже не удался)");
    journal.close();
  }
});

test("Gemini: не сетевой сбой (регион, квота, модель) и сбой после части ответа — без повтора, сразу «не проверял»", async () => {
  const endings = [
    {
      name: "регион",
      fn: (k) =>
        k.handle(
          event("gemini", "turn_completed", {
            failed: true,
            text: "ход завершён: ERROR — Eligibility check failed: Your current account is not eligible for Antigravity, because it is not currently available in your location. (Antigravity отказал по региону (Eligibility check failed))",
          }),
        ),
    },
    { name: "квота", fn: (k) => k.handle(event("gemini", "turn_completed", { failed: true, text: "ход завершён: ERROR — RESOURCE_EXHAUSTED: quota exceeded" })) },
    { name: "модель", fn: (k) => k.handle(event("gemini", "turn_completed", { failed: true, text: "ход завершён: ERROR — model error (model overloaded)" })) },
    {
      name: "часть ответа",
      fn: (k) => {
        k.handle(event("gemini", "message", { text: "Начал проверку разбиения." }));
        k.handle(event("gemini", "turn_completed", NETWORK_FAILURE));
      },
    },
    { name: "номер ошибки в чужом слове", fn: (k) => k.handle(event("gemini", "turn_completed", { failed: true, text: "ход завершён: ERROR — limit 15020 reached" })) },
  ];
  for (const { name, fn } of endings) {
    const { k, gemini, events, journal } = await pairRoom({ geminiRetryMs: 40 }, 3, { liveGemini: true });
    turn(k, "codex", "Код верен.\nВЕРДИКТ: ПРИНЯТО");
    gemini.busy = false;
    fn(k);
    await waitFor(() => k.state.stage === "accepted", `${name}: итог по Codex`);
    await sleep(100);
    assert.equal(gemini.received.length, 1, `${name}: повтора нет`);
    assert.equal(said(events, /^Gemini: сбой сети/).length, 0, name);
    assert.equal(said(events, /\(повтор тоже не удался\)/).length, 0, name);
    assert.equal(said(events, /^Gemini не проверял: /).length, 1, name);
    journal.close();
  }
});

test("Gemini: «Прервать», «Остановить», новая задача и новая сессия во время ожидания повтора — повтора нет", async () => {
  for (const action of ["interruptAll", "stopAll", "новая задача", "новая сессия Gemini"]) {
    const { k, gemini, events, journal } = await pairRoom({ geminiRetryMs: 60 }, 3, { liveGemini: true });
    geminiNetworkFailure(k, gemini);
    await waitFor(() => said(events, /^Gemini: сбой сети/).length === 1, `${action}: ожидание повтора`);
    if (action === "новая задача") await k.fromHuman("новая задача", "review");
    else if (action === "новая сессия Gemini") await k.newSession("gemini");
    else await k[action]();
    await sleep(200);
    assert.equal(gemini.received.length, 1, `${action}: повтора нет`);
    if (action === "новая сессия Gemini") {
      assert.equal(k.state.pair.sides.gemini.reason, "новая сессия Gemini");
      assert.equal(k.state.stage, "reviewing", "цикл идёт с Codex");
    }
    journal.close();
  }
});

test("Gemini: прямой вопрос человека во время ожидания повтора ждёт в очереди и уходит Gemini только после повторного хода", async () => {
  const { k, gemini, events, journal } = await pairRoom({ geminiRetryMs: 300 }, 3, { liveGemini: true });
  geminiNetworkFailure(k, gemini);
  await waitFor(() => said(events, /^Gemini: сбой сети/).length === 1, "ожидание повтора");
  await k.fromHuman("какой бейзлайн взять?", "gemini");
  assert.equal(gemini.received.length, 1, "вопрос не ушёл Gemini во время ожидания");
  assert.equal(k.state.queued, 1, "вопрос ждёт в очереди");
  await waitFor(() => gemini.received.length === 2, "повторный ход");
  assert.equal(gemini.received[1].text, gemini.received[0].text, "сначала — повтор проверки");
  assert.equal(k.state.queued, 1, "вопрос ждёт конца повторного хода");
  turn(k, "codex", "Код верен.\nВЕРДИКТ: ПРИНЯТО");
  geminiTurn(k, gemini, "Утечек нет.\nВЕРДИКТ: ПРИНЯТО");
  await waitFor(() => gemini.received.length === 3, "прямой вопрос после повтора");
  assert.match(gemini.received[2].text, /какой бейзлайн взять\?/);
  await waitFor(() => k.state.stage === "accepted", "проверка принята обоими");
  assert.equal(said(events, /^Рецензенты приняли работу\. Цикл завершён\./).length, 1);
  journal.close();
});

test("Gemini: ожидание повтора — признак жизни: молчание его не снимает, «был занят другим ходом» не пишется", async () => {
  {
    // Codex уже ответил: часы Gemini идут, а цели у Gemini нет.
    const { k, gemini, events, journal } = await pairRoom({ geminiRetryMs: 400, geminiSilenceMs: 120 }, 3, { liveGemini: true });
    turn(k, "codex", "Код верен.\nВЕРДИКТ: ПРИНЯТО");
    geminiNetworkFailure(k, gemini);
    await sleep(330);
    assert.equal(gemini.interrupted, 0, "ожидание повтора — не молчание");
    assert.deepEqual(k.state.pair.sides.gemini, { state: "waiting" });
    await waitFor(() => gemini.received.length === 2, "повторный ход");
    geminiTurn(k, gemini, "Утечек нет.\nВЕРДИКТ: ПРИНЯТО");
    await waitFor(() => k.state.stage === "accepted", "итог с Gemini");
    assert.equal(said(events, /^Рецензенты приняли работу\. Цикл завершён\./).length, 1);
    assert.equal(said(events, /замолчал|не подавал признаков жизни|был занят другим ходом/).length, 0);
    journal.close();
  }
  {
    // Предел безопасности истёк во время ожидания: это предел, а не «занят другим ходом»; повтора нет.
    const { k, gemini, events, journal } = await pairRoom({ geminiRetryMs: 300, geminiSafetyMs: 80 }, 3, { liveGemini: true });
    turn(k, "codex", "Код верен.\nВЕРДИКТ: ПРИНЯТО");
    geminiNetworkFailure(k, gemini);
    await waitFor(() => k.state.stage === "accepted", "итог по Codex по пределу");
    assert.match(k.state.pair.sides.gemini.reason, /^не закончил за .+ после ответа Codex — остановлен$/);
    assert.equal(said(events, /был занят другим ходом/).length, 0);
    await sleep(350);
    assert.equal(gemini.received.length, 1, "снятая проверка не повторяется");
    journal.close();
  }
});

test("Gemini: срок при замечаниях Codex истёк во время ожидания повтора — Claude получает замечания Codex, повтор идёт, поздний отзыв — в ленте", async () => {
  const { k, claude, gemini, events, journal } = await pairRoom({ geminiRetryMs: 150, geminiWaitMs: 40 }, 3, { liveGemini: true });
  turn(k, "codex", "Дефект.\nВЕРДИКТ: ЕСТЬ ЗАМЕЧАНИЯ");
  geminiNetworkFailure(k, gemini);
  await waitFor(() => claude.received.length === 2, "замечания Codex у Claude");
  assert.match(k.state.pair.sides.gemini.reason, /^не уложился в .+ после ответа Codex — ещё проверяет$/);
  await waitFor(() => gemini.received.length === 2, "повтор после срока");
  geminiTurn(k, gemini, "Пробел.\nВЕРДИКТ: ЕСТЬ ЗАМЕЧАНИЯ");
  await waitFor(() => said(events, /^Gemini опоздал к проверке 1: есть замечания/).length === 1, "поздний отзыв в ленте");
  assert.equal(claude.received.length, 2, "поздний отзыв Claude не пересылается");
  journal.close();
});

test("Gemini на фальшивом agy: Bad Gateway и выход кодом 3 — повтор через geminiRetryMs, отзыв повторного хода входит в проверку (журнал 05.10)", async () => {
  const catalog = mkdtempSync(join(tmpdir(), "panel-"));
  const journal = new Journal(join(catalog, "j.sqlite"));
  journal.ensureRoom("r", catalog);
  const claude = new Stub("claude");
  const codex = new Stub("codex");
  const events = [];
  let k;
  const gemini = new GeminiAdapter({ command: "node", commandArgs: [FAKE_AGY], cwd: catalog }, (e) => k.handle(e));
  k = new Coordinator(claude, codex, journal, {
    room: "r",
    cwd: catalog,
    maxAutoRounds: 3,
    onEvent: (e) => events.push(e),
    gemini,
    geminiRetryMs: 500,
  });
  try {
    await k.fromHuman("подобрать порог классификатора СБОЙ-СЕТИ-ОДИН-РАЗ", "review");
    turn(k, "claude", "порог 0.4, F1 на валидации 0.71");
    await waitFor(() => codex.received.length === 1, "материал у Codex");
    turn(k, "codex", "Код верен.\nВЕРДИКТ: ПРИНЯТО");
    await waitFor(() => said(events, /^Gemini: сбой сети/).length === 1, "строка о повторе", 10_000);
    assert.equal(said(events, /^Gemini: сбой сети \(Bad Gateway\) — повтор через 1 с\.$/).length, 1);
    await waitFor(() => events.some((e) => e.agent === "gemini" && e.kind === "error"), "выход agy кодом 3", 10_000);
    assert.deepEqual(k.state.pair.sides.gemini, { state: "waiting" }, "выход процесса после сбоя — не «не проверял»");
    // Обычный ответ фальшивки вердикта не содержит: важно, что он засчитан как отзыв.
    await waitFor(() => k.state.stage === "held", "итог после повтора", 10_000);
    assert.equal(said(events, /^Итог проверки 1: Codex — принято, Gemini — без вердикта\.$/).length, 1);
    assert.equal(said(events, /Gemini не проверял/).length, 0);
    const completed = events.filter((e) => e.agent === "gemini" && e.kind === "turn_completed");
    assert.equal(completed.length, 2);
    assert.equal(completed[0].failed, true);
    assert.equal(completed[1].failed, undefined);
  } finally {
    await gemini.stop();
    journal.close();
  }
});

test("T7-wording: принятие при непроверенном Gemini — «Codex принял работу», не «Рецензенты»", async () => {
  const { k, events, journal } = await pairRoom();
  turn(k, "codex", "Код верен.\nВЕРДИКТ: ПРИНЯТО");
  k.handle(event("gemini", "turn_completed", { incomplete: "пустой ответ" }));
  await waitFor(() => k.state.stage === "accepted", "принятие по Codex");
  assert.ok(systemEvents(events).some((e) => /^Codex принял работу \(Gemini не проверял\)\. Цикл завершён\./.test(e.text)));
  assert.ok(!systemEvents(events).some((e) => /^Рецензенты приняли работу/.test(e.text)));
  journal.close();
});

test("T7-wording: оба приняли — «Рецензенты приняли работу»", async () => {
  const { k, events, journal } = await pairRoom();
  turn(k, "codex", "Код верен.\nВЕРДИКТ: ПРИНЯТО");
  turn(k, "gemini", "Утечек нет.\nВЕРДИКТ: ПРИНЯТО");
  await waitFor(() => k.state.stage === "accepted", "принятие");
  assert.ok(systemEvents(events).some((e) => /^Рецензенты приняли работу\. Цикл завершён\./.test(e.text)));
  journal.close();
});

test("M6: новая сессия Gemini во время пары не останавливает цикл — «не проверял», Codex продолжает", async () => {
  const { k, codex, events, journal } = await pairRoom();
  await k.newSession("gemini");
  assert.equal(k.state.stage, "reviewing", "цикл не должен остановиться");
  assert.equal(k.state.pair.sides.gemini.state, "unchecked");
  turn(k, "codex", "Код верен.\nВЕРДИКТ: ПРИНЯТО");
  await waitFor(() => k.state.stage === "accepted", "принятие по Codex");
  assert.ok(systemEvents(events).some((e) => /^Gemini не проверял: новая сессия Gemini/.test(e.text)));
  assert.equal(codex.received.length, 1, "Codex не перезапущен и не остановлен");
  journal.close();
});

test("M7: прямой вопрос Gemini, закончившийся пустым ответом, виден в ленте", async () => {
  const { k, events, journal } = room(3, {}, { withGemini: true });
  await k.fromHuman("вопрос", "gemini");
  k.handle(event("gemini", "turn_completed", { incomplete: "пустой ответ" }));
  await waitFor(() => systemEvents(events).some((e) => /^Gemini не ответил: пустой ответ\./.test(e.text)), "сообщение о неполном прямом ответе");
  journal.close();
});

test("Gemini не уложился в срок после замечаний Codex — Claude получает замечания Codex, Gemini не прерван, его поздние замечания — в ленте", async () => {
  // Срок geminiWaitMs — только когда Codex нашёл замечания: Claude простаивает.
  // Gemini при этом не останавливается: его отзыв ещё может пригодиться
  // (R1, R7 — дизайн срока Gemini 03.10).
  const { k, claude, gemini, events, journal } = await pairRoom({ geminiWaitMs: 40 }, 3, { liveGemini: true });
  turn(k, "codex", "Дефект в пороге.\nВЕРДИКТ: ЕСТЬ ЗАМЕЧАНИЯ");
  await waitFor(() => claude.received.length === 2, "замечания Claude без Gemini");
  assert.match(claude.received[1].text, /— Gemini — методология и факты — не проверял \(это не замечание, исправлять нечего\)/);
  assert.match(k.state.pair.sides.gemini.reason, /^не уложился в .+ после ответа Codex — ещё проверяет$/);
  assert.equal(gemini.interrupted, 0, "Gemini не прерывается");
  assert.equal(gemini.busy, true);
  assert.equal(
    said(events, /^Gemini не уложился в .+ и ещё проверяет: Claude получил замечания одного Codex\. Если Gemini закончит до проверки 2, его ответ появится в ленте\.$/).length,
    1,
  );
  assert.equal(said(events, /^Gemini не проверял: /).length, 0, "общая строка заменена пояснением");
  assert.equal(said(events, /^Итог проверки 1: Codex — есть замечания, Gemini — не проверял \(не уложился/).length, 1);

  geminiTurn(k, gemini, "Поздно: утечка id.\nВЕРДИКТ: ЕСТЬ ЗАМЕЧАНИЯ");
  await waitFor(() => said(events, /Gemini опоздал/).length === 1, "поздний отзыв назван в ленте");
  assert.equal(
    said(events, /^Gemini опоздал к проверке 1: есть замечания \(текст выше\)\. Claude их не получил — он уже работает по замечаниям Codex; проверку 2 Gemini получит вместе с Codex\.$/).length,
    1,
  );
  assert.equal(said(events, /Поздний ответ Gemini/).length, 0);
  assert.equal(claude.received.length, 2, "поздний ответ Claude не пересылается");
  assert.equal(k.state.stage, "working");
  assert.deepEqual(k.state.pair.sides.gemini, { state: "done", verdict: "remarks" });
  assert.deepEqual(k.state.trail.find((sh) => sh.who === "gemini" && sh.round === 1), { who: "gemini", round: 1, mark: "!" });
  journal.close();
});

test("«Прервать» во время ожидания Gemini — срок не сводит снятую проверку", async () => {
  const { k, claude, events, journal } = await pairRoom({ geminiWaitMs: 40 });
  turn(k, "codex", "Дефект.\nВЕРДИКТ: ЕСТЬ ЗАМЕЧАНИЯ");
  await k.interruptAll();
  await sleep(120);
  assert.equal(claude.received.length, 1, "после «Прервать» замечания не уходят");
  assert.equal(k.state.stage, "stopped");
  assert.ok(!systemEvents(events).some((e) => /Итог проверки/.test(e.text)));
  journal.close();
});

test("удержанная пара уходит обоим по кнопке «Отправить на проверку»", async () => {
  const { k, codex, gemini, journal } = room(0, {}, { withGemini: true });
  await k.fromHuman("задача", "review");
  turn(k, "claude", "сделал");
  await waitFor(() => k.state.stage === "held", "удержание по пределу");
  assert.equal(k.state.held.action, "review");
  assert.match(k.state.held.reason, /не проверена рецензентами/);
  await k.releaseHeld();
  assert.equal(codex.received.length, 1);
  assert.equal(gemini.received.length, 1);
  assert.equal(k.state.round, 1);
  assert.equal(k.state.stage, "reviewing");
  journal.close();
});

test("Gemini не запустился (нет правил «только чтение») — не проверял, цикл идёт с Codex", async () => {
  const { k, codex, gemini, events, journal } = room(3, {}, { withGemini: true });
  gemini.send = async () => {
    throw new Error("нет режима «только чтение» в настройках agy: нет запрета записи: deny write_file(*)");
  };
  await k.fromHuman("задача", "review");
  turn(k, "claude", "сделал");
  await waitFor(() => codex.received.length === 1, "Codex получил проверку");
  assert.equal(k.state.stage, "reviewing", "сбой Gemini не останавливает цикл");
  turn(k, "codex", "Хорошо.\nВЕРДИКТ: ПРИНЯТО");
  await waitFor(() => k.state.stage === "accepted", "принятие по Codex");
  assert.ok(systemEvents(events).some((e) => /Gemini не проверял: нет режима «только чтение»/.test(e.text)));
  journal.close();
});

test("принятая работа при сдвинутом дереве — отметка версии в ленте", async () => {
  let n = 0;
  const snapshot = async () => ({ id: `v${(n += 1)}`, commit: undefined, dirty: true, at: Date.now(), source: "filesystem" });
  const { k, codex, events, journal } = room(3, { snapshot }, { withGemini: true });
  await k.fromHuman("задача", "review");
  turn(k, "claude", "сделал");
  await waitFor(() => codex.received.length === 1, "проверка");
  turn(k, "codex", "ВЕРДИКТ: ПРИНЯТО");
  turn(k, "gemini", "ВЕРДИКТ: ПРИНЯТО");
  await waitFor(() => k.state.stage === "accepted", "принятие");
  assert.ok(systemEvents(events).some((e) => /Файлы изменились за время проверки: принята версия/.test(e.text)));
  journal.close();
});

test("расход Gemini в проверке входит в расход задачи и в предел токенов", async () => {
  const { k, claude, gemini, journal } = room(3, { taskTokenLimit: 1000 }, { withGemini: true });
  await k.fromHuman("задача", "review");
  turn(k, "claude", "сделал", { usage: { input: 300, cached: 0, output: 10 } });
  await waitFor(() => gemini.received.length === 1, "проверка");
  turn(k, "codex", "Дефект.\nВЕРДИКТ: ЕСТЬ ЗАМЕЧАНИЯ", { usage: { input: 300, cached: 0, output: 10 } });
  turn(k, "gemini", "Пробел.\nВЕРДИКТ: ЕСТЬ ЗАМЕЧАНИЯ", { usage: { input: 400, cached: 0, output: 10 } });
  await waitFor(() => k.state.stage === "held", "предел токенов");
  assert.equal(k.state.usage.task.gemini.input, 400);
  assert.match(k.state.held.reason, /1030 токенов/);
  assert.equal(claude.received.length, 1);
  journal.close();
});

test("сбой Codex по-прежнему останавливает цикл, и срок Gemini не срабатывает", async () => {
  const { k, claude, events, journal } = await pairRoom({ geminiWaitMs: 40 });
  k.handle(event("codex", "turn_completed", { failed: true, text: "ход завершён: failed" }));
  await sleep(120);
  assert.equal(k.state.stage, "stopped");
  assert.equal(claude.received.length, 1);
  assert.ok(systemEvents(events).some((e) => /Ход Codex завершился с ошибкой/.test(e.text)));
  assert.ok(!systemEvents(events).some((e) => /Итог проверки/.test(e.text)));
  journal.close();
});

test("устаревшая проверка Gemini в очереди не уходит, когда он освобождается после сведения по сроку", async () => {
  // Gemini занят (например, прямым вопросом) — его проверка встаёт в очередь.
  // Codex принимает, срок ожидания истекает, пара сведена по Codex одному.
  // Когда Gemini освобождается, выгрузка очереди не должна доставить ему
  // проверку устаревшей пары — иначе её ответ придёт «поздним ответом» и
  // потратит квоту Gemini впустую. Codex принял — срок здесь geminiSafetyMs
  // (R1, дизайн срока Gemini 03.10).
  const { k, codex, gemini, journal } = room(3, { geminiWaitMs: 40, geminiSafetyMs: 40 }, { withGemini: true });
  gemini.busy = true;
  await k.fromHuman("задача", "review");
  turn(k, "claude", "сделал");
  await waitFor(() => codex.received.length === 1, "Codex получил проверку");
  assert.equal(k.state.queued, 1, "проверка Gemini ждёт в очереди, пока он занят");
  turn(k, "codex", "Хорошо.\nВЕРДИКТ: ПРИНЯТО");
  await waitFor(() => k.state.stage === "accepted", "принятие по сроку ожидания Gemini");
  assert.equal(k.state.queued, 0, "по сроку устаревшая проверка снята из очереди сразу");
  gemini.busy = false;
  k.handle(event("gemini", "turn_completed"));
  await sleep(30);
  assert.equal(gemini.received.length, 0, "устаревшая проверка не должна уйти Gemini");
  assert.equal(k.state.queued, 0, "устаревшее снято из очереди, а не зависло в ней");
  journal.close();
});

test("устаревшая проверка Gemini в очереди не уходит даже после того, как её обогнала следующая проверка", async () => {
  // Gemini занят всё время; новая проверка того же цикла в очереди
  // вытесняет прежнюю (это было и раньше — дедупликация в #send), так что
  // в очереди остаётся одна запись — на самую свежую проверку. Если срок
  // ожидания истёк и для неё (она сведена без Gemini), освободившийся
  // Gemini всё равно не должен получить её из очереди. С 03.10 по сроку она
  // снимается из очереди сразу, не дожидаясь, пока Gemini освободится.
  const { k, claude, codex, gemini, journal } = room(3, { geminiWaitMs: 40, geminiSafetyMs: 40 }, { withGemini: true });
  gemini.busy = true;
  await k.fromHuman("задача", "review");
  turn(k, "claude", "сделал");
  await waitFor(() => codex.received.length === 1, "проверка 1 у Codex");
  turn(k, "codex", "Дефект.\nВЕРДИКТ: ЕСТЬ ЗАМЕЧАНИЯ");
  await waitFor(() => claude.received.length === 2, "замечания без Gemini (срок истёк)");
  turn(k, "claude", "исправил");
  await waitFor(() => codex.received.length === 2, "проверка 2 у Codex");
  turn(k, "codex", "Хорошо.\nВЕРДИКТ: ПРИНЯТО");
  await waitFor(() => k.state.stage === "accepted", "проверка 2 сведена без Gemini");
  assert.equal(k.state.queued, 0, "устаревшая проверка снята из очереди по сроку, а не ждёт Gemini");
  gemini.busy = false;
  k.handle(event("gemini", "turn_completed"));
  await sleep(30);
  assert.equal(gemini.received.length, 0, "устаревшая проверка не должна уйти Gemini");
  assert.equal(k.state.queued, 0);
  journal.close();
});

// --- Сведение пары: все исходы из спецификации ------------------------------

const VERDICT_TEXT = {
  accepted: "Всё в порядке.\nВЕРДИКТ: ПРИНЯТО",
  remarks: "Нашёл дефект.\nВЕРДИКТ: ЕСТЬ ЗАМЕЧАНИЯ",
  human: "Нужно решение.\nВЕРДИКТ: НУЖНО РЕШЕНИЕ ЧЕЛОВЕКА",
  missing: "Посмотрел, не уверен.",
};

const MERGE_TABLE = [
  { codex: "accepted", gemini: "accepted", stage: "accepted" },
  { codex: "accepted", gemini: "remarks", stage: "working" },
  { codex: "remarks", gemini: "accepted", stage: "working" },
  { codex: "human", gemini: "accepted", stage: "held", held: /^Codex просит/ },
  { codex: "accepted", gemini: "human", stage: "held", held: /^Gemini просит/ },
  { codex: "missing", gemini: "accepted", stage: "held", held: /^Codex не вынес/ },
  { codex: "accepted", gemini: "missing", stage: "held", held: /^Gemini не вынес/ },
  { codex: "accepted", gemini: "unchecked", stage: "accepted" },
  { codex: "remarks", gemini: "unchecked", stage: "working", uncheckedBlock: true },
  { codex: "human", gemini: "human", stage: "held", held: /^Codex и Gemini просят/ },
];

test("сведение пары: таблица исходов Codex × Gemini — строже побеждает", async () => {
  for (const row of MERGE_TABLE) {
    const { k, claude, journal } = await pairRoom();
    turn(k, "codex", VERDICT_TEXT[row.codex]);
    if (row.gemini === "unchecked") {
      k.handle(event("gemini", "turn_completed", { incomplete: "пустой ответ" }));
    } else {
      turn(k, "gemini", VERDICT_TEXT[row.gemini]);
    }
    const label = `Codex=${row.codex}, Gemini=${row.gemini}`;
    await waitFor(() => k.state.stage === row.stage, `${label} → ${row.stage}`);
    if (row.stage === "accepted") {
      assert.equal(claude.received.length, 1, `${label}: принятое не возвращается Claude`);
    } else if (row.stage === "working") {
      assert.equal(claude.received.length, 2, `${label}: Claude должен получить общее сообщение`);
      const back = claude.received[1];
      assert.equal(back.heading, "[замечания рецензентов Codex и Gemini]");
      assert.match(back.text, /— Codex — код —/);
      assert.match(back.text, /— Gemini — методология и факты —/);
      if (row.uncheckedBlock) assert.match(back.text, /— Gemini — методология и факты — не проверял \(это не замечание, исправлять нечего\)/);
    } else if (row.stage === "held") {
      assert.match(k.state.held.reason, row.held, `${label}: причина удержания`);
      assert.equal(claude.received.length, 1, `${label}: удержание не должно уйти Claude само`);
    }
    journal.close();
  }
});

test("«Остановить» во время ожидания Gemini — срок не сводит снятую проверку", async () => {
  const { k, claude, events, journal } = await pairRoom({ geminiWaitMs: 40 });
  turn(k, "codex", "Дефект.\nВЕРДИКТ: ЕСТЬ ЗАМЕЧАНИЯ");
  await k.stopAll();
  await sleep(120);
  assert.equal(claude.received.length, 1, "после «Остановить» замечания не уходят");
  assert.equal(k.state.stage, "stopped");
  assert.ok(!systemEvents(events).some((e) => /Итог проверки/.test(e.text)));
  journal.close();
});

test("новая задача во время ожидания Gemini — прежняя пара не сводится, новый цикл идёт своим чередом", async () => {
  const { k, claude, codex, gemini, events, journal } = await pairRoom({ geminiWaitMs: 40 });
  turn(k, "codex", "Дефект.\nВЕРДИКТ: ЕСТЬ ЗАМЕЧАНИЯ");
  await k.fromHuman("новая задача", "review");
  await waitFor(() => claude.received.length >= 2, "новая задача ушла Claude");
  await sleep(60);
  assert.ok(!systemEvents(events).some((e) => /Итог проверки 1/.test(e.text)), "прежняя пара не должна свестись после смены цикла");
  turn(k, "claude", "сделал по новой задаче");
  await waitFor(() => codex.received.length === 2 && gemini.received.length === 2, "новый цикл проверки ушёл обоим");
  journal.close();
});

test("замечания пары подписаны версией каждого рецензента отдельно — дерево ушло вперёд", async () => {
  let n = 0;
  const snapshot = async () => ({ id: `v${(n += 1)}`, commit: undefined, dirty: true, at: Date.now(), source: "filesystem" });
  const { k, claude, codex, gemini, journal } = room(3, { snapshot }, { withGemini: true });
  await k.fromHuman("задача", "review");
  turn(k, "claude", "сделал");
  await waitFor(() => codex.received.length === 1 && gemini.received.length === 1, "проверка у обоих");
  turn(k, "codex", "Дефект.\nВЕРДИКТ: ЕСТЬ ЗАМЕЧАНИЯ");
  turn(k, "gemini", "Пробел.\nВЕРДИКТ: ЕСТЬ ЗАМЕЧАНИЯ");
  await waitFor(() => claude.received.length === 2, "возврат Claude с замечаниями обоих");
  const back = claude.received[1];
  assert.match(back.text, /— Codex — код —\nДефект\.[\s\S]*Файлы изменились после начала проверки/);
  assert.match(back.text, /— Gemini — методология и факты —\nПробел\.[\s\S]*Файлы изменились после начала проверки/);
  journal.close();
});

test("поздняя проверка Gemini за прошлый раунд снимается с началом следующего — новая уходит сразу и сводится из своих ответов", async () => {
  // Прежде поздний ход раунда 1 держал Gemini, а материал раунда 2 ждал в
  // очереди — опоздание переходило из проверки в проверку (R6, дизайн
  // срока Gemini 03.10).
  const { k, claude, codex, gemini, events, journal } = await pairRoom({ geminiWaitMs: 40 }, 3, { liveGemini: true });
  turn(k, "codex", "Дефект в пороге.\nВЕРДИКТ: ЕСТЬ ЗАМЕЧАНИЯ");
  await waitFor(() => claude.received.length === 2, "замечания без Gemini (срок истёк)");
  assert.equal(gemini.busy, true, "Gemini всё ещё проверяет раунд 1");
  turn(k, "claude", "исправил");
  await waitFor(() => codex.received.length === 2 && gemini.received.length === 2, "проверка 2 у обоих сразу");
  assert.equal(gemini.interrupted, 1, "поздний ход раунда 1 снят один раз");
  assert.equal(k.state.queued, 0, "материал раунда 2 не ждал в очереди");
  assert.equal(said(events, /^Поздняя проверка Gemini \(проверка 1\) снята: началась проверка 2\.$/).length, 1);
  turn(k, "codex", "Хорошо.\nВЕРДИКТ: ПРИНЯТО");
  geminiTurn(k, gemini, "Хорошо.\nВЕРДИКТ: ПРИНЯТО");
  await waitFor(() => k.state.stage === "accepted", "раунд 2 сведён из собственных ответов");
  assert.equal(said(events, /^Итог проверки 2: Codex — принято, Gemini — принято\.$/).length, 1);
  assert.equal(gemini.interrupted, 1);
  journal.close();
});

test("новая сессия Gemini, пока снимается его поздняя проверка, — материал следующей проверки ей не уходит", async () => {
  // Рецензия 03.10: отправка Gemini после каскадной остановки проверяла
  // только номер пары. Новая сессия во время остановки уже засчитала
  // «не проверял», а материал всё равно уходил — ход и квота впустую.
  const { k, claude, codex, gemini, events, journal } = await pairRoom({ geminiWaitMs: 40 }, 3, { liveGemini: true });
  turn(k, "codex", "Дефект в пороге.\nВЕРДИКТ: ЕСТЬ ЗАМЕЧАНИЯ");
  await waitFor(() => claude.received.length === 2, "замечания без Gemini (срок истёк)");
  assert.equal(gemini.busy, true, "Gemini всё ещё проверяет раунд 1");
  let release;
  const gate = new Promise((r) => (release = r));
  // Остановка процесса идёт не мгновенно (killTree у настоящего адаптера).
  gemini.interrupt = async () => {
    gemini.interrupted += 1;
    gemini.busy = false;
    await gate;
  };
  turn(k, "claude", "исправил");
  await waitFor(() => codex.received.length === 2, "проверка 2 у Codex");
  assert.equal(gemini.interrupted, 1, "поздний ход раунда 1 снимается");
  assert.equal(gemini.received.length, 1, "Gemini ждёт конца остановки");
  await k.newSession("gemini");
  assert.equal(k.state.pair.sides.gemini.reason, "новая сессия Gemini");
  release();
  await sleep(50);
  assert.equal(gemini.received.length, 1, "материал проверки 2 новой сессии не уходит");
  turn(k, "codex", "Хорошо.\nВЕРДИКТ: ПРИНЯТО");
  await waitFor(() => k.state.stage === "accepted", "проверка 2 сведена по Codex");
  assert.equal(said(events, /Поздний ответ Gemini/).length, 0);
  journal.close();
});

// --- Срок Gemini: по вердикту Codex и по признакам жизни (дизайн 03.10) -----
//
// Живой прогон 03.10: Gemini (Flash high) проверял 8,7 мин, ~7 из них — веб.
// Один срок «10 мин после Codex, что бы тот ни сказал» сводил пару без него,
// оставлял процесс работать, а материал следующей проверки ждал в очереди.

test("Codex принял, Gemini работает дольше срока — пару не сводим, его замечания уходят Claude вместе с принятием Codex", async () => {
  // R1: принятие Codex не даёт ложного «Цикл завершён»: срок geminiWaitMs
  // здесь не действует, Gemini ждут, пока он работает.
  const { k, claude, gemini, events, journal } = await pairRoom({ geminiWaitMs: 40 }, 3, { liveGemini: true });
  turn(k, "codex", "Код верен.\nВЕРДИКТ: ПРИНЯТО");
  await sleep(200);
  assert.equal(k.state.stage, "reviewing", "срок после принятия Codex пару не сводит");
  assert.equal(said(events, /Итог проверки/).length, 0);
  assert.equal(gemini.interrupted, 0);
  geminiTurn(k, gemini, "Пробел: сиды не зафиксированы.\nВЕРДИКТ: ЕСТЬ ЗАМЕЧАНИЯ");
  await waitFor(() => claude.received.length === 2, "замечания Gemini у Claude");
  assert.match(claude.received[1].text, /— Codex — код — принято/);
  assert.match(claude.received[1].text, /— Gemini — методология и факты —\nПробел: сиды/);
  assert.equal(k.state.stage, "working");
  assert.equal(said(events, /^Итог проверки 1: Codex — принято, Gemini — есть замечания\.$/).length, 1);
  journal.close();
});

test("Codex принял, автопересылка выключена — поздний Gemini даёт удержание с обоими отзывами, «принято» не наступает", async () => {
  const stages = [];
  const { k, claude, gemini, journal } = await pairRoom({ geminiWaitMs: 40, onState: (s) => stages.push(s.stage) }, 3, { liveGemini: true });
  k.setAuto(false);
  turn(k, "codex", "Код верен.\nВЕРДИКТ: ПРИНЯТО");
  await sleep(200);
  assert.equal(k.state.stage, "reviewing");
  geminiTurn(k, gemini, "Пробел: сиды не зафиксированы.\nВЕРДИКТ: ЕСТЬ ЗАМЕЧАНИЯ");
  await waitFor(() => k.state.stage === "held", "удержание");
  assert.match(k.state.held.reason, /^Автопересылка выключена/);
  assert.ok(!stages.includes("accepted"), "принятия одним Codex не было ни на миг");
  await k.releaseHeld();
  assert.equal(claude.received.length, 2);
  assert.match(claude.received[1].text, /— Codex — код — принято/);
  assert.match(claude.received[1].text, /— Gemini — методология и факты —\nПробел: сиды/);
  journal.close();
});

test("Gemini опоздал, пока замечания Codex удержаны, — его отзыв добавлен к ним и уходит Claude по кнопке", async () => {
  // R7: удержанное сообщение ещё не ушло — поздний отзыв в него входит.
  const { k, claude, gemini, events, journal } = await pairRoom({ geminiWaitMs: 40 }, 3, { liveGemini: true });
  k.setAuto(false);
  turn(k, "codex", "Дефект в пороге.\nВЕРДИКТ: ЕСТЬ ЗАМЕЧАНИЯ");
  await waitFor(() => k.state.stage === "held", "замечания Codex удержаны");
  assert.equal(
    said(events, /^Gemini не уложился в .+ и ещё проверяет: если он закончит, пока замечания ждут вашего решения, его отзыв будет добавлен к ним\.$/).length,
    1,
  );
  geminiTurn(k, gemini, "Пробел: утечка id.\nВЕРДИКТ: ЕСТЬ ЗАМЕЧАНИЯ");
  await waitFor(
    () => said(events, /^Gemini опоздал к проверке 1, но успел до отправки: его отзыв добавлен к удержанным замечаниям\.$/).length === 1,
    "отзыв добавлен к удержанному",
  );
  assert.equal(k.state.stage, "held");
  assert.match(k.state.held.reason, /^Автопересылка выключена/);
  assert.deepEqual(k.state.pair.sides.gemini, { state: "done", verdict: "remarks" });
  await k.releaseHeld();
  assert.equal(claude.received.length, 2);
  assert.match(claude.received[1].text, /— Codex — код —\nДефект в пороге/);
  assert.match(claude.received[1].text, /— Gemini — методология и факты —\nПробел: утечка id/);
  assert.doesNotMatch(claude.received[1].text, /не проверял \(это не замечание/);
  journal.close();
});

test("Gemini опоздал и просит решения, пока замечания удержаны, — причина удержания и вердикт — его", async () => {
  const { k, gemini, events, journal } = await pairRoom({ geminiWaitMs: 40 }, 3, { liveGemini: true });
  k.setAuto(false);
  turn(k, "codex", "Дефект в пороге.\nВЕРДИКТ: ЕСТЬ ЗАМЕЧАНИЯ");
  await waitFor(() => k.state.stage === "held", "замечания Codex удержаны");
  geminiTurn(k, gemini, "Нужен доступ к данным.\nВЕРДИКТ: НУЖНО РЕШЕНИЕ ЧЕЛОВЕКА");
  await waitFor(() => said(events, /^Gemini опоздал к проверке 1, но успел до отправки/).length === 1, "отзыв добавлен");
  assert.match(k.state.held.reason, /^Gemini просит вашего решения/);
  assert.ok(k.state.held.reason.includes("Codex: есть замечания"), k.state.held.reason);
  assert.equal(k.state.verdict, "human");
  journal.close();
});

test("Gemini опоздал с принятием, пока замечания удержаны, — удержанное не меняется, «принято» в ленте", async () => {
  const { k, claude, gemini, events, journal } = await pairRoom({ geminiWaitMs: 40 }, 3, { liveGemini: true });
  k.setAuto(false);
  turn(k, "codex", "Дефект в пороге.\nВЕРДИКТ: ЕСТЬ ЗАМЕЧАНИЯ");
  await waitFor(() => k.state.stage === "held", "замечания Codex удержаны");
  geminiTurn(k, gemini, "Всё в порядке.\nВЕРДИКТ: ПРИНЯТО");
  await waitFor(() => said(events, /^Gemini опоздал к проверке 1: принято\.$/).length === 1, "строка о позднем принятии");
  assert.equal(k.state.verdict, "remarks");
  await k.releaseHeld();
  assert.match(claude.received[1].text, /— Codex — код —\nДефект в пороге/);
  journal.close();
});

test("Gemini опоздал, когда Claude уже доработал и следующая проверка удержана, — лента не говорит, что Claude работает", async () => {
  // Рецензия 03.10: строка «Claude … уже работает по замечаниям Codex»
  // выходила и тогда, когда Claude закончил, а проверку 2 удержал предел.
  const { k, claude, codex, gemini, events, journal } = await pairRoom({ geminiWaitMs: 40 }, 1, { liveGemini: true });
  turn(k, "codex", "Дефект в пороге.\nВЕРДИКТ: ЕСТЬ ЗАМЕЧАНИЯ");
  await waitFor(() => claude.received.length === 2, "замечания Codex у Claude");
  turn(k, "claude", "исправил");
  await waitFor(() => k.state.stage === "held", "проверка 2 удержана пределом");
  assert.match(k.state.held.reason, /^Предел проверок \(1\) достигнут/);
  assert.equal(gemini.busy, true, "Gemini всё ещё проверяет раунд 1");
  geminiTurn(k, gemini, "Пробел: утечка id.\nВЕРДИКТ: ЕСТЬ ЗАМЕЧАНИЯ");
  await waitFor(() => said(events, /Gemini опоздал/).length === 1, "поздний отзыв назван в ленте");
  assert.equal(
    said(
      events,
      /^Gemini опоздал к проверке 1: есть замечания \(текст выше\)\. Claude их не получил — он уже закончил работу по замечаниям Codex, и обмен ждёт вашего решения; если отправите проверку 2, Gemini получит её вместе с Codex\.$/,
    ).length,
    1,
  );
  assert.equal(said(events, /уже работает/).length, 0);
  assert.equal(k.state.stage, "held");
  assert.equal(claude.received.length, 2, "поздний ответ Claude не пересылается");
  await k.releaseHeld();
  await waitFor(() => codex.received.length === 2 && gemini.received.length === 2, "проверка 2 у обоих");
  journal.close();
});

test("срок молчания Gemini — 6 мин, и настройки с документацией говорят то же (замеры 04.10)", () => {
  // Повтор проверки Trading 04.10: наибольшее молчание вывода — 34,6 с у
  // Flash high и 23,4 с у Pro high; верхняя оценка по журналу 03.10 — 105,7 с
  // без событий, втрое — 5,3 мин. Прежние 10 мин брались с запасом на
  // незамеренное рассуждение Pro high.
  assert.equal(GEMINI_SILENCE_MS, 6 * 60_000);
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));
  const wait = manifest.contributes.configuration.properties["agentPanel.geminiWaitMinutes"].description;
  assert.match(wait, /: 6 мин молчания или 45 мин/);
  for (const file of ["package.json", "README.md", "docs/устройство.md"]) {
    assert.doesNotMatch(readFileSync(file, "utf8"), /10 мин[а-я]* (молчания|не подававший)|молчания Gemini \(10|замолчал на 10/, file);
  }
});

test("Gemini замолчал после ответа Codex — процесс остановлен, итог по Codex, поздний конец хода не засчитан", async () => {
  const { k, claude, gemini, events, journal } = await pairRoom({ geminiSilenceMs: 60 }, 3, { liveGemini: true });
  turn(k, "codex", "Дефект.\nВЕРДИКТ: ЕСТЬ ЗАМЕЧАНИЯ");
  await waitFor(() => claude.received.length === 2, "замечания Codex у Claude после молчания Gemini");
  assert.equal(gemini.interrupted, 1);
  assert.match(k.state.pair.sides.gemini.reason, /^замолчал на .+ — остановлен$/);
  assert.equal(
    said(events, /^Gemini .+ не подавал признаков жизни \(последнее действие в \d\d:\d\d\) — процесс остановлен\. Итог проверки 1 — по Codex\.$/).length,
    1,
  );
  assert.equal(said(events, /^Gemini не проверял: /).length, 0);
  // Конец снятого хода не приходит у настоящего адаптера; и если придёт —
  // это не проверка 1.
  turn(k, "gemini", "Поздно.\nВЕРДИКТ: ЕСТЬ ЗАМЕЧАНИЯ");
  await sleep(30);
  assert.equal(said(events, /Поздний ответ Gemini|Gemini опоздал/).length, 0);
  assert.equal(claude.received.length, 2);
  journal.close();
});

test("признаки жизни Gemini — вывод процесса или его события — держат ожидание дольше срока молчания", async () => {
  for (const via of ["вывод процесса", "события"]) {
    const { k, claude, gemini, journal } = await pairRoom({ geminiSilenceMs: 80 }, 3, { liveGemini: true });
    turn(k, "codex", "Дефект.\nВЕРДИКТ: ЕСТЬ ЗАМЕЧАНИЯ");
    const timer = setInterval(() => {
      if (via === "вывод процесса") gemini.lastOutputAt = Date.now();
      else k.handle(event("gemini", "tool_running", { tool: "read_url_content", callId: "c1" }));
    }, 15);
    await sleep(400);
    clearInterval(timer);
    assert.equal(gemini.interrupted, 0, `${via}: живой Gemini не останавливается`);
    assert.equal(k.state.stage, "reviewing", via);
    geminiTurn(k, gemini, "Пробел.\nВЕРДИКТ: ЕСТЬ ЗАМЕЧАНИЯ");
    await waitFor(() => claude.received.length === 2, `${via}: сведение с Gemini`);
    assert.match(claude.received[1].text, /— Gemini — методология и факты —\nПробел\./);
    journal.close();
  }
});

test("молчание Gemini считается от ответа Codex, а не от его последнего действия до него", async () => {
  const { k, gemini, journal } = await pairRoom({ geminiSilenceMs: 100 }, 3, { liveGemini: true });
  gemini.lastOutputAt = Date.now();
  k.handle(event("gemini", "tool_running", { tool: "search_web", callId: "c1" }));
  await sleep(300);
  const answered = Date.now();
  turn(k, "codex", "Дефект.\nВЕРДИКТ: ЕСТЬ ЗАМЕЧАНИЯ");
  await sleep(40);
  assert.equal(gemini.interrupted, 0, "молчание до ответа Codex не в счёт");
  await waitFor(() => gemini.interrupted === 1, "срок молчания от ответа Codex");
  assert.ok(Date.now() - answered >= 90, "не раньше срока молчания после ответа Codex");
  journal.close();
});

test("Codex принял, Gemini жив, но не кончает — предел безопасности останавливает его, итог по Codex", async () => {
  const { k, gemini, events, journal } = await pairRoom({ geminiWaitMs: 40, geminiSilenceMs: 80, geminiSafetyMs: 250 }, 3, { liveGemini: true });
  const timer = setInterval(() => (gemini.lastOutputAt = Date.now()), 15);
  try {
    turn(k, "codex", "Код верен.\nВЕРДИКТ: ПРИНЯТО");
    await sleep(120);
    assert.equal(k.state.stage, "reviewing", "срок geminiWaitMs при принятии Codex не действует");
    await waitFor(() => k.state.stage === "accepted", "принятие по Codex после предела");
  } finally {
    clearInterval(timer);
  }
  assert.equal(gemini.interrupted, 1);
  assert.match(k.state.pair.sides.gemini.reason, /^не закончил за .+ после ответа Codex — остановлен$/);
  assert.equal(said(events, /^Gemini не закончил за .+ после ответа Codex — процесс остановлен\. Итог проверки 1 — по Codex\.$/).length, 1);
  assert.equal(said(events, /^Codex принял работу \(Gemini не проверял\)\. Цикл завершён\./).length, 1);
  journal.close();
});

test("Gemini занят прямым вопросом — не прерывается; по сроку «был занят другим ходом», материал проверки снят из очереди", async () => {
  const { k, codex, gemini, events, journal } = room(3, { geminiSafetyMs: 80, geminiSilenceMs: 30 }, { withGemini: true, liveGemini: true });
  await k.fromHuman("какой бейзлайн взять?", "gemini");
  assert.equal(gemini.received.length, 1);
  await k.fromHuman("подобрать порог", "review");
  turn(k, "claude", "порог 0.4");
  await waitFor(() => codex.received.length === 1, "проверка у Codex");
  assert.equal(k.state.queued, 1, "проверка Gemini ждёт конца прямого вопроса");
  turn(k, "codex", "Код верен.\nВЕРДИКТ: ПРИНЯТО");
  await waitFor(() => k.state.stage === "accepted", "итог по Codex после срока");
  assert.equal(gemini.interrupted, 0, "прямой вопрос человека панель не снимает, молчание чужого хода не в счёт");
  assert.equal(k.state.queued, 0, "устаревшая проверка снята из очереди сразу");
  assert.equal(k.state.pair.sides.gemini.reason, "был занят другим ходом — материал проверки 1 не дошёл");
  assert.equal(said(events, /^Gemini был занят другим ходом и проверку 1 не начал\. Итог — по Codex\.$/).length, 1);
  geminiTurn(k, gemini, "логистическая регрессия");
  await sleep(30);
  assert.equal(gemini.received.length, 1, "проверка ему уже не уходит");
  assert.equal(said(events, /Поздний ответ|опоздал/).length, 0, "ответ на прямой вопрос — прямой");
  journal.close();
});

test("пределы ожидания Gemini — от ответа Codex: материал, дошедший позже, срок не сдвигает", async () => {
  // Рецензия 03.10: срок от передачи материала растягивал обещанные 45 минут
  // почти до 90, если материал ждал за прямым вопросом. Молчание по-прежнему
  // считается от передачи (тест ниже), а пределы — от ответа Codex.
  const { k, codex, gemini, journal } = room(3, { geminiSafetyMs: 60_000 }, { withGemini: true, liveGemini: true });
  await k.fromHuman("какой бейзлайн взять?", "gemini");
  await k.fromHuman("подобрать порог", "review");
  turn(k, "claude", "порог 0.4");
  await waitFor(() => codex.received.length === 1, "проверка у Codex");
  turn(k, "codex", "Код верен.\nВЕРДИКТ: ПРИНЯТО");
  const first = k.state.pair.waitUntil;
  assert.equal(typeof first, "number");
  await sleep(60);
  geminiTurn(k, gemini, "логистическая регрессия");
  await waitFor(() => gemini.received.length === 2, "материал проверки ушёл освободившемуся Gemini");
  assert.equal(k.state.pair.waitUntil, first, "срок не сдвинут передачей материала");
  journal.close();
});

test("замечания Codex: Claude ждёт Gemini не дольше срока после ответа Codex, даже если материал дошёл до Gemini позже", async () => {
  const { k, claude, codex, gemini, journal } = room(3, { geminiWaitMs: 200, geminiSilenceMs: 5000 }, { withGemini: true, liveGemini: true });
  await k.fromHuman("какой бейзлайн взять?", "gemini");
  await k.fromHuman("подобрать порог", "review");
  turn(k, "claude", "порог 0.4");
  await waitFor(() => codex.received.length === 1, "проверка у Codex");
  const answered = Date.now();
  turn(k, "codex", "Дефект в пороге.\nВЕРДИКТ: ЕСТЬ ЗАМЕЧАНИЯ");
  await sleep(120);
  geminiTurn(k, gemini, "логистическая регрессия");
  await waitFor(() => gemini.received.length === 2, "материал проверки ушёл Gemini позже ответа Codex");
  await waitFor(() => claude.received.length === 2, "замечания Codex у Claude по сроку");
  const waited = Date.now() - answered;
  // Срок от передачи дал бы ~320 мс (120 + 200).
  assert.ok(waited < 290, `не дольше срока после ответа Codex (с поправкой на опрос): ${waited} мс`);
  assert.equal(gemini.interrupted, 0, "Gemini по сроку при замечаниях не снимается");
  journal.close();
});

test("опоздавший Gemini (срок при замечаниях Codex истёк) замолчал — процесс остановлен, пара не сводится заново, прямой вопрос уходит", async () => {
  // Рецензия 03.10: после срока при замечаниях часы очищались, и зависший
  // опоздавший Gemini держал очередь без срока.
  const { k, claude, gemini, events, journal } = await pairRoom({ geminiWaitMs: 40, geminiSilenceMs: 150 }, 3, { liveGemini: true });
  turn(k, "codex", "Дефект в пороге.\nВЕРДИКТ: ЕСТЬ ЗАМЕЧАНИЯ");
  await waitFor(() => claude.received.length === 2, "замечания Codex у Claude по сроку");
  assert.equal(gemini.interrupted, 0, "по сроку при замечаниях Gemini не снимается");
  await k.fromHuman("какой бейзлайн взять?", "gemini");
  assert.equal(gemini.received.length, 1, "прямой вопрос ждёт опоздавшую проверку");
  await waitFor(() => gemini.interrupted === 1, "молчание опоздавшего Gemini замечено");
  assert.equal(
    said(events, /^Gemini, опоздавший к проверке 1, .+ не подавал признаков жизни \(последнее действие в \d\d:\d\d\) — процесс остановлен; его отзыва не будет\.$/).length,
    1,
  );
  await waitFor(() => gemini.received.length === 2, "прямой вопрос ушёл Gemini");
  assert.match(gemini.received[1].text, /какой бейзлайн/);
  assert.equal(claude.received.length, 2, "пара не сводится заново");
  assert.equal(said(events, /^Итог проверки 1/).length, 1);
  turn(k, "gemini", "логистическая регрессия");
  await sleep(30);
  assert.equal(said(events, /опоздал к проверке|Поздний ответ/).length, 0, "ответ на прямой вопрос — прямой");
  journal.close();
});

test("опоздавший Gemini жив, но не кончает — предел безопасности от ответа Codex останавливает его", async () => {
  const { k, claude, gemini, events, journal } = await pairRoom(
    { geminiWaitMs: 40, geminiSilenceMs: 80, geminiSafetyMs: 300 },
    3,
    { liveGemini: true },
  );
  const timer = setInterval(() => (gemini.lastOutputAt = Date.now()), 15);
  let answered;
  try {
    answered = Date.now();
    turn(k, "codex", "Дефект в пороге.\nВЕРДИКТ: ЕСТЬ ЗАМЕЧАНИЯ");
    await waitFor(() => claude.received.length === 2, "замечания Codex у Claude по сроку");
    await sleep(120);
    assert.equal(gemini.interrupted, 0, "живой опоздавший Gemini работает дальше");
    await waitFor(() => gemini.interrupted === 1, "предел безопасности");
  } finally {
    clearInterval(timer);
  }
  assert.ok(Date.now() - answered >= 280, "не раньше предела после ответа Codex");
  assert.equal(
    said(events, /^Gemini, опоздавший к проверке 1, не закончил за .+ после ответа Codex — процесс остановлен; его отзыва не будет\.$/).length,
    1,
  );
  assert.equal(claude.received.length, 2, "пара не сводится заново");
  journal.close();
});

test("сторож опоздавшего Gemini действует, пока сведение ждёт снимок версии, — по молчанию и по пределу", async () => {
  // Рецензия 03.10 (проверка 2): сторож ставился после конца сведения, а
  // сведение ждёт снимок и отправку Claude — всё это время опоздавший Gemini
  // был без контроля.
  for (const { name, options, alive, reason, note } of [
    {
      name: "молчание",
      options: { geminiWaitMs: 40, geminiSilenceMs: 120 },
      alive: false,
      reason: /^замолчал на .+ — остановлен$/,
      note: /^Gemini .+ не подавал признаков жизни \(последнее действие в \d\d:\d\d\) — процесс остановлен\. Итог проверки 1 — по Codex\.$/,
    },
    {
      name: "предел",
      options: { geminiWaitMs: 40, geminiSilenceMs: 80, geminiSafetyMs: 200 },
      alive: true,
      reason: /^не закончил за .+ после ответа Codex — остановлен$/,
      note: /^Gemini не закончил за .+ после ответа Codex — процесс остановлен\. Итог проверки 1 — по Codex\.$/,
    },
  ]) {
    let armed = false;
    let blocked = 0;
    let release;
    const gate = new Promise((r) => (release = r));
    const snapshot = async (cwd) => {
      if (armed) {
        blocked += 1;
        await gate;
      }
      return takeSnapshot(cwd);
    };
    const { k, claude, gemini, events, journal } = await pairRoom({ ...options, snapshot }, 3, { liveGemini: true });
    const timer = alive ? setInterval(() => (gemini.lastOutputAt = Date.now()), 15) : undefined;
    try {
      turn(k, "codex", "Дефект в пороге.\nВЕРДИКТ: ЕСТЬ ЗАМЕЧАНИЯ");
      armed = true;
      await waitFor(() => blocked > 0, `${name}: сведение ждёт снимок`);
      await waitFor(() => gemini.interrupted === 1, `${name}: сторож сработал во время снимка`);
      assert.equal(claude.received.length, 1, `${name}: сведение ещё не закончено`);
    } finally {
      clearInterval(timer);
    }
    armed = false;
    release();
    await waitFor(() => claude.received.length === 2, `${name}: замечания Codex у Claude`);
    assert.match(k.state.pair.sides.gemini.reason, reason, name);
    assert.equal(said(events, note).length, 1, `${name}: итог объясняет остановку`);
    assert.equal(said(events, /ещё проверяет|опоздавший/).length, 0, `${name}: не «ещё проверяет» о снятом`);
    assert.match(claude.received[1].text, /— Gemini — методология и факты — не проверял/);
    journal.close();
  }
});

test("предел безопасности действует и в первом ожидании, если срок при замечаниях длиннее его", async () => {
  const { k, claude, gemini, events, journal } = await pairRoom(
    { geminiWaitMs: 600, geminiSilenceMs: 80, geminiSafetyMs: 150 },
    3,
    { liveGemini: true },
  );
  const timer = setInterval(() => (gemini.lastOutputAt = Date.now()), 15);
  let answered;
  try {
    answered = Date.now();
    turn(k, "codex", "Дефект в пороге.\nВЕРДИКТ: ЕСТЬ ЗАМЕЧАНИЯ");
    await waitFor(() => gemini.interrupted === 1, "предел безопасности до срока ожидания");
  } finally {
    clearInterval(timer);
  }
  const stopped = Date.now() - answered;
  assert.ok(stopped >= 140 && stopped < 500, `по пределу, а не по сроку: ${stopped} мс`);
  await waitFor(() => claude.received.length === 2, "замечания Codex у Claude");
  assert.match(k.state.pair.sides.gemini.reason, /^не закончил за .+ после ответа Codex — остановлен$/);
  assert.equal(said(events, /^Gemini не закончил за .+ после ответа Codex — процесс остановлен\. Итог проверки 1 — по Codex\.$/).length, 1);
  journal.close();
});

test("поздний отзыв Gemini, пришедший, пока сводится итог, входит в замечания и общий вердикт", async () => {
  // Рецензия 03.10: сведение выбирало исходы до снимка версии; отзыв,
  // пришедший за время снимка, оставался вне замечаний, а лента говорила,
  // что Claude уже работает.
  for (const { auto, late, check } of [
    {
      auto: true,
      late: "Пробел: утечка id.\nВЕРДИКТ: ЕСТЬ ЗАМЕЧАНИЯ",
      check: async ({ k, claude }) => {
        await waitFor(() => claude.received.length === 2, "замечания у Claude");
        assert.match(claude.received[1].text, /— Codex — код —\nДефект в пороге/);
        assert.match(claude.received[1].text, /— Gemini — методология и факты —\nПробел: утечка id/);
        assert.equal(k.state.verdict, "remarks");
      },
    },
    {
      auto: false,
      late: "Нужен доступ к данным.\nВЕРДИКТ: НУЖНО РЕШЕНИЕ ЧЕЛОВЕКА",
      check: async ({ k, claude }) => {
        await waitFor(() => k.state.stage === "held", "удержано");
        assert.match(k.state.held.reason, /^Gemini просит вашего решения/);
        assert.equal(k.state.verdict, "human");
        await k.releaseHeld();
        assert.match(claude.received[1].text, /— Gemini — методология и факты —\nНужен доступ к данным/);
      },
    },
  ]) {
    let armed = false;
    let blocked = 0;
    let release;
    const gate = new Promise((r) => (release = r));
    const snapshot = async (cwd) => {
      if (armed) {
        blocked += 1;
        await gate;
      }
      return takeSnapshot(cwd);
    };
    const r = await pairRoom({ geminiWaitMs: 40, snapshot }, 3, { liveGemini: true });
    r.k.setAuto(auto);
    turn(r.k, "codex", "Дефект в пороге.\nВЕРДИКТ: ЕСТЬ ЗАМЕЧАНИЯ");
    armed = true;
    await waitFor(() => blocked > 0, "сведение ждёт снимок версии");
    geminiTurn(r.k, r.gemini, late);
    await waitFor(() => r.k.state.pair.sides.gemini?.state === "done", "поздний отзыв принят");
    armed = false;
    release();
    await check(r);
    assert.equal(said(r.events, /Claude их не получил|уже работает/).length, 0, `auto=${auto}`);
    assert.equal(said(r.events, /^Итог проверки 1: Codex — есть замечания, Gemini — (есть замечания|нужно решение человека)\.$/).length, 1);
    r.journal.close();
  }
});

test("материал дошёл до Gemini после ответа Codex — молчание считается от передачи, а не ждёт прежнего срока", async () => {
  // Рецензия 03.10: часы, поставленные при ответе Codex на чужой ход
  // (прямой вопрос), не переставлялись при передаче материала — зависший
  // после неё Gemini снимался только по пределу (45 мин вместо 10).
  const { k, codex, gemini, events, journal } = room(3, { geminiSilenceMs: 60, geminiSafetyMs: 3000 }, { withGemini: true, liveGemini: true });
  await k.fromHuman("какой бейзлайн взять?", "gemini");
  await k.fromHuman("подобрать порог", "review");
  turn(k, "claude", "порог 0.4");
  await waitFor(() => codex.received.length === 1, "проверка у Codex");
  turn(k, "codex", "Код верен.\nВЕРДИКТ: ПРИНЯТО");
  await sleep(30);
  geminiTurn(k, gemini, "логистическая регрессия");
  await waitFor(() => gemini.received.length === 2, "материал проверки ушёл освободившемуся Gemini");
  const handed = Date.now();
  await waitFor(() => gemini.interrupted === 1, "молчание после передачи замечено", 1000);
  const after = Date.now() - handed;
  assert.ok(after >= 30, `не раньше срока молчания после передачи (с поправкой на опрос): ${after} мс`);
  assert.match(k.state.pair.sides.gemini.reason, /^замолчал на .+ — остановлен$/);
  await waitFor(() => k.state.stage === "accepted", "итог по Codex");
  assert.equal(said(events, /^Codex принял работу \(Gemini не проверял\)\. Цикл завершён\./).length, 1);
  journal.close();
});

test("новая задача снимает идущую проверку Gemini, а прямой вопрос человека не снимается никогда", async () => {
  {
    const { k, gemini, events, journal } = await pairRoom({}, 3, { liveGemini: true });
    await k.fromHuman("новая задача", "review");
    assert.equal(gemini.interrupted, 1);
    assert.equal(said(events, /^Поздняя проверка Gemini \(проверка 1\) снята: новая задача\.$/).length, 1);
    journal.close();
  }
  {
    const { k, claude, codex, gemini, events, journal } = room(3, {}, { withGemini: true, liveGemini: true });
    await k.fromHuman("какой бейзлайн взять?", "gemini");
    await k.fromHuman("задача", "review");
    turn(k, "claude", "сделал");
    await waitFor(() => codex.received.length === 1, "проверка у Codex");
    assert.equal(k.state.queued, 1, "проверка Gemini ждёт конца прямого вопроса");
    await k.fromHuman("ещё задача", "review");
    await waitFor(() => claude.received.length === 2, "новая задача у Claude");
    assert.equal(gemini.interrupted, 0, "прямой вопрос не снимают ни проверка, ни новая задача");
    assert.equal(said(events, /Поздняя проверка Gemini/).length, 0);
    journal.close();
  }
});

test("после того как панель сняла ход Gemini, следующее его сообщение говорит, что прошлый ход прерван, — и только оно", async () => {
  const { k, gemini, journal } = await pairRoom({ geminiSilenceMs: 40 }, 3, { liveGemini: true });
  turn(k, "codex", "Дефект.\nВЕРДИКТ: ЕСТЬ ЗАМЕЧАНИЯ");
  await waitFor(() => gemini.interrupted === 1, "снят по молчанию");
  await k.fromHuman("что с утечкой?", "gemini");
  assert.equal(gemini.received[1].text, "[прошлый ход прерван панелью — его материал устарел, проверяй только этот]\nчто с утечкой?");
  geminiTurn(k, gemini, "ответ");
  await k.fromHuman("ещё вопрос", "gemini");
  assert.equal(gemini.received[2].text, "ещё вопрос");
  journal.close();
});

test("«Прервать» при занятом Gemini — следующее сообщение с пометкой; новая сессия пометку снимает", async () => {
  {
    const { k, gemini, journal } = room(3, {}, { withGemini: true, liveGemini: true });
    await k.fromHuman("первый вопрос", "gemini");
    await k.interruptAll();
    await k.fromHuman("второй вопрос", "gemini");
    assert.match(gemini.received[1].text, /^\[прошлый ход прерван панелью/);
    journal.close();
  }
  {
    const { k, gemini, journal } = room(3, {}, { withGemini: true, liveGemini: true });
    await k.fromHuman("первый вопрос", "gemini");
    await k.interruptAll();
    await k.newSession("gemini");
    await k.fromHuman("с чистого листа", "gemini");
    assert.equal(gemini.received[1].text, "с чистого листа");
    journal.close();
  }
});

test("расход снятого панелью хода Gemini входит в расход задачи", async () => {
  const { k, gemini, journal } = await pairRoom({ geminiSilenceMs: 40 }, 3, { liveGemini: true });
  gemini.partial = { input: 500, cached: 100, output: 7 };
  turn(k, "codex", "Дефект.\nВЕРДИКТ: ЕСТЬ ЗАМЕЧАНИЯ");
  await waitFor(() => gemini.interrupted === 1, "снят по молчанию");
  assert.deepEqual(k.state.usage.task.gemini, { input: 500, cached: 100, output: 7 });
  journal.close();
});

test("часы Gemini не переживают сведения, «Остановить», «Прервать» и новую задачу", async () => {
  const fast = { geminiWaitMs: 60, geminiSilenceMs: 40, geminiSafetyMs: 60 };
  {
    const { k, gemini, events, journal } = await pairRoom(fast, 3, { liveGemini: true });
    turn(k, "codex", "Код верен.\nВЕРДИКТ: ПРИНЯТО");
    geminiTurn(k, gemini, "Всё в порядке.\nВЕРДИКТ: ПРИНЯТО");
    await waitFor(() => k.state.stage === "accepted", "сведение");
    const lines = systemEvents(events).length;
    await sleep(200);
    assert.equal(gemini.interrupted, 0, "после сведения часы не останавливают Gemini");
    assert.equal(systemEvents(events).length, lines, "после сведения новых строк нет");
    journal.close();
  }
  for (const action of ["stopAll", "interruptAll", "новая задача"]) {
    const { k, gemini, events, journal } = await pairRoom(fast, 3, { liveGemini: true });
    turn(k, "codex", "Дефект.\nВЕРДИКТ: ЕСТЬ ЗАМЕЧАНИЯ");
    if (action === "новая задача") await k.fromHuman("новая задача", "review");
    else await k[action]();
    const interrupted = gemini.interrupted;
    const lines = systemEvents(events).length;
    await sleep(200);
    assert.equal(gemini.interrupted, interrupted, `${action}: часы прежней пары не останавливают Gemini`);
    assert.equal(systemEvents(events).length, lines, `${action}: новых строк нет`);
    assert.equal(said(events, /Итог проверки 1|замолчал|не уложился/).length, 0, action);
    journal.close();
  }
});

test("поздний ответ Gemini засчитывается один раз; следующий его ответ — прямой; после новой сессии — не поздний", async () => {
  {
    // Цель проверки 1 забрал первый поздний ответ, и второй конец хода
    // приходит без неё — как ответ на прямой вопрос. До ветки позднего
    // отзыва он не доходит, поэтому сброс pair.overdue в #reviewFinished
    // этим тестом не закреплён: второй цели проверки того же номера при
    // настоящей работе не бывает, сброс — страховка (рецензия 03.10).
    const { k, claude, gemini, events, journal } = await pairRoom({ geminiWaitMs: 40 }, 3, { liveGemini: true });
    turn(k, "codex", "Дефект.\nВЕРДИКТ: ЕСТЬ ЗАМЕЧАНИЯ");
    await waitFor(() => claude.received.length === 2, "замечания Codex");
    geminiTurn(k, gemini, "Пробел.\nВЕРДИКТ: ЕСТЬ ЗАМЕЧАНИЯ");
    await waitFor(() => said(events, /Gemini опоздал к проверке 1/).length === 1, "первый поздний ответ");
    const lines = systemEvents(events).length;
    geminiTurn(k, gemini, "Ещё раз.\nВЕРДИКТ: ПРИНЯТО");
    await sleep(30);
    assert.equal(systemEvents(events).length, lines, "второй ответ — прямой: ни «опоздал», ни «Поздний ответ», ни других строк");
    assert.deepEqual(k.state.pair.sides.gemini, { state: "done", verdict: "remarks" }, "итог Gemini за проверку 1 не меняется");
    assert.deepEqual(k.state.trail.find((sh) => sh.who === "gemini" && sh.round === 1), { who: "gemini", round: 1, mark: "!" });
    assert.equal(claude.received.length, 2);
    journal.close();
  }
  {
    const { k, claude, gemini, events, journal } = await pairRoom({ geminiWaitMs: 40 }, 3, { liveGemini: true });
    turn(k, "codex", "Дефект.\nВЕРДИКТ: ЕСТЬ ЗАМЕЧАНИЯ");
    await waitFor(() => claude.received.length === 2, "замечания Codex");
    await k.newSession("gemini");
    assert.equal(gemini.forgotten, 1);
    geminiTurn(k, gemini, "Пробел.\nВЕРДИКТ: ЕСТЬ ЗАМЕЧАНИЯ");
    await sleep(30);
    assert.equal(said(events, /Gemini опоздал|Поздний ответ Gemini/).length, 0);
    journal.close();
  }
});

test("M6: после новой сессии Gemini его прямой ответ — прямой, не «поздний ответ» проверки; следующая проверка засчитана своему номеру", async () => {
  const { k, claude, codex, gemini, events, journal } = await pairRoom({}, 3, { liveGemini: true });
  await k.newSession("gemini");
  assert.equal(gemini.forgotten, 1);
  await k.fromHuman("что думаешь про порог?", "gemini");
  assert.equal(gemini.received.length, 2, "новая сессия свободна — прямой вопрос ушёл сразу");
  gemini.busy = false;
  k.handle(event("gemini", "turn_completed", { incomplete: "пустой ответ" }));
  await waitFor(() => said(events, /^Gemini не ответил: пустой ответ\.$/).length === 1, "пустой прямой ответ назван");
  assert.equal(said(events, /Поздний ответ Gemini/).length, 0);
  turn(k, "codex", "Дефект.\nВЕРДИКТ: ЕСТЬ ЗАМЕЧАНИЯ");
  await waitFor(() => claude.received.length === 2, "замечания Codex");
  turn(k, "claude", "исправил");
  await waitFor(() => codex.received.length === 2 && gemini.received.length === 3, "проверка 2 у обоих");
  geminiTurn(k, gemini, "Пробел.\nВЕРДИКТ: ЕСТЬ ЗАМЕЧАНИЯ");
  turn(k, "codex", "Хорошо.\nВЕРДИКТ: ПРИНЯТО");
  await waitFor(() => claude.received.length === 3, "замечания проверки 2");
  assert.equal(said(events, /^Итог проверки 2: Codex — принято, Gemini — есть замечания\.$/).length, 1);
  journal.close();
});

test("состояние пары: срок ожидания Gemini есть, только пока Codex ответил, а Gemini ещё проверяет", async () => {
  const { k, gemini, journal } = await pairRoom({ geminiWaitMs: 60_000 }, 3, { liveGemini: true });
  assert.ok(!("waitUntil" in k.state.pair), "оба проверяют — срока нет");
  const before = Date.now();
  turn(k, "codex", "Дефект.\nВЕРДИКТ: ЕСТЬ ЗАМЕЧАНИЯ");
  const after = Date.now();
  const until = k.state.pair.waitUntil;
  assert.ok(until >= before + 60_000 && until <= after + 60_000, `срок — ответ Codex + geminiWaitMs: ${until - before}`);
  geminiTurn(k, gemini, "Всё в порядке.\nВЕРДИКТ: ПРИНЯТО");
  await waitFor(() => k.state.stage === "working", "сведение");
  assert.ok(!("waitUntil" in k.state.pair), "Gemini ответил — срока нет");
  journal.close();
});

// ---------------------------------------------------------------------------
// Стоп-сигнал на командах Codex (спецификация 05.10, ступень 2): команда
// рецензента с запрещённым фрагментом пути прерывает его ход проверки.
// ---------------------------------------------------------------------------

/** Начало команды Codex, как его выдаёт адаптер: raw — сам элемент commandExecution. */
function codexCommand(command, id = "cmd-1") {
  return event("codex", "tool_call", {
    tool: "commandExecution",
    callId: id,
    text: JSON.stringify({ type: "commandExecution", id, command }),
    raw: { type: "commandExecution", id, command, status: "inProgress" },
  });
}

const STOP_LINE = /^Codex обратился к запрещённому пути «data\/» — проверка остановлена, решите, как продолжить\.$/;

test("стоп-сигнал: команда Codex с запрещённым путём — ход прерван, проверка остановлена, поздний конец хода ничего не меняет", async () => {
  const { k, claude, codex, events, journal } = await pairRoom({ forbidden: ["data/", ".env"] });
  // Обычная команда чтения — не повод.
  k.handle(codexCommand("rg -n порог src", "cmd-0"));
  assert.equal(codex.interrupted, 0);
  assert.equal(k.state.stage, "reviewing");
  // «\» и «/» — одно и то же: data\x.parquet — это data/.
  k.handle(codexCommand("python -c \"open('data\\\\x.parquet')\""));
  assert.equal(codex.interrupted, 1, "ход Codex прерван сразу");
  assert.equal(k.state.stage, "stopped");
  assert.equal(k.state.pair, undefined, "пара снята");
  assert.equal(said(events, STOP_LINE).length, 1);
  // Заглушка, в отличие от адаптера (codex.ts, #interrupted), поздний конец
  // прерванного хода пропускает: он не должен ни свести, ни ожить.
  const lines = systemEvents(events).length;
  turn(k, "codex", "Код верен.\nВЕРДИКТ: ПРИНЯТО");
  await sleep(30);
  assert.equal(k.state.stage, "stopped");
  assert.equal(systemEvents(events).length, lines, "ни «Поздний ответ», ни итога проверки");
  assert.equal(claude.received.length, 1);
  journal.close();
});

test("стоп-сигнал: прерванный ход Codex не оставляет цели — его ответ в следующей задаче засчитан ей", async () => {
  // Адаптер глотает поздний конец прерванного хода: если цель проверки
  // осталась бы, следующий ход Codex взял бы её и стал «поздним» (Review Focus 1).
  const { k, codex, gemini, events, journal } = await pairRoom({ forbidden: ["data/"] });
  k.handle(event("codex", "message", { text: "Смотрю данные." }));
  k.handle(codexCommand("Get-Content DATA\\prices.csv"));
  assert.equal(k.state.stage, "stopped", "регистр не спасает");
  await k.fromHuman("подобрать порог заново", "review");
  turn(k, "claude", "порог 0.5, F1 на валидации 0.72");
  await waitFor(() => codex.received.length === 2 && gemini.received.length === 2, "проверка новой задачи у обоих");
  turn(k, "codex", "Код верен.\nВЕРДИКТ: ПРИНЯТО");
  geminiTurn(k, gemini, "Всё в порядке.\nВЕРДИКТ: ПРИНЯТО");
  await waitFor(() => k.state.stage === "accepted", "принятие новой задачи");
  assert.equal(said(events, /Поздний ответ/).length, 0);
  assert.equal(said(events, /^Итог проверки 1: Codex — принято, Gemini — принято\.$/).length, 1);
  journal.close();
});

test("стоп-сигнал: прямой вопрос Codex не прерывается — только предупреждение в ленте", async () => {
  const { k, codex, events, journal } = room(3, { forbidden: ["data/", ".env"] });
  await k.fromHuman("что лежит в настройках?", "codex");
  assert.equal(codex.received.length, 1);
  k.handle(codexCommand("Get-Content .ENV"));
  assert.equal(codex.interrupted, 0);
  assert.equal(said(events, /^Codex обратился к запрещённому пути «\.env» вне проверки — ход не прерван\.$/).length, 1);
  turn(k, "codex", "Там ключи.");
  await sleep(30);
  assert.equal(said(events, /Поздний ответ|проверка остановлена/).length, 0);
  assert.notEqual(k.state.stage, "stopped");
  journal.close();
});

test("стоп-сигнал на адаптере Codex (фальшивка): ход прерван, поздний конец проглочен, цикл не висит в «проверяют», следующая проверка засчитана", async () => {
  // Review Focus 1: настоящий адаптер конец прерванного хода не выдаёт —
  // цель, буфер и пару координатор снимает сам.
  const catalog = mkdtempSync(join(tmpdir(), "panel-"));
  const journal = new Journal(join(catalog, "j.sqlite"));
  journal.ensureRoom("r", catalog);
  const claude = new Stub("claude");
  const events = [];
  let k;
  const codex = new CodexAdapter({ command: "node", commandArgs: [FAKE_CODEX], cwd: catalog }, (e) => k.handle(e));
  k = new Coordinator(claude, codex, journal, {
    room: "r",
    cwd: catalog,
    maxAutoRounds: 3,
    onEvent: (e) => events.push(e),
    forbidden: ["data/", "data\\", ".env"],
  });
  try {
    await k.fromHuman("подобрать порог классификатора", "review");
    turn(k, "claude", "порог 0.4, F1 на валидации 0.71 КОМАНДА-ДАННЫЕ");
    await waitFor(() => k.state.stage === "stopped", "стоп-сигнал", 10_000);
    assert.equal(said(events, STOP_LINE).length, 1);
    await waitFor(() => events.some((e) => e.agent === "codex" && /поздний конец прерванного/.test(e.text ?? "")), "поздний конец", 10_000);
    await sleep(50);
    assert.equal(codex.busy, false);
    assert.equal(events.some((e) => e.agent === "codex" && e.kind === "turn_completed"), false);
    assert.equal(k.state.stage, "stopped", "остановлено, а не «проверяют»");
    assert.equal(said(events, /Поздний ответ/).length, 0);
    // Следующая задача: обычный ход Codex — конец новой проверки, а не прежней.
    await k.fromHuman("подобрать порог заново", "review");
    turn(k, "claude", "порог 0.5, F1 на валидации 0.72");
    await waitFor(() => k.state.pair?.sides.codex?.state === "done", "отзыв Codex засчитан новой проверке", 10_000);
    assert.equal(said(events, /Поздний ответ/).length, 0);
    assert.equal(said(events, /запрещённому пути/).length, 1);
  } finally {
    await codex.stop();
    journal.close();
  }
});

test("профиль прав Codex не принят (Codex обновился): проверка идёт в «только чтение», цикл не падает", async () => {
  // Review Focus 4 (задача 9): откат — строка в ленте без отметки провала;
  // координатор не считает это смертью агента, отзыв засчитан проверке.
  const project = mkdtempSync(join(tmpdir(), "panel-"));
  const folder = join(mkdtempSync(join(tmpdir(), "review-")), "codex");
  const journal = new Journal(join(project, "j.sqlite"));
  journal.ensureRoom("r", project);
  const claude = new Stub("claude");
  const events = [];
  let k;
  const codex = new CodexAdapter(
    { command: "node", commandArgs: [FAKE_CODEX, "--reject-profile"], cwd: project, review: { folder } },
    (e) => k.handle(e),
  );
  k = new Coordinator(claude, codex, journal, { room: "r", cwd: project, maxAutoRounds: 3, onEvent: (e) => events.push(e) });
  try {
    await k.fromHuman("подобрать порог классификатора", "review");
    turn(k, "claude", "порог 0.4, F1 на валидации 0.71");
    await waitFor(() => k.state.pair?.sides.codex?.state === "done", "отзыв Codex засчитан проверке", 10_000);
    const fallback = events.filter((e) => e.agent === "codex" && e.kind === "error");
    assert.equal(fallback.length, 1);
    assert.match(fallback[0].text, /^Песочница Codex не прошла проверку \(профиль прав не принят\): проверка идёт в режиме «только чтение»\.$/);
    assert.equal(fallback[0].failed, undefined);
    assert.notEqual(k.state.stage, "stopped");
    assert.equal(said(events, /завершился с ошибкой|цикл рецензии остановлен/).length, 0);
  } finally {
    await codex.stop();
    journal.close();
  }
});

test("стоп-сигнал: без запрещённого списка команды Codex не проверяются", async () => {
  const { k, codex, journal } = await pairRoom();
  k.handle(codexCommand("python -c \"open('data/x.parquet')\""));
  assert.equal(codex.interrupted, 0);
  assert.equal(k.state.stage, "reviewing");
  journal.close();
});

// Фрагмент из списка — часть пути, а не любая подстрока: «.env» в
// process.env и os.environ, «data/» в metadata/ — не путь к секретам или
// данным, а обычное чтение кода (рецензия задачи 8). Ложное срабатывание
// стоило бы проверки и звало бы человека.
test("стоп-сигнал: process.env, os.environ, metadata/, sample_data\\ — не запрещённые пути, проверка идёт", async () => {
  const { k, codex, events, journal } = await pairRoom({ forbidden: ["data/", ".env"] });
  for (const command of [
    'rg -n "process.env" src',
    "rg os.environ",
    "python -c \"import os; print(os.environ.get('X'))\"",
    "ls metadata/",
    "Get-ChildItem sample_data\\",
    "cat .envrc",
  ]) {
    k.handle(codexCommand(command));
    assert.equal(codex.interrupted, 0, command);
  }
  assert.equal(k.state.stage, "reviewing");
  assert.equal(said(events, /запрещённому пути/).length, 0);
  // .env.local — тот же секрет с суффиксом: ловится.
  k.handle(codexCommand("cat .env.local"));
  assert.equal(codex.interrupted, 1);
  assert.equal(k.state.stage, "stopped");
  assert.equal(said(events, /^Codex обратился к запрещённому пути «\.env» — проверка остановлена, решите, как продолжить\.$/).length, 1);
  journal.close();
});

test("стоп-сигнал: путь ловится в начале команды, после пробела, кавычки, косой черты, «=»; фрагмент с косой черты — внутри пути", async () => {
  // Прямой вопрос: каждое совпадение даёт строку-предупреждение, ход не прерывается.
  const { k, codex, events, journal } = room(3, { forbidden: ["data/", ".env", "\\secrets"] });
  await k.fromHuman("что лежит в проекте?", "codex");
  const warned = () => said(events, /вне проверки — ход не прерван/).length;
  for (const command of [
    ".env",
    "cat .env.local",
    "type C:\\p\\.env",
    "python -c \"open('data/x')\"",
    "dir DATA\\\\x",
    "tool --config=.env",
    "Get-Content `data\\x.csv`",
    "type C:\\Users\\me\\Trading\\data\\prices.parquet",
    "ls C:/p/secrets/key",
  ]) {
    const before = warned();
    k.handle(codexCommand(command));
    assert.equal(warned(), before + 1, command);
  }
  assert.equal(codex.interrupted, 0);
  journal.close();
});

test("стоп-сигнал: сбой после прерывания (onState бросил) не становится необработанным отказом", async () => {
  // Хвост после interrupt() — очередь и обновление панели. Брось он, отказ
  // без обработчика уронил бы процесс расширения (Node 24: --unhandled-rejections=throw).
  const rejections = [];
  const onRejection = (err) => rejections.push(err);
  process.on("unhandledRejection", onRejection);
  let broken = false;
  try {
    const { k, codex, journal } = await pairRoom({
      forbidden: ["data/"],
      onState: () => {
        if (broken) throw new Error("панель закрыта");
      },
    });
    k.handle(codexCommand("cat data/x.csv"));
    broken = true;
    await sleep(50);
    assert.equal(codex.interrupted, 1);
    assert.deepEqual(rejections, []);
    journal.close();
  } finally {
    broken = false;
    process.off("unhandledRejection", onRejection);
  }
});

// ---------------------------------------------------------------------------
// Блок «Проверки рецензента» (спецификация 05.10): команды Codex и их выводы
// идут Claude свидетельством вместе с замечаниями — прежде они выбрасывались,
// и Claude получал «пересчитайте» без самого пересчёта.
// ---------------------------------------------------------------------------

/** Конец команды Codex, как у адаптера: text — JSON элемента, вывод — в raw.aggregatedOutput. */
function codexCommandDone(command, output, id = "cmd-1", exitCode = 0) {
  const item = { type: "commandExecution", id, command, status: "completed", aggregatedOutput: output, exitCode };
  return event("codex", "tool_result", { tool: "commandExecution", callId: id, text: JSON.stringify(item), raw: item });
}

/** Команда Codex целиком: начало и конец. */
function codexRan(k, command, output, id, exitCode = 0) {
  k.handle(codexCommand(command, id));
  k.handle(codexCommandDone(command, output, id, exitCode));
}

const CHECKS_HEADER = "— Проверки рецензента Codex (скрипты рецензента — свидетельство; не запускай их) —";
const DD_SCRIPT = "python C:\\Temp\\agent-panel-review\\codex\\dd.py";

/** Блок проверок в сообщении Claude: от шапки до следующего раздела. */
function checksSection(text) {
  const start = text.indexOf(CHECKS_HEADER);
  if (start < 0) return undefined;
  const rest = text.slice(start);
  const end = rest.search(/\n\n(— Gemini|Файлы изменились|Исправьте или обоснуйте)/);
  return end < 0 ? rest : rest.slice(0, end);
}

/** Выводы команд блока: всё после строки «$ …» (и строки кода выхода) до пустой строки. */
function checkOutputs(block) {
  return block
    .slice(CHECKS_HEADER.length + 1)
    .split("\n\n")
    .filter((piece) => piece.startsWith("$ "))
    .map((piece) => piece.split("\n").slice(1).filter((line) => !/^\[код выхода \d+\]$/.test(line)).join("\n"));
}

test("проверки рецензента: команда и вывод скрипта Codex — блоком-свидетельством в сообщении Claude", async () => {
  const { k, claude, gemini, journal } = await pairRoom();
  codexRan(k, DD_SCRIPT, "max_dd -0.2\n", "cmd-dd");
  codexRan(k, "python C:\\Temp\\agent-panel-review\\codex\\leak.py", "Traceback: KeyError 'date'\n", "cmd-leak", 1);
  codexRan(k, "mkdir C:\\Temp\\agent-panel-review\\codex\\out", "", "cmd-mkdir");
  turn(k, "codex", "Просадка посчитана неверно.\nВЕРДИКТ: ЕСТЬ ЗАМЕЧАНИЯ");
  geminiTurn(k, gemini, "Чек-лист закрыт.\nВЕРДИКТ: ПРИНЯТО");
  await waitFor(() => claude.received.length === 2, "замечания у Claude");
  const text = claude.received[1].text;
  assert.ok(text.includes([CHECKS_HEADER, `$ ${DD_SCRIPT}`, "max_dd -0.2"].join("\n")), text);
  // Провал скрипта виден, пустой вывод назван: Claude не примет трассу за результат.
  assert.ok(text.includes("$ python C:\\Temp\\agent-panel-review\\codex\\leak.py\n[код выхода 1]\nTraceback: KeyError 'date'"), text);
  assert.ok(text.includes("$ mkdir C:\\Temp\\agent-panel-review\\codex\\out\n(вывода нет)"), text);
  assert.doesNotMatch(text, /"type":"commandExecution"/, "команда — строкой, не JSON элемента");
  // Блок — в разделе Codex, после его замечаний, до раздела Gemini.
  assert.ok(text.indexOf("Просадка посчитана неверно") < text.indexOf(CHECKS_HEADER));
  assert.ok(text.indexOf(CHECKS_HEADER) < text.indexOf("— Gemini — методология и факты"));
  assert.equal(k.state.verdict, "remarks", "вердикт — по реплике, не по выводам");
  journal.close();
});

test("проверки рецензента: без команд блока нет", async () => {
  const { k, claude, gemini, journal } = await pairRoom();
  // Поиск в вебе — не команда: блока он не создаёт.
  k.handle(event("codex", "tool_call", { tool: "webSearch", callId: "ws-1", text: "{}" }));
  k.handle(event("codex", "tool_result", { tool: "webSearch", callId: "ws-1", text: "{}" }));
  turn(k, "codex", "Просадка посчитана неверно.\nВЕРДИКТ: ЕСТЬ ЗАМЕЧАНИЯ");
  geminiTurn(k, gemini, "Чек-лист закрыт.\nВЕРДИКТ: ПРИНЯТО");
  await waitFor(() => claude.received.length === 2, "замечания у Claude");
  assert.doesNotMatch(claude.received[1].text, /Проверки рецензента/);
  journal.close();
});

test("проверки рецензента: вывод длиннее 4000 знаков — начало и конец с пометкой пропуска", async () => {
  const { k, claude, gemini, journal } = await pairRoom();
  const long = `начало вывода\n${"x".repeat(9000)}\nитог: max_dd -0.2`;
  codexRan(k, DD_SCRIPT, long, "cmd-long");
  turn(k, "codex", "Просадка посчитана неверно.\nВЕРДИКТ: ЕСТЬ ЗАМЕЧАНИЯ");
  geminiTurn(k, gemini, "Чек-лист закрыт.\nВЕРДИКТ: ПРИНЯТО");
  await waitFor(() => claude.received.length === 2, "замечания у Claude");
  const block = checksSection(claude.received[1].text);
  const [output] = checkOutputs(block);
  assert.ok(output.length <= 4000, `вывод ${output.length} знаков`);
  assert.ok(output.length > 3900, "предел использован");
  assert.ok(output.startsWith("начало вывода\n"));
  assert.ok(output.endsWith("\nитог: max_dd -0.2"));
  assert.match(output, /\[… пропущены символы [\d ]+–[\d ]+ из 9 032 …\]/);
  assert.doesNotMatch(block, /блок сокращён/, "блок в пределе — пометки об обрезке блока нет");
  journal.close();
});

test("проверки рецензента: весь блок — не больше 20 000 знаков, с пометкой об обрезке", async () => {
  const { k, claude, gemini, journal } = await pairRoom();
  for (let i = 0; i < 12; i++) {
    codexRan(k, `python C:\\Temp\\agent-panel-review\\codex\\check${i}.py`, `проверка ${i}\n${"y".repeat(6000)}\nитог ${i}`, `cmd-${i}`);
  }
  turn(k, "codex", "Просадка посчитана неверно.\nВЕРДИКТ: ЕСТЬ ЗАМЕЧАНИЯ");
  geminiTurn(k, gemini, "Чек-лист закрыт.\nВЕРДИКТ: ПРИНЯТО");
  await waitFor(() => claude.received.length === 2, "замечания у Claude");
  const block = checksSection(claude.received[1].text);
  assert.ok(block.length <= 20_000, `блок ${block.length} знаков`);
  assert.ok(block.length > 19_000, "предел использован");
  assert.match(
    block,
    /\n\n\[… блок сокращён до 20 000 символов: длинные выводы урезаны, предел вывода — [\d ]+ символ(а|ов)?\. Полностью — в ленте и журнале панели …\]$/,
  );
  // Команды — все, у каждого вывода — начало и конец.
  const outputs = checkOutputs(block);
  assert.equal(outputs.length, 12);
  outputs.forEach((output, i) => {
    assert.ok(output.length <= 4000, `вывод ${i}: ${output.length} знаков`);
    assert.ok(output.startsWith(`проверка ${i}\n`) && output.endsWith(`\nитог ${i}`), `вывод ${i}`);
  });
  journal.close();
});

test("проверки рецензента: команд больше, чем помещается, — ранние не входят, поздние остаются, пометка называет число", async () => {
  // Codex сначала читает код, потом пишет и запускает скрипты: свидетельства,
  // на которых стоит вердикт, — в поздних командах.
  const { k, claude, gemini, journal } = await pairRoom();
  const module = (i) => `src\\models\\classifier_module${String(i).padStart(3, "0")}.py`;
  for (let i = 0; i < 400; i++) codexRan(k, `rg -n "порог классификатора" ${module(i)}`, "ok", `cmd-${i}`);
  turn(k, "codex", "Просадка посчитана неверно.\nВЕРДИКТ: ЕСТЬ ЗАМЕЧАНИЯ");
  geminiTurn(k, gemini, "Чек-лист закрыт.\nВЕРДИКТ: ПРИНЯТО");
  await waitFor(() => claude.received.length === 2, "замечания у Claude");
  const block = checksSection(claude.received[1].text);
  assert.ok(block.length <= 20_000, `блок ${block.length} знаков`);
  const kept = checkOutputs(block).length;
  assert.ok(kept > 100 && kept < 400, `вошло ${kept}`);
  assert.ok(block.includes(`$ rg -n "порог классификатора" ${module(399)}\nok`), "последняя команда — в блоке");
  assert.ok(!block.includes(module(0)), "первая — нет");
  assert.ok(
    block.endsWith(`[… блок сокращён до 20 000 символов: ранних команд не вошло — ${400 - kept}. Полностью — в ленте и журнале панели …]`),
    block.slice(-200),
  );
  journal.close();
});

test("проверки рецензента: в комнате без Gemini блок — в сообщении Claude после замечаний Codex", async () => {
  const { k, claude, codex, journal } = room();
  await k.fromHuman("посчитать просадку стратегии", "review");
  turn(k, "claude", "max_dd -0.1");
  await waitFor(() => codex.received.length === 1, "проверка у Codex");
  codexRan(k, DD_SCRIPT, "max_dd -0.2\n", "cmd-dd");
  turn(k, "codex", "Просадка посчитана неверно.\nВЕРДИКТ: ЕСТЬ ЗАМЕЧАНИЯ");
  await waitFor(() => claude.received.length === 2, "замечания у Claude");
  const text = claude.received[1].text;
  assert.ok(text.startsWith("Замечания рецензента:\nПросадка посчитана неверно."), text);
  assert.ok(text.includes(`Просадка посчитана неверно.\nВЕРДИКТ: ЕСТЬ ЗАМЕЧАНИЯ\n\n${CHECKS_HEADER}\n$ ${DD_SCRIPT}\nmax_dd -0.2`), text);
  assert.ok(text.indexOf(CHECKS_HEADER) < text.indexOf("Исправьте или обоснуйте несогласие по каждому пункту."));
  // Следующий ход Codex — без команд: блока нет.
  turn(k, "claude", "исправил: max_dd -0.2");
  await waitFor(() => codex.received.length === 2, "проверка 2 у Codex");
  turn(k, "codex", "Знак просадки перепутан.\nВЕРДИКТ: ЕСТЬ ЗАМЕЧАНИЯ");
  await waitFor(() => claude.received.length === 3, "замечания 2 у Claude");
  assert.doesNotMatch(claude.received[2].text, /Проверки рецензента/);
  journal.close();
});

test("проверки рецензента: поздний отзыв Gemini пересобирает удержанные замечания — блок проверок Codex остаётся", async () => {
  const { k, claude, gemini, events, journal } = await pairRoom({ geminiWaitMs: 40 }, 3, { liveGemini: true });
  k.setAuto(false);
  codexRan(k, DD_SCRIPT, "max_dd -0.2\n", "cmd-dd");
  turn(k, "codex", "Просадка посчитана неверно.\nВЕРДИКТ: ЕСТЬ ЗАМЕЧАНИЯ");
  await waitFor(() => k.state.stage === "held", "замечания Codex удержаны");
  geminiTurn(k, gemini, "Пробел: утечка id.\nВЕРДИКТ: ЕСТЬ ЗАМЕЧАНИЯ");
  await waitFor(() => said(events, /^Gemini опоздал к проверке 1, но успел до отправки/).length === 1, "отзыв добавлен");
  await k.releaseHeld();
  const text = claude.received[1].text;
  assert.ok(text.includes(`${CHECKS_HEADER}\n$ ${DD_SCRIPT}\nmax_dd -0.2`), text);
  assert.ok(text.indexOf("Просадка посчитана неверно") < text.indexOf(CHECKS_HEADER));
  assert.ok(text.indexOf(CHECKS_HEADER) < text.indexOf("— Gemini — методология и факты —\nПробел: утечка id"), text);
  journal.close();
});
