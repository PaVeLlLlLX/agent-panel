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

test("Claude: длинный вывод инструмента — усечённый текст для показа и полный для рецензента", async () => {
  const с = собиратель();
  const а = claude(с);
  try {
    await а.send({ text: "ДЛИННЫЙ-ВЫВОД", from: "human" });
    await дождаться(() => с.события.some((е) => е.kind === "turn_completed"), "конец хода");
    const р = с.события.find((е) => е.kind === "tool_result");
    assert.ok(р, "результат инструмента не пришёл");
    assert.match(р.text, /обрезано \d+ символов/, "показ остаётся ограниченным");
    assert.ok(р.full, "полный текст потерян");
    assert.ok(р.full.startsWith("начало-вывода "), "блоки текста — как текст, а не JSON");
    assert.ok(р.full.endsWith("КОНЕЦ-ВЫВОДА"), "конец вывода потерян");
    assert.ok(!р.full.includes('"type"'), "в полный текст попала обёртка блоков");
  } finally {
    await а.stop();
  }
});

test("Claude: запрос и решение разрешения знают, о каком вызове инструмента речь", async () => {
  // Рецензия Codex 28.09: карточка живёт по request_id, бусина — по tool_use_id,
  // и отказ человека не доходил до бусины.
  const с = собиратель();
  const а = claude(с);
  try {
    await а.send({ text: "НУЖНО-РАЗРЕШЕНИЕ", from: "human" });
    await дождаться(() => с.события.some((е) => е.kind === "approval_requested"), "запрос разрешения");
    const запрос = с.события.find((е) => е.kind === "approval_requested");
    assert.equal(запрос.toolCallId, "toolu_perm");
    await а.answerApproval(запрос.callId, "deny");
    await дождаться(() => с.события.some((е) => е.kind === "approval_decided"), "решение");
    assert.equal(с.события.find((е) => е.kind === "approval_decided").toolCallId, "toolu_perm");
  } finally {
    await а.stop();
  }
});

test("Claude: ход с фоновым субагентом кончается итогом, а не первым result", async () => {
  // Живая трасса 28.09: в режиме панели result приходит, пока субагент ещё
  // работает; потом Claude сам продолжает ход. Прежде панель отдавала
  // рецензенту «агент запущен, жду», а итог никто не проверял.
  const с = собиратель();
  const а = claude(с);
  try {
    await а.send({ text: "ФОНОВЫЙ-СУБАГЕНТ", from: "human" });
    await дождаться(() => с.события.some((е) => е.kind === "message" && е.text === "агент запущен, жду"), "промежуточная реплика");
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(с.события.filter((е) => е.kind === "turn_completed").length, 0, "ход кончился раньше субагента");
    assert.equal(а.busy, true, "пока работает субагент, Claude занят");
    await дождаться(() => с.события.some((е) => е.kind === "turn_completed"), "конец хода");
    const порядок = с.события.filter((е) => е.kind === "message" || е.kind === "turn_completed").map((е) => е.kind === "message" ? е.text : "конец");
    assert.deepEqual(порядок, ["агент запущен, жду", "alpha", "конец"]);
    assert.equal(а.busy, false);
    const субагента = с.события.filter((е) => е.parentCallId === "toolu_agent").map((е) => е.kind);
    assert.deepEqual(субагента, ["tool_call", "tool_result"], "действия субагента помечены вызовом, который его запустил");
    assert.ok(с.события.some((е) => е.kind === "diagnostic" && /субагент/.test(е.text ?? "")), "человек видит, почему ход не кончился");
  } finally {
    await а.stop();
  }
});

test("Claude: расход хода — сумма всех result хода, лимит — последнее сведение", async () => {
  const с = собиратель();
  const а = claude(с);
  try {
    await а.send({ text: "ФОНОВЫЙ-СУБАГЕНТ", from: "human" });
    await дождаться(() => с.события.some((е) => е.kind === "turn_completed"), "конец хода");
    const конец = с.события.find((е) => е.kind === "turn_completed");
    assert.deepEqual(конец.usage, { input: 3115, cached: 3000, output: 27 });
    assert.deepEqual(конец.limit, { status: "allowed", window: "five_hour", resetsAt: 1790553000000 });
  } finally {
    await а.stop();
  }
});

const концыХода = (с) => с.события.filter((е) => е.kind === "turn_completed");
const подождать = (мс) => new Promise((r) => setTimeout(r, мс));

test("Claude: срок не закрывает ход, пока модель отвечает итоговым запросом", async () => {
  const с = собиратель();
  const а = claude(с, { backgroundGraceMs: 200 });
  try {
    await а.send({ text: "ДВА-СУБАГЕНТА", from: "human" });
    await дождаться(() => с.события.some((е) => е.kind === "message" && е.text === "итог-2"), "итог-2");
    await подождать(400);
    assert.equal(концыХода(с).length, 1, "ход закрыт дважды или раньше итога");
    const порядок = с.события.filter((е) => е.kind === "message" || е.kind === "turn_completed").map((е) => е.text);
    assert.equal(порядок[порядок.length - 1].startsWith("ход завершён"), true);
    assert.ok(порядок.indexOf("итог-2") < порядок.length - 1);
  } finally {
    await а.stop();
  }
});

test("Claude: снимок задач без task_type не снимает известного субагента", async () => {
  const с = собиратель();
  const а = claude(с, { backgroundGraceMs: 200 });
  try {
    await а.send({ text: "СНИМОК-БЕЗ-ТИПА", from: "human" });
    await дождаться(() => концыХода(с).length > 0, "конец хода");
    await подождать(100);
    assert.equal(концыХода(с).length, 1);
    const итоги = с.события.filter((е) => е.kind === "message").map((е) => е.text);
    assert.deepEqual(итоги, ["жду", "итог"], "ход закрыт по сроку до итога");
  } finally {
    await а.stop();
  }
});

test("Claude: после ошибки при работающем субагенте его поздний итог держит следующий ход", async () => {
  const с = собиратель();
  const а = claude(с, { backgroundGraceMs: 200 });
  try {
    await а.send({ text: "ОШИБКА-ПРИ-СУБАГЕНТЕ", from: "human" });
    await дождаться(() => концыХода(с).length === 1, "ход с ошибкой");
    assert.equal(концыХода(с)[0].failed, true);
    await а.send({ text: "здравствуй", from: "human" });
    await дождаться(() => с.события.some((е) => е.kind === "message" && е.text === "поздний итог"), "поздний итог");
    await дождаться(() => концыХода(с).length === 2, "конец второго хода");
    await подождать(300);
    assert.equal(концыХода(с).length, 2, "поздний итог закончил второй ход раньше или вдвойне");
    const последние = с.события.filter((е) => е.kind === "message" || е.kind === "turn_completed").slice(-2).map((е) => е.kind);
    assert.deepEqual(последние, ["message", "turn_completed"]);
  } finally {
    await а.stop();
  }
});

