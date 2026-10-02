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
  trackGeometry,
  savedRoute,
  beadFor,
  actionCounters,
  verdictLine,
} = require_("../media/thread.js");

// --- Уровни ------------------------------------------------------------------

test("уровни идут по возрастанию, с русскими названиями и подсказками", () => {
  const levels = effortLevels("codex", ["high", "low", "ultra", "medium", "max", "xhigh"]);
  assert.deepEqual(levels.map((u) => u.id), ["low", "medium", "high", "xhigh", "max", "ultra"]);
  assert.deepEqual(levels.map((u) => u.name), ["Низкое", "Среднее", "Высокое", "Очень высокое", "Максимум", "Ультра"]);
  assert.ok(levels.every((u) => u.tip.length > 0), "определение каждого уровня — в подсказке");
});

test("у Claude и Codex разные гаммы: тёплая и холодная", () => {
  const claude = effortLevels("claude", ["low", "max"]);
  const codex = effortLevels("codex", ["low", "max"]);
  assert.notEqual(claude[1].color, codex[1].color);
});

test("ветвится только «Ультра»; Ultracode — режим Claude, только если доступен", () => {
  assert.deepEqual(effortLevels("codex", ["max", "ultra"]).map((u) => u.fork), [false, true]);
  assert.equal(effortLevels("claude", ["high", "max"]).some((u) => u.id === "ultracode"), false);
  const withMode = effortLevels("claude", ["high", "max"], { ultracode: true });
  const lastIndex = withMode[withMode.length - 1];
  assert.equal(lastIndex.id, "ultracode");
  assert.equal(lastIndex.mode, true);
  assert.equal(lastIndex.fork, true);
});

test("неизвестный уровень не теряется, а встаёт в конец", () => {
  assert.deepEqual(effortLevels("codex", ["low", "turbo"]).map((u) => u.id), ["low", "turbo"]);
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
  const levels = effortLevels("codex", ["low", "medium", "high", "xhigh", "max"]);
  const bottom = threadLayout("codex", levels, "low", "low");
  const top = threadLayout("codex", levels, "max", "low");
  assert.equal(bottom.nodes[0].current, true);
  assert.ok(top.nodes[4].size > top.nodes[3].size);
  assert.ok(top.litWidth > bottom.litWidth);
  assert.equal(bottom.particles.length, 0, "на самом низком уровне поток стоит");
  assert.ok(top.particles.length > 4);
  assert.ok(parseFloat(top.particles[0].dur) < 2, "чем выше уровень, тем быстрее частицы");
});

test("«Максимум» — глубина: нить толще и двойное кольцо; ветвления нет", () => {
  const levels = effortLevels("codex", ["low", "max", "ultra"]);
  const r = threadLayout("codex", levels, "max", "low");
  assert.equal(r.deep, true);
  assert.equal(r.fork, false);
  assert.ok(r.litHeight > 2);
});

test("«Ультра» — ширина: нить ветвится на три ветки", () => {
  const levels = effortLevels("codex", ["low", "max", "ultra"]);
  const r = threadLayout("codex", levels, "ultra", "low");
  assert.equal(r.fork, true);
  assert.equal(r.branches.length, 3);
  assert.ok(r.forkLeft + 34 <= 330, "ветки помещаются в карточку");
});

test("пустой выбор — это уровень по умолчанию, отмеченный чёрточкой", () => {
  const levels = effortLevels("claude", ["low", "medium", "high", "max"]);
  const r = threadLayout("claude", levels, "", "high");
  assert.equal(r.nodes[2].current, true);
  assert.equal(r.defaultLeft, r.nodes[2].center - 1);
});

test("режим за пунктиром: сплошная часть кончается на последнем уровне", () => {
  const levels = effortLevels("claude", ["low", "high", "max"], { ultracode: true });
  const r = threadLayout("claude", levels, "high", "high");
  assert.ok(r.modeSegment);
  assert.equal(r.modeSegment.left, r.nodes[2].center);
});

