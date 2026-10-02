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
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ClaudeAdapter, formatForClaude } from "../out/adapters/claude.js";
import { CodexAdapter } from "../out/adapters/codex.js";
import { GeminiAdapter, formatForGemini } from "../out/adapters/gemini.js";

const fixturePath = (name) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
const FAKE_CLAUDE = fixturePath("fake-claude.mjs");
const FAKE_CODEX = fixturePath("fake-codex.mjs");
const FAKE_AGY = fixturePath("fake-agy.mjs");
const MISSING_COMMAND = "nesushchestvuyushchaya-komanda-agent-panel";

function collector() {
  const events = [];
  return { events, sink: (e) => events.push(e) };
}

async function waitFor(condition, message, limit = 10000) {
  const start = Date.now();
  while (Date.now() - start < limit) {
    if (condition()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail(`не дождались: ${message}`);
}

const catalog = () => mkdtempSync(join(tmpdir(), "adapter-"));
const errors = (events) => events.filter((e) => e.kind === "error");

function claude(s, extra = {}) {
  return new ClaudeAdapter(
    { command: "node", commandArgs: [FAKE_CLAUDE], cwd: catalog(), ...extra },
    s.sink,
  );
}

function codex(s, extra = {}) {
  return new CodexAdapter(
    { command: "node", commandArgs: [FAKE_CODEX], cwd: catalog(), ...extra },
    s.sink,
  );
}

function gemini(s, extra = {}) {
  return new GeminiAdapter({ command: "node", commandArgs: [FAKE_AGY], cwd: catalog(), ...extra }, s.sink);
}

// ---------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------

test("Claude: процесс поднимается сам при первой отправке, ответ и поток доходят", async () => {
  const s = collector();
  const a = claude(s);
  try {
    await a.send({ text: "здравствуй", from: "human" });
    await waitFor(() => s.events.some((e) => e.kind === "turn_completed"), "конец хода");
    assert.ok(s.events.some((e) => e.kind === "message" && e.text === "привет"));
    assert.deepEqual(
      s.events.filter((e) => e.kind === "text_delta").map((e) => e.text),
      ["при", "вет"],
    );
    assert.equal(a.sessionId, "fake-claude-session");
  } finally {
    await a.stop();
  }
});

test("Claude: U+2028 и U+2029 внутри строки JSON не режут её", async () => {
  // readline делит строки и по U+2028/U+2029, а JSON.stringify пишет их как
  // есть: ответ рвался на куски вне протокола (живой прогон 02.10, у Codex).
  const s = collector();
  const a = claude(s);
  try {
    await a.send({ text: "РАЗРЫВ", from: "human" });
    await waitFor(() => s.events.some((e) => e.kind === "turn_completed"), "конец хода");
    assert.deepEqual(s.events.filter((e) => e.kind === "message").map((e) => e.text), ["до после конец"]);
  } finally {
    await a.stop();
  }
});

test("Claude: длинный вывод инструмента — усечённый текст для показа и полный для рецензента", async () => {
  const s = collector();
  const a = claude(s);
  try {
    await a.send({ text: "ДЛИННЫЙ-ВЫВОД", from: "human" });
    await waitFor(() => s.events.some((e) => e.kind === "turn_completed"), "конец хода");
    const r = s.events.find((e) => e.kind === "tool_result");
    assert.ok(r, "результат инструмента не пришёл");
    assert.match(r.text, /обрезано \d+ символов/, "показ остаётся ограниченным");
    assert.ok(r.full, "полный текст потерян");
    assert.ok(r.full.startsWith("начало-вывода "), "блоки текста — как текст, а не JSON");
    assert.ok(r.full.endsWith("КОНЕЦ-ВЫВОДА"), "конец вывода потерян");
    assert.ok(!r.full.includes('"type"'), "в полный текст попала обёртка блоков");
  } finally {
    await a.stop();
  }
});

test("Claude: запрос и решение разрешения знают, о каком вызове инструмента речь", async () => {
  // Рецензия Codex 28.09: карточка живёт по request_id, бусина — по tool_use_id,
  // и отказ человека не доходил до бусины.
  const s = collector();
  const a = claude(s);
  try {
    await a.send({ text: "НУЖНО-РАЗРЕШЕНИЕ", from: "human" });
    await waitFor(() => s.events.some((e) => e.kind === "approval_requested"), "запрос разрешения");
    const request = s.events.find((e) => e.kind === "approval_requested");
    assert.equal(request.toolCallId, "toolu_perm");
    await a.answerApproval(request.callId, "deny");
    await waitFor(() => s.events.some((e) => e.kind === "approval_decided"), "решение");
    assert.equal(s.events.find((e) => e.kind === "approval_decided").toolCallId, "toolu_perm");
  } finally {
    await a.stop();
  }
});

test("Claude: ход с фоновым субагентом кончается итогом, а не первым result", async () => {
  // Живая трасса 28.09: в режиме панели result приходит, пока субагент ещё
  // работает; потом Claude сам продолжает ход. Прежде панель отдавала
  // рецензенту «агент запущен, жду», а итог никто не проверял.
  const s = collector();
  const a = claude(s);
  try {
    await a.send({ text: "ФОНОВЫЙ-СУБАГЕНТ", from: "human" });
    await waitFor(() => s.events.some((e) => e.kind === "message" && e.text === "агент запущен, жду"), "промежуточная реплика");
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(s.events.filter((e) => e.kind === "turn_completed").length, 0, "ход кончился раньше субагента");
    assert.equal(a.busy, true, "пока работает субагент, Claude занят");
    await waitFor(() => s.events.some((e) => e.kind === "turn_completed"), "конец хода");
    const order = s.events.filter((e) => e.kind === "message" || e.kind === "turn_completed").map((e) => e.kind === "message" ? e.text : "конец");
    assert.deepEqual(order, ["агент запущен, жду", "alpha", "конец"]);
    assert.equal(a.busy, false);
    const subagentKinds = s.events.filter((e) => e.parentCallId === "toolu_agent").map((e) => e.kind);
    assert.deepEqual(subagentKinds, ["tool_call", "tool_result"], "действия субагента помечены вызовом, который его запустил");
    assert.ok(s.events.some((e) => e.kind === "diagnostic" && /субагент/.test(e.text ?? "")), "человек видит, почему ход не кончился");
  } finally {
    await a.stop();
  }
});

test("Claude: расход хода — сумма всех result хода, лимит — последнее сведение", async () => {
  const s = collector();
  const a = claude(s);
  try {
    await a.send({ text: "ФОНОВЫЙ-СУБАГЕНТ", from: "human" });
    await waitFor(() => s.events.some((e) => e.kind === "turn_completed"), "конец хода");
    const end = s.events.find((e) => e.kind === "turn_completed");
    assert.deepEqual(end.usage, { input: 3115, cached: 3000, output: 27 });
    assert.deepEqual(end.limit, { status: "allowed", window: "five_hour", resetsAt: 1790553000000 });
  } finally {
    await a.stop();
  }
});

const turnEnds = (s) => s.events.filter((e) => e.kind === "turn_completed");
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

test("Claude: срок не закрывает ход, пока модель отвечает итоговым запросом", async () => {
  const s = collector();
  const a = claude(s, { backgroundGraceMs: 200 });
  try {
    await a.send({ text: "ДВА-СУБАГЕНТА", from: "human" });
    await waitFor(() => s.events.some((e) => e.kind === "message" && e.text === "итог-2"), "итог-2");
    await delay(400);
    assert.equal(turnEnds(s).length, 1, "ход закрыт дважды или раньше итога");
    const order = s.events.filter((e) => e.kind === "message" || e.kind === "turn_completed").map((e) => e.text);
    assert.equal(order[order.length - 1].startsWith("ход завершён"), true);
    assert.ok(order.indexOf("итог-2") < order.length - 1);
  } finally {
    await a.stop();
  }
});

test("Claude: снимок задач без task_type не снимает известного субагента", async () => {
  const s = collector();
  const a = claude(s, { backgroundGraceMs: 200 });
  try {
    await a.send({ text: "СНИМОК-БЕЗ-ТИПА", from: "human" });
    await waitFor(() => turnEnds(s).length > 0, "конец хода");
    await delay(100);
    assert.equal(turnEnds(s).length, 1);
    const results = s.events.filter((e) => e.kind === "message").map((e) => e.text);
    assert.deepEqual(results, ["жду", "итог"], "ход закрыт по сроку до итога");
  } finally {
    await a.stop();
  }
});

test("Claude: после ошибки при работающем субагенте его поздний итог держит следующий ход", async () => {
  const s = collector();
  const a = claude(s, { backgroundGraceMs: 200 });
  try {
    await a.send({ text: "ОШИБКА-ПРИ-СУБАГЕНТЕ", from: "human" });
    await waitFor(() => turnEnds(s).length === 1, "ход с ошибкой");
    assert.equal(turnEnds(s)[0].failed, true);
    await a.send({ text: "здравствуй", from: "human" });
    await waitFor(() => s.events.some((e) => e.kind === "message" && e.text === "поздний итог"), "поздний итог");
    await waitFor(() => turnEnds(s).length === 2, "конец второго хода");
    await delay(300);
    assert.equal(turnEnds(s).length, 2, "поздний итог закончил второй ход раньше или вдвойне");
    const lastItems = s.events.filter((e) => e.kind === "message" || e.kind === "turn_completed").slice(-2).map((e) => e.kind);
    assert.deepEqual(lastItems, ["message", "turn_completed"]);
  } finally {
    await a.stop();
  }
});

test("Claude: процесс умер при работающем субагенте — следующий ход не виснет", async () => {
  const s = collector();
  const a = claude(s, { backgroundGraceMs: 200 });
  try {
    await a.send({ text: "УПАСТЬ-ПРИ-СУБАГЕНТЕ", from: "human" });
    await waitFor(() => s.events.some((e) => e.kind === "error"), "ошибка процесса");
    const before = turnEnds(s).length;
    await a.send({ text: "здравствуй", from: "human" });
    await waitFor(() => turnEnds(s).length > before, "конец нового хода");
    await delay(400);
    assert.equal(turnEnds(s).length, before + 1, "поздний срок старого хода выдал лишний конец");
    assert.equal(a.busy, false);
  } finally {
    await a.stop();
  }
});

test("Claude: расход умершего процесса не переходит в следующий ход", async () => {
  const s = collector();
  const a = claude(s, { backgroundGraceMs: 200 });
  try {
    await a.send({ text: "УПАСТЬ-ПРИ-СУБАГЕНТЕ", from: "human" });
    await waitFor(() => s.events.some((e) => e.kind === "error"), "ошибка процесса");
    await a.send({ text: "здравствуй", from: "human" });
    await waitFor(() => s.events.some((e) => e.kind === "turn_completed"), "конец нового хода");
    assert.equal(s.events.find((e) => e.kind === "turn_completed").usage, undefined, "в ход попал расход умершего процесса");
  } finally {
    await a.stop();
  }
});

test("Claude: субагент молчит — ход закрывается по сроку тишины, а не висит", async () => {
  const s = collector();
  const a = claude(s, { backgroundGraceMs: 200, backgroundIdleMs: 300 });
  try {
    await a.send({ text: "МОЛЧАЛИВЫЙ-СУБАГЕНТ", from: "human" });
    await waitFor(() => s.events.some((e) => e.kind === "turn_completed"), "конец хода по тишине", 5000);
    assert.match(s.events.find((e) => e.kind === "turn_completed").text, /не сообщил/);
    assert.equal(a.busy, false);
  } finally {
    await a.stop();
  }
});

test("Claude: второй субагент молчит после итогового запроса — срок тишины всё равно идёт", async () => {
  // Рецензия Codex 28.09: init продолжения снимал и таймер тишины.
  const s = collector();
  const a = claude(s, { backgroundGraceMs: 200, backgroundIdleMs: 400 });
  try {
    await a.send({ text: "ОДИН-МОЛЧИТ", from: "human" });
    await waitFor(() => s.events.some((e) => e.kind === "turn_completed"), "конец хода по тишине", 5000);
    assert.match(s.events.find((e) => e.kind === "turn_completed").text, /не сообщил/);
  } finally {
    await a.stop();
  }
});

test("Claude: срок тишины не закрывает открытый запрос модели", async () => {
  const s = collector();
  const a = claude(s, { backgroundGraceMs: 200, backgroundIdleMs: 300 });
  try {
    await a.send({ text: "ДОЛГИЙ-ЗАПРОС", from: "human" });
    await waitFor(() => s.events.some((e) => e.kind === "message" && e.text === "поздний"), "поздний ответ", 5000);
    await waitFor(() => s.events.some((e) => e.kind === "turn_completed"), "конец хода");
    await new Promise((r) => setTimeout(r, 300));
    const ends = s.events.filter((e) => e.kind === "turn_completed");
    assert.equal(ends.length, 1);
    const order = s.events.filter((e) => e.kind === "message" || e.kind === "turn_completed").map((e) => e.kind === "message" ? e.text : "конец");
    assert.deepEqual(order, ["жду", "поздний", "конец"]);
  } finally {
    await a.stop();
  }
});

test("Claude: после закрытия по тишине процесс остановлен — поздних концов хода нет", async () => {
  const s = collector();
  const a = claude(s, { backgroundGraceMs: 200, backgroundIdleMs: 300 });
  try {
    await a.send({ text: "МОЛЧАЛИВЫЙ-СУБАГЕНТ", from: "human" });
    await waitFor(() => s.events.some((e) => e.kind === "turn_completed"), "конец по тишине", 5000);
    await waitFor(() => s.events.some((e) => e.kind === "diagnostic" && /остановлен/.test(e.text ?? "")), "остановка процесса");
    // Процесс со всем деревом снят раньше, чем объявлен конец хода: иначе
    // очередь ушла бы в умирающий процесс, а рецензия — к ещё живому
    // субагенту (рецензия Codex 28.09).
    const stopIndex = s.events.findIndex((e) => e.kind === "diagnostic" && /остановлен/.test(e.text ?? ""));
    const end = s.events.findIndex((e) => e.kind === "turn_completed");
    assert.ok(stopIndex >= 0 && stopIndex < end, "конец хода объявлен до остановки процесса");
    await a.send({ text: "здравствуй", from: "human" });
    await waitFor(() => s.events.filter((e) => e.kind === "turn_completed").length === 2, "следующий ход");
    assert.equal(s.events.filter((e) => e.kind === "error").length, 0, "плановая остановка — не ошибка");
  } finally {
    await a.stop();
  }
});

test("Claude: фоновый Bash ход не держит — ждут только субагентов", async () => {
  const s = collector();
  const a = claude(s);
  try {
    await a.send({ text: "ФОНОВЫЙ-BASH", from: "human" });
    await waitFor(() => s.events.some((e) => e.kind === "turn_completed"), "конец хода");
    assert.equal(a.busy, false);
  } finally {
    await a.stop();
  }
});

test("Claude: фоновая команда кончилась после хода — Claude продолжает сам, ход помечен самостоятельным", async () => {
  // Живая трасса 28.09 (CLI 2.1.220): Bash с run_in_background, result, через
  // 20 с task_notification, init и новый ход — панель ничего не отправляла.
  // Такой ход не должен выглядеть ответом на следующее сообщение панели.
  const events = [];
  const busyStates = [];
  const a = new ClaudeAdapter({ command: "node", commandArgs: [FAKE_CLAUDE], cwd: catalog() }, (e) => {
    events.push(e);
    busyStates.push([e.kind, a.busy]);
  });
  try {
    await a.send({ text: "ФОНОВЫЙ-BASH-ПОЗЖЕ", from: "human" });
    await waitFor(() => events.filter((e) => e.kind === "turn_completed").length === 2, "два конца хода");
    const [first, second] = events.filter((e) => e.kind === "turn_completed");
    assert.equal(first.unsolicited, undefined);
    assert.equal(second.unsolicited, true);
    assert.deepEqual(second.usage, { input: 503, cached: 500, output: 4 });

    const start = events.find((e) => e.kind === "turn_started");
    assert.equal(start?.unsolicited, true);
    assert.match(start.text, /sleep 20 в фоне/);
    // Пока идёт самостоятельный ход, адаптер занят: координатор копит
    // сообщения в очереди, а не пишет их в чужой ход.
    const i = busyStates.findIndex(([kind]) => kind === "turn_started");
    assert.deepEqual(busyStates[i], ["turn_started", true]);
    assert.ok(events.some((e) => e.kind === "message" && e.text === "Команда завершена успешно."));
    assert.equal(a.busy, false);
  } finally {
    await a.stop();
  }
});

test("Claude: гонка — CLI начал свой запрос раньше, чем принял сообщение панели", async () => {
  // Рецензия Codex 28.09: сообщение ушло, когда CLI уже начал самостоятельный
  // запрос, а его init ещё не дошёл. По занятости их не различить; различает
  // эхо (--replay-user-messages): CLI повторяет сообщение внутри его запроса.
  const events = [];
  const busyStates = [];
  const a = new ClaudeAdapter({ command: "node", commandArgs: [FAKE_CLAUDE], cwd: catalog() }, (e) => {
    events.push(e);
    if (e.kind === "turn_completed") busyStates.push(a.busy);
  });
  try {
    await a.send({ text: "привет", from: "human" });
    await waitFor(() => events.some((e) => e.kind === "turn_completed"), "первый ход");
    assert.ok(events.find((e) => e.raw?.argv)?.raw.argv.includes("--replay-user-messages"));
    events.length = 0;
    busyStates.length = 0;

    await a.send({ text: "ГОНКА", from: "human" });
    await waitFor(() => events.filter((e) => e.kind === "turn_completed").length === 2, "два конца хода");
    const [foreign, own] = events.filter((e) => e.kind === "turn_completed");
    assert.equal(foreign.unsolicited, true);
    assert.deepEqual(foreign.usage, { input: 70, cached: 0, output: 7 });
    assert.equal(own.unsolicited, undefined);
    assert.deepEqual(own.usage, { input: 5, cached: 0, output: 5 });
    const start = events.find((e) => e.kind === "turn_started");
    assert.equal(start?.unsolicited, true);
    assert.match(start.text, /pytest/);
    // Реплика чужого запроса — до его конца, ответ на сообщение — после.
    const replyIndex = events.findIndex((e) => e.text === "ответ на сообщение");
    assert.ok(events.findIndex((e) => e.text === "итог фоновой") < events.indexOf(foreign));
    assert.ok(events.indexOf(foreign) < replyIndex);
    // Между концами адаптер занят: сообщение панели ещё ждёт ответа.
    assert.deepEqual(busyStates, [true, false]);
  } finally {
    await a.stop();
  }
});

test("Claude: свой запрос с ошибкой до эха — конец своего хода, а не чужой", async () => {
  // Рецензия Codex 28.09: иначе ход ждал бы следующего запроса вечно.
  const s = collector();
  const a = claude(s);
  try {
    await a.send({ text: "привет", from: "human" });
    await waitFor(() => s.events.some((e) => e.kind === "turn_completed"), "первый ход");
    s.events.length = 0;
    await a.send({ text: "ОШИБКА-ДО-ЭХА", from: "human" });
    await waitFor(() => s.events.some((e) => e.kind === "turn_completed"), "конец хода");
    const end = s.events.find((e) => e.kind === "turn_completed");
    assert.equal(end.failed, true);
    assert.equal(end.unsolicited, undefined);
    assert.equal(a.busy, false);
  } finally {
    await a.stop();
  }
});

test("Claude: субагент чужого запроса не держит свой ход", async () => {
  // Рецензия Codex 28.09: субагент запроса без эха попадал в общий набор,
  // держал ответ на сообщение, а его итог становился частью этого ответа.
  const s = collector();
  const a = claude(s);
  try {
    await a.send({ text: "привет", from: "human" });
    await waitFor(() => s.events.some((e) => e.kind === "turn_completed"), "первый ход");
    s.events.length = 0;
    await a.send({ text: "ЧУЖОЙ-СУБАГЕНТ", from: "human" });
    await waitFor(() => s.events.filter((e) => e.kind === "turn_completed").length === 3, "три конца хода");
    const [foreign, own, continuation] = s.events.filter((e) => e.kind === "turn_completed");
    assert.equal(foreign.unsolicited, true);
    assert.equal(own.unsolicited, undefined);
    assert.equal(continuation.unsolicited, true);
    const i = (text) => s.events.findIndex((e) => e.text === text);
    assert.ok(i("ответ на сообщение") < s.events.indexOf(own));
    assert.ok(s.events.indexOf(own) < i("итог чужого субагента"));
    assert.equal(s.events.some((e) => /ждёт субагентов/.test(e.text ?? "")), false);
  } finally {
    await a.stop();
  }
});

test("Claude: чужой запрос, запустивший субагента, чужой и при ошибке", async () => {
  // Рецензия Codex 28.09 (2febf2e): ошибка без эха считалась своей, даже если
  // запрос уже работал. Свой запрос повторяет сообщение раньше любого ответа
  // модели, значит, запрос без эха с ответом — чужой.
  const s = collector();
  const a = claude(s);
  try {
    await a.send({ text: "привет", from: "human" });
    await waitFor(() => s.events.some((e) => e.kind === "turn_completed"), "первый ход");
    s.events.length = 0;
    await a.send({ text: "ЧУЖОЙ-СУБАГЕНТ-С-ОШИБКОЙ", from: "human" });
    await waitFor(() => s.events.filter((e) => e.kind === "turn_completed").length === 3, "три конца хода");
    const [foreign, own, continuation] = s.events.filter((e) => e.kind === "turn_completed");
    assert.equal(foreign.unsolicited, true);
    assert.equal(foreign.failed, true);
    assert.equal(own.unsolicited, undefined);
    assert.equal(own.failed, undefined);
    assert.equal(continuation.unsolicited, true);
  } finally {
    await a.stop();
  }
});

test("Claude: чужой запрос, начавший поток и упавший, — чужой", async () => {
  // Рецензия Codex 28.09 (fe9bce2): до ошибки мог прийти только stream_event.
  const s = collector();
  const a = claude(s);
  try {
    await a.send({ text: "привет", from: "human" });
    await waitFor(() => s.events.some((e) => e.kind === "turn_completed"), "первый ход");
    s.events.length = 0;
    await a.send({ text: "ЧУЖОЙ-ПОТОК", from: "human" });
    await waitFor(() => s.events.filter((e) => e.kind === "turn_completed").length === 2, "два конца хода");
    const [foreign, own] = s.events.filter((e) => e.kind === "turn_completed");
    assert.equal(foreign.unsolicited, true);
    assert.equal(own.unsolicited, undefined);
    assert.equal(own.failed, undefined);
  } finally {
    await a.stop();
  }
});

test("Claude: стартовый init без сообщения — не самостоятельный ход", async () => {
  // Рецензия Codex 28.09: публичный start() без send. Фальшивый CLI пишет init
  // сразу при запуске (настоящий 2.1.220 молчит до сообщения — проба 28.09).
  const s = collector();
  const a = claude(s);
  try {
    await a.start();
    await waitFor(() => s.events.some((e) => e.raw?.argv), "init при запуске");
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(s.events.some((e) => e.kind === "turn_started"), false);
    assert.equal(a.busy, false);
  } finally {
    await a.stop();
  }
});

test("Claude: причина самостоятельного хода не переходит из прежнего процесса", async () => {
  // Рецензия Codex 28.09: уведомление о фоновой задаче остановленного процесса
  // не должно подписать ход нового.
  const s = collector();
  const a = claude(s);
  try {
    await a.send({ text: "ФОН-УВЕДОМЛЕНИЕ-БЕЗ-ХОДА", from: "human" });
    await waitFor(() => s.events.some((e) => e.kind === "turn_completed"), "ход");
    await new Promise((r) => setTimeout(r, 150));
    await a.stop();
    s.events.length = 0;
    await a.send({ text: "САМ-БЕЗ-ПРИЧИНЫ", from: "human" });
    await waitFor(() => s.events.some((e) => e.kind === "turn_started"), "самостоятельный ход");
    const start = s.events.find((e) => e.kind === "turn_started");
    assert.doesNotMatch(start.text, /старая/);
  } finally {
    await a.stop();
  }
});

test("Claude: фоновая команда без продолжения — ход кончается сразу и не ждёт её", async () => {
  // Фоновая команда (сервер) может не кончиться никогда: держать ход ради неё нельзя.
  const s = collector();
  const a = claude(s);
  try {
    await a.send({ text: "ФОНОВЫЙ-BASH", from: "human" });
    await waitFor(() => s.events.some((e) => e.kind === "turn_completed"), "конец хода");
    assert.equal(s.events.some((e) => e.kind === "turn_started"), false);
    assert.equal(a.busy, false);
  } finally {
    await a.stop();
  }
});

test("Claude: субагент кончился, а продолжения нет — ход закрывается по сроку", async () => {
  const s = collector();
  const a = claude(s, { backgroundGraceMs: 200 });
  try {
    await a.send({ text: "ФОНОВЫЙ-БЕЗ-ПРОДОЛЖЕНИЯ", from: "human" });
    await waitFor(() => s.events.some((e) => e.kind === "turn_completed"), "конец хода по сроку");
    const end = s.events.find((e) => e.kind === "turn_completed");
    assert.match(end.text, /продолжени/);
    assert.equal(a.busy, false);
  } finally {
    await a.stop();
  }
});

test("Codex: поздний конец прерванного хода не закрывает новый ход", async () => {
  // Рецензия Codex 28.09: turn/completed прерванного хода приходит после
  // ответа на turn/interrupt; без сверки с ходом он снимал бы новый.
  const s = collector();
  const a = codex(s);
  try {
    await a.send({ text: "ДОЛГИЙ-ХОД", from: "human" });
    await waitFor(() => s.events.some((e) => e.kind === "turn_started"), "начало долгого хода");
    await a.interrupt();
    s.events.length = 0;
    await a.send({ text: "ПОЗЖЕ", from: "human" });
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(a.busy, true, "новый ход ещё идёт");
    assert.equal(s.events.some((e) => e.kind === "turn_completed"), false);
    await waitFor(() => s.events.some((e) => e.kind === "turn_completed"), "конец нового хода");
    const end = s.events.find((e) => e.kind === "turn_completed");
    assert.equal(end.failed, undefined);
    assert.ok(s.events.some((e) => e.kind === "message" && e.text === "поздний ответ"));
  } finally {
    await a.stop();
  }
});

test("Codex: «Прервать» во время запуска процесса отменяет отправку", async () => {
  // Рецензия Codex 28.09 (2febf2e): пока шёл запуск, адаптер не был занят, и
  // прерывание ничего не делало — ход начинался после него.
  const s = collector();
  const a = codex(s);
  try {
    // Обработчик — сразу: отказ приходит во время прерывания.
    const outgoing = a.send({ text: "ПОЗЖЕ", from: "human" }).then(() => "ушла", (err) => err);
    await a.interrupt();
    assert.ok((await outgoing) instanceof Error, "отправка отменена");
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(a.busy, false);
    assert.equal(s.events.some((e) => e.kind === "message" && e.text === "поздний ответ"), false);
  } finally {
    await a.stop();
  }
});

test("Codex: второе «Прервать» до начала нового хода не адресуется прежнему", async () => {
  // Рецензия Codex 28.09 (2febf2e): после первого прерывания #ход оставался
  // прежним, и второе прерывание уходило ему, а новый ход продолжался.
  const s = collector();
  const a = codex(s);
  try {
    await a.send({ text: "ДОЛГИЙ-ХОД", from: "human" });
    await waitFor(() => s.events.some((e) => e.kind === "turn_started"), "начало долгого хода");
    await a.interrupt();
    const outgoing = a.send({ text: "ПОЗЖЕ", from: "human" }).catch(() => undefined);
    await a.interrupt();
    await outgoing;
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(a.busy, false);
    assert.equal(s.events.some((e) => e.kind === "message" && e.text === "поздний ответ"), false);
  } finally {
    await a.stop();
  }
});

test("Codex: метка прерванного хода не переживает перезапуск процесса", async () => {
  // Рецензия Codex 28.09 (2febf2e): номера ходов нового процесса могут
  // совпасть с прежними; пропущенный конец оставил бы адаптер занятым.
  const s = collector();
  const a = codex(s);
  try {
    await a.send({ text: "ДОЛГИЙ-ХОД", from: "human" });
    await waitFor(() => s.events.some((e) => e.kind === "turn_started"), "начало долгого хода");
    await a.interrupt();
    await a.stop();
    s.events.length = 0;
    await a.send({ text: "привет", from: "human" });
    await waitFor(() => s.events.some((e) => e.kind === "turn_completed"), "конец хода нового процесса");
    assert.equal(a.busy, false);
  } finally {
    await a.stop();
  }
});

test("Claude: команда с пробелом в пути запускается через оболочку Windows", { skip: process.platform !== "win32" }, async () => {
  // Рецензия Codex 28.09 (2febf2e): путь без кавычек cmd.exe делил на части.
  const dir = join(catalog(), "папка с пробелом");
  mkdirSync(dir);
  const wrapper = join(dir, "fake claude.cmd");
  writeFileSync(wrapper, `@"${process.execPath}" "${FAKE_CLAUDE}" %*\r\n`);
  const s = collector();
  const a = new ClaudeAdapter({ command: wrapper, cwd: catalog() }, s.sink);
  try {
    await a.send({ text: "привет", from: "human" });
    await waitFor(() => s.events.some((e) => e.kind === "turn_completed"), "ход через обёртку");
    assert.ok(s.events.some((e) => e.kind === "message" && e.text === "привет"));
  } finally {
    await a.stop();
  }
});

test("Codex: сбой при запуске не снимает занятость следующей отправки", async () => {
  // Рецензия Codex 28.09 (fe9bce2): процесс умер при запуске, координатор уже
  // отправил следующее сообщение, а catch прежней отправки снял его занятость.
  const label = join(catalog(), "умер");
  const events = [];
  let secondRun;
  let busyAfterFailure;
  const a = new CodexAdapter(
    { command: "node", commandArgs: [FAKE_CODEX, "--die-once", label], cwd: catalog() },
    (e) => {
      events.push(e);
      if (e.kind === "error" && e.failed && !secondRun) {
        secondRun = a.send({ text: "ПОЗЖЕ", from: "human" }).then(() => "ушла", (err) => err);
      }
    },
  );
  try {
    const firstLine = a.send({ text: "привет", from: "human" }).then(() => "ушла", (err) => {
      // Вторая отправка уже начата (в обработчике ошибки), её ход ещё не
      // начался: в этом окне координатор по busy решает, слать ли третью.
      busyAfterFailure = a.busy;
      return err;
    });
    assert.ok((await firstLine) instanceof Error, "первая отправка не удалась");
    assert.ok(secondRun, "вторая отправка начата при сбое");
    assert.equal(busyAfterFailure, true, "занятость второй отправки не снята");
    assert.equal(await secondRun, "ушла");
    assert.equal(a.busy, true, "второй ход ещё идёт");
    await waitFor(() => events.some((e) => e.kind === "message" && e.text === "поздний ответ"), "ответ второго хода");
  } finally {
    await a.stop();
  }
});

test("Codex: поздние элементы прерванного хода не попадают в новый ход", async () => {
  // Рецензия Codex 28.09 (8d38285): фильтровался только turn/completed, а
  // поздний item/completed мог войти в ответ новой проверки.
  const s = collector();
  const a = codex(s);
  try {
    await a.send({ text: "ДОЛГИЙ-ХОД", from: "human" });
    await waitFor(() => s.events.some((e) => e.kind === "turn_started"), "начало долгого хода");
    await a.interrupt();
    s.events.length = 0;
    await a.send({ text: "ПОЗЖЕ", from: "human" });
    await waitFor(() => s.events.some((e) => e.kind === "turn_completed"), "конец нового хода");
    const replies = s.events.filter((e) => e.kind === "message").map((e) => e.text);
    assert.deepEqual(replies, ["поздний ответ"]);
  } finally {
    await a.stop();
  }
});

test("Codex: поздний конец прерванного хода не выдаётся концом хода и без нового", async () => {
  // Рецензия Codex 28.09 (fe9bce2): при свободном адаптере поздний конец
  // становился ложным turn_completed.
  const s = collector();
  const a = codex(s);
  try {
    await a.send({ text: "ДОЛГИЙ-ХОД", from: "human" });
    await waitFor(() => s.events.some((e) => e.kind === "turn_started"), "начало долгого хода");
    await a.interrupt();
    s.events.length = 0;
    await waitFor(() => s.events.some((e) => /поздний конец прерванного/.test(e.text ?? "")), "поздний конец");
    assert.equal(s.events.some((e) => e.kind === "turn_completed"), false);
  } finally {
    await a.stop();
  }
});

test("Codex: метка прерванного хода не переживает и неожиданную смерть процесса", async () => {
  // Рецензия Codex 28.09 (1c5e618): stop() набор очищал, #конец — нет.
  const s = collector();
  const a = codex(s);
  try {
    await a.send({ text: "ДОЛГИЙ-ХОД", from: "human" });
    await waitFor(() => s.events.some((e) => e.kind === "turn_started"), "начало долгого хода");
    await a.interrupt();
    await a.send({ text: "УПАСТЬ-ХОД", from: "human" }).catch(() => undefined);
    await waitFor(() => s.events.some((e) => e.kind === "error" && e.failed), "смерть процесса");
    s.events.length = 0;
    await a.send({ text: "привет", from: "human" });
    await waitFor(() => s.events.some((e) => e.kind === "turn_completed"), "конец хода нового процесса");
    assert.equal(a.busy, false);
  } finally {
    await a.stop();
  }
});

test("Claude: относительный путь с пробелом — от каталога агента", { skip: process.platform !== "win32" }, async () => {
  // Рецензия Codex 28.09 (1c5e618): путь проверялся от каталога расширения.
  const root = catalog();
  mkdirSync(join(root, "папка с пробелом"));
  writeFileSync(join(root, "папка с пробелом", "fake claude.cmd"), `@"${process.execPath}" "${FAKE_CLAUDE}" %*\r\n`);
  const s = collector();
  const a = new ClaudeAdapter({ command: "папка с пробелом\\fake claude.cmd", cwd: root }, s.sink);
  try {
    await a.send({ text: "привет", from: "human" });
    await waitFor(() => s.events.some((e) => e.kind === "turn_completed"), "ход через обёртку");
  } finally {
    await a.stop();
  }
});

test("Claude: команда с аргументом в строке не берётся в кавычки целиком", { skip: process.platform !== "win32" }, async () => {
  // Рецензия Codex 28.09 (fe9bce2): «node script.js» в кавычках — одно имя.
  const s = collector();
  const a = new ClaudeAdapter({ command: `node ${FAKE_CLAUDE}`, cwd: catalog() }, s.sink);
  try {
    await a.send({ text: "привет", from: "human" });
    await waitFor(() => s.events.some((e) => e.kind === "turn_completed"), "ход");
  } finally {
    await a.stop();
  }
});

test("Claude: после «новой сессии» процесс запускается без --resume", async () => {
  const s = collector();
  const a = claude(s, { resumeSessionId: "старая-сессия" });
  try {
    await a.start();
    await waitFor(() => s.events.some((e) => e.raw?.argv), "первый запуск");
    assert.ok(s.events.find((e) => e.raw?.argv).raw.argv.includes("--resume"));
    await a.forgetSession();
    s.events.length = 0;
    await a.start();
    await waitFor(() => s.events.some((e) => e.raw?.argv), "запуск после забвения");
    assert.equal(s.events.find((e) => e.raw?.argv).raw.argv.includes("--resume"), false);
  } finally {
    await a.stop();
  }
});

test("Claude: отправка во время «новой сессии» не возобновляет прежнюю", async () => {
  const s = collector();
  const a = claude(s, { resumeSessionId: "старая-сессия" });
  try {
    await a.start();
    await waitFor(() => s.events.some((e) => e.raw?.argv), "первый запуск");
    s.events.length = 0;
    const forget = a.forgetSession();
    await a.send({ text: "здравствуй", from: "human" });
    await forget;
    await waitFor(() => s.events.some((e) => e.raw?.argv), "запуск после забвения");
    assert.equal(s.events.find((e) => e.raw?.argv).raw.argv.includes("--resume"), false);
  } finally {
    await a.stop();
  }
});

test("Claude: пользовательские настройки с хуками по умолчанию не загружаются", async () => {
  const s = collector();
  const a = claude(s);
  try {
    await a.start();
    await waitFor(() => s.events.some((e) => e.raw?.argv), "запись запуска");
    const argv = s.events.find((e) => e.raw?.argv).raw.argv;
    const i = argv.indexOf("--setting-sources");
    assert.ok(i >= 0, "без флага в сессии панели срабатывают хуки владельца");
    assert.equal(argv[i + 1], "project,local");
  } finally {
    await a.stop();
  }
});

test("Claude: stderr — диагностика без цветовых кодов, а не ошибка в беседе", async () => {
  const s = collector();
  const a = claude(s);
  try {
    await a.start();
    await waitFor(
      () => s.events.some((e) => e.kind === "diagnostic" && /WARN/.test(e.text ?? "")),
      "диагностика",
    );
    const d = s.events.filter((e) => e.kind === "diagnostic");
    assert.ok(d.every((e) => !/\x1b\[/.test(e.text ?? "")), "цветовые коды не вычищены");
    assert.ok(d.every((e) => e.visibility === "stream"), "диагностика не передаётся агенту");
    assert.deepEqual(errors(s.events), []);
  } finally {
    await a.stop();
  }
});

test("Claude: ход с ошибкой — завершение хода с отметкой провала", async () => {
  const s = collector();
  const a = claude(s);
  try {
    await a.send({ text: "ОШИБКА-ХОДА", from: "human" });
    await waitFor(() => s.events.some((e) => e.kind === "turn_completed"), "конец хода");
    const end = s.events.find((e) => e.kind === "turn_completed");
    assert.equal(end.failed, true);
    assert.equal(a.busy, false);
  } finally {
    await a.stop();
  }
});

test("Claude: отказы в разрешениях приходят в завершении хода, ход не провален", async () => {
  // Отказы приходят при is_error: false, поэтому по failed их не отличить.
  const s = collector();
  const a = claude(s);
  try {
    await a.send({ text: "ОТКАЗ", from: "human" });
    await waitFor(() => s.events.some((e) => e.kind === "turn_completed"), "конец хода");
    const end = s.events.find((e) => e.kind === "turn_completed");
    assert.notEqual(end.failed, true);
    assert.deepEqual(end.denials, ["Bash: git -C C:\\agent-panel show d748e88"]);
  } finally {
    await a.stop();
  }
});

// --- Разрешения: --permission-prompt-tool stdio ------------------------------

const REPLY_PREFIX = "ОТВЕТ-ПАНЕЛИ ";
/** Что панель ответила агенту: фальшивка пишет каждый control_response в stderr. */
const panelReplies = (events) =>
  events
    .filter((e) => e.kind === "diagnostic" && (e.text ?? "").startsWith(REPLY_PREFIX))
    .map((e) => JSON.parse(e.text.slice(REPLY_PREFIX.length)));
const find = (events, kind) => events.find((e) => e.kind === kind);

async function requestPermission(s, a) {
  await a.send({ text: "НУЖНО-РАЗРЕШЕНИЕ", from: "human" });
  await waitFor(() => find(s.events, "approval_requested"), "запрос разрешения");
  return find(s.events, "approval_requested");
}

test("Claude: запускается с каналом запросов разрешений", async () => {
  const s = collector();
  const a = claude(s);
  try {
    await a.start();
    await waitFor(() => s.events.some((e) => e.raw?.argv), "запись запуска");
    const argv = s.events.find((e) => e.raw?.argv).raw.argv;
    const i = argv.indexOf("--permission-prompt-tool");
    assert.ok(i >= 0, "без флага действия, требующие согласия, отклоняются молча");
    assert.equal(argv[i + 1], "stdio");
  } finally {
    await a.stop();
  }
});

test("Claude: запрос разрешения — событие с командой, ход ждёт ответа человека", async () => {
  const s = collector();
  const a = claude(s);
  try {
    const z = await requestPermission(s, a);
    assert.equal(z.tool, "Bash");
    assert.equal(z.callId, "perm-1");
    assert.match(z.text, /mkdir probe-dir/);
    assert.deepEqual(z.sessionRules, ["Bash(mkdir probe-dir *)"]);
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(!find(s.events, "turn_completed"), "ход не должен завершаться без ответа");
    assert.equal(a.busy, true);
  } finally {
    await a.stop();
  }
});

test("Claude: «разрешить» — агент получает исходный ввод, ход завершается без отказов", async () => {
  const s = collector();
  const a = claude(s);
  try {
    await requestPermission(s, a);
    assert.equal(await a.answerApproval("perm-1", "allow"), true);
    assert.equal(await a.answerApproval("perm-1", "allow"), false, "повторный ответ не отправляется");
    await waitFor(() => find(s.events, "turn_completed"), "конец хода");
    const replies = panelReplies(s.events);
    assert.equal(replies.length, 1);
    assert.equal(replies[0].subtype, "success");
    assert.equal(replies[0].request_id, "perm-1");
    assert.deepEqual(replies[0].response, {
      behavior: "allow",
      updatedInput: { command: "mkdir probe-dir", description: "Create directory" },
    });
    const decision = find(s.events, "approval_decided");
    assert.equal(decision.callId, "perm-1");
    assert.match(decision.text, /разрешено/);
    assert.equal(find(s.events, "turn_completed").denials, undefined);
  } finally {
    await a.stop();
  }
});

test("Claude: «в этой сессии» — только правила команды и только на сессию", async () => {
  // Предложение addRules приходит с destination localSettings: записать его
  // как есть значило бы править файл настроек владельца. setMode acceptEdits
  // разрешил бы все правки сразу — шире, чем видит человек на кнопке.
  const s = collector();
  const a = claude(s);
  try {
    await requestPermission(s, a);
    assert.equal(await a.answerApproval("perm-1", "allowSession"), true);
    await waitFor(() => find(s.events, "turn_completed"), "конец хода");
    const [reply] = panelReplies(s.events);
    assert.deepEqual(reply.response.updatedPermissions, [
      {
        type: "addRules",
        rules: [{ toolName: "Bash", ruleContent: "mkdir probe-dir *" }],
        behavior: "allow",
        destination: "session",
      },
    ]);
    assert.match(find(s.events, "approval_decided").text, /в этой сессии/);
  } finally {
    await a.stop();
  }
});

test("Claude: «отклонить» — агент получает причину, отказ человека не удерживает работу", async () => {
  // Отказ, данный человеком, — его решение, а не блокировка: повторять ход
  // незачем, работа идёт дальше как обычно.
  const s = collector();
  const a = claude(s);
  try {
    await requestPermission(s, a);
    assert.equal(await a.answerApproval("perm-1", "deny"), true);
    await waitFor(() => find(s.events, "turn_completed"), "конец хода");
    const [reply] = panelReplies(s.events);
    assert.equal(reply.response.behavior, "deny");
    assert.match(reply.response.message, /человек/);
    assert.match(find(s.events, "approval_decided").text, /отклонено/);
    assert.equal(find(s.events, "turn_completed").denials, undefined);
  } finally {
    await a.stop();
  }
});

test("Claude: остановка закрывает открытый запрос, поздний ответ не отправляется", async () => {
  const s = collector();
  const a = claude(s);
  try {
    await requestPermission(s, a);
    await a.stop();
    const decision = find(s.events, "approval_decided");
    assert.ok(decision, "карточка запроса осталась бы открытой навсегда");
    assert.equal(decision.callId, "perm-1");
    assert.equal(await a.answerApproval("perm-1", "allow"), false);
  } finally {
    await a.stop();
  }
});

test("Claude: необслуживаемый запрос агента получает ответ-ошибку, ход не виснет", async () => {
  const s = collector();
  const a = claude(s);
  try {
    await a.send({ text: "ЧУЖОЙ-ЗАПРОС", from: "human" });
    await waitFor(() => find(s.events, "turn_completed"), "конец хода");
    const [reply] = panelReplies(s.events);
    assert.equal(reply.subtype, "error");
    assert.equal(reply.request_id, "hook-1");
    assert.equal(find(s.events, "approval_requested"), undefined);
  } finally {
    await a.stop();
  }
});

// --- Модель и уровень рассуждения ---------------------------------------------

const launches = (events) => events.filter((e) => e.raw?.argv).map((e) => e.raw.argv);
const flag = (argv, name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const ends = (events) => events.filter((e) => e.kind === "turn_completed").length;

test("Claude: список моделей — из ответа initialize, без рабочей сессии", async () => {
  const s = collector();
  const a = claude(s);
  try {
    const catalog = await a.listModels();
    assert.deepEqual(catalog.map((m) => m.id), ["", "sonnet", "opus", "haiku"]);
    assert.equal(catalog[0].label, "по умолчанию (Sonnet 5)");
    assert.deepEqual(catalog[0].efforts, ["low", "medium", "high", "xhigh", "max"]);
    assert.equal(catalog.find((m) => m.id === "opus").label, "Opus");
    assert.deepEqual(catalog.find((m) => m.id === "haiku").efforts, [], "у Haiku нет уровней");
    assert.deepEqual(launches(s.events), [], "список моделей не должен поднимать рабочую сессию");
    assert.equal(a.busy, false);
  } finally {
    await a.stop();
  }
});

test("Claude: выбранные модель и уровень передаются при запуске", async () => {
  const s = collector();
  const a = claude(s, { model: "opus", effort: "high" });
  try {
    await a.send({ text: "здравствуй", from: "human" });
    await waitFor(() => ends(s.events) === 1, "конец хода");
    const [argv] = launches(s.events);
    assert.equal(flag(argv, "--model"), "opus");
    assert.equal(flag(argv, "--effort"), "high");
  } finally {
    await a.stop();
  }
});

test("Claude: смена модели между ходами — перезапуск с той же сессией", async () => {
  const s = collector();
  const a = claude(s);
  try {
    await a.send({ text: "здравствуй", from: "human" });
    await waitFor(() => ends(s.events) === 1, "первый ход");
    assert.equal(flag(launches(s.events)[0], "--model"), undefined, "без выбора флаг не передаётся");

    a.setModel({ model: "haiku", effort: "" });
    await a.send({ text: "здравствуй", from: "human" });
    await waitFor(() => ends(s.events) === 2, "второй ход");
    const all = launches(s.events);
    assert.equal(all.length, 2);
    assert.equal(flag(all[1], "--model"), "haiku");
    assert.equal(flag(all[1], "--effort"), undefined);
    assert.equal(flag(all[1], "--resume"), "fake-claude-session", "контекст сессии не должен теряться");
  } finally {
    await a.stop();
  }
});

test("Claude: тот же выбор не перезапускает процесс", async () => {
  const s = collector();
  const a = claude(s, { model: "opus", effort: "" });
  try {
    await a.send({ text: "здравствуй", from: "human" });
    await waitFor(() => ends(s.events) === 1, "первый ход");
    a.setModel({ model: "opus", effort: "" });
    await a.send({ text: "здравствуй", from: "human" });
    await waitFor(() => ends(s.events) === 2, "второй ход");
    assert.equal(launches(s.events).length, 1);
  } finally {
    await a.stop();
  }
});

// --- Режим разрешений ----------------------------------------------------------

test("Claude: режим разрешений передаётся при запуске; «спрашивать» — без флага", async () => {
  for (const [mode, expected] of [["bypassPermissions", "bypassPermissions"], ["default", undefined]]) {
    const s = collector();
    const a = claude(s, { permissionMode: mode });
    try {
      await a.start();
      await waitFor(() => launches(s.events).length === 1, "запись запуска");
      assert.equal(flag(launches(s.events)[0], "--permission-mode"), expected, mode);
    } finally {
      await a.stop();
    }
  }
});

test("Claude: «без вопросов» посреди хода разрешает открытый запрос сразу", async () => {
  // Проба на Claude Code 2.1.220: setMode bypassPermissions в ответе на запрос
  // не отключил следующий запрос в той же сессии. Поэтому до перезапуска
  // разрешает панель, а флаг запуска действует со следующего хода.
  const s = collector();
  const a = claude(s);
  try {
    await requestPermission(s, a);
    a.setPermissionMode("bypassPermissions");
    await waitFor(() => find(s.events, "turn_completed"), "конец хода");
    const [reply] = panelReplies(s.events);
    assert.equal(reply.response.behavior, "allow");
    assert.match(find(s.events, "approval_decided").text, /без вопросов/);
  } finally {
    await a.stop();
  }
});

test("Claude: смена режима разрешений — перезапуск с флагом и той же сессией", async () => {
  const s = collector();
  const a = claude(s);
  try {
    await a.send({ text: "здравствуй", from: "human" });
    await waitFor(() => ends(s.events) === 1, "первый ход");
    a.setPermissionMode("bypassPermissions");
    await a.send({ text: "НУЖНО-РАЗРЕШЕНИЕ", from: "human" });
    await waitFor(() => ends(s.events) === 2, "второй ход");
    const all = launches(s.events);
    assert.equal(all.length, 2);
    assert.equal(flag(all[1], "--permission-mode"), "bypassPermissions");
    assert.equal(flag(all[1], "--resume"), "fake-claude-session");
    // Фальшивка режима не знает и спрашивает — панель отвечает сама, ход не стоит.
    assert.equal(panelReplies(s.events)[0].response.behavior, "allow");
  } finally {
    await a.stop();
  }
});

test("Claude: плановая остановка не показывается как ошибка", async () => {
  const s = collector();
  const a = claude(s);
  try {
    await a.send({ text: "здравствуй", from: "human" });
    await waitFor(() => s.events.some((e) => e.kind === "turn_completed"), "конец хода");
    await a.stop();
    await waitFor(
      () => s.events.some((e) => e.kind === "diagnostic" && /остановлен/.test(e.text ?? "")),
      "отметка об остановке",
    );
    assert.deepEqual(errors(s.events), [], "закрытие комнаты — не авария");
  } finally {
    await a.stop();
  }
});

test("Claude: внезапное падение — ошибка с отметкой, следующая отправка поднимает ту же сессию", async () => {
  const s = collector();
  const a = claude(s);
  try {
    await a.send({ text: "здравствуй", from: "human" });
    await waitFor(() => s.events.some((e) => e.kind === "turn_completed"), "первый ход");
    await a.send({ text: "УПАСТЬ", from: "human" });
    await waitFor(() => errors(s.events).length > 0, "ошибка падения");
    assert.equal(errors(s.events)[0].failed, true);
    assert.equal(a.busy, false, "мёртвый процесс не может оставаться занятым");

    await a.send({ text: "здравствуй снова", from: "human" });
    await waitFor(
      () => s.events.filter((e) => e.kind === "message").length === 2,
      "ответ после перезапуска",
    );
    const second = s.events.filter((e) => e.raw?.argv).at(-1).raw.argv;
    const i = second.indexOf("--resume");
    assert.ok(i >= 0, "без --resume перезапуск потерял бы историю");
    assert.equal(second[i + 1], "fake-claude-session");
  } finally {
    await a.stop();
  }
});

test("Claude: session_id сообщается обратным вызовом", async () => {
  const s = collector();
  const receivedEvents = [];
  const a = claude(s, { onSessionId: (id) => receivedEvents.push(id) });
  try {
    await a.start();
    await waitFor(() => receivedEvents.length > 0, "обратный вызов");
    assert.deepEqual(receivedEvents, ["fake-claude-session"]);
  } finally {
    await a.stop();
  }
});

test("Claude: заголовок сообщения — из prompt.heading, иначе по отправителю", () => {
  assert.match(formatForClaude({ text: "т", from: "human" }), /^\[от человека\]\nт$/);
  assert.match(formatForClaude({ text: "т", from: "codex" }), /^\[замечание рецензента Codex\]/);
  assert.match(formatForClaude({ text: "т", from: "gemini" }), /^\[замечание рецензента Gemini\]/);
  assert.equal(
    formatForClaude({ text: "т", from: "codex", heading: "[замечания рецензентов Codex и Gemini]", snapshot: "abc" }),
    "[замечания рецензентов Codex и Gemini]\n[версия файлов: abc]\nт",
  );
});

test("Claude: несуществующая команда — ошибка с отметкой, а не падение панели", async () => {
  // Без обработчиков error на процессе и его stdin необработанное
  // исключение уронило бы хост расширений VS Code целиком.
  const s = collector();
  const a = new ClaudeAdapter({ command: MISSING_COMMAND, cwd: catalog() }, s.sink);
  try {
    try {
      await a.send({ text: "здравствуй", from: "human" });
    } catch {
      // Отказ отправки допустим; недопустимо падение процесса.
    }
    await waitFor(
      () => errors(s.events).some((e) => e.failed === true),
      "ошибка запуска",
    );
    assert.equal(a.busy, false);
  } finally {
    await a.stop();
  }
});

// ---------------------------------------------------------------------------
// Жизненный цикл процессов
//
// Найдено рецензентом. На Windows процесс запускается через cmd.exe
// (shell:true), и kill() убивает оболочку, а не агента с его командами.
// Следующее сообщение поднимало второго Claude на ту же сессию, пока первый
// ещё работал.
// ---------------------------------------------------------------------------

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("Claude: остановка убивает агента и его команды, и ждёт их завершения", async () => {
  const s = collector();
  const a = claude(s);
  const file = join(catalog(), "pids.json");
  let pids;
  try {
    await a.send({ text: `ДОЛГАЯ-КОМАНДА ${file}`, from: "human" });
    await waitFor(() => {
      try {
        pids = JSON.parse(readFileSync(file, "utf8"));
        return true;
      } catch {
        return false;
      }
    }, "запуск долгой команды");
    assert.ok(isAlive(pids.grandchild), "долгая команда должна работать до остановки");

    await a.stop();
    assert.equal(isAlive(pids.agent), false, "после stop() агент не должен быть жив");
    assert.equal(isAlive(pids.grandchild), false, "после stop() его команда не должна быть жива");
  } finally {
    await a.stop();
    if (pids && isAlive(pids.grandchild)) process.kill(pids.grandchild);
  }
});

// На Windows этот сценарий не проверяется, и это измерено, а не предположено.
// Если процесс перестал читать ввод, короткая запись в его канал проходит
// УСПЕШНО: ни ошибки записи, ни события error, процесс жив (опыт с
// fs.closeSync(0), 310 мс). Ошибка EPIPE приходит лишь после переполнения
// буфера канала — в опыте с непрерывной записью около 60 секунд. Одно
// сообщение агенту буфер не переполняет, поэтому детерминированной проверки
// на Windows нет. Обработка ошибки в адаптере при этом та же и срабатывает,
// когда система ошибку сообщает; на Windows от зависшего агента спасает
// кнопка «Остановить», которая теперь снимает всё дерево процессов.
const CHANNEL_UNCHECKED =
  process.platform === "win32" &&
  "на Windows запись в канал, который процесс перестал читать, проходит без ошибки до переполнения буфера (измерено)";

test("Claude: сломанный канал при живом процессе — ошибка, а не вечное ожидание", { skip: CHANNEL_UNCHECKED }, async () => {
  // Запуск без оболочки намеренно: через cmd.exe поломка канала не видна
  // вовсе — оболочка держит свою копию канала открытой.
  const s = collector();
  const a = new ClaudeAdapter(
    {
      command: process.execPath,
      commandArgs: [FAKE_CLAUDE, "--close-stdin"],
      cwd: catalog(),
      shell: false,
    },
    s.sink,
  );
  try {
    try {
      await a.send({ text: "здравствуй", from: "human" });
    } catch {
      // отказ отправки допустим
    }
    await waitFor(() => errors(s.events).some((e) => e.failed === true), "ошибка канала");
    assert.equal(a.busy, false, "ответа не будет — агент не может оставаться занятым");
  } finally {
    await a.stop();
  }
});

const TURN_PREFIX = "ПАРАМЕТРЫ-ХОДА ";
/** Модель и уровень каждого turn/start: фальшивка пишет их в stderr. */
const turnParams = (events) =>
  events
    .filter((e) => e.kind === "diagnostic" && (e.text ?? "").startsWith(TURN_PREFIX))
    .map((e) => JSON.parse(e.text.slice(TURN_PREFIX.length)));

test("Codex: список моделей — из model/list, скрытые пропущены, по умолчанию первой", async () => {
  const s = collector();
  const a = codex(s);
  try {
    const catalog = await a.listModels();
    assert.deepEqual(catalog.map((m) => m.id), ["", "gpt-sol", "gpt-luna"]);
    assert.equal(catalog[0].label, "по умолчанию (GPT-Sol)");
    assert.deepEqual(catalog[0].efforts, ["low", "medium", "high", "ultra"]);
    assert.equal(catalog[0].defaultEffort, "low");
    assert.equal(catalog.find((m) => m.id === "gpt-luna").defaultEffort, "medium");
    assert.equal(a.sessionId, undefined, "список моделей не должен создавать ветку");
  } finally {
    await a.stop();
  }
});

test("Codex: модель и уровень уходят в turn/start; без выбора не передаются", async () => {
  const s = collector();
  const a = codex(s);
  try {
    await a.send({ text: "здравствуй", from: "human" });
    await waitFor(() => ends(s.events) === 1, "первый ход");
    a.setModel({ model: "gpt-luna", effort: "high" });
    await a.send({ text: "здравствуй", from: "human" });
    await waitFor(() => ends(s.events) === 2, "второй ход");
    const [first, second] = turnParams(s.events);
    assert.deepEqual(first, {});
    assert.deepEqual(second, { model: "gpt-luna", effort: "high" });
  } finally {
    await a.stop();
  }
});

test("Codex: возврат к «по умолчанию» передаёт модель по умолчанию явно", async () => {
  // Модель, переданная в turn/start, остаётся у ветки: промолчать значило бы
  // оставить прежнюю.
  const s = collector();
  const a = codex(s);
  try {
    await a.listModels();
    a.setModel({ model: "gpt-luna", effort: "high" });
    await a.send({ text: "здравствуй", from: "human" });
    await waitFor(() => ends(s.events) === 1, "первый ход");
    a.setModel({ model: "", effort: "" });
    await a.send({ text: "здравствуй", from: "human" });
    await waitFor(() => ends(s.events) === 2, "второй ход");
    assert.deepEqual(turnParams(s.events)[1], { model: "gpt-sol", effort: "low" });
  } finally {
    await a.stop();
  }
});

test("Codex: немедленный перезапуск после остановки работает", async () => {
  // Сценарий рецензента: поздний exit старого процесса отклонял запросы
  // нового и убивал его запуск.
  const s = collector();
  const a = codex(s);
  try {
    for (let i = 1; i <= 3; i += 1) {
      await a.send({ text: `здравствуй ${i}`, from: "human" });
      await waitFor(
        () => s.events.filter((e) => e.kind === "turn_completed").length === i,
        `ход ${i}`,
      );
      await a.stop();
    }
    assert.deepEqual(errors(s.events), []);
  } finally {
    await a.stop();
  }
});

test("Codex: второе сообщение во время запуска не теряется", async () => {
  const s = collector();
  const a = codex(s);
  try {
    const firstSend = a.send({ text: "первое", from: "human" });
    const secondSend = a.send({ text: "второе", from: "human" });
    await Promise.all([firstSend, secondSend]);
    await waitFor(
      () => s.events.filter((e) => e.kind === "turn_completed").length === 2,
      "оба хода",
    );
    assert.deepEqual(errors(s.events), []);
  } finally {
    await a.stop();
  }
});

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

test("Codex: расход хода и недельный лимит из уведомлений app-server", async () => {
  // Живая проба 28.09: thread/tokenUsage/updated (last — последний ход) и
  // account/rateLimits/updated (primary.usedPercent, окно 10080 минут).
  const s = collector();
  const a = codex(s);
  try {
    await a.send({ text: "здравствуй", from: "claude" });
    await waitFor(() => s.events.some((e) => e.kind === "turn_completed"), "конец хода");
    const end = s.events.find((e) => e.kind === "turn_completed");
    assert.deepEqual(end.usage, { input: 17522, cached: 7936, output: 5 });
    assert.deepEqual(end.limit, { percent: 8, window: "week", resetsAt: 1791057755000 });
  } finally {
    await a.stop();
  }
});

test("Codex: расход хода — по своему turnId, с несколькими запросами и сбросом итога", async () => {
  // Рецензия Codex 28.09: повтор расхода прежнего хода при возобновлении,
  // несколько запросов модели в ходе и сброс накопительного итога после сжатия.
  const s = collector();
  const a = codex(s);
  try {
    await a.send({ text: "РАСХОД-СЛОЖНЫЙ", from: "claude" });
    await waitFor(() => s.events.some((e) => e.kind === "turn_completed"), "конец хода");
    assert.deepEqual(s.events.find((e) => e.kind === "turn_completed").usage, { input: 1200, cached: 0, output: 30 });
  } finally {
    await a.stop();
  }
});

test("Codex: расход без известного хода не приписывается текущему", async () => {
  const s = collector();
  const a = codex(s);
  try {
    await a.send({ text: "РАСХОД-БЕЗ-ХОДА", from: "claude" });
    await waitFor(() => s.events.some((e) => e.kind === "turn_completed"), "конец хода");
    assert.equal(s.events.find((e) => e.kind === "turn_completed").usage, undefined);
  } finally {
    await a.stop();
  }
});

test("Codex: после «новой сессии» ветка из настроек комнаты не возобновляется", async () => {
  const s = collector();
  const a = codex(s, { resumeThreadId: "ветка-владельца" });
  try {
    await a.send({ text: "здравствуй", from: "claude" });
    await waitFor(() => s.events.some((e) => e.kind === "turn_completed"), "ход в прежней ветке");
    assert.ok(s.events.some((e) => /ПАРАМЕТРЫ-ВЕТКИ .*"resume":true/.test(e.text ?? "")), "сначала ветка возобновлялась");
    s.events.length = 0;
    await a.forgetSession();
    await a.send({ text: "здравствуй", from: "claude" });
    await waitFor(() => s.events.some((e) => e.kind === "turn_completed"), "ход в новой ветке");
    assert.equal(s.events.some((e) => /ПАРАМЕТРЫ-ВЕТКИ .*"resume":true/.test(e.text ?? "")), false);
  } finally {
    await a.stop();
  }
});

test("Codex: начало и конец одного инструмента связаны id элемента", async () => {
  // Рецензия Codex 28.09: без callId один инструмент давал в панели две бусины.
  const s = collector();
  const a = codex(s);
  try {
    await a.send({ text: "КОМАНДА", from: "claude" });
    await waitFor(() => s.events.some((e) => e.kind === "turn_completed"), "конец хода");
    const call = s.events.find((e) => e.kind === "tool_call");
    const result = s.events.find((e) => e.kind === "tool_result");
    assert.ok(call && result, "нет начала или конца инструмента");
    assert.equal(call.callId, "cmd-1");
    assert.equal(result.callId, "cmd-1");
  } finally {
    await a.stop();
  }
});

test("Codex: ветка из thread.id, процесс поднимается сам, ответ и поток доходят", async () => {
  const s = collector();
  const a = codex(s);
  try {
    await a.send({ text: "здравствуй", from: "human" });
    await waitFor(() => s.events.some((e) => e.kind === "turn_completed"), "конец хода");
    assert.equal(a.sessionId, "fake-thread-1");
    assert.ok(s.events.some((e) => e.kind === "message" && e.text === "привет"));
    assert.deepEqual(
      s.events.filter((e) => e.kind === "text_delta").map((e) => e.text),
      ["при", "вет"],
    );
  } finally {
    await a.stop();
  }
});

test("Codex: ход со статусом failed — завершение с отметкой провала", async () => {
  const s = collector();
  const a = codex(s);
  try {
    await a.send({ text: "ОШИБКА-ХОДА", from: "human" });
    await waitFor(() => s.events.some((e) => e.kind === "turn_completed"), "конец хода");
    const end = s.events.find((e) => e.kind === "turn_completed");
    assert.equal(end.failed, true);
    assert.match(end.text ?? "", /сбой модели/);
    assert.equal(a.busy, false);
  } finally {
    await a.stop();
  }
});

test("Codex: stderr — диагностика без цветовых кодов, а не ошибка в беседе", async () => {
  // Ровно та строка, что в живом прогоне показалась красной репликой.
  const s = collector();
  const a = codex(s);
  try {
    await a.start();
    await waitFor(
      () => s.events.some((e) => e.kind === "diagnostic" && /ERROR/.test(e.text ?? "")),
      "диагностика",
    );
    const d = s.events.filter((e) => e.kind === "diagnostic");
    assert.ok(d.every((e) => !/\x1b\[/.test(e.text ?? "")));
    assert.deepEqual(errors(s.events), []);
  } finally {
    await a.stop();
  }
});

test("Codex: запрос на изменение файла отклоняется панелью", async () => {
  const s = collector();
  const a = codex(s);
  try {
    await a.send({ text: "ЗАПИСАТЬ", from: "human" });
    await waitFor(() => s.events.some((e) => e.kind === "approval_decided"), "решение");
    assert.equal(a.decisions[0].allow, false);
    await waitFor(
      () => s.events.some((e) => /ответ клиента: error/.test(e.text ?? "")),
      "фальшивый сервер получил отказ",
    );
  } finally {
    await a.stop();
  }
});

test("Codex: плановая остановка не показывается как ошибка", async () => {
  const s = collector();
  const a = codex(s);
  try {
    await a.send({ text: "здравствуй", from: "human" });
    await waitFor(() => s.events.some((e) => e.kind === "turn_completed"), "конец хода");
    await a.stop();
    await waitFor(
      () => s.events.some((e) => e.kind === "diagnostic" && /остановлен/.test(e.text ?? "")),
      "отметка об остановке",
    );
    assert.deepEqual(errors(s.events), []);
  } finally {
    await a.stop();
  }
});

test("Codex: идентификатор ветки сообщается обратным вызовом", async () => {
  const s = collector();
  const receivedEvents = [];
  const a = codex(s, { onSessionId: (id) => receivedEvents.push(id) });
  try {
    await a.start();
    await waitFor(() => receivedEvents.length > 0, "обратный вызов");
    assert.equal(receivedEvents[0], "fake-thread-1");
  } finally {
    await a.stop();
  }
});

test("Codex: несуществующая команда — отправка отклоняется, панель не падает", async () => {
  const s = collector();
  const a = new CodexAdapter({ command: MISSING_COMMAND, cwd: catalog() }, s.sink);
  try {
    await assert.rejects(a.send({ text: "здравствуй", from: "human" }));
    await waitFor(
      () => errors(s.events).some((e) => e.failed === true),
      "ошибка запуска",
    );
    assert.equal(a.busy, false, "отказ запуска не должен оставлять агента занятым");
  } finally {
    await a.stop();
  }
});

const THREAD_PREFIX = "ПАРАМЕТРЫ-ВЕТКИ ";
const threadParams = (events) =>
  events
    .filter((e) => e.kind === "diagnostic" && (e.text ?? "").startsWith(THREAD_PREFIX))
    .map((e) => JSON.parse(e.text.slice(THREAD_PREFIX.length)));

test("Codex: U+2028 в истории ветки не обрывает возобновление", async () => {
  // Живой прогон 02.10: ответ thread/resume (14 МБ истории) нёс U+2028/U+2029
  // как есть; readline резал по ним строку, ответ не разбирался, и запуск
  // ждал его вечно — пара висела на «Codex и Gemini проверяют».
  const s = collector();
  const a = codex(s, { resumeThreadId: "ветка-РАЗРЫВ" });
  let started = false;
  const sending = a.send({ text: "здравствуй", from: "claude" }).then(() => {
    started = true;
  });
  sending.catch(() => undefined);
  try {
    await waitFor(() => started, "ход в возобновлённой ветке", 3000);
    assert.equal(s.events.some((e) => /вне протокола/.test(e.text ?? "")), false);
  } finally {
    await a.stop();
  }
});

test("Codex: при возобновлении ветки роль рецензента задаётся заново", async () => {
  // Ветка владельца заведена в приложении Codex с ролью разработчика. При
  // возобновлении панель обязана вернуть роль рецензента: thread/resume
  // принимает developerInstructions наравне с thread/start (схема 0.153.0).
  const s = collector();
  const a = codex(s, { resumeThreadId: "чужая-ветка" });
  try {
    await a.start();
    await waitFor(() => threadParams(s.events).length === 1, "параметры возобновления");
    const p = threadParams(s.events)[0];
    assert.equal(p.resume, true);
    assert.equal(p.sandbox, "read-only");
    assert.match(p.developerInstructions, /рецензент/i, "без инструкции ветка сохранит прежнюю роль");
  } finally {
    await a.stop();
  }
});

// ---------------------------------------------------------------------------
// Gemini (agy)
//
// Блок — своя область видимости: launches ниже разбирает argv из init agy
// (raw.init.argv), а не из raw.argv, как у Claude/Codex выше, и под тем же
// именем не может быть вторым const на уровне модуля.
// ---------------------------------------------------------------------------
{
  /** argv процесса agy из его init: поле есть только у фальшивого agy. */
  const launches = (events) => events.filter((e) => e.kind === "diagnostic" && e.raw?.event === "init").map((e) => e.raw.init.argv);
  const completed = (events) => events.filter((e) => e.kind === "turn_completed");

  test("Gemini: запуск с -p=, потоком и своим агентом; реплика и расход хода — сумма шагов", async () => {
    const s = collector();
    const a = gemini(s);
    try {
      await a.send({ text: "проверь", from: "human" });
      await waitFor(() => completed(s.events).length === 1, "конец хода");
      const [argv] = launches(s.events);
      assert.ok(argv.includes("-p="), "-p без значения съел бы следующий флаг");
      assert.deepEqual(argv.slice(argv.indexOf("--agent"), argv.indexOf("--agent") + 2), ["--agent", "agent-panel-reviewer"]);
      assert.ok(argv.includes("stream-json"));
      assert.ok(!argv.includes("--model"), "модель по умолчанию — флаг не передаётся");
      assert.deepEqual(s.events.filter((e) => e.kind === "message").map((e) => e.text), ["готово: файл прочитан"]);
      const done = completed(s.events)[0];
      assert.deepEqual(done.usage, { input: 300, cached: 0, output: 12 });
      assert.equal(done.incomplete, undefined);
      assert.equal(done.failed, undefined);
      assert.equal(a.sessionId, "fake-agy-conv");
      const call = s.events.find((e) => e.kind === "tool_call");
      assert.equal(call.tool, "view_file");
      assert.equal(s.events.find((e) => e.kind === "tool_result").text, "2 lines, 21 bytes");
      assert.ok(!s.events.some((e) => e.kind === "error"), "служебный лог stderr — диагностика, а не ошибка");
    } finally {
      await a.stop();
    }
  });

  test("Gemini: U+2028 и U+2029 внутри строки JSON не режут её", async () => {
    const s = collector();
    const a = gemini(s);
    try {
      await a.send({ text: "РАЗРЫВ", from: "human" });
      await waitFor(() => completed(s.events).length === 1, "конец хода");
      assert.deepEqual(s.events.filter((e) => e.kind === "message").map((e) => e.text), ["до после конец"]);
      assert.equal(completed(s.events)[0].incomplete, undefined);
    } finally {
      await a.stop();
    }
  });

  test("Gemini: сообщение несёт заголовок, папку проекта и версию файлов", () => {
    const text = formatForGemini({ text: "материал", from: "claude", heading: "[материал проверки от панели]", snapshot: "abc" }, "C:/proj");
    assert.equal(text, "[материал проверки от панели]\n[папка проекта: C:/proj — ищи и читай файлы только в ней]\n[версия файлов: abc]\nматериал");
    assert.match(formatForGemini({ text: "т", from: "human" }, "C:/p"), /^\[от человека\]\n/);
  });

  test("Gemini: продолжение разговора — --conversation; накопительный итог прежнего процесса в расход не идёт", async () => {
    const s = collector();
    const ids = [];
    const a = gemini(s, { resumeConversationId: "conv-7", onSessionId: (id) => ids.push(id) });
    try {
      await a.send({ text: "продолжи", from: "human" });
      await waitFor(() => completed(s.events).length === 1, "конец хода");
      const [argv] = launches(s.events);
      assert.deepEqual(argv.slice(argv.indexOf("--conversation"), argv.indexOf("--conversation") + 2), ["--conversation", "conv-7"]);
      assert.deepEqual(completed(s.events)[0].usage, { input: 300, cached: 0, output: 12 }, "100 000 прежнего процесса не засчитаны");
      assert.deepEqual(ids, [], "тот же разговор — привязка не меняется");
    } finally {
      await a.stop();
    }
  });

  test("Gemini: мягкий отказ — пустой ответ и прирост denied_actions — проверка неполная", async () => {
    const s = collector();
    const a = gemini(s);
    try {
      await a.send({ text: "ОТКАЗ-БЕЗ-ЗАПРОСА", from: "human" });
      await waitFor(() => completed(s.events).length === 1, "первый ход");
      assert.match(completed(s.events)[0].incomplete, /отклонены без запроса: ReadUrlContent/);
      assert.deepEqual(completed(s.events)[0].denials, ["ReadUrlContent"]);
      await a.send({ text: "обычный ход", from: "human" });
      await waitFor(() => completed(s.events).length === 2, "второй ход");
      assert.equal(completed(s.events)[1].incomplete, undefined, "прежний отказ не засчитывается второй раз");
    } finally {
      await a.stop();
    }
  });

  test("Gemini: отказ с непустым ответом — не «не проверял», отказ всё равно виден в denials (M8)", async () => {
    const s = collector();
    const a = gemini(s);
    try {
      await a.send({ text: "ОТКАЗ-С-ОТВЕТОМ", from: "human" });
      await waitFor(() => completed(s.events).length === 1, "конец хода");
      assert.equal(completed(s.events)[0].incomplete, undefined, "непустой ответ — проверка состоялась");
      assert.deepEqual(completed(s.events)[0].denials, ["ReadUrlContent"]);
      assert.ok(s.events.some((e) => e.kind === "message" && /страницу не открыл/.test(e.text ?? "")));
    } finally {
      await a.stop();
    }
  });

  test("Gemini: запрет правилом — ошибка шага видна отказом, ход продолжается и отвечает", async () => {
    const s = collector();
    const a = gemini(s);
    try {
      await a.send({ text: "ЗАПРЕТ", from: "human" });
      await waitFor(() => completed(s.events).length === 1, "конец хода");
      assert.match(s.events.find((e) => e.kind === "tool_result").text, /permission check failed/);
      const decided = s.events.find((e) => e.kind === "approval_decided");
      assert.match(decided.text, /^отклонено правилом «только чтение»: write_to_file/);
      assert.equal(decided.toolCallId, s.events.find((e) => e.kind === "tool_call").callId);
      assert.ok(s.events.some((e) => e.kind === "message" && /запись запрещена/.test(e.text)));
      assert.equal(completed(s.events)[0].incomplete, undefined);
    } finally {
      await a.stop();
    }
  });

  test("Gemini: ход с ошибкой и отказ по региону — failed с причиной из stderr", async () => {
    const s = collector();
    const a = gemini(s);
    try {
      await a.send({ text: "ОШИБКА-ХОДА", from: "human" });
      await waitFor(() => completed(s.events).length === 1, "ход с ошибкой");
      assert.equal(completed(s.events)[0].failed, true);
      assert.match(completed(s.events)[0].text, /ERROR — model error \(model overloaded\)/);

      await a.send({ text: "РЕГИОН", from: "human" });
      await waitFor(() => completed(s.events).length === 2 && errors(s.events).length === 1, "отказ по региону и выход");
      assert.match(completed(s.events)[1].text, /Eligibility check failed/);
      // exit приходит раньше, чем дочитан stderr, не всегда — причина в тексте ошибки не обязательна.
      assert.match(errors(s.events)[0].text, /завершился неожиданно \(код 1/);
      assert.equal(a.busy, false);
    } finally {
      await a.stop();
    }
  });

  test("Gemini: без правил «только чтение» процесс не запускается, причина — в отказе отправки", async () => {
    const s = collector();
    const a = gemini(s, { beforeStart: () => "нет режима «только чтение» в настройках agy: нет запрета записи: deny write_file(*)" });
    await assert.rejects(a.send({ text: "проверь", from: "human" }), /нет режима «только чтение»/);
    assert.equal(launches(s.events).length, 0);
    assert.equal(a.busy, false);
  });

  test("Gemini: правила проверяются на каждом ходу — пропали между ходами, живой процесс останавливается (I2)", async () => {
    const s = collector();
    let allow = true;
    const a = gemini(s, {
      beforeStart: () => (allow ? undefined : "нет режима «только чтение» в настройках agy: нет запрета записи: deny write_file(*)"),
    });
    try {
      await a.send({ text: "первый ход", from: "human" });
      await waitFor(() => completed(s.events).length === 1, "первый ход завершён");
      assert.equal(launches(s.events).length, 1, "один процесс поднят");
      allow = false;
      await assert.rejects(a.send({ text: "второй ход", from: "human" }), /нет режима «только чтение»/);
      assert.equal(a.busy, false, "ход не остался занятым");
      assert.equal(launches(s.events).length, 1, "второй процесс не поднимался — второго init нет");
      await waitFor(
        () => s.events.some((e) => e.kind === "diagnostic" && /процесс Gemini остановлен/.test(e.text ?? "")),
        "живой процесс остановлен, а не продолжен молча",
      );
    } finally {
      await a.stop();
    }
  });

  test("Gemini: смена модели — перезапуск между ходами с --model и тем же разговором", async () => {
    const s = collector();
    const a = gemini(s);
    try {
      await a.send({ text: "раз", from: "human" });
      await waitFor(() => completed(s.events).length === 1, "первый ход");
      a.setModel({ model: "gemini-3.1-pro", effort: "low" });
      await a.send({ text: "два", from: "human" });
      await waitFor(() => completed(s.events).length === 2, "второй ход");
      const second = launches(s.events)[1];
      assert.deepEqual(second.slice(second.indexOf("--model"), second.indexOf("--model") + 2), ["--model", "gemini-3.1-pro-low"]);
      assert.deepEqual(second.slice(second.indexOf("--conversation"), second.indexOf("--conversation") + 2), ["--conversation", "fake-agy-conv"]);
    } finally {
      await a.stop();
    }
  });

  test("Gemini: «Прервать» останавливает процесс; следующий ход продолжает разговор", async () => {
    const s = collector();
    const a = gemini(s);
    try {
      await a.send({ text: "ДОЛГО", from: "human" });
      await waitFor(() => launches(s.events).length === 1, "процесс поднят");
      await a.interrupt();
      assert.equal(a.busy, false);
      assert.equal(errors(s.events).length, 0, "плановая остановка — не ошибка");
      await a.send({ text: "дальше", from: "human" });
      await waitFor(() => completed(s.events).length === 1, "ход после прерывания");
      assert.ok(launches(s.events)[1].includes("--conversation"));
    } finally {
      await a.stop();
    }
  });

  test("Gemini: новая сессия — следующий запуск без --conversation", async () => {
    const s = collector();
    const a = gemini(s, { resumeConversationId: "conv-7" });
    try {
      await a.forgetSession();
      await a.send({ text: "с чистого листа", from: "human" });
      await waitFor(() => completed(s.events).length === 1, "ход");
      assert.ok(!launches(s.events)[0].includes("--conversation"));
    } finally {
      await a.stop();
    }
  });

  test("Gemini: падение процесса посреди хода — ошибка с отметкой failed", async () => {
    const s = collector();
    const a = gemini(s);
    try {
      await a.send({ text: "УПАСТЬ", from: "human" });
      await waitFor(() => errors(s.events).length === 1, "ошибка процесса");
      assert.equal(errors(s.events)[0].failed, true);
      assert.equal(a.busy, false);
    } finally {
      await a.stop();
    }
  });

  test("Gemini: список моделей из agy models — только gemini, уровни из суффикса", async () => {
    const a = gemini(collector());
    const list = await a.listModels();
    assert.deepEqual(list.map((o) => o.id), ["", "gemini-3.8-flash", "gemini-3.1-pro"]);
  });
}