test("Claude: процесс умер при работающем субагенте — следующий ход не виснет", async () => {
  const с = собиратель();
  const а = claude(с, { backgroundGraceMs: 200 });
  try {
    await а.send({ text: "УПАСТЬ-ПРИ-СУБАГЕНТЕ", from: "human" });
    await дождаться(() => с.события.some((е) => е.kind === "error"), "ошибка процесса");
    const было = концыХода(с).length;
    await а.send({ text: "здравствуй", from: "human" });
    await дождаться(() => концыХода(с).length > было, "конец нового хода");
    await подождать(400);
    assert.equal(концыХода(с).length, было + 1, "поздний срок старого хода выдал лишний конец");
    assert.equal(а.busy, false);
  } finally {
    await а.stop();
  }
});

test("Claude: расход умершего процесса не переходит в следующий ход", async () => {
  const с = собиратель();
  const а = claude(с, { backgroundGraceMs: 200 });
  try {
    await а.send({ text: "УПАСТЬ-ПРИ-СУБАГЕНТЕ", from: "human" });
    await дождаться(() => с.события.some((е) => е.kind === "error"), "ошибка процесса");
    await а.send({ text: "здравствуй", from: "human" });
    await дождаться(() => с.события.some((е) => е.kind === "turn_completed"), "конец нового хода");
    assert.equal(с.события.find((е) => е.kind === "turn_completed").usage, undefined, "в ход попал расход умершего процесса");
  } finally {
    await а.stop();
  }
});

test("Claude: субагент молчит — ход закрывается по сроку тишины, а не висит", async () => {
  const с = собиратель();
  const а = claude(с, { backgroundGraceMs: 200, backgroundIdleMs: 300 });
  try {
    await а.send({ text: "МОЛЧАЛИВЫЙ-СУБАГЕНТ", from: "human" });
    await дождаться(() => с.события.some((е) => е.kind === "turn_completed"), "конец хода по тишине", 5000);
    assert.match(с.события.find((е) => е.kind === "turn_completed").text, /не сообщил/);
    assert.equal(а.busy, false);
  } finally {
    await а.stop();
  }
});

test("Claude: второй субагент молчит после итогового запроса — срок тишины всё равно идёт", async () => {
  // Рецензия Codex 28.09: init продолжения снимал и таймер тишины.
  const с = собиратель();
  const а = claude(с, { backgroundGraceMs: 200, backgroundIdleMs: 400 });
  try {
    await а.send({ text: "ОДИН-МОЛЧИТ", from: "human" });
    await дождаться(() => с.события.some((е) => е.kind === "turn_completed"), "конец хода по тишине", 5000);
    assert.match(с.события.find((е) => е.kind === "turn_completed").text, /не сообщил/);
  } finally {
    await а.stop();
  }
});

test("Claude: срок тишины не закрывает открытый запрос модели", async () => {
  const с = собиратель();
  const а = claude(с, { backgroundGraceMs: 200, backgroundIdleMs: 300 });
  try {
    await а.send({ text: "ДОЛГИЙ-ЗАПРОС", from: "human" });
    await дождаться(() => с.события.some((е) => е.kind === "message" && е.text === "поздний"), "поздний ответ", 5000);
    await дождаться(() => с.события.some((е) => е.kind === "turn_completed"), "конец хода");
    await new Promise((r) => setTimeout(r, 300));
    const концы = с.события.filter((е) => е.kind === "turn_completed");
    assert.equal(концы.length, 1);
    const порядок = с.события.filter((е) => е.kind === "message" || е.kind === "turn_completed").map((е) => е.kind === "message" ? е.text : "конец");
    assert.deepEqual(порядок, ["жду", "поздний", "конец"]);
  } finally {
    await а.stop();
  }
});

test("Claude: после закрытия по тишине процесс остановлен — поздних концов хода нет", async () => {
  const с = собиратель();
  const а = claude(с, { backgroundGraceMs: 200, backgroundIdleMs: 300 });
  try {
    await а.send({ text: "МОЛЧАЛИВЫЙ-СУБАГЕНТ", from: "human" });
    await дождаться(() => с.события.some((е) => е.kind === "turn_completed"), "конец по тишине", 5000);
    await дождаться(() => с.события.some((е) => е.kind === "diagnostic" && /остановлен/.test(е.text ?? "")), "остановка процесса");
    // Процесс со всем деревом снят раньше, чем объявлен конец хода: иначе
    // очередь ушла бы в умирающий процесс, а рецензия — к ещё живому
    // субагенту (рецензия Codex 28.09).
    const остановка = с.события.findIndex((е) => е.kind === "diagnostic" && /остановлен/.test(е.text ?? ""));
    const конец = с.события.findIndex((е) => е.kind === "turn_completed");
    assert.ok(остановка >= 0 && остановка < конец, "конец хода объявлен до остановки процесса");
    await а.send({ text: "здравствуй", from: "human" });
    await дождаться(() => с.события.filter((е) => е.kind === "turn_completed").length === 2, "следующий ход");
    assert.equal(с.события.filter((е) => е.kind === "error").length, 0, "плановая остановка — не ошибка");
  } finally {
    await а.stop();
  }
});

test("Claude: фоновый Bash ход не держит — ждут только субагентов", async () => {
  const с = собиратель();
  const а = claude(с);
  try {
    await а.send({ text: "ФОНОВЫЙ-BASH", from: "human" });
    await дождаться(() => с.события.some((е) => е.kind === "turn_completed"), "конец хода");
    assert.equal(а.busy, false);
  } finally {
    await а.stop();
  }
});

test("Claude: фоновая команда кончилась после хода — Claude продолжает сам, ход помечен самостоятельным", async () => {
  // Живая трасса 28.09 (CLI 2.1.220): Bash с run_in_background, result, через
  // 20 с task_notification, init и новый ход — панель ничего не отправляла.
  // Такой ход не должен выглядеть ответом на следующее сообщение панели.
  const события = [];
  const занятость = [];
  const а = new ClaudeAdapter({ command: "node", commandArgs: [ФАЛЬШИВЫЙ_CLAUDE], cwd: каталог() }, (е) => {
    события.push(е);
    занятость.push([е.kind, а.busy]);
  });
  try {
    await а.send({ text: "ФОНОВЫЙ-BASH-ПОЗЖЕ", from: "human" });
    await дождаться(() => события.filter((е) => е.kind === "turn_completed").length === 2, "два конца хода");
    const [первый, второй] = события.filter((е) => е.kind === "turn_completed");
    assert.equal(первый.unsolicited, undefined);
    assert.equal(второй.unsolicited, true);
    assert.deepEqual(второй.usage, { input: 503, cached: 500, output: 4 });

    const начало = события.find((е) => е.kind === "turn_started");
    assert.equal(начало?.unsolicited, true);
    assert.match(начало.text, /sleep 20 в фоне/);
    // Пока идёт самостоятельный ход, адаптер занят: координатор копит
    // сообщения в очереди, а не пишет их в чужой ход.
    const i = занятость.findIndex(([вид]) => вид === "turn_started");
    assert.deepEqual(занятость[i], ["turn_started", true]);
    assert.ok(события.some((е) => е.kind === "message" && е.text === "Команда завершена успешно."));
    assert.equal(а.busy, false);
  } finally {
    await а.stop();
  }
});

