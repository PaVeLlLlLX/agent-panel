/**
 * Фальшивый Claude Code для проверки адаптера.
 *
 * Воспроизводит формат, снятый с настоящего `claude -p --output-format
 * stream-json` на этой машине: system/init, stream_event с text_delta,
 * assistant, result. Лежит вне каталога test/ намеренно — штатный запуск
 * `node --test` берёт как тесты все .mjs внутри test/, и этот процесс,
 * читающий stdin, повис бы.
 *
 * Управляется словами в тексте реплики:
 *   ОШИБКА-ХОДА — result с is_error: true;
 *   УПАСТЬ      — внезапный выход процесса посреди хода.
 *
 * В system/init добавлено поле argv — его нет у настоящего Claude, но оно
 * позволяет проверить, с какими флагами адаптер запускает процесс.
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);

// --close-stdin: закрыть свой stdin сразу, но продолжать жить. Так
// воспроизводится сломанный канал при живом процессе.
if (argv.includes("--close-stdin")) {
  process.stdin.destroy();
  setInterval(() => {}, 1000);
}
const СЕССИЯ = "fake-claude-session";
const записать = (о) => process.stdout.write(`${JSON.stringify(о)}\n`);

// Настоящие агенты пишут в stderr служебные логи с цветовыми кодами.
process.stderr.write(
  "\x1b[2m2026-09-14T17:07:57.727561Z\x1b[0m \x1b[33mWARN\x1b[0m фальшивый служебный лог\n",
);

записать({
  type: "system",
  subtype: "init",
  session_id: СЕССИЯ,
  model: "fake",
  tools: [],
  argv,
  pid: process.pid,
});

/** Запросы к панели, ждущие control_response: request_id → продолжение хода. */
const ожидающие = new Map();

const строки = createInterface({ input: process.stdin });
строки.on("line", (строка) => {
  let запись;
  try {
    запись = JSON.parse(строка);
  } catch {
    return;
  }
  if (запись.type === "control_response") {
    // Ответ панели — в stderr: тест читает его из диагностики и видит,
    // что именно ушло агенту.
    process.stderr.write(`ОТВЕТ-ПАНЕЛИ ${JSON.stringify(запись.response)}\n`);
    const продолжить = ожидающие.get(запись.response?.request_id);
    ожидающие.delete(запись.response?.request_id);
    продолжить?.(запись.response);
    return;
  }
  if (запись.type !== "user") return;
  const текст = (запись.message?.content ?? []).map((б) => б.text ?? "").join("");

  // НУЖНО-РАЗРЕШЕНИЕ: запрос can_use_tool в форме, снятой пробой с Claude Code
  // 2.1.220 (--permission-prompt-tool stdio). Ход ждёт ответа панели; отказ,
  // как у настоящего, попадает в permission_denials итога.
  if (текст.includes("НУЖНО-РАЗРЕШЕНИЕ")) {
    const вход = { command: "mkdir probe-dir", description: "Create directory" };
    записать({ type: "stream_event", event: { type: "message_start" }, session_id: СЕССИЯ });
    записать({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "toolu_perm", name: "Bash", input: вход }] },
      session_id: СЕССИЯ,
    });
    записать({
      type: "control_request",
      request_id: "perm-1",
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        display_name: "Bash",
        input: вход,
        description: "Create directory",
        permission_suggestions: [
          {
            type: "addRules",
            rules: [{ toolName: "Bash", ruleContent: "mkdir probe-dir *" }],
            behavior: "allow",
            destination: "localSettings",
          },
          { type: "addDirectories", directories: ["C:\\probe"], destination: "session" },
          { type: "setMode", mode: "acceptEdits", destination: "session" },
        ],
        blocked_path: "C:\\probe\\probe-dir",
        tool_use_id: "toolu_perm",
      },
    });
    ожидающие.set("perm-1", (ответ) => {
      const решение = ответ?.response ?? {};
      const разрешено = решение.behavior === "allow";
      записать({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_perm",
              content: разрешено ? "" : String(решение.message ?? ""),
              is_error: !разрешено,
            },
          ],
        },
        session_id: СЕССИЯ,
      });
      записать({
        type: "assistant",
        message: { content: [{ type: "text", text: разрешено ? "каталог создан" : "не разрешили" }] },
        session_id: СЕССИЯ,
      });
      записать({
        type: "result",
        subtype: "success",
        is_error: false,
        num_turns: 2,
        session_id: СЕССИЯ,
        ...(разрешено
          ? {}
          : { permission_denials: [{ tool_name: "Bash", tool_use_id: "toolu_perm", tool_input: вход }] }),
      });
    });
    return;
  }

  // ЧУЖОЙ-ЗАПРОС: control_request, который панель не обслуживает. Без ответа
  // настоящий Claude ждал бы вечно.
  if (текст.includes("ЧУЖОЙ-ЗАПРОС")) {
    записать({ type: "control_request", request_id: "hook-1", request: { subtype: "hook_callback", callback_id: "x" } });
    ожидающие.set("hook-1", () => {
      записать({ type: "assistant", message: { content: [{ type: "text", text: "дальше" }] }, session_id: СЕССИЯ });
      записать({ type: "result", subtype: "success", is_error: false, num_turns: 1, session_id: СЕССИЯ });
    });
    return;
  }

  // ДОЛГАЯ-КОМАНДА <путь>: как настоящий Claude, выполняющий инструмент, —
  // запускает долгий дочерний процесс, пишет его pid в файл и хода не
  // завершает. Проверяет, что остановка убивает всё дерево.
  const долгая = /ДОЛГАЯ-КОМАНДА (\S+)/.exec(текст);
  if (долгая) {
    const внук = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    writeFileSync(долгая[1], JSON.stringify({ агент: process.pid, внук: внук.pid }));
    return;
  }
  if (текст.includes("УПАСТЬ")) {
    process.exit(3);
  }
  if (текст.includes("ОТКАЗ")) {
    // Форма снята с настоящего result живого прогона 15 сентября:
    // отказы приходят при is_error: false.
    записать({
      type: "assistant",
      message: { content: [{ type: "text", text: "команда заблокирована" }] },
      session_id: СЕССИЯ,
    });
    записать({
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 1,
      session_id: СЕССИЯ,
      permission_denials: [
        {
          tool_name: "Bash",
          tool_use_id: "toolu_fake",
          tool_input: { command: "git -C C:\\agent-panel show d748e88", description: "Show commit" },
        },
      ],
    });
    return;
  }
  if (текст.includes("ОШИБКА-ХОДА")) {
    записать({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      stop_reason: "error_during_execution",
      num_turns: 1,
      session_id: СЕССИЯ,
    });
    return;
  }

  записать({ type: "stream_event", event: { type: "message_start" }, session_id: СЕССИЯ });
  for (const кусок of ["при", "вет"]) {
    записать({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: кусок } },
      session_id: СЕССИЯ,
    });
  }
  записать({
    type: "assistant",
    message: { content: [{ type: "text", text: "привет" }] },
    session_id: СЕССИЯ,
  });
  записать({ type: "result", subtype: "success", is_error: false, num_turns: 1, session_id: СЕССИЯ });
});
строки.on("close", () => process.exit(0));
