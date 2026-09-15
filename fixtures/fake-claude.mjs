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
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
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
});

const строки = createInterface({ input: process.stdin });
строки.on("line", (строка) => {
  let запись;
  try {
    запись = JSON.parse(строка);
  } catch {
    return;
  }
  if (запись.type !== "user") return;
  const текст = (запись.message?.content ?? []).map((б) => б.text ?? "").join("");

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
