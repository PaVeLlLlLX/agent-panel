/**
 * Фальшивый Antigravity CLI (agy) для проверки панели.
 *
 * Повторяет формат, снятый живой пробой 02.10.2026
 * (docs/research/2026-10-02-проба-agy.md):
 *   agy models                             — строки «slug<TAB>название»;
 *   agy -p /usage --output-format json     — квота без хода модели;
 *   agy -p= --input-format stream-json --output-format stream-json …
 *                                           — поточный режим, по строке
 *     {"event":"user","message":{"content":"…"}} на ход; init, затем на
 *     каждый ход step_update (user_input, agent_response с text_delta и
 *     usage, tool с tool_info) и result.
 *
 * Управляющие слова в тексте хода (разбираются один раз, в порядке строк):
 *   ОТКАЗ-БЕЗ-ЗАПРОСА — действие отклонено без интерфейса: пустой response,
 *     status SUCCESS, denied_actions копится;
 *   ОТКАЗ-С-ОТВЕТОМ   — тот же мягкий отказ, но модель всё равно отвечает
 *     текстом (M8: непустой ответ — не «не проверял», отказ остаётся в denials);
 *   ЗАПРЕТ            — write_to_file кончается ERROR с permission check
 *     failed, ход продолжается и отвечает;
 *   ОШИБКА-ХОДА       — status ERROR с error "model error", строка AGY_ERROR
 *     в stderr раньше result;
 *   РЕГИОН            — отказ по региону (Eligibility check failed) в stderr,
 *     result ERROR и выход с кодом 1;
 *   РАЗРЫВ            — ответ с U+2028/U+2029 внутри строки JSON;
 *   ДОЛГО             — ответ через 30 с (для «Прервать» до ответа);
 *   УПАСТЬ            — процесс завершается кодом 3 без result.
 * Поле init.argv — весь argv процесса, только у этой фальшивки.
 * Лежит вне test/ по той же причине, что fake-claude.mjs: читает stdin.
 */
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const writeLine = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

if (argv[0] === "models") {
  process.stderr.write("Fetching available models...\n");
  process.stdout.write(
    [
      "gemini-3.8-flash-high\tGemini 3.8 Flash (High)",
      "gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)",
      "gemini-3.8-flash-low\tGemini 3.8 Flash (Low)",
      "gemini-3.1-pro-high\tGemini 3.1 Pro (High)",
      "gemini-3.1-pro-low\tGemini 3.1 Pro (Low)",
      "claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)",
      "gpt-oss-120b-medium\tGPT-OSS 120B (Medium)",
    ].join("\n") + "\n",
  );
  process.exit(0);
}

if (argv.includes("/usage")) {
  const bucket = (window, left, reset) => ({ window, remaining_fraction: left, reset_time: reset });
  writeLine({
    conversation_id: "",
    status: "SUCCESS",
    response: "",
    num_turns: 0,
    usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 },
    command: { name: "usage", data: { groups: [
      { name: "Gemini Models", buckets: [bucket("weekly", 0.97, "2026-10-09T07:36:04Z"), bucket("5h", 0.89, "2026-10-02T12:36:04Z")] },
      { name: "Claude and GPT models", buckets: [bucket("weekly", 1, "2026-10-09T07:39:51Z")] },
    ] } },
  });
  process.exit(0);
}

const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const CONVERSATION = flag("--conversation") ?? "fake-agy-conv";
// После --conversation накопительный итог включает расход прежнего процесса (проба 02.10).
const PREVIOUS = flag("--conversation") ? 100_000 : 0;

process.stderr.write("фальшивый служебный лог agy\n");
writeLine({
  event: "init",
  conversation_id: CONVERSATION,
  init: {
    cwd: process.cwd(),
    tools: ["view_file", "write_to_file", "run_command", "read_url_content"],
    permission_mode: "request-review",
    model: flag("--model") ?? "gemini-3.8-flash-high",
    agent: flag("--agent"),
    argv,
  },
});

let step = 0;
let turns = 0;
let spent = PREVIOUS;
let spentOut = 0;
const denied = [];

const usageOf = (input, output) => ({ input_tokens: input, output_tokens: output, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: input + output });
const stepUpdate = (fields) => writeLine({ event: "step_update", step_update: { conversation_id: CONVERSATION, step_index: step, ...fields } });