test("пустой выбор при неизвестном умолчании: ни один узел не выбран, поток стоит", () => {
  const levels = effortLevels("claude", ["low", "medium", "high", "max"]);
  const r = threadLayout("claude", levels, "", "");
  assert.equal(r.label, "По умолчанию");
  assert.equal(r.nodes.some((u) => u.current), false);
  assert.equal(r.litWidth, 0);
  assert.equal(r.particles.length, 0);
  assert.equal(r.ringLeft, null, "кольцо некому показывать");
  assert.equal(r.defaultLeft, null, "чёрточка умолчания не ставится наугад");
  assert.ok(r.nodes.every((u) => u.fill === "var(--нить-пусто)"));
});

test("нет уровней — нет нити", () => {
  assert.equal(threadLayout("claude", [], "", ""), null);
});

// --- Эстафета ------------------------------------------------------------------

const state = (extra) => ({ stage: "idle", round: 0, maxRounds: 3, approvals: 0, claudeBusy: false, codexBusy: false, ...extra });

test("эстафета: частицы бегут к тому, кто работает", () => {
  const k = relayView(state({ stage: "reviewing", round: 1 }));
  assert.equal(k.active, "codex");
  assert.equal(k.flow, "to-codex");
  assert.equal(k.label, "Codex проверяет");
  const v = relayView(state({ stage: "working", round: 1 }));
  assert.equal(v.active, "claude");
  assert.equal(v.flow, "to-claude");
});

test("эстафета: ждёт человека при удержании и при открытом запросе разрешения", () => {
  assert.equal(relayView(state({ stage: "held", verdict: "human" })).active, "human");
  const r = relayView(state({ stage: "working", approvals: 1 }));
  assert.equal(r.active, "human");
  assert.equal(r.label, "Ждёт разрешения");
  assert.equal(r.flow, "none", "пока человек не ответил, работа стоит");
});

test("эстафета: прямой вопрос вне цикла тоже виден", () => {
  assert.equal(relayView(state({ claudeBusy: true })).active, "claude");
  assert.equal(relayView(state({ codexBusy: true })).label, "Codex отвечает");
});

test("эстафета: счёт проверок — по точке на каждую, закрашены пройденные", () => {
  assert.deepEqual(relayView(state({ stage: "reviewing", round: 2, maxRounds: 3 })).rounds, [true, true, false]);
});

test("эстафета: принятая работа и вердикт словами", () => {
  const r = relayView(state({ stage: "accepted", verdict: "accepted" }));
  assert.equal(r.active, "accepted");
  assert.equal(r.sub, "принято");
  assert.equal(relayView(state({ stage: "working", verdict: "remarks" })).sub, "есть замечания");
});

// --- Дорожка цикла ------------------------------------------------------------------

test("дорожка: пройденные шаги, текущий и пустые шаги оставшихся проверок", () => {
  const steps = trackSteps(
    [{ who: "task" }, { who: "claude" }, { who: "codex", mark: "!" }, { who: "claude" }],
    { stage: "working", maxRounds: 3 },
  );
  assert.deepEqual(steps.map((sh) => sh.who), ["task", "claude", "codex", "claude", "codex", "claude", "codex"]);
  assert.deepEqual(steps.map((sh) => sh.state), ["done", "done", "done", "current", "ghost", "ghost", "ghost"]);
  assert.equal(steps[2].mark, "!");
});

test("дорожка: после принятия текущего шага и пустых нет", () => {
  const steps = trackSteps(
    [{ who: "task" }, { who: "claude" }, { who: "codex", mark: "✓" }],
    { stage: "accepted", maxRounds: 3 },
  );
  assert.ok(steps.every((sh) => sh.state === "done"));
});

