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
 *   ВОПРОС-ЧЕЛОВЕКУ — AskUserQuestion: ход ждёт ответа панели;
 *   УПАСТЬ      — внезапный выход процесса посреди хода;
 *   РАЗРЫВ      — ответ с U+2028/U+2029 внутри строки JSON.
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
const SESSION = "fake-claude-session";
const writeLine = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

// `claude -p "/usage"` — ответ без запроса модели (CLI 2.1.220, 28.09). Доля
// отдаётся, только если адаптер просит не оставлять файл сессии.
if (argv.includes("/usage") && argv.includes("--hang-usage")) {
  // Зависший /usage: остальной модуль (init, чтение stdin) не выполняется.
  setInterval(() => {}, 1000);
  await new Promise(() => {});
} else if (argv.includes("/usage")) {
  const lines = [
    "Current session: 28% used · resets Sep 28, 6:50am (Asia/Novosibirsk)",
    argv.includes("--no-session-persistence")
      ? "Current week (all models): 4% used · resets Oct 4, 12am (Asia/Novosibirsk)"
      : "session would be persisted",
  ];
  writeLine({ type: "result", subtype: "success", is_error: false, result: lines.join(String.fromCharCode(10)) });
  process.exit(0);
}

// Настоящие агенты пишут в stderr служебные логи с цветовыми кодами.
process.stderr.write(
  "\x1b[2m2026-09-14T17:07:57.727561Z\x1b[0m \x1b[33mWARN\x1b[0m фальшивый служебный лог\n",
);

writeLine({
  type: "system",
  subtype: "init",
  session_id: SESSION,
  model: "fake",
  tools: [],
  argv,
  pid: process.pid,
});

