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
import { mkdtempSync, readFileSync } from "node:fs";
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
