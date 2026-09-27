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

// `claude -p "/usage"` — ответ без запроса модели (CLI 2.1.220, 28.09). Доля
// отдаётся, только если адаптер просит не оставлять файл сессии.
if (argv.includes("/usage") && argv.includes("--hang-usage")) {
  // Зависший /usage: остальной модуль (init, чтение stdin) не выполняется.
  setInterval(() => {}, 1000);
  await new Promise(() => {});
} else if (argv.includes("/usage")) {
  const строки = [
    "Current session: 28% used · resets Sep 28, 6:50am (Asia/Novosibirsk)",
    argv.includes("--no-session-persistence")
      ? "Current week (all models): 4% used · resets Oct 4, 12am (Asia/Novosibirsk)"
      : "session would be persisted",
  ];
  записать({ type: "result", subtype: "success", is_error: false, result: строки.join(String.fromCharCode(10)) });
  process.exit(0);
}

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
  // initialize: список моделей в форме, снятой пробой с Claude Code 2.1.220.
  if (запись.type === "control_request" && запись.request?.subtype === "initialize") {
    const уровни = ["low", "medium", "high", "xhigh", "max"];
    записать({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: запись.request_id,
        response: {
          commands: [],
          models: [
            { value: "default", resolvedModel: "claude-sonnet-5", displayName: "Default (recommended)", description: "Sonnet 5 · Efficient for routine tasks", supportsEffort: true, supportedEffortLevels: уровни },
            { value: "sonnet", resolvedModel: "claude-sonnet-5", displayName: "Sonnet", description: "Sonnet 5 · Efficient for routine tasks", supportsEffort: true, supportedEffortLevels: уровни },
            { value: "opus", resolvedModel: "claude-opus-5", displayName: "Opus", description: "Opus 5 · Best for everyday, complex tasks", supportsEffort: true, supportedEffortLevels: уровни },
            { value: "haiku", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku", description: "Haiku 4.5 · Fastest for quick answers" },
          ],
        },
      },
    });
    return;
  }
  if (запись.type !== "user") return;
  const текст = (запись.message?.content ?? []).map((б) => б.text ?? "").join("");
  // --replay-user-messages: настоящий CLI повторяет сообщение с isReplay,
  // когда начинает его обрабатывать — внутри своего запроса, после init
  // (живая проба 28.09: второе сообщение, посланное во время первого хода,
  // повторено только в своём запросе).
  const эхо = () => {
    if (argv.includes("--replay-user-messages")) {
      записать({ type: "user", message: запись.message, session_id: СЕССИЯ, parent_tool_use_id: null, isReplay: true });
    }
  };
  const initЗапроса = () => записать({ type: "system", subtype: "init", session_id: СЕССИЯ, model: "fake", tools: [], argv, pid: process.pid });
  // ГОНКА: CLI уже начал свой запрос (кончилась фоновая команда), когда
  // пришло сообщение панели; сообщение обрабатывается следом.
  if (текст.includes("ГОНКА")) {
    записать({ type: "system", subtype: "task_notification", task_id: "tb", status: "completed", summary: "Background command pytest completed (exit code 1)", session_id: СЕССИЯ });
    initЗапроса();
    записать({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "итог фоновой" }] }, session_id: СЕССИЯ });
    записать({ type: "result", subtype: "success", is_error: false, num_turns: 1, session_id: СЕССИЯ, usage: { input_tokens: 70, output_tokens: 7 } });
    initЗапроса();
    эхо();
    записать({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "ответ на сообщение" }] }, session_id: СЕССИЯ });
    записать({ type: "result", subtype: "success", is_error: false, num_turns: 1, session_id: СЕССИЯ, usage: { input_tokens: 5, output_tokens: 5 } });
    return;
  }
  // ОШИБКА-ДО-ЭХА: свой запрос кончился ошибкой раньше, чем CLI повторил сообщение.
  if (текст.includes("ОШИБКА-ДО-ЭХА")) {
    initЗапроса();
    записать({ type: "result", subtype: "error_during_execution", is_error: true, num_turns: 0, session_id: СЕССИЯ });
    return;
  }
  // ЧУЖОЙ-СУБАГЕНТ: чужой запрос запускает субагента, потом идёт свой;
  // субагент чужого кончается позже, и CLI сам продолжает.
  if (текст.includes("ЧУЖОЙ-СУБАГЕНТ")) {
    записать({ type: "system", subtype: "task_notification", task_id: "tb", status: "completed", summary: "Background command lint completed", session_id: СЕССИЯ });
    initЗапроса();
    записать({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id: "toolu_чужой", name: "Agent", input: { description: "чужой" } }] }, session_id: СЕССИЯ });
    записать({ type: "system", subtype: "task_started", task_id: "t9", tool_use_id: "toolu_чужой", task_type: "local_agent", session_id: СЕССИЯ });
    записать({ type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "toolu_чужой", content: "Async agent launched successfully." }] }, session_id: СЕССИЯ });
    записать({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "чужой ждёт субагента" }] }, session_id: СЕССИЯ });
    const сОшибкой = текст.includes("С-ОШИБКОЙ");
    записать({ type: "result", subtype: сОшибкой ? "error_during_execution" : "success", is_error: сОшибкой, num_turns: 2, session_id: СЕССИЯ });
    initЗапроса();
    эхо();
    записать({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "ответ на сообщение" }] }, session_id: СЕССИЯ });
    записать({ type: "result", subtype: "success", is_error: false, num_turns: 1, session_id: СЕССИЯ });
    setTimeout(() => {
      записать({ type: "system", subtype: "task_notification", task_id: "t9", status: "completed", session_id: СЕССИЯ });
      initЗапроса();
      записать({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "итог чужого субагента" }] }, session_id: СЕССИЯ });
      записать({ type: "result", subtype: "success", is_error: false, num_turns: 1, session_id: СЕССИЯ });
    }, 200);
    return;
  }
  эхо();
  // ФОН-УВЕДОМЛЕНИЕ-БЕЗ-ХОДА: фоновая команда кончилась, но CLI ход не начал.
  if (текст.includes("ФОН-УВЕДОМЛЕНИЕ-БЕЗ-ХОДА")) {
    записать({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "запущено" }] }, session_id: СЕССИЯ });
    записать({ type: "result", subtype: "success", is_error: false, num_turns: 1, session_id: СЕССИЯ });
    setTimeout(() => {
      записать({ type: "system", subtype: "task_notification", task_id: "tc", status: "completed", summary: "Background command старая completed", session_id: СЕССИЯ });
    }, 50);
    return;
  }
  // САМ-БЕЗ-ПРИЧИНЫ: после хода CLI сам начинает запрос без уведомления о задаче.
  if (текст.includes("САМ-БЕЗ-ПРИЧИНЫ")) {
    записать({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "готово" }] }, session_id: СЕССИЯ });
    записать({ type: "result", subtype: "success", is_error: false, num_turns: 1, session_id: СЕССИЯ });
    setTimeout(() => {
      initЗапроса();
      записать({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "сам" }] }, session_id: СЕССИЯ });
      записать({ type: "result", subtype: "success", is_error: false, num_turns: 1, session_id: СЕССИЯ });
    }, 50);
    return;
  }

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

  // ДЛИННЫЙ-ВЫВОД: результат инструмента длиннее предела показа, блоками
  // текста — как у настоящего Claude для части инструментов.
  if (текст.includes("ДЛИННЫЙ-ВЫВОД")) {
    записать({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "toolu_long", name: "Bash", input: { command: "cat big.log" } }] },
      session_id: СЕССИЯ,
    });
    записать({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_long",
            content: [
              { type: "text", text: "начало-вывода " + "x".repeat(100_000) },
              { type: "text", text: "КОНЕЦ-ВЫВОДА" },
            ],
          },
        ],
      },
      session_id: СЕССИЯ,
    });
    записать({ type: "assistant", message: { content: [{ type: "text", text: "прочитал" }] }, session_id: СЕССИЯ });
    записать({ type: "result", subtype: "success", is_error: false, num_turns: 2, session_id: СЕССИЯ });
    return;
  }

  // Трудные порядки для ожидания субагентов (рецензия Codex 28.09).
  const субагентЗапущен = (id) => {
    записать({ type: "system", subtype: "task_started", task_id: id, tool_use_id: "toolu_" + id, task_type: "local_agent", session_id: СЕССИЯ });
  };
  const итог = (текстИтога, ошибка = false) => {
    записать({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: текстИтога }] }, session_id: СЕССИЯ });
    записать({ type: "result", subtype: ошибка ? "error_during_execution" : "success", is_error: ошибка, num_turns: 1, session_id: СЕССИЯ });
  };
  const init = () => записать({ type: "system", subtype: "init", session_id: СЕССИЯ, model: "fake", tools: [], argv, pid: process.pid });
  const готов = (id) => записать({ type: "system", subtype: "task_notification", task_id: id, status: "completed", session_id: СЕССИЯ });
  // ДВА-СУБАГЕНТА: второй кончается, пока модель отвечает итоговым запросом.
  if (текст.includes("ДВА-СУБАГЕНТА")) {
    субагентЗапущен("t1");
    субагентЗапущен("t2");
    итог("жду двоих");
    setTimeout(() => {
      готов("t1");
      init();
      готов("t2");
      setTimeout(() => {
        итог("итог-1");
        setTimeout(() => {
          init();
          итог("итог-2");
        }, 50);
      }, 400);
    }, 100);
    return;
  }
  // ОДИН-МОЛЧИТ: первый субагент кончил, Claude ответил итоговым запросом, второй молчит.
  if (текст.includes("ОДИН-МОЛЧИТ")) {
    субагентЗапущен("t1");
    субагентЗапущен("t2");
    итог("жду двоих");
    setTimeout(() => {
      готов("t1");
      init();
      итог("первый готов");
    }, 100);
    return;
  }
  // ДОЛГИЙ-ЗАПРОС: итоговый запрос модели открыт и долго молчит, потом отвечает.
  if (текст.includes("ДОЛГИЙ-ЗАПРОС")) {
    субагентЗапущен("t1");
    итог("жду");
    setTimeout(() => {
      готов("t1");
      init();
      setTimeout(() => итог("поздний"), 700);
    }, 50);
    return;
  }
  // МОЛЧАЛИВЫЙ-СУБАГЕНТ: субагент запущен и больше о себе не сообщает.
  if (текст.includes("МОЛЧАЛИВЫЙ-СУБАГЕНТ")) {
    субагентЗапущен("t1");
    итог("жду");
    return;
  }
  // СНИМОК-БЕЗ-ТИПА: background_tasks_changed с известным id без task_type.
  if (текст.includes("СНИМОК-БЕЗ-ТИПА")) {
    субагентЗапущен("t1");
    итог("жду");
    записать({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "t1" }], session_id: СЕССИЯ });
    setTimeout(() => {
      готов("t1");
      init();
      итог("итог");
    }, 400);
    return;
  }
  // ОШИБКА-ПРИ-СУБАГЕНТЕ: result с ошибкой, пока субагент работает; его итог приходит позже.
  if (текст.includes("ОШИБКА-ПРИ-СУБАГЕНТЕ")) {
    субагентЗапущен("t1");
    итог("сбой", true);
    setTimeout(() => {
      готов("t1");
      init();
      итог("поздний итог");
    }, 400);
    return;
  }
  // УПАСТЬ-ПРИ-СУБАГЕНТЕ: процесс умирает, пока субагент работает.
  if (текст.includes("УПАСТЬ-ПРИ-СУБАГЕНТЕ")) {
    субагентЗапущен("t1");
    записать({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "жду" }] }, session_id: СЕССИЯ });
    записать({ type: "result", subtype: "success", is_error: false, num_turns: 1, session_id: СЕССИЯ, usage: { input_tokens: 777, output_tokens: 7 } });
    setTimeout(() => process.exit(3), 50);
    return;
  }

  // ФОНОВЫЙ-СУБАГЕНТ / ФОНОВЫЙ-БЕЗ-ПРОДОЛЖЕНИЯ / ФОНОВЫЙ-BASH: форма снята живой
  // трассой Claude Code 2.1.220 в режиме stream-json 28.09.2026. Agent по
  // умолчанию запускает субагента в фоне: result приходит раньше, чем субагент
  // закончил; потом записи субагента с parent_tool_use_id, task_notification,
  // новый init и настоящий итог со своим result.
  if (текст.includes("ФОНОВЫЙ-")) {
    const bash = текст.includes("ФОНОВЫЙ-BASH");
    записать({
      type: "assistant",
      parent_tool_use_id: null,
      message: { content: [{ type: "tool_use", id: "toolu_agent", name: bash ? "Bash" : "Agent", input: { description: "фон" } }] },
      session_id: СЕССИЯ,
    });
    записать({
      type: "system", subtype: "task_started", task_id: "t1", tool_use_id: "toolu_agent",
      task_type: bash ? "local_bash" : "local_agent", description: bash ? "sleep 20 в фоне" : "фон", session_id: СЕССИЯ,
    });
    записать({
      type: "user",
      parent_tool_use_id: null,
      message: { content: [{ type: "tool_result", tool_use_id: "toolu_agent", content: [{ type: "text", text: "Async agent launched successfully." }] }] },
      session_id: СЕССИЯ,
    });
    записать({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "агент запущен, жду" }] }, session_id: СЕССИЯ });
    записать({ type: "rate_limit_event", rate_limit_info: { status: "allowed", resetsAt: 1790553000, rateLimitType: "five_hour" }, session_id: СЕССИЯ });
    записать({
      type: "result", subtype: "success", is_error: false, num_turns: 2, session_id: СЕССИЯ,
      usage: { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 100, output_tokens: 20 },
    });
    // ФОНОВЫЙ-BASH-ПОЗЖЕ: команда кончается после result, и Claude сам
    // начинает новый ход — без сообщения панели (живая трасса 28.09, 2.1.220).
    if (bash && текст.includes("ФОНОВЫЙ-BASH-ПОЗЖЕ")) {
      setTimeout(() => {
        записать({ type: "system", subtype: "background_tasks_changed", tasks: [], session_id: СЕССИЯ });
        записать({ type: "system", subtype: "task_updated", task_id: "t1", patch: { status: "completed" }, session_id: СЕССИЯ });
        записать({
          type: "system", subtype: "task_notification", task_id: "t1", tool_use_id: "toolu_agent", status: "completed",
          summary: "Background command \"sleep 20 в фоне\" completed (exit code 0)", session_id: СЕССИЯ,
        });
        записать({ type: "system", subtype: "init", session_id: СЕССИЯ, model: "fake", tools: [], argv, pid: process.pid });
        записать({ type: "system", subtype: "thinking_tokens", session_id: СЕССИЯ });
        записать({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "Команда завершена успешно." }] }, session_id: СЕССИЯ });
        записать({
          type: "result", subtype: "success", is_error: false, num_turns: 1, session_id: СЕССИЯ,
          usage: { input_tokens: 3, cache_read_input_tokens: 500, cache_creation_input_tokens: 0, output_tokens: 4 },
        });
      }, 300);
      return;
    }
    if (bash) return;
    setTimeout(() => {
      записать({
        type: "assistant",
        parent_tool_use_id: "toolu_agent",
        message: { content: [{ type: "tool_use", id: "toolu_sub", name: "Read", input: { file_path: "a.txt" } }] },
        session_id: СЕССИЯ,
      });
      записать({
        type: "user",
        parent_tool_use_id: "toolu_agent",
        message: { content: [{ type: "tool_result", tool_use_id: "toolu_sub", content: "alpha" }] },
        session_id: СЕССИЯ,
      });
      записать({ type: "system", subtype: "task_notification", task_id: "t1", tool_use_id: "toolu_agent", status: "completed", session_id: СЕССИЯ });
      if (текст.includes("ФОНОВЫЙ-БЕЗ-ПРОДОЛЖЕНИЯ")) return;
      записать({ type: "system", subtype: "init", session_id: СЕССИЯ, model: "fake", tools: [], argv, pid: process.pid });
      записать({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "alpha" }] }, session_id: СЕССИЯ });
      записать({
        type: "result", subtype: "success", is_error: false, num_turns: 1, session_id: СЕССИЯ,
        usage: { input_tokens: 5, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0, output_tokens: 7 },
      });
    }, 300);
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
