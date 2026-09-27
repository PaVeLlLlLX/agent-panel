/**
 * Язык нитей: геометрия и смысл без DOM.
 *
 * Облик согласован с владельцем 27.09 (docs/specs/2026-09-27-облик-язык-нитей.md):
 * агенты — огоньки своего цвета, связи — нити, работа — частицы. Здесь
 * проверяется то, что легко сломать незаметно: какие уровни показываются,
 * где стоит выбранный и узел по умолчанию, когда нить ветвится, как этапы
 * координатора превращаются в «Эстафету» и «Дорожку цикла», какую форму
 * получает бусина действия.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
globalThis.PanelFormat = require_("../media/format.js");
const {
  effortLevels,
  defaultEffort,
  threadLayout,
  relayView,
  trackSteps,
  beadFor,
  actionCounters,
  verdictLine,
} = require_("../media/thread.js");

// --- Уровни ------------------------------------------------------------------

test("уровни идут по возрастанию, с русскими названиями и подсказками", () => {
  const уровни = effortLevels("codex", ["high", "low", "ultra", "medium", "max", "xhigh"]);
  assert.deepEqual(уровни.map((у) => у.id), ["low", "medium", "high", "xhigh", "max", "ultra"]);
  assert.deepEqual(уровни.map((у) => у.name), ["Низкое", "Среднее", "Высокое", "Очень высокое", "Максимум", "Ультра"]);
  assert.ok(уровни.every((у) => у.tip.length > 0), "определение каждого уровня — в подсказке");
});

test("у Claude и Codex разные гаммы: тёплая и холодная", () => {
  const claude = effortLevels("claude", ["low", "max"]);
  const codex = effortLevels("codex", ["low", "max"]);
  assert.notEqual(claude[1].color, codex[1].color);
});

test("ветвится только «Ультра»; Ultracode — режим Claude, только если доступен", () => {
  assert.deepEqual(effortLevels("codex", ["max", "ultra"]).map((у) => у.fork), [false, true]);
  assert.equal(effortLevels("claude", ["high", "max"]).some((у) => у.id === "ultracode"), false);
  const сРежимом = effortLevels("claude", ["high", "max"], { ultracode: true });
  const последний = сРежимом[сРежимом.length - 1];
  assert.equal(последний.id, "ultracode");
  assert.equal(последний.mode, true);
  assert.equal(последний.fork, true);
});

test("неизвестный уровень не теряется, а встаёт в конец", () => {
  assert.deepEqual(effortLevels("codex", ["low", "turbo"]).map((у) => у.id), ["low", "turbo"]);
});

test("уровень по умолчанию — только из каталога; неизвестный не угадывается", () => {
  assert.equal(defaultEffort({ efforts: ["low", "high"], defaultEffort: "low" }), "low");
  // Claude своего умолчания в каталоге не сообщает; «Высокое» было бы догадкой.
  assert.equal(defaultEffort({ efforts: ["low", "medium", "high", "max"] }), "");
  assert.equal(defaultEffort({ efforts: ["low"], defaultEffort: "max" }), "", "умолчание вне списка — не умолчание");
  assert.equal(defaultEffort({ efforts: [] }), "");
});

// --- Нить --------------------------------------------------------------------

test("выбранный узел крупнее, нить светится до него, частиц больше на высоких уровнях", () => {
  const уровни = effortLevels("codex", ["low", "medium", "high", "xhigh", "max"]);
  const низ = threadLayout("codex", уровни, "low", "low");
  const верх = threadLayout("codex", уровни, "max", "low");
  assert.equal(низ.nodes[0].current, true);
  assert.ok(верх.nodes[4].size > верх.nodes[3].size);
  assert.ok(верх.litWidth > низ.litWidth);
  assert.equal(низ.particles.length, 0, "на самом низком уровне поток стоит");
  assert.ok(верх.particles.length > 4);
  assert.ok(parseFloat(верх.particles[0].dur) < 2, "чем выше уровень, тем быстрее частицы");
});

test("«Максимум» — глубина: нить толще и двойное кольцо; ветвления нет", () => {
  const уровни = effortLevels("codex", ["low", "max", "ultra"]);
  const р = threadLayout("codex", уровни, "max", "low");
  assert.equal(р.deep, true);
  assert.equal(р.fork, false);
  assert.ok(р.litHeight > 2);
});

test("«Ультра» — ширина: нить ветвится на три ветки", () => {
  const уровни = effortLevels("codex", ["low", "max", "ultra"]);
  const р = threadLayout("codex", уровни, "ultra", "low");
  assert.equal(р.fork, true);
  assert.equal(р.branches.length, 3);
  assert.ok(р.forkLeft + 34 <= 330, "ветки помещаются в карточку");
});

test("пустой выбор — это уровень по умолчанию, отмеченный чёрточкой", () => {
  const уровни = effortLevels("claude", ["low", "medium", "high", "max"]);
  const р = threadLayout("claude", уровни, "", "high");
  assert.equal(р.nodes[2].current, true);
  assert.equal(р.defaultLeft, р.nodes[2].center - 1);
});

test("режим за пунктиром: сплошная часть кончается на последнем уровне", () => {
  const уровни = effortLevels("claude", ["low", "high", "max"], { ultracode: true });
  const р = threadLayout("claude", уровни, "high", "high");
  assert.ok(р.modeSegment);
  assert.equal(р.modeSegment.left, р.nodes[2].center);
});

test("пустой выбор при неизвестном умолчании: ни один узел не выбран, поток стоит", () => {
  const уровни = effortLevels("claude", ["low", "medium", "high", "max"]);
  const р = threadLayout("claude", уровни, "", "");
  assert.equal(р.label, "По умолчанию");
  assert.equal(р.nodes.some((у) => у.current), false);
  assert.equal(р.litWidth, 0);
  assert.equal(р.particles.length, 0);
  assert.equal(р.ringLeft, null, "кольцо некому показывать");
  assert.equal(р.defaultLeft, null, "чёрточка умолчания не ставится наугад");
  assert.ok(р.nodes.every((у) => у.fill === "var(--нить-пусто)"));
});

test("нет уровней — нет нити", () => {
  assert.equal(threadLayout("claude", [], "", ""), null);
});

// --- Эстафета ------------------------------------------------------------------

const состояние = (доп) => ({ stage: "idle", round: 0, maxRounds: 3, approvals: 0, claudeBusy: false, codexBusy: false, ...доп });

test("эстафета: частицы бегут к тому, кто работает", () => {
  const к = relayView(состояние({ stage: "reviewing", round: 1 }));
  assert.equal(к.active, "codex");
  assert.equal(к.flow, "to-codex");
  assert.equal(к.label, "Codex проверяет");
  const в = relayView(состояние({ stage: "working", round: 1 }));
  assert.equal(в.active, "claude");
  assert.equal(в.flow, "to-claude");
});

test("эстафета: ждёт человека при удержании и при открытом запросе разрешения", () => {
  assert.equal(relayView(состояние({ stage: "held", verdict: "human" })).active, "human");
  const р = relayView(состояние({ stage: "working", approvals: 1 }));
  assert.equal(р.active, "human");
  assert.equal(р.label, "Ждёт разрешения");
  assert.equal(р.flow, "none", "пока человек не ответил, работа стоит");
});

test("эстафета: прямой вопрос вне цикла тоже виден", () => {
  assert.equal(relayView(состояние({ claudeBusy: true })).active, "claude");
  assert.equal(relayView(состояние({ codexBusy: true })).label, "Codex отвечает");
});

test("эстафета: счёт проверок — по точке на каждую, закрашены пройденные", () => {
  assert.deepEqual(relayView(состояние({ stage: "reviewing", round: 2, maxRounds: 3 })).rounds, [true, true, false]);
});

test("эстафета: принятая работа и вердикт словами", () => {
  const р = relayView(состояние({ stage: "accepted", verdict: "accepted" }));
  assert.equal(р.active, "accepted");
  assert.equal(р.sub, "принято");
  assert.equal(relayView(состояние({ stage: "working", verdict: "remarks" })).sub, "есть замечания");
});

// --- Дорожка цикла ------------------------------------------------------------------

test("дорожка: пройденные шаги, текущий и пустые шаги оставшихся проверок", () => {
  const шаги = trackSteps(
    [{ who: "task" }, { who: "claude" }, { who: "codex", mark: "!" }, { who: "claude" }],
    { stage: "working", maxRounds: 3 },
  );
  assert.deepEqual(шаги.map((ш) => ш.who), ["task", "claude", "codex", "claude", "codex", "claude", "codex"]);
  assert.deepEqual(шаги.map((ш) => ш.state), ["done", "done", "done", "current", "ghost", "ghost", "ghost"]);
  assert.equal(шаги[2].mark, "!");
});

test("дорожка: после принятия текущего шага и пустых нет", () => {
  const шаги = trackSteps(
    [{ who: "task" }, { who: "claude" }, { who: "codex", mark: "✓" }],
    { stage: "accepted", maxRounds: 3 },
  );
  assert.ok(шаги.every((ш) => ш.state === "done"));
});

test("дорожка: человек — текущий шаг, когда панель ждёт его", () => {
  const шаги = trackSteps(
    [{ who: "task" }, { who: "claude" }, { who: "codex", mark: "?" }, { who: "you" }],
    { stage: "held", maxRounds: 3 },
  );
  assert.equal(шаги[шаги.length - 1].who, "you");
  assert.equal(шаги[шаги.length - 1].state, "current");
});

test("дорожка без цикла пуста", () => {
  assert.deepEqual(trackSteps([], { stage: "idle", maxRounds: 3 }), []);
});

// --- Бусины и счётчики ------------------------------------------------------------------

test("бусина: форма по виду действия, состояние отдельно", () => {
  assert.deepEqual(beadFor("Bash", "running"), { shape: "square", status: "running" });
  assert.equal(beadFor("Read", "done").shape, "ring");
  assert.equal(beadFor("Edit", "done").shape, "diamond");
  assert.equal(beadFor("commandExecution", "denied").shape, "square");
  assert.equal(beadFor("mcp__om__search", "done").shape, "dot");
});

test("счётчики: команды, чтения, правки, прочее и отказы — только ненулевые", () => {
  assert.deepEqual(actionCounters(["Bash", "Bash", "Read", "Grep", "Edit", "Task"], 1), [
    { kind: "command", n: 2 },
    { kind: "read", n: 2 },
    { kind: "edit", n: 1 },
    { kind: "other", n: 1 },
    { kind: "denied", n: 1 },
  ]);
  assert.deepEqual(actionCounters([], 0), []);
});

// --- Строка вердикта ------------------------------------------------------------------

/** Текст из строк: перевод строки кодом, а не escape-записью (см. hygiene.test.mjs). */
const строки = (...с) => с.join(String.fromCharCode(10));