/** Запросы к панели, ждущие control_response: request_id → продолжение хода. */
const pendingRequests = new Map();

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    return;
  }
  if (record.type === "control_response") {
    // Ответ панели — в stderr: тест читает его из диагностики и видит,
    // что именно ушло агенту.
    process.stderr.write(`ОТВЕТ-ПАНЕЛИ ${JSON.stringify(record.response)}\n`);
    const resume = pendingRequests.get(record.response?.request_id);
    pendingRequests.delete(record.response?.request_id);
    resume?.(record.response);
    return;
  }
  // initialize: список моделей в форме, снятой пробой с Claude Code 2.1.220.
  if (record.type === "control_request" && record.request?.subtype === "initialize") {
    const levels = ["low", "medium", "high", "xhigh", "max"];
    writeLine({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: record.request_id,
        response: {
          commands: [],
          models: [
            { value: "default", resolvedModel: "claude-sonnet-5", displayName: "Default (recommended)", description: "Sonnet 5 · Efficient for routine tasks", supportsEffort: true, supportedEffortLevels: levels },
            { value: "sonnet", resolvedModel: "claude-sonnet-5", displayName: "Sonnet", description: "Sonnet 5 · Efficient for routine tasks", supportsEffort: true, supportedEffortLevels: levels },
            { value: "opus", resolvedModel: "claude-opus-5", displayName: "Opus", description: "Opus 5 · Best for everyday, complex tasks", supportsEffort: true, supportedEffortLevels: levels },
            { value: "haiku", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku", description: "Haiku 4.5 · Fastest for quick answers" },
          ],
        },
      },
    });
    return;
  }
  if (record.type !== "user") return;
  const text = (record.message?.content ?? []).map((b) => b.text ?? "").join("");
  // --replay-user-messages: настоящий CLI повторяет сообщение с isReplay,
  // когда начинает его обрабатывать — внутри своего запроса, после init
  // (живая проба 28.09: второе сообщение, посланное во время первого хода,
  // повторено только в своём запросе).
  const echo = () => {
    if (argv.includes("--replay-user-messages")) {
      writeLine({ type: "user", message: record.message, session_id: SESSION, parent_tool_use_id: null, isReplay: true });
    }
  };
  const emitInit = () => writeLine({ type: "system", subtype: "init", session_id: SESSION, model: "fake", tools: [], argv, pid: process.pid });
  // ГОНКА: CLI уже начал свой запрос (кончилась фоновая команда), когда
  // пришло сообщение панели; сообщение обрабатывается следом.
  if (text.includes("ГОНКА")) {
    writeLine({ type: "system", subtype: "task_notification", task_id: "tb", status: "completed", summary: "Background command pytest completed (exit code 1)", session_id: SESSION });
    emitInit();
    writeLine({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "итог фоновой" }] }, session_id: SESSION });
    writeLine({ type: "result", subtype: "success", is_error: false, num_turns: 1, session_id: SESSION, usage: { input_tokens: 70, output_tokens: 7 } });
    emitInit();
    echo();
    writeLine({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "ответ на сообщение" }] }, session_id: SESSION });
    writeLine({ type: "result", subtype: "success", is_error: false, num_turns: 1, session_id: SESSION, usage: { input_tokens: 5, output_tokens: 5 } });
    return;
  }
  // ОШИБКА-ДО-ЭХА: свой запрос кончился ошибкой раньше, чем CLI повторил сообщение.
  if (text.includes("ОШИБКА-ДО-ЭХА")) {
    emitInit();
    writeLine({ type: "result", subtype: "error_during_execution", is_error: true, num_turns: 0, session_id: SESSION });
    return;
  }
  // ЧУЖОЙ-СУБАГЕНТ: чужой запрос запускает субагента, потом идёт свой;
  // субагент чужого кончается позже, и CLI сам продолжает.
  if (text.includes("ЧУЖОЙ-СУБАГЕНТ")) {
    writeLine({ type: "system", subtype: "task_notification", task_id: "tb", status: "completed", summary: "Background command lint completed", session_id: SESSION });
    emitInit();
    writeLine({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id: "toolu_чужой", name: "Agent", input: { description: "чужой" } }] }, session_id: SESSION });
    writeLine({ type: "system", subtype: "task_started", task_id: "t9", tool_use_id: "toolu_чужой", task_type: "local_agent", session_id: SESSION });
    writeLine({ type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "toolu_чужой", content: "Async agent launched successfully." }] }, session_id: SESSION });
    writeLine({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "чужой ждёт субагента" }] }, session_id: SESSION });
    const withError = text.includes("С-ОШИБКОЙ");
    writeLine({ type: "result", subtype: withError ? "error_during_execution" : "success", is_error: withError, num_turns: 2, session_id: SESSION });
    emitInit();
    echo();
    writeLine({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "ответ на сообщение" }] }, session_id: SESSION });
    writeLine({ type: "result", subtype: "success", is_error: false, num_turns: 1, session_id: SESSION });
    setTimeout(() => {
      writeLine({ type: "system", subtype: "task_notification", task_id: "t9", status: "completed", session_id: SESSION });
      emitInit();
      writeLine({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "итог чужого субагента" }] }, session_id: SESSION });
      writeLine({ type: "result", subtype: "success", is_error: false, num_turns: 1, session_id: SESSION });
    }, 200);
    return;
  }
  // ЧУЖОЙ-ПОТОК: чужой запрос успел начать ответ (только stream_event) и
  // кончился ошибкой; свой идёт следом. Эхо своего приходит раньше первого
  // stream_event (замер 28.09), значит, поток без эха — чужой.
  if (text.includes("ЧУЖОЙ-ПОТОК")) {
    emitInit();
    writeLine({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_start" }, session_id: SESSION });
    writeLine({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", delta: { type: "text_delta", text: "чуж" } }, session_id: SESSION });
    writeLine({ type: "result", subtype: "error_during_execution", is_error: true, num_turns: 1, session_id: SESSION });
    emitInit();
    echo();
    writeLine({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "ответ на сообщение" }] }, session_id: SESSION });
    writeLine({ type: "result", subtype: "success", is_error: false, num_turns: 1, session_id: SESSION });
    return;
  }
  echo();
  // ФОН-УВЕДОМЛЕНИЕ-БЕЗ-ХОДА: фоновая команда кончилась, но CLI ход не начал.
  if (text.includes("ФОН-УВЕДОМЛЕНИЕ-БЕЗ-ХОДА")) {
    writeLine({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "запущено" }] }, session_id: SESSION });
    writeLine({ type: "result", subtype: "success", is_error: false, num_turns: 1, session_id: SESSION });
    setTimeout(() => {
      writeLine({ type: "system", subtype: "task_notification", task_id: "tc", status: "completed", summary: "Background command старая completed", session_id: SESSION });
    }, 50);
    return;
  }
  // САМ-БЕЗ-ПРИЧИНЫ: после хода CLI сам начинает запрос без уведомления о задаче.
  if (text.includes("САМ-БЕЗ-ПРИЧИНЫ")) {
    writeLine({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "готово" }] }, session_id: SESSION });
    writeLine({ type: "result", subtype: "success", is_error: false, num_turns: 1, session_id: SESSION });
    setTimeout(() => {
      emitInit();
      writeLine({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "сам" }] }, session_id: SESSION });
      writeLine({ type: "result", subtype: "success", is_error: false, num_turns: 1, session_id: SESSION });
    }, 50);
    return;
  }

  // НУЖНО-РАЗРЕШЕНИЕ: запрос can_use_tool в форме, снятой пробой с Claude Code
  // 2.1.220 (--permission-prompt-tool stdio). Ход ждёт ответа панели; отказ,
  // как у настоящего, попадает в permission_denials итога.
  if (text.includes("НУЖНО-РАЗРЕШЕНИЕ")) {
    const input = { command: "mkdir probe-dir", description: "Create directory" };
    writeLine({ type: "stream_event", event: { type: "message_start" }, session_id: SESSION });
    writeLine({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "toolu_perm", name: "Bash", input: input }] },
      session_id: SESSION,
    });
    writeLine({
      type: "control_request",
      request_id: "perm-1",
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        display_name: "Bash",
        input: input,
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
        // ТОЛЬКО-ЧЕЛОВЕКОМ: запрос, который CLI отдаёт человеку и в bypassPermissions.
        ...(text.includes("ТОЛЬКО-ЧЕЛОВЕКОМ") ? { requires_user_interaction: true } : {}),
      },
    });
    pendingRequests.set("perm-1", (reply) => {
      const decision = reply?.response ?? {};
      const allowed = decision.behavior === "allow";
      writeLine({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_perm",
              content: allowed ? "" : String(decision.message ?? ""),
              is_error: !allowed,
            },
          ],
        },
        session_id: SESSION,
      });
      writeLine({
        type: "assistant",
        message: { content: [{ type: "text", text: allowed ? "каталог создан" : "не разрешили" }] },
        session_id: SESSION,
      });
      writeLine({
        type: "result",
        subtype: "success",
        is_error: false,
        num_turns: 2,
        session_id: SESSION,
        ...(allowed
          ? {}
          : { permission_denials: [{ tool_name: "Bash", tool_use_id: "toolu_perm", tool_input: input }] }),
      });
    });
    return;
  }

  // ВОПРОС-ЧЕЛОВЕКУ: AskUserQuestion в форме из журнала панели (CLI 2.1.287,
  // seq 66068): can_use_tool с requires_user_interaction, без предложений
  // правил. CLI присылает его и в режиме bypassPermissions. Ответ — answers
  // в updatedInput (документация Agent SDK, user-input, 05.10.2026).
  if (text.includes("ВОПРОС-ЧЕЛОВЕКУ")) {
    const input = {
      questions: [
        { question: "Какой вариант?", header: "Выбор", options: [{ label: "а" }, { label: "б" }], multiSelect: false },
      ],
    };
    writeLine({ type: "stream_event", event: { type: "message_start" }, session_id: SESSION });
    writeLine({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "toolu_q", name: "AskUserQuestion", input: input }] },
      session_id: SESSION,
    });
    writeLine({
      type: "control_request",
      request_id: "ask-1",
      request: {
        subtype: "can_use_tool",
        tool_name: "AskUserQuestion",
        display_name: "AskUserQuestion",
        input: input,
        tool_use_id: "toolu_q",
        requires_user_interaction: true,
      },
    });
    pendingRequests.set("ask-1", (reply) => {
      const decision = reply?.response ?? {};
      const allowed = decision.behavior === "allow";
      const answers = allowed ? decision.updatedInput?.answers : undefined;
      writeLine({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_q",
              content: !allowed
                ? String(decision.message ?? "")
                : answers
                  ? `User has answered your questions: ${JSON.stringify(answers)}`
                  : "The user did not answer the questions.",
              is_error: !allowed,
            },
          ],
        },
        session_id: SESSION,
      });
      writeLine({
        type: "assistant",
        message: { content: [{ type: "text", text: `ответ получен: ${answers ? JSON.stringify(answers) : "нет ответов"}` }] },
        session_id: SESSION,
      });
      writeLine({
        type: "result",
        subtype: "success",
        is_error: false,
        num_turns: 2,
        session_id: SESSION,
        ...(allowed
          ? {}
          : { permission_denials: [{ tool_name: "AskUserQuestion", tool_use_id: "toolu_q", tool_input: input }] }),
      });
    });
    return;
  }

  // ДЛИННЫЙ-ВЫВОД: результат инструмента длиннее предела показа, блоками
  // текста — как у настоящего Claude для части инструментов.
  if (text.includes("ДЛИННЫЙ-ВЫВОД")) {
    writeLine({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "toolu_long", name: "Bash", input: { command: "cat big.log" } }] },
      session_id: SESSION,
    });
    writeLine({
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
      session_id: SESSION,
    });
    writeLine({ type: "assistant", message: { content: [{ type: "text", text: "прочитал" }] }, session_id: SESSION });
    writeLine({ type: "result", subtype: "success", is_error: false, num_turns: 2, session_id: SESSION });
    return;
  }

  // Трудные порядки для ожидания субагентов (рецензия Codex 28.09).
  const subagentStarted = (id) => {
    writeLine({ type: "system", subtype: "task_started", task_id: id, tool_use_id: "toolu_" + id, task_type: "local_agent", session_id: SESSION });
  };
  const result = (resultText, error = false) => {
    writeLine({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: resultText }] }, session_id: SESSION });
    writeLine({ type: "result", subtype: error ? "error_during_execution" : "success", is_error: error, num_turns: 1, session_id: SESSION });
  };
  const init = () => writeLine({ type: "system", subtype: "init", session_id: SESSION, model: "fake", tools: [], argv, pid: process.pid });
  const taskDone = (id) => writeLine({ type: "system", subtype: "task_notification", task_id: id, status: "completed", session_id: SESSION });
  // ДВА-СУБАГЕНТА: второй кончается, пока модель отвечает итоговым запросом.
  if (text.includes("ДВА-СУБАГЕНТА")) {
    subagentStarted("t1");
    subagentStarted("t2");
    result("жду двоих");
    setTimeout(() => {
      taskDone("t1");
      init();
      taskDone("t2");
      setTimeout(() => {
        result("итог-1");
        setTimeout(() => {
          init();
          result("итог-2");
        }, 50);
      }, 400);
    }, 100);
    return;
  }
  // ОДИН-МОЛЧИТ: первый субагент кончил, Claude ответил итоговым запросом, второй молчит.
  if (text.includes("ОДИН-МОЛЧИТ")) {
    subagentStarted("t1");
    subagentStarted("t2");
    result("жду двоих");
    setTimeout(() => {
      taskDone("t1");
      init();
      result("первый готов");
    }, 100);
    return;
  }
  // ДОЛГИЙ-ЗАПРОС: итоговый запрос модели открыт и долго молчит, потом отвечает.
  if (text.includes("ДОЛГИЙ-ЗАПРОС")) {
    subagentStarted("t1");
    result("жду");
    setTimeout(() => {
      taskDone("t1");
      init();
      setTimeout(() => result("поздний"), 700);
    }, 50);
    return;
  }
  // МОЛЧАЛИВЫЙ-СУБАГЕНТ: субагент запущен и больше о себе не сообщает.
  if (text.includes("МОЛЧАЛИВЫЙ-СУБАГЕНТ")) {
    subagentStarted("t1");
    result("жду");
    return;
  }
  // СНИМОК-БЕЗ-ТИПА: background_tasks_changed с известным id без task_type.
  if (text.includes("СНИМОК-БЕЗ-ТИПА")) {
    subagentStarted("t1");
    result("жду");
    writeLine({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "t1" }], session_id: SESSION });
    setTimeout(() => {
      taskDone("t1");
      init();
      result("итог");
    }, 400);
    return;
  }
  // ОШИБКА-ПРИ-СУБАГЕНТЕ: result с ошибкой, пока субагент работает; его итог приходит позже.
  if (text.includes("ОШИБКА-ПРИ-СУБАГЕНТЕ")) {
    subagentStarted("t1");
    result("сбой", true);
    setTimeout(() => {
      taskDone("t1");
      init();
      result("поздний итог");
    }, 400);
    return;
  }
  // УПАСТЬ-ПРИ-СУБАГЕНТЕ: процесс умирает, пока субагент работает.
  if (text.includes("УПАСТЬ-ПРИ-СУБАГЕНТЕ")) {
    subagentStarted("t1");
    writeLine({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "жду" }] }, session_id: SESSION });
    writeLine({ type: "result", subtype: "success", is_error: false, num_turns: 1, session_id: SESSION, usage: { input_tokens: 777, output_tokens: 7 } });
    setTimeout(() => process.exit(3), 50);
    return;
  }

  // ФОНОВЫЙ-СУБАГЕНТ / ФОНОВЫЙ-БЕЗ-ПРОДОЛЖЕНИЯ / ФОНОВЫЙ-BASH: форма снята живой
  // трассой Claude Code 2.1.220 в режиме stream-json 28.09.2026. Agent по
  // умолчанию запускает субагента в фоне: result приходит раньше, чем субагент
  // закончил; потом записи субагента с parent_tool_use_id, task_notification,
  // новый init и настоящий итог со своим result.
  if (text.includes("ФОНОВЫЙ-")) {
    const bash = text.includes("ФОНОВЫЙ-BASH");
    writeLine({
      type: "assistant",
      parent_tool_use_id: null,
      message: { content: [{ type: "tool_use", id: "toolu_agent", name: bash ? "Bash" : "Agent", input: { description: "фон" } }] },
      session_id: SESSION,
    });
    writeLine({
      type: "system", subtype: "task_started", task_id: "t1", tool_use_id: "toolu_agent",
      task_type: bash ? "local_bash" : "local_agent", description: bash ? "sleep 20 в фоне" : "фон", session_id: SESSION,
    });
    writeLine({
      type: "user",
      parent_tool_use_id: null,
      message: { content: [{ type: "tool_result", tool_use_id: "toolu_agent", content: [{ type: "text", text: "Async agent launched successfully." }] }] },
      session_id: SESSION,
    });
    writeLine({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "агент запущен, жду" }] }, session_id: SESSION });
    writeLine({ type: "rate_limit_event", rate_limit_info: { status: "allowed", resetsAt: 1790553000, rateLimitType: "five_hour" }, session_id: SESSION });
    writeLine({
      type: "result", subtype: "success", is_error: false, num_turns: 2, session_id: SESSION,
      usage: { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 100, output_tokens: 20 },
    });
    // ФОНОВЫЙ-BASH-ПОЗЖЕ: команда кончается после result, и Claude сам
    // начинает новый ход — без сообщения панели (живая трасса 28.09, 2.1.220).
    if (bash && text.includes("ФОНОВЫЙ-BASH-ПОЗЖЕ")) {
      setTimeout(() => {
        writeLine({ type: "system", subtype: "background_tasks_changed", tasks: [], session_id: SESSION });
        writeLine({ type: "system", subtype: "task_updated", task_id: "t1", patch: { status: "completed" }, session_id: SESSION });
        writeLine({
          type: "system", subtype: "task_notification", task_id: "t1", tool_use_id: "toolu_agent", status: "completed",
          summary: "Background command \"sleep 20 в фоне\" completed (exit code 0)", session_id: SESSION,
        });
        writeLine({ type: "system", subtype: "init", session_id: SESSION, model: "fake", tools: [], argv, pid: process.pid });
        writeLine({ type: "system", subtype: "thinking_tokens", session_id: SESSION });
        writeLine({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "Команда завершена успешно." }] }, session_id: SESSION });
        writeLine({
          type: "result", subtype: "success", is_error: false, num_turns: 1, session_id: SESSION,
          usage: { input_tokens: 3, cache_read_input_tokens: 500, cache_creation_input_tokens: 0, output_tokens: 4 },
        });
      }, 300);
      return;
    }
    if (bash) return;
    setTimeout(() => {
      writeLine({
        type: "assistant",
        parent_tool_use_id: "toolu_agent",
        message: { content: [{ type: "tool_use", id: "toolu_sub", name: "Read", input: { file_path: "a.txt" } }] },
        session_id: SESSION,
      });
      writeLine({
        type: "user",
        parent_tool_use_id: "toolu_agent",
        message: { content: [{ type: "tool_result", tool_use_id: "toolu_sub", content: "alpha" }] },
        session_id: SESSION,
      });
      writeLine({ type: "system", subtype: "task_notification", task_id: "t1", tool_use_id: "toolu_agent", status: "completed", session_id: SESSION });
      if (text.includes("ФОНОВЫЙ-БЕЗ-ПРОДОЛЖЕНИЯ")) return;
      writeLine({ type: "system", subtype: "init", session_id: SESSION, model: "fake", tools: [], argv, pid: process.pid });
      writeLine({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "alpha" }] }, session_id: SESSION });
      writeLine({
        type: "result", subtype: "success", is_error: false, num_turns: 1, session_id: SESSION,
        usage: { input_tokens: 5, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0, output_tokens: 7 },
      });
    }, 300);
    return;
  }

  // ЧУЖОЙ-ЗАПРОС: control_request, который панель не обслуживает. Без ответа
  // настоящий Claude ждал бы вечно.
  if (text.includes("ЧУЖОЙ-ЗАПРОС")) {
    writeLine({ type: "control_request", request_id: "hook-1", request: { subtype: "hook_callback", callback_id: "x" } });
    pendingRequests.set("hook-1", () => {
      writeLine({ type: "assistant", message: { content: [{ type: "text", text: "дальше" }] }, session_id: SESSION });
      writeLine({ type: "result", subtype: "success", is_error: false, num_turns: 1, session_id: SESSION });
    });
    return;
  }

  // ДОЛГАЯ-КОМАНДА <путь>: как настоящий Claude, выполняющий инструмент, —
  // запускает долгий дочерний процесс, пишет его pid в файл и хода не
  // завершает. Проверяет, что остановка убивает всё дерево.
  const longCmd = /ДОЛГАЯ-КОМАНДА (\S+)/.exec(text);
  if (longCmd) {
    const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    writeFileSync(longCmd[1], JSON.stringify({ agent: process.pid, grandchild: grandchild.pid }));
    return;
  }
  if (text.includes("УПАСТЬ")) {
    process.exit(3);
  }
  if (text.includes("ОТКАЗ")) {
    // Форма снята с настоящего result живого прогона 15 сентября:
    // отказы приходят при is_error: false.
    writeLine({
      type: "assistant",
      message: { content: [{ type: "text", text: "команда заблокирована" }] },
      session_id: SESSION,
    });
    writeLine({
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 1,
      session_id: SESSION,
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
  if (text.includes("ОШИБКА-ХОДА")) {
    writeLine({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      stop_reason: "error_during_execution",
      num_turns: 1,
      session_id: SESSION,
    });
    return;
  }

  // РАЗРЫВ: ответ с U+2028/U+2029 — JSON.stringify пишет их как есть.
  if (text.includes("РАЗРЫВ")) {
    writeLine({ type: "assistant", message: { content: [{ type: "text", text: "до после конец" }] }, session_id: SESSION });
    writeLine({ type: "result", subtype: "success", is_error: false, num_turns: 1, session_id: SESSION });
    return;
  }

  writeLine({ type: "stream_event", event: { type: "message_start" }, session_id: SESSION });
  for (const chunk of ["при", "вет"]) {
    writeLine({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: chunk } },
      session_id: SESSION,
    });
  }
  writeLine({
    type: "assistant",
    message: { content: [{ type: "text", text: "привет" }] },
    session_id: SESSION,
  });
  writeLine({ type: "result", subtype: "success", is_error: false, num_turns: 1, session_id: SESSION });
});
lines.on("close", () => process.exit(0));