/** Вызов модели: шаг agent_response, текст кусками, расход на DONE. */
function modelCall(input, output, text = "") {
  if (text) stepUpdate({ state: "ACTIVE", step_type: "agent_response", text_delta: text.slice(0, 3) });
  stepUpdate({ state: "DONE", step_type: "agent_response", ...(text ? { text_delta: text.slice(3) } : {}), usage: usageOf(input, output) });
  spent += input;
  spentOut += output;
  step += 1;
}

function tool(name, parameters, state, extra = {}) {
  stepUpdate({ state: "ACTIVE", step_type: "tool", tool_name: name, tool_info: { name, parameters } });
  stepUpdate({ state, step_type: "tool", tool_name: name, tool_info: { name, parameters, ...extra } });
  step += 1;
}

function result(status, response, extra = {}) {
  turns += 1;
  writeLine({
    event: "result",
    result: {
      conversation_id: CONVERSATION,
      status,
      response,
      duration_seconds: 1,
      num_turns: turns,
      usage: usageOf(spent, spentOut),
      ...(denied.length ? { denied_actions: [...denied] } : {}),
      ...extra,
    },
  });
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    return;
  }
  if (record.event !== "user") return;
  const text = String(record.message?.content ?? "");
  stepUpdate({ state: "DONE", step_type: "user_input" });
  step += 1;
  if (text.includes("УПАСТЬ")) {
    modelCall(50, 1);
    process.exit(3);
  }
  // stderr и stdout — разные каналы: строка stderr идёт раньше result с запасом,
  // иначе адаптер мог бы разобрать result до причины.
  if (text.includes("РЕГИОН")) {
    const reason = "Eligibility check failed: Your current account is not eligible for Antigravity, because it is not currently available in your location.";
    process.stderr.write(`error: ${reason}\n`);
    setTimeout(() => {
      result("ERROR", "", { error: reason });
      process.exit(1);
    }, 50);
    return;
  }
  if (text.includes("ОШИБКА-ХОДА")) {
    process.stderr.write('AGY_ERROR: {"status":"UNAVAILABLE","code":503,"message":"model overloaded","retryable":true}\n');
    setTimeout(() => {
      modelCall(80, 0);
      result("ERROR", "", { error: "model error" });
    }, 50);
    return;
  }
  if (text.includes("ОТКАЗ-БЕЗ-ЗАПРОСА")) {
    modelCall(100, 2);
    tool("read_url_content", { Url: "https://pypi.org/pypi/scikit-learn/json" }, "DONE");
    denied.push({ action: "read_url", display_name: "ReadUrlContent" });
    process.stderr.write('jetski: no output produced — a tool required the "read_url" permission that headless mode cannot prompt for, so it was auto-denied.\n');
    result("SUCCESS", "");
    return;
  }
  if (text.includes("ОТКАЗ-С-ОТВЕТОМ")) {
    modelCall(100, 2);
    tool("read_url_content", { Url: "https://pypi.org/pypi/scikit-learn/json" }, "DONE");
    denied.push({ action: "read_url", display_name: "ReadUrlContent" });
    process.stderr.write('jetski: no output produced — a tool required the "read_url" permission that headless mode cannot prompt for, so it was auto-denied.\n');
    modelCall(150, 6, "страницу не открыл, но вот ответ по памяти");
    result("SUCCESS", "страницу не открыл, но вот ответ по памяти\n");
    return;
  }
  if (text.includes("ЗАПРЕТ")) {
    modelCall(100, 2);
    tool("write_to_file", { TargetFile: "out.txt" }, "ERROR", {
      error: { type: "TOOL_ERROR", message: 'permission check failed for write_file "out.txt": Permission denied: Matches user-configured deny rule' },
    });
    modelCall(150, 6, "не удалось: запись запрещена");
    result("SUCCESS", "не удалось: запись запрещена\n");
    return;
  }
  // РАЗРЫВ: ответ с U+2028/U+2029 — JSON.stringify пишет их как есть.
  if (text.includes("РАЗРЫВ")) {
    modelCall(100, 2, "до после конец");
    result("SUCCESS", "до после конец\n");
    return;
  }
  const answer = () => {
    modelCall(100, 2);
    tool("view_file", { AbsolutePath: "notes.py" }, "DONE", { output: "2 lines, 21 bytes" });
    modelCall(200, 10, "готово: файл прочитан");
    result("SUCCESS", "готово: файл прочитан\n");
  };
  if (text.includes("ДОЛГО")) setTimeout(answer, 30_000);
  else answer();
});