test("Claude: гонка — CLI начал свой запрос раньше, чем принял сообщение панели", async () => {
  // Рецензия Codex 28.09: сообщение ушло, когда CLI уже начал самостоятельный
  // запрос, а его init ещё не дошёл. По занятости их не различить; различает
  // эхо (--replay-user-messages): CLI повторяет сообщение внутри его запроса.
  const события = [];
  const занятость = [];
  const а = new ClaudeAdapter({ command: "node", commandArgs: [ФАЛЬШИВЫЙ_CLAUDE], cwd: каталог() }, (е) => {
    события.push(е);
    if (е.kind === "turn_completed") занятость.push(а.busy);
  });
  try {
    await а.send({ text: "привет", from: "human" });
    await дождаться(() => события.some((е) => е.kind === "turn_completed"), "первый ход");
    assert.ok(события.find((е) => е.raw?.argv)?.raw.argv.includes("--replay-user-messages"));
    события.length = 0;
    занятость.length = 0;

    await а.send({ text: "ГОНКА", from: "human" });
    await дождаться(() => события.filter((е) => е.kind === "turn_completed").length === 2, "два конца хода");
    const [чужой, свой] = события.filter((е) => е.kind === "turn_completed");
    assert.equal(чужой.unsolicited, true);
    assert.deepEqual(чужой.usage, { input: 70, cached: 0, output: 7 });
    assert.equal(свой.unsolicited, undefined);
    assert.deepEqual(свой.usage, { input: 5, cached: 0, output: 5 });
    const начало = события.find((е) => е.kind === "turn_started");
    assert.equal(начало?.unsolicited, true);
    assert.match(начало.text, /pytest/);
    // Реплика чужого запроса — до его конца, ответ на сообщение — после.
    const iОтвета = события.findIndex((е) => е.text === "ответ на сообщение");
    assert.ok(события.findIndex((е) => е.text === "итог фоновой") < события.indexOf(чужой));
    assert.ok(события.indexOf(чужой) < iОтвета);
    // Между концами адаптер занят: сообщение панели ещё ждёт ответа.
    assert.deepEqual(занятость, [true, false]);
  } finally {
    await а.stop();
  }
});

test("Claude: свой запрос с ошибкой до эха — конец своего хода, а не чужой", async () => {
  // Рецензия Codex 28.09: иначе ход ждал бы следующего запроса вечно.
  const с = собиратель();
  const а = claude(с);
  try {
    await а.send({ text: "привет", from: "human" });
    await дождаться(() => с.события.some((е) => е.kind === "turn_completed"), "первый ход");
    с.события.length = 0;
    await а.send({ text: "ОШИБКА-ДО-ЭХА", from: "human" });
    await дождаться(() => с.события.some((е) => е.kind === "turn_completed"), "конец хода");
    const конец = с.события.find((е) => е.kind === "turn_completed");
    assert.equal(конец.failed, true);
    assert.equal(конец.unsolicited, undefined);
    assert.equal(а.busy, false);
  } finally {
    await а.stop();
  }
});

test("Claude: субагент чужого запроса не держит свой ход", async () => {
  // Рецензия Codex 28.09: субагент запроса без эха попадал в общий набор,
  // держал ответ на сообщение, а его итог становился частью этого ответа.
  const с = собиратель();
  const а = claude(с);
  try {
    await а.send({ text: "привет", from: "human" });
    await дождаться(() => с.события.some((е) => е.kind === "turn_completed"), "первый ход");
    с.события.length = 0;
    await а.send({ text: "ЧУЖОЙ-СУБАГЕНТ", from: "human" });
    await дождаться(() => с.события.filter((е) => е.kind === "turn_completed").length === 3, "три конца хода");
    const [чужой, свой, продолжение] = с.события.filter((е) => е.kind === "turn_completed");
    assert.equal(чужой.unsolicited, true);
    assert.equal(свой.unsolicited, undefined);
    assert.equal(продолжение.unsolicited, true);
    const i = (текст) => с.события.findIndex((е) => е.text === текст);
    assert.ok(i("ответ на сообщение") < с.события.indexOf(свой));
    assert.ok(с.события.indexOf(свой) < i("итог чужого субагента"));
    assert.equal(с.события.some((е) => /ждёт субагентов/.test(е.text ?? "")), false);
  } finally {
    await а.stop();
  }
});

test("Claude: чужой запрос, запустивший субагента, чужой и при ошибке", async () => {
  // Рецензия Codex 28.09 (2febf2e): ошибка без эха считалась своей, даже если
  // запрос уже работал. Свой запрос повторяет сообщение раньше любого ответа
  // модели, значит, запрос без эха с ответом — чужой.
  const с = собиратель();
  const а = claude(с);
  try {
    await а.send({ text: "привет", from: "human" });
    await дождаться(() => с.события.some((е) => е.kind === "turn_completed"), "первый ход");
    с.события.length = 0;
    await а.send({ text: "ЧУЖОЙ-СУБАГЕНТ-С-ОШИБКОЙ", from: "human" });
    await дождаться(() => с.события.filter((е) => е.kind === "turn_completed").length === 3, "три конца хода");
    const [чужой, свой, продолжение] = с.события.filter((е) => е.kind === "turn_completed");
    assert.equal(чужой.unsolicited, true);
    assert.equal(чужой.failed, true);
    assert.equal(свой.unsolicited, undefined);
    assert.equal(свой.failed, undefined);
    assert.equal(продолжение.unsolicited, true);
  } finally {
    await а.stop();
  }
});

test("Claude: чужой запрос, начавший поток и упавший, — чужой", async () => {
  // Рецензия Codex 28.09 (fe9bce2): до ошибки мог прийти только stream_event.
  const с = собиратель();
  const а = claude(с);
  try {
    await а.send({ text: "привет", from: "human" });
    await дождаться(() => с.события.some((е) => е.kind === "turn_completed"), "первый ход");
    с.события.length = 0;
    await а.send({ text: "ЧУЖОЙ-ПОТОК", from: "human" });
    await дождаться(() => с.события.filter((е) => е.kind === "turn_completed").length === 2, "два конца хода");
    const [чужой, свой] = с.события.filter((е) => е.kind === "turn_completed");
    assert.equal(чужой.unsolicited, true);
    assert.equal(свой.unsolicited, undefined);
    assert.equal(свой.failed, undefined);
  } finally {
    await а.stop();
  }
});