test("вердикт: последняя строка отделяется от текста и остаётся видимой как есть", () => {
  const р = verdictLine(строки("Замечаний два.", "", "1. Первое.", "", "ВЕРДИКТ: ЕСТЬ ЗАМЕЧАНИЯ", ""));
  assert.equal(р.verdict, "remarks");
  assert.equal(р.line, "ВЕРДИКТ: ЕСТЬ ЗАМЕЧАНИЯ");
  assert.equal(р.body, строки("Замечаний два.", "", "1. Первое."));
  assert.equal(verdictLine(строки("Всё хорошо.", "ВЕРДИКТ: ПРИНЯТО")).verdict, "accepted");
  assert.equal(verdictLine(строки("Нужны данные.", "ВЕРДИКТ: НУЖНО РЕШЕНИЕ ЧЕЛОВЕКА")).verdict, "human");
});

test("вердикт: строку не в конце, в коде, в цитате и неточную не отделяем", () => {
  assert.equal(verdictLine(строки("ВЕРДИКТ: ПРИНЯТО", "а потом ещё текст")), null);
  assert.equal(verdictLine(строки("```", "ВЕРДИКТ: ПРИНЯТО")), null, "незакрытый блок кода");
  assert.equal(verdictLine("    ВЕРДИКТ: ПРИНЯТО"), null, "отступ кода");
  assert.equal(verdictLine("> ВЕРДИКТ: ПРИНЯТО"), null);
  assert.equal(verdictLine("ВЕРДИКТ: НЕПРИНЯТО"), null);
  assert.equal(verdictLine("`ВЕРДИКТ: ПРИНЯТО`"), null);
  assert.equal(verdictLine(""), null);
});