test("дорожка: человек — текущий шаг, когда панель ждёт его", () => {
  const steps = trackSteps(
    [{ who: "task" }, { who: "claude" }, { who: "codex", mark: "?" }, { who: "you" }],
    { stage: "held", maxRounds: 3 },
  );
  assert.equal(steps[steps.length - 1].who, "you");
  assert.equal(steps[steps.length - 1].state, "current");
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
const lines = (...s) => s.join(String.fromCharCode(10));

test("вердикт: последняя строка отделяется от текста и остаётся видимой как есть", () => {
  const r = verdictLine(lines("Замечаний два.", "", "1. Первое.", "", "ВЕРДИКТ: ЕСТЬ ЗАМЕЧАНИЯ", ""));
  assert.equal(r.verdict, "remarks");
  assert.equal(r.line, "ВЕРДИКТ: ЕСТЬ ЗАМЕЧАНИЯ");
  assert.equal(r.body, lines("Замечаний два.", "", "1. Первое."));
  assert.equal(verdictLine(lines("Всё хорошо.", "ВЕРДИКТ: ПРИНЯТО")).verdict, "accepted");
  assert.equal(verdictLine(lines("Нужны данные.", "ВЕРДИКТ: НУЖНО РЕШЕНИЕ ЧЕЛОВЕКА")).verdict, "human");
});

test("вердикт: строку не в конце, в коде, в цитате и неточную не отделяем", () => {
  assert.equal(verdictLine(lines("ВЕРДИКТ: ПРИНЯТО", "а потом ещё текст")), null);
  assert.equal(verdictLine(lines("```", "ВЕРДИКТ: ПРИНЯТО")), null, "незакрытый блок кода");
  assert.equal(verdictLine("    ВЕРДИКТ: ПРИНЯТО"), null, "отступ кода");
  assert.equal(verdictLine("> ВЕРДИКТ: ПРИНЯТО"), null);
  assert.equal(verdictLine("ВЕРДИКТ: НЕПРИНЯТО"), null);
  assert.equal(verdictLine("`ВЕРДИКТ: ПРИНЯТО`"), null);
  assert.equal(verdictLine(""), null);
});

test("эстафета: прямой ответ после принятой задачи виден, а не «Работа принята»", () => {
  // Рецензия Codex 28.09: accepted проверялся раньше занятости агентов.
  const r = relayView(state({ stage: "accepted", verdict: "accepted", claudeBusy: true }));
  assert.equal(r.active, "claude");
  assert.equal(r.label, "Claude отвечает");
  assert.equal(relayView(state({ stage: "accepted", verdict: "accepted" })).active, "accepted");
});

test("у Gemini своя гамма — фиолетовая, отличная от Claude и Codex", () => {
  const gemini = effortLevels("gemini", ["low", "high"]);
  assert.equal(gemini[1].color, "#A78BFA");
  assert.notEqual(gemini[1].color, effortLevels("codex", ["low", "high"])[1].color);
  assert.ok(gemini.every((u) => u.tip.length > 0));
});

const pairState = (sides, extra = {}) =>
  state({ stage: "reviewing", round: 1, reviewers: ["codex", "gemini"], pair: { round: 1, sides }, ...extra });

test("эстафета пары: оба проверяют — частицы по обеим веткам", () => {
  const r = relayView(pairState({ codex: { state: "waiting" }, gemini: { state: "waiting" } }));
  assert.equal(r.active, "reviewers");
  assert.equal(r.flow, "to-reviewers");
  assert.equal(r.label, "Codex и Gemini проверяют");
  assert.equal(r.pair, true);
  assert.deepEqual(r.lit, { claude: false, codex: true, gemini: true });
});

test("эстафета пары: Codex закончил — горит Gemini, отметка Codex, подпись его вердиктом", () => {
  const r = relayView(pairState({ codex: { state: "done", verdict: "accepted" }, gemini: { state: "waiting" } }));
  assert.equal(r.active, "gemini");
  assert.equal(r.flow, "to-gemini");
  assert.equal(r.label, "Gemini проверяет");
  assert.equal(r.sub, "Codex: принято");
  assert.deepEqual(r.marks, { codex: "✓", gemini: "" });
});

test("эстафета пары: принято обоими и принято без Gemini", () => {
  const both = relayView(pairState({ codex: { state: "done", verdict: "accepted" }, gemini: { state: "done", verdict: "accepted" } }, { stage: "accepted" }));
  assert.equal(both.sub, "Codex и Gemini: принято");
  assert.deepEqual(both.lit, { claude: true, codex: true, gemini: true });
  const alone = relayView(pairState({ codex: { state: "done", verdict: "accepted" }, gemini: { state: "unchecked", reason: "квота" } }, { stage: "accepted" }));
  assert.equal(alone.sub, "Codex: принято · Gemini не проверял");
});

test("эстафета без Gemini — как прежде, вилки нет", () => {
  const r = relayView(state({ stage: "reviewing", round: 1 }));
  assert.equal(r.pair, false);
  assert.equal(r.label, "Codex проверяет");
  assert.equal(relayView(state({ geminiBusy: true })).label, "Gemini отвечает");
});

test("дорожка пары: Codex и Gemini одной проверки — ромб; пустые проверки — пустые ромбы", () => {
  const columns = trackSteps(
    [{ who: "task" }, { who: "claude" }, { who: "codex", round: 1, mark: "!" }, { who: "gemini", round: 1, mark: "!" }, { who: "claude" },
      { who: "codex", round: 2, mark: "✓" }, { who: "gemini", round: 2 }],
    { stage: "reviewing", maxRounds: 3, reviewers: ["codex", "gemini"] },
  );
  assert.deepEqual(columns.map((c) => c.who), ["task", "claude", "pair", "claude", "pair", "claude", "pair"]);
  assert.equal(columns[4].state, "current");
  assert.equal(columns[4].top.state, "done", "Codex уже ответил");
  assert.equal(columns[4].bottom.state, "current", "Gemini ещё проверяет");
  assert.equal(columns[6].state, "ghost");
  assert.equal(columns[6].bottom.who, "gemini");
});

test("дорожка пары: «не проверял» сохраняет причину", () => {
  const columns = trackSteps(
    [{ who: "task" }, { who: "claude" }, { who: "codex", round: 1, mark: "✓" }, { who: "gemini", round: 1, unchecked: "квота" }],
    { stage: "accepted", maxRounds: 3, reviewers: ["codex", "gemini"] },
  );
  assert.equal(columns[2].bottom.unchecked, "квота");
});

test("геометрия дорожки: ромб — две кривые из Claude и две в следующий шаг; без пар — одна линия", () => {
  const columns = trackSteps(
    [{ who: "task" }, { who: "claude" }, { who: "codex", round: 1, mark: "!" }, { who: "gemini", round: 1, mark: "!" }, { who: "claude" }],
    { stage: "working", maxRounds: 1, reviewers: ["codex", "gemini"] },
  );
  const g = trackGeometry(columns);
  const codexNode = g.nodes.find((u) => u.who === "codex");
  const geminiNode = g.nodes.find((u) => u.who === "gemini");
  assert.equal(codexNode.x, geminiNode.x, "рецензенты одной проверки — в одном столбце");
  assert.ok(codexNode.y < geminiNode.y, "Codex сверху, Gemini снизу");
  assert.equal(g.links.filter((l) => l.d.includes("C")).length, 4);
  assert.ok(g.height > 28);
  const flat = trackGeometry(trackSteps([{ who: "task" }, { who: "claude" }, { who: "codex", round: 1 }], { stage: "reviewing", maxRounds: 1 }));
  assert.ok(flat.nodes.every((u) => u.y === flat.nodes[0].y));
  assert.equal(flat.height, 28);
});

test("режим из сохранённого состояния: both прежней версии — all; неизвестный — review", () => {
  const ids = ["review", "all", "claude", "codex", "gemini"];
  assert.equal(savedRoute("both", ids), "all");
  assert.equal(savedRoute("gemini", ids), "gemini");
  assert.equal(savedRoute("gemini", ["review", "all", "claude", "codex"]), "review");
  assert.equal(savedRoute(undefined, ids), "review");
});

test("вердикт: ограды кода помнят вид и длину, как src/verdict.ts", () => {
  // Рецензия Codex 28.09: чётность оград давала «принято» внутри блока из четырёх кавычек.
  assert.equal(verdictLine(lines("````", "```", "ВЕРДИКТ: ПРИНЯТО")), null, "три кавычки не закрывают четыре");
  assert.equal(verdictLine(lines("````", "код", "````", "ВЕРДИКТ: ПРИНЯТО")).verdict, "accepted");
  assert.equal(verdictLine(lines("~~~", "ВЕРДИКТ: ПРИНЯТО")), null, "тильды — тоже ограда");
  assert.equal(verdictLine(lines("~~~", "```", "ВЕРДИКТ: ПРИНЯТО")), null, "кавычки не закрывают тильды");
  assert.equal(verdictLine(lines("```js", "x", "``` лишнее", "ВЕРДИКТ: ПРИНЯТО")), null, "ограда с текстом после не закрывает");
  assert.equal(verdictLine(lines("```js", "x", "```", "ВЕРДИКТ: ЕСТЬ ЗАМЕЧАНИЯ")).verdict, "remarks");
});