test("Claude: стартовый init без сообщения — не самостоятельный ход", async () => {
  // Рецензия Codex 28.09: публичный start() без send. Фальшивый CLI пишет init
  // сразу при запуске (настоящий 2.1.220 молчит до сообщения — проба 28.09).
  const с = собиратель();
  const а = claude(с);
  try {
    await а.start();
    await дождаться(() => с.события.some((е) => е.raw?.argv), "init при запуске");
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(с.события.some((е) => е.kind === "turn_started"), false);
    assert.equal(а.busy, false);
  } finally {
    await а.stop();
  }
});

test("Claude: причина самостоятельного хода не переходит из прежнего процесса", async () => {
  // Рецензия Codex 28.09: уведомление о фоновой задаче остановленного процесса
  // не должно подписать ход нового.
  const с = собиратель();
  const а = claude(с);
  try {
    await а.send({ text: "ФОН-УВЕДОМЛЕНИЕ-БЕЗ-ХОДА", from: "human" });
    await дождаться(() => с.события.some((е) => е.kind === "turn_completed"), "ход");
    await new Promise((r) => setTimeout(r, 150));
    await а.stop();
    с.события.length = 0;
    await а.send({ text: "САМ-БЕЗ-ПРИЧИНЫ", from: "human" });
    await дождаться(() => с.события.some((е) => е.kind === "turn_started"), "самостоятельный ход");
    const начало = с.события.find((е) => е.kind === "turn_started");
    assert.doesNotMatch(начало.text, /старая/);
  } finally {
    await а.stop();
  }
});

test("Claude: фоновая команда без продолжения — ход кончается сразу и не ждёт её", async () => {
  // Фоновая команда (сервер) может не кончиться никогда: держать ход ради неё нельзя.
  const с = собиратель();
  const а = claude(с);
  try {
    await а.send({ text: "ФОНОВЫЙ-BASH", from: "human" });
    await дождаться(() => с.события.some((е) => е.kind === "turn_completed"), "конец хода");
    assert.equal(с.события.some((е) => е.kind === "turn_started"), false);
    assert.equal(а.busy, false);
  } finally {
    await а.stop();
  }
});

test("Claude: субагент кончился, а продолжения нет — ход закрывается по сроку", async () => {
  const с = собиратель();
  const а = claude(с, { backgroundGraceMs: 200 });
  try {
    await а.send({ text: "ФОНОВЫЙ-БЕЗ-ПРОДОЛЖЕНИЯ", from: "human" });
    await дождаться(() => с.события.some((е) => е.kind === "turn_completed"), "конец хода по сроку");
    const конец = с.события.find((е) => е.kind === "turn_completed");
    assert.match(конец.text, /продолжени/);
    assert.equal(а.busy, false);
  } finally {
    await а.stop();
  }
});

test("Codex: поздний конец прерванного хода не закрывает новый ход", async () => {
  // Рецензия Codex 28.09: turn/completed прерванного хода приходит после
  // ответа на turn/interrupt; без сверки с ходом он снимал бы новый.
  const с = собиратель();
  const а = codex(с);
  try {
    await а.send({ text: "ДОЛГИЙ-ХОД", from: "human" });
    await дождаться(() => с.события.some((е) => е.kind === "turn_started"), "начало долгого хода");
    await а.interrupt();
    с.события.length = 0;
    await а.send({ text: "ПОЗЖЕ", from: "human" });
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(а.busy, true, "новый ход ещё идёт");
    assert.equal(с.события.some((е) => е.kind === "turn_completed"), false);
    await дождаться(() => с.события.some((е) => е.kind === "turn_completed"), "конец нового хода");
    const конец = с.события.find((е) => е.kind === "turn_completed");
    assert.equal(конец.failed, undefined);
    assert.ok(с.события.some((е) => е.kind === "message" && е.text === "поздний ответ"));
  } finally {
    await а.stop();
  }
});

test("Codex: «Прервать» во время запуска процесса отменяет отправку", async () => {
  // Рецензия Codex 28.09 (2febf2e): пока шёл запуск, адаптер не был занят, и
  // прерывание ничего не делало — ход начинался после него.
  const с = собиратель();
  const а = codex(с);
  try {
    // Обработчик — сразу: отказ приходит во время прерывания.
    const отправка = а.send({ text: "ПОЗЖЕ", from: "human" }).then(() => "ушла", (беда) => беда);
    await а.interrupt();
    assert.ok((await отправка) instanceof Error, "отправка отменена");
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(а.busy, false);
    assert.equal(с.события.some((е) => е.kind === "message" && е.text === "поздний ответ"), false);
  } finally {
    await а.stop();
  }
});

test("Codex: второе «Прервать» до начала нового хода не адресуется прежнему", async () => {
  // Рецензия Codex 28.09 (2febf2e): после первого прерывания #ход оставался
  // прежним, и второе прерывание уходило ему, а новый ход продолжался.
  const с = собиратель();
  const а = codex(с);
  try {
    await а.send({ text: "ДОЛГИЙ-ХОД", from: "human" });
    await дождаться(() => с.события.some((е) => е.kind === "turn_started"), "начало долгого хода");
    await а.interrupt();
    const отправка = а.send({ text: "ПОЗЖЕ", from: "human" }).catch(() => undefined);
    await а.interrupt();
    await отправка;
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(а.busy, false);
    assert.equal(с.события.some((е) => е.kind === "message" && е.text === "поздний ответ"), false);
  } finally {
    await а.stop();
  }
});

test("Codex: метка прерванного хода не переживает перезапуск процесса", async () => {
  // Рецензия Codex 28.09 (2febf2e): номера ходов нового процесса могут
  // совпасть с прежними; пропущенный конец оставил бы адаптер занятым.
  const с = собиратель();
  const а = codex(с);
  try {
    await а.send({ text: "ДОЛГИЙ-ХОД", from: "human" });
    await дождаться(() => с.события.some((е) => е.kind === "turn_started"), "начало долгого хода");
    await а.interrupt();
    await а.stop();
    с.события.length = 0;
    await а.send({ text: "привет", from: "human" });
    await дождаться(() => с.события.some((е) => е.kind === "turn_completed"), "конец хода нового процесса");
    assert.equal(а.busy, false);
  } finally {
    await а.stop();
  }
});

test("Claude: команда с пробелом в пути запускается через оболочку Windows", { skip: process.platform !== "win32" }, async () => {
  // Рецензия Codex 28.09 (2febf2e): путь без кавычек cmd.exe делил на части.
  const папка = join(каталог(), "папка с пробелом");
  mkdirSync(папка);
  const обёртка = join(папка, "fake claude.cmd");
  writeFileSync(обёртка, `@"${process.execPath}" "${ФАЛЬШИВЫЙ_CLAUDE}" %*\r\n`);
  const с = собиратель();
  const а = new ClaudeAdapter({ command: обёртка, cwd: каталог() }, с.sink);
  try {
    await а.send({ text: "привет", from: "human" });
    await дождаться(() => с.события.some((е) => е.kind === "turn_completed"), "ход через обёртку");
    assert.ok(с.события.some((е) => е.kind === "message" && е.text === "привет"));
  } finally {
    await а.stop();
  }
});