test("эстафета: прямой ответ после принятой задачи виден, а не «Работа принята»", () => {
  // Рецензия Codex 28.09: accepted проверялся раньше занятости агентов.
  const р = relayView(состояние({ stage: "accepted", verdict: "accepted", claudeBusy: true }));
  assert.equal(р.active, "claude");
  assert.equal(р.label, "Claude отвечает");
  assert.equal(relayView(состояние({ stage: "accepted", verdict: "accepted" })).active, "accepted");
});

test("вердикт: ограды кода помнят вид и длину, как src/verdict.ts", () => {
  // Рецензия Codex 28.09: чётность оград давала «принято» внутри блока из четырёх кавычек.
  assert.equal(verdictLine(строки("````", "```", "ВЕРДИКТ: ПРИНЯТО")), null, "три кавычки не закрывают четыре");
  assert.equal(verdictLine(строки("````", "код", "````", "ВЕРДИКТ: ПРИНЯТО")).verdict, "accepted");
  assert.equal(verdictLine(строки("~~~", "ВЕРДИКТ: ПРИНЯТО")), null, "тильды — тоже ограда");
  assert.equal(verdictLine(строки("~~~", "```", "ВЕРДИКТ: ПРИНЯТО")), null, "кавычки не закрывают тильды");
  assert.equal(verdictLine(строки("```js", "x", "``` лишнее", "ВЕРДИКТ: ПРИНЯТО")), null, "ограда с текстом после не закрывает");
  assert.equal(verdictLine(строки("```js", "x", "```", "ВЕРДИКТ: ЕСТЬ ЗАМЕЧАНИЯ")).verdict, "remarks");
});