test("Codex: сбой при запуске не снимает занятость следующей отправки", async () => {
  // Рецензия Codex 28.09 (fe9bce2): процесс умер при запуске, координатор уже
  // отправил следующее сообщение, а catch прежней отправки снял его занятость.
  const метка = join(каталог(), "умер");
  const события = [];
  let вторая;
  let занятПослеСбоя;
  const а = new CodexAdapter(
    { command: "node", commandArgs: [ФАЛЬШИВЫЙ_CODEX, "--die-once", метка], cwd: каталог() },
    (е) => {
      события.push(е);
      if (е.kind === "error" && е.failed && !вторая) {
        вторая = а.send({ text: "ПОЗЖЕ", from: "human" }).then(() => "ушла", (беда) => беда);
      }
    },
  );
  try {
    const первая = а.send({ text: "привет", from: "human" }).then(() => "ушла", (беда) => {
      // Вторая отправка уже начата (в обработчике ошибки), её ход ещё не
      // начался: в этом окне координатор по busy решает, слать ли третью.
      занятПослеСбоя = а.busy;
      return беда;
    });
    assert.ok((await первая) instanceof Error, "первая отправка не удалась");
    assert.ok(вторая, "вторая отправка начата при сбое");
    assert.equal(занятПослеСбоя, true, "занятость второй отправки не снята");
    assert.equal(await вторая, "ушла");
    assert.equal(а.busy, true, "второй ход ещё идёт");
    await дождаться(() => события.some((е) => е.kind === "message" && е.text === "поздний ответ"), "ответ второго хода");
  } finally {
    await а.stop();
  }
});

test("Codex: поздний конец прерванного хода не выдаётся концом хода и без нового", async () => {
  // Рецензия Codex 28.09 (fe9bce2): при свободном адаптере поздний конец
  // становился ложным turn_completed.
  const с = собиратель();
  const а = codex(с);
  try {
    await а.send({ text: "ДОЛГИЙ-ХОД", from: "human" });
    await дождаться(() => с.события.some((е) => е.kind === "turn_started"), "начало долгого хода");
    await а.interrupt();
    с.события.length = 0;
    await дождаться(() => с.события.some((е) => /поздний конец прерванного/.test(е.text ?? "")), "поздний конец");
    assert.equal(с.события.some((е) => е.kind === "turn_completed"), false);
  } finally {
    await а.stop();
  }
});

test("Claude: команда с аргументом в строке не берётся в кавычки целиком", { skip: process.platform !== "win32" }, async () => {
  // Рецензия Codex 28.09 (fe9bce2): «node script.js» в кавычках — одно имя.
  const с = собиратель();
  const а = new ClaudeAdapter({ command: `node ${ФАЛЬШИВЫЙ_CLAUDE}`, cwd: каталог() }, с.sink);
  try {
    await а.send({ text: "привет", from: "human" });
    await дождаться(() => с.события.some((е) => е.kind === "turn_completed"), "ход");
  } finally {
    await а.stop();
  }
});

test("Claude: после «новой сессии» процесс запускается без --resume", async () => {
  const с = собиратель();
  const а = claude(с, { resumeSessionId: "старая-сессия" });
  try {
    await а.start();
    await дождаться(() => с.события.some((е) => е.raw?.argv), "первый запуск");
    assert.ok(с.события.find((е) => е.raw?.argv).raw.argv.includes("--resume"));
    await а.forgetSession();
    с.события.length = 0;
    await а.start();
    await дождаться(() => с.события.some((е) => е.raw?.argv), "запуск после забвения");
    assert.equal(с.события.find((е) => е.raw?.argv).raw.argv.includes("--resume"), false);
  } finally {
    await а.stop();
  }
});

test("Claude: отправка во время «новой сессии» не возобновляет прежнюю", async () => {
  const с = собиратель();
  const а = claude(с, { resumeSessionId: "старая-сессия" });
  try {
    await а.start();
    await дождаться(() => с.события.some((е) => е.raw?.argv), "первый запуск");
    с.события.length = 0;
    const забыть = а.forgetSession();
    await а.send({ text: "здравствуй", from: "human" });
    await забыть;
    await дождаться(() => с.события.some((е) => е.raw?.argv), "запуск после забвения");
    assert.equal(с.события.find((е) => е.raw?.argv).raw.argv.includes("--resume"), false);
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

// --- Разрешения: --permission-prompt-tool stdio ------------------------------

const ПРЕФИКС_ОТВЕТА = "ОТВЕТ-ПАНЕЛИ ";
/** Что панель ответила агенту: фальшивка пишет каждый control_response в stderr. */
const ответыПанели = (события) =>
  события
    .filter((е) => е.kind === "diagnostic" && (е.text ?? "").startsWith(ПРЕФИКС_ОТВЕТА))
    .map((е) => JSON.parse(е.text.slice(ПРЕФИКС_ОТВЕТА.length)));
const найти = (события, вид) => события.find((е) => е.kind === вид);

async function запросРазрешения(с, а) {
  await а.send({ text: "НУЖНО-РАЗРЕШЕНИЕ", from: "human" });
  await дождаться(() => найти(с.события, "approval_requested"), "запрос разрешения");
  return найти(с.события, "approval_requested");
}

test("Claude: запускается с каналом запросов разрешений", async () => {
  const с = собиратель();
  const а = claude(с);
  try {
    await а.start();
    await дождаться(() => с.события.some((е) => е.raw?.argv), "запись запуска");
    const argv = с.события.find((е) => е.raw?.argv).raw.argv;
    const i = argv.indexOf("--permission-prompt-tool");
    assert.ok(i >= 0, "без флага действия, требующие согласия, отклоняются молча");
    assert.equal(argv[i + 1], "stdio");
  } finally {
    await а.stop();
  }
});

test("Claude: запрос разрешения — событие с командой, ход ждёт ответа человека", async () => {
  const с = собиратель();
  const а = claude(с);
  try {
    const з = await запросРазрешения(с, а);
    assert.equal(з.tool, "Bash");
    assert.equal(з.callId, "perm-1");
    assert.match(з.text, /mkdir probe-dir/);
    assert.deepEqual(з.sessionRules, ["Bash(mkdir probe-dir *)"]);
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(!найти(с.события, "turn_completed"), "ход не должен завершаться без ответа");
    assert.equal(а.busy, true);
  } finally {
    await а.stop();
  }
});

test("Claude: «разрешить» — агент получает исходный ввод, ход завершается без отказов", async () => {
  const с = собиратель();
  const а = claude(с);
  try {
    await запросРазрешения(с, а);
    assert.equal(await а.answerApproval("perm-1", "allow"), true);
    assert.equal(await а.answerApproval("perm-1", "allow"), false, "повторный ответ не отправляется");
    await дождаться(() => найти(с.события, "turn_completed"), "конец хода");
    const ответы = ответыПанели(с.события);
    assert.equal(ответы.length, 1);
    assert.equal(ответы[0].subtype, "success");
    assert.equal(ответы[0].request_id, "perm-1");
    assert.deepEqual(ответы[0].response, {
      behavior: "allow",
      updatedInput: { command: "mkdir probe-dir", description: "Create directory" },
    });
    const решение = найти(с.события, "approval_decided");
    assert.equal(решение.callId, "perm-1");
    assert.match(решение.text, /разрешено/);
    assert.equal(найти(с.события, "turn_completed").denials, undefined);
  } finally {
    await а.stop();
  }
});

test("Claude: «в этой сессии» — только правила команды и только на сессию", async () => {
  // Предложение addRules приходит с destination localSettings: записать его
  // как есть значило бы править файл настроек владельца. setMode acceptEdits
  // разрешил бы все правки сразу — шире, чем видит человек на кнопке.
  const с = собиратель();
  const а = claude(с);
  try {
    await запросРазрешения(с, а);
    assert.equal(await а.answerApproval("perm-1", "allowSession"), true);
    await дождаться(() => найти(с.события, "turn_completed"), "конец хода");
    const [ответ] = ответыПанели(с.события);
    assert.deepEqual(ответ.response.updatedPermissions, [
      {
        type: "addRules",
        rules: [{ toolName: "Bash", ruleContent: "mkdir probe-dir *" }],
        behavior: "allow",
        destination: "session",
      },
    ]);
    assert.match(найти(с.события, "approval_decided").text, /в этой сессии/);
  } finally {
    await а.stop();
  }
});

test("Claude: «отклонить» — агент получает причину, отказ человека не удерживает работу", async () => {
  // Отказ, данный человеком, — его решение, а не блокировка: повторять ход
  // незачем, работа идёт дальше как обычно.
  const с = собиратель();
  const а = claude(с);
  try {
    await запросРазрешения(с, а);
    assert.equal(await а.answerApproval("perm-1", "deny"), true);
    await дождаться(() => найти(с.события, "turn_completed"), "конец хода");
    const [ответ] = ответыПанели(с.события);
    assert.equal(ответ.response.behavior, "deny");
    assert.match(ответ.response.message, /человек/);
    assert.match(найти(с.события, "approval_decided").text, /отклонено/);
    assert.equal(найти(с.события, "turn_completed").denials, undefined);
  } finally {
    await а.stop();
  }
});

test("Claude: остановка закрывает открытый запрос, поздний ответ не отправляется", async () => {
  const с = собиратель();
  const а = claude(с);
  try {
    await запросРазрешения(с, а);
    await а.stop();
    const решение = найти(с.события, "approval_decided");
    assert.ok(решение, "карточка запроса осталась бы открытой навсегда");
    assert.equal(решение.callId, "perm-1");
    assert.equal(await а.answerApproval("perm-1", "allow"), false);
  } finally {
    await а.stop();
  }
});

test("Claude: необслуживаемый запрос агента получает ответ-ошибку, ход не виснет", async () => {
  const с = собиратель();
  const а = claude(с);
  try {
    await а.send({ text: "ЧУЖОЙ-ЗАПРОС", from: "human" });
    await дождаться(() => найти(с.события, "turn_completed"), "конец хода");
    const [ответ] = ответыПанели(с.события);
    assert.equal(ответ.subtype, "error");
    assert.equal(ответ.request_id, "hook-1");
    assert.equal(найти(с.события, "approval_requested"), undefined);
  } finally {
    await а.stop();
  }
});

// --- Модель и уровень рассуждения ---------------------------------------------

const запуски = (события) => события.filter((е) => е.raw?.argv).map((е) => е.raw.argv);
const флаг = (argv, имя) => {
  const i = argv.indexOf(имя);
  return i >= 0 ? argv[i + 1] : undefined;
};
const концы = (события) => события.filter((е) => е.kind === "turn_completed").length;

test("Claude: список моделей — из ответа initialize, без рабочей сессии", async () => {
  const с = собиратель();
  const а = claude(с);
  try {
    const каталог = await а.listModels();
    assert.deepEqual(каталог.map((м) => м.id), ["", "sonnet", "opus", "haiku"]);
    assert.equal(каталог[0].label, "по умолчанию (Sonnet 5)");
    assert.deepEqual(каталог[0].efforts, ["low", "medium", "high", "xhigh", "max"]);
    assert.equal(каталог.find((м) => м.id === "opus").label, "Opus");
    assert.deepEqual(каталог.find((м) => м.id === "haiku").efforts, [], "у Haiku нет уровней");
    assert.deepEqual(запуски(с.события), [], "список моделей не должен поднимать рабочую сессию");
    assert.equal(а.busy, false);
  } finally {
    await а.stop();
  }
});

test("Claude: выбранные модель и уровень передаются при запуске", async () => {
  const с = собиратель();
  const а = claude(с, { model: "opus", effort: "high" });
  try {
    await а.send({ text: "здравствуй", from: "human" });
    await дождаться(() => концы(с.события) === 1, "конец хода");
    const [argv] = запуски(с.события);
    assert.equal(флаг(argv, "--model"), "opus");
    assert.equal(флаг(argv, "--effort"), "high");
  } finally {
    await а.stop();
  }
});

test("Claude: смена модели между ходами — перезапуск с той же сессией", async () => {
  const с = собиратель();
  const а = claude(с);
  try {
    await а.send({ text: "здравствуй", from: "human" });
    await дождаться(() => концы(с.события) === 1, "первый ход");
    assert.equal(флаг(запуски(с.события)[0], "--model"), undefined, "без выбора флаг не передаётся");

    а.setModel({ model: "haiku", effort: "" });
    await а.send({ text: "здравствуй", from: "human" });
    await дождаться(() => концы(с.события) === 2, "второй ход");
    const все = запуски(с.события);
    assert.equal(все.length, 2);
    assert.equal(флаг(все[1], "--model"), "haiku");
    assert.equal(флаг(все[1], "--effort"), undefined);
    assert.equal(флаг(все[1], "--resume"), "fake-claude-session", "контекст сессии не должен теряться");
  } finally {
    await а.stop();
  }
});

test("Claude: тот же выбор не перезапускает процесс", async () => {
  const с = собиратель();
  const а = claude(с, { model: "opus", effort: "" });
  try {
    await а.send({ text: "здравствуй", from: "human" });
    await дождаться(() => концы(с.события) === 1, "первый ход");
    а.setModel({ model: "opus", effort: "" });
    await а.send({ text: "здравствуй", from: "human" });
    await дождаться(() => концы(с.события) === 2, "второй ход");
    assert.equal(запуски(с.события).length, 1);
  } finally {
    await а.stop();
  }
});

// --- Режим разрешений ----------------------------------------------------------

test("Claude: режим разрешений передаётся при запуске; «спрашивать» — без флага", async () => {
  for (const [режим, ожидается] of [["bypassPermissions", "bypassPermissions"], ["default", undefined]]) {
    const с = собиратель();
    const а = claude(с, { permissionMode: режим });
    try {
      await а.start();
      await дождаться(() => запуски(с.события).length === 1, "запись запуска");
      assert.equal(флаг(запуски(с.события)[0], "--permission-mode"), ожидается, режим);
    } finally {
      await а.stop();
    }
  }
});

test("Claude: «без вопросов» посреди хода разрешает открытый запрос сразу", async () => {
  // Проба на Claude Code 2.1.220: setMode bypassPermissions в ответе на запрос
  // не отключил следующий запрос в той же сессии. Поэтому до перезапуска
  // разрешает панель, а флаг запуска действует со следующего хода.
  const с = собиратель();
  const а = claude(с);
  try {
    await запросРазрешения(с, а);
    а.setPermissionMode("bypassPermissions");
    await дождаться(() => найти(с.события, "turn_completed"), "конец хода");
    const [ответ] = ответыПанели(с.события);
    assert.equal(ответ.response.behavior, "allow");
    assert.match(найти(с.события, "approval_decided").text, /без вопросов/);
  } finally {
    await а.stop();
  }
});

test("Claude: смена режима разрешений — перезапуск с флагом и той же сессией", async () => {
  const с = собиратель();
  const а = claude(с);
  try {
    await а.send({ text: "здравствуй", from: "human" });
    await дождаться(() => концы(с.события) === 1, "первый ход");
    а.setPermissionMode("bypassPermissions");
    await а.send({ text: "НУЖНО-РАЗРЕШЕНИЕ", from: "human" });
    await дождаться(() => концы(с.события) === 2, "второй ход");
    const все = запуски(с.события);
    assert.equal(все.length, 2);
    assert.equal(флаг(все[1], "--permission-mode"), "bypassPermissions");
    assert.equal(флаг(все[1], "--resume"), "fake-claude-session");
    // Фальшивка режима не знает и спрашивает — панель отвечает сама, ход не стоит.
    assert.equal(ответыПанели(с.события)[0].response.behavior, "allow");
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
// Жизненный цикл процессов
//
// Найдено рецензентом. На Windows процесс запускается через cmd.exe
// (shell:true), и kill() убивает оболочку, а не агента с его командами.
// Следующее сообщение поднимало второго Claude на ту же сессию, пока первый
// ещё работал.
// ---------------------------------------------------------------------------

function жив(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("Claude: остановка убивает агента и его команды, и ждёт их завершения", async () => {
  const с = собиратель();
  const а = claude(с);
  const файл = join(каталог(), "pids.json");
  let pids;
  try {
    await а.send({ text: `ДОЛГАЯ-КОМАНДА ${файл}`, from: "human" });
    await дождаться(() => {
      try {
        pids = JSON.parse(readFileSync(файл, "utf8"));
        return true;
      } catch {
        return false;
      }
    }, "запуск долгой команды");
    assert.ok(жив(pids.внук), "долгая команда должна работать до остановки");

    await а.stop();
    assert.equal(жив(pids.агент), false, "после stop() агент не должен быть жив");
    assert.equal(жив(pids.внук), false, "после stop() его команда не должна быть жива");
  } finally {
    await а.stop();
    if (pids && жив(pids.внук)) process.kill(pids.внук);
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
const КАНАЛ_НЕ_ПРОВЕРЯЕМ =
  process.platform === "win32" &&
  "на Windows запись в канал, который процесс перестал читать, проходит без ошибки до переполнения буфера (измерено)";

test("Claude: сломанный канал при живом процессе — ошибка, а не вечное ожидание", { skip: КАНАЛ_НЕ_ПРОВЕРЯЕМ }, async () => {
  // Запуск без оболочки намеренно: через cmd.exe поломка канала не видна
  // вовсе — оболочка держит свою копию канала открытой.
  const с = собиратель();
  const а = new ClaudeAdapter(
    {
      command: process.execPath,
      commandArgs: [ФАЛЬШИВЫЙ_CLAUDE, "--close-stdin"],
      cwd: каталог(),
      shell: false,
    },
    с.sink,
  );
  try {
    try {
      await а.send({ text: "здравствуй", from: "human" });
    } catch {
      // отказ отправки допустим
    }
    await дождаться(() => ошибки(с.события).some((е) => е.failed === true), "ошибка канала");
    assert.equal(а.busy, false, "ответа не будет — агент не может оставаться занятым");
  } finally {
    await а.stop();
  }
});

const ПРЕФИКС_ХОДА = "ПАРАМЕТРЫ-ХОДА ";
/** Модель и уровень каждого turn/start: фальшивка пишет их в stderr. */
const параметрыХодов = (события) =>
  события
    .filter((е) => е.kind === "diagnostic" && (е.text ?? "").startsWith(ПРЕФИКС_ХОДА))
    .map((е) => JSON.parse(е.text.slice(ПРЕФИКС_ХОДА.length)));

test("Codex: список моделей — из model/list, скрытые пропущены, по умолчанию первой", async () => {
  const с = собиратель();
  const а = codex(с);
  try {
    const каталог = await а.listModels();
    assert.deepEqual(каталог.map((м) => м.id), ["", "gpt-sol", "gpt-luna"]);
    assert.equal(каталог[0].label, "по умолчанию (GPT-Sol)");
    assert.deepEqual(каталог[0].efforts, ["low", "medium", "high", "ultra"]);
    assert.equal(каталог[0].defaultEffort, "low");
    assert.equal(каталог.find((м) => м.id === "gpt-luna").defaultEffort, "medium");
    assert.equal(а.sessionId, undefined, "список моделей не должен создавать ветку");
  } finally {
    await а.stop();
  }
});

test("Codex: модель и уровень уходят в turn/start; без выбора не передаются", async () => {
  const с = собиратель();
  const а = codex(с);
  try {
    await а.send({ text: "здравствуй", from: "human" });
    await дождаться(() => концы(с.события) === 1, "первый ход");
    а.setModel({ model: "gpt-luna", effort: "high" });
    await а.send({ text: "здравствуй", from: "human" });
    await дождаться(() => концы(с.события) === 2, "второй ход");
    const [первый, второй] = параметрыХодов(с.события);
    assert.deepEqual(первый, {});
    assert.deepEqual(второй, { model: "gpt-luna", effort: "high" });
  } finally {
    await а.stop();
  }
});

test("Codex: возврат к «по умолчанию» передаёт модель по умолчанию явно", async () => {
  // Модель, переданная в turn/start, остаётся у ветки: промолчать значило бы
  // оставить прежнюю.
  const с = собиратель();
  const а = codex(с);
  try {
    await а.listModels();
    а.setModel({ model: "gpt-luna", effort: "high" });
    await а.send({ text: "здравствуй", from: "human" });
    await дождаться(() => концы(с.события) === 1, "первый ход");
    а.setModel({ model: "", effort: "" });
    await а.send({ text: "здравствуй", from: "human" });
    await дождаться(() => концы(с.события) === 2, "второй ход");
    assert.deepEqual(параметрыХодов(с.события)[1], { model: "gpt-sol", effort: "low" });
  } finally {
    await а.stop();
  }
});

test("Codex: немедленный перезапуск после остановки работает", async () => {
  // Сценарий рецензента: поздний exit старого процесса отклонял запросы
  // нового и убивал его запуск.
  const с = собиратель();
  const а = codex(с);
  try {
    for (let i = 1; i <= 3; i += 1) {
      await а.send({ text: `здравствуй ${i}`, from: "human" });
      await дождаться(
        () => с.события.filter((е) => е.kind === "turn_completed").length === i,
        `ход ${i}`,
      );
      await а.stop();
    }
    assert.deepEqual(ошибки(с.события), []);
  } finally {
    await а.stop();
  }
});

test("Codex: второе сообщение во время запуска не теряется", async () => {
  const с = собиратель();
  const а = codex(с);
  try {
    const первое = а.send({ text: "первое", from: "human" });
    const второе = а.send({ text: "второе", from: "human" });
    await Promise.all([первое, второе]);
    await дождаться(
      () => с.события.filter((е) => е.kind === "turn_completed").length === 2,
      "оба хода",
    );
    assert.deepEqual(ошибки(с.события), []);
  } finally {
    await а.stop();
  }
});

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

test("Codex: расход хода и недельный лимит из уведомлений app-server", async () => {
  // Живая проба 28.09: thread/tokenUsage/updated (last — последний ход) и
  // account/rateLimits/updated (primary.usedPercent, окно 10080 минут).
  const с = собиратель();
  const а = codex(с);
  try {
    await а.send({ text: "здравствуй", from: "claude" });
    await дождаться(() => с.события.some((е) => е.kind === "turn_completed"), "конец хода");
    const конец = с.события.find((е) => е.kind === "turn_completed");
    assert.deepEqual(конец.usage, { input: 17522, cached: 7936, output: 5 });
    assert.deepEqual(конец.limit, { percent: 8, window: "week", resetsAt: 1791057755000 });
  } finally {
    await а.stop();
  }
});

test("Codex: расход хода — по своему turnId, с несколькими запросами и сбросом итога", async () => {
  // Рецензия Codex 28.09: повтор расхода прежнего хода при возобновлении,
  // несколько запросов модели в ходе и сброс накопительного итога после сжатия.
  const с = собиратель();
  const а = codex(с);
  try {
    await а.send({ text: "РАСХОД-СЛОЖНЫЙ", from: "claude" });
    await дождаться(() => с.события.some((е) => е.kind === "turn_completed"), "конец хода");
    assert.deepEqual(с.события.find((е) => е.kind === "turn_completed").usage, { input: 1200, cached: 0, output: 30 });
  } finally {
    await а.stop();
  }
});

test("Codex: расход без известного хода не приписывается текущему", async () => {
  const с = собиратель();
  const а = codex(с);
  try {
    await а.send({ text: "РАСХОД-БЕЗ-ХОДА", from: "claude" });
    await дождаться(() => с.события.some((е) => е.kind === "turn_completed"), "конец хода");
    assert.equal(с.события.find((е) => е.kind === "turn_completed").usage, undefined);
  } finally {
    await а.stop();
  }
});

test("Codex: после «новой сессии» ветка из настроек комнаты не возобновляется", async () => {
  const с = собиратель();
  const а = codex(с, { resumeThreadId: "ветка-владельца" });
  try {
    await а.send({ text: "здравствуй", from: "claude" });
    await дождаться(() => с.события.some((е) => е.kind === "turn_completed"), "ход в прежней ветке");
    assert.ok(с.события.some((е) => /ПАРАМЕТРЫ-ВЕТКИ .*"resume":true/.test(е.text ?? "")), "сначала ветка возобновлялась");
    с.события.length = 0;
    await а.forgetSession();
    await а.send({ text: "здравствуй", from: "claude" });
    await дождаться(() => с.события.some((е) => е.kind === "turn_completed"), "ход в новой ветке");
    assert.equal(с.события.some((е) => /ПАРАМЕТРЫ-ВЕТКИ .*"resume":true/.test(е.text ?? "")), false);
  } finally {
    await а.stop();
  }
});

test("Codex: начало и конец одного инструмента связаны id элемента", async () => {
  // Рецензия Codex 28.09: без callId один инструмент давал в панели две бусины.
  const с = собиратель();
  const а = codex(с);
  try {
    await а.send({ text: "КОМАНДА", from: "claude" });
    await дождаться(() => с.события.some((е) => е.kind === "turn_completed"), "конец хода");
    const вызов = с.события.find((е) => е.kind === "tool_call");
    const итог = с.события.find((е) => е.kind === "tool_result");
    assert.ok(вызов && итог, "нет начала или конца инструмента");
    assert.equal(вызов.callId, "cmd-1");
    assert.equal(итог.callId, "cmd-1");
  } finally {
    await а.stop();
  }
});

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

const ПРЕФИКС_ВЕТКИ = "ПАРАМЕТРЫ-ВЕТКИ ";
const параметрыВетки = (события) =>
  события
    .filter((е) => е.kind === "diagnostic" && (е.text ?? "").startsWith(ПРЕФИКС_ВЕТКИ))
    .map((е) => JSON.parse(е.text.slice(ПРЕФИКС_ВЕТКИ.length)));

test("Codex: при возобновлении ветки роль рецензента задаётся заново", async () => {
  // Ветка владельца заведена в приложении Codex с ролью разработчика. При
  // возобновлении панель обязана вернуть роль рецензента: thread/resume
  // принимает developerInstructions наравне с thread/start (схема 0.153.0).
  const с = собиратель();
  const а = codex(с, { resumeThreadId: "чужая-ветка" });
  try {
    await а.start();
    await дождаться(() => параметрыВетки(с.события).length === 1, "параметры возобновления");
    const п = параметрыВетки(с.события)[0];
    assert.equal(п.resume, true);
    assert.equal(п.sandbox, "read-only");
    assert.match(п.developerInstructions, /рецензент/i, "без инструкции ветка сохранит прежнюю роль");
  } finally {
    await а.stop();
  }
});
