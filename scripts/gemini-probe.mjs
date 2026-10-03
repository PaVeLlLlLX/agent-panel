/**
 * Живая проба Gemini: настоящий agy через адаптер панели.
 *
 * Проверяет то, что офлайн-тесты на фальшивом agy проверить не могут: вход по
 * подписке, правила «только чтение» в настоящей папке проекта (запись и
 * команда — явный отказ, файлы не меняются), чтение страниц, продолжение
 * разговора, квоту и — с флагом --keep-default-components — читает ли агент
 * без встроенной части agy файлы проекта, а не диска.
 *
 * Тратит квоту Google AI Pro. Нужны: agy со входом, правила «только чтение»
 * (кнопка «Добавить правила» в панели).
 *
 * Запуск: npm run build && node scripts/gemini-probe.mjs [--keep-default-components]
 *
 * **--deny-check** (I4, финальная рецензия 02.10): прежние прогоны видели
 * правило `deny` срабатывающим только на роли рецензента, которая сама не
 * пытается писать («Файлы не меняешь… ответь «принято»») — отказ «только
 * чтение» в ленте панели вообще не был замечен под её собственными
 * настройками (`excludeDefaultComponents: true`, те же `tools`). Этот режим
 * поднимает отдельного пробного агента с ТЕМИ ЖЕ фронт-маттером, что и
 * рецензент панели, но с нейтральной ролью, которая пытается писать и
 * выполнять команды, — чтобы увидеть сам отказ правила `deny`, а не
 * дисциплину роли. Пробный агент убирается в finally и не остаётся в
 * настройках владельца.
 *
 * **--timing [--model <slug>] [--cwd <папка>] [--out <файл>] [--dry-run]** (срок молчания
 * Gemini, 03.10): GEMINI_SILENCE_MS в coordinator.ts взят с запасом, потому
 * что долгое рассуждение Pro high не замерено, а признак жизни панели — любая
 * строка stdout или stderr текущего процесса. Режим запускает agy теми же
 * аргументами, что адаптер, в папке комнаты (по умолчанию ~/source/Trading,
 * правила «только чтение» на месте), с пробным агентом, у которого тот же
 * agent.md, что у рецензента панели, и шлёт ОДНУ настоящую проверку: задачу
 * человека и материал Claude из журнала комнаты (только чтение базы) плюс
 * GEMINI_FOCUS и просьбу о вердикте — так, как их собирает координатор. Каждая
 * строка вывода записывается с отметкой времени и разбором; итог — длительность,
 * самый долгий промежуток без строк (всего и внутри шага agent_response),
 * приходят ли пустые ACTIVE во время рассуждения и вызовы инструментов.
 *
 * Тот же прогон — **повтор проверки Trading** с новой ролью (03.10): по
 * умолчанию шлётся проверка `b758130` (задача seq 54152, материал seq 54587),
 * которую Gemini 02.10 принял, пропустив то, что поймал Codex. Сообщение
 * собирается через formatForGemini (шапка с датой) и нынешний GEMINI_FOCUS.
 * В отчёте (--out) — ответ целиком (`answer`) и `replay` (scripts/gemini-replay.mjs):
 * открытые файлы (`filesOpened`, пути view_file), поиски по файлам
 * (`fileSearches`: где искал), обращения к вебу (`webCalls`: запрос или адрес),
 * прочитаны ли GEMINI.md и AGENTS.md из корня папки, обращения к сохранённым
 * страницам agy, файлы и места поиска вне папки проекта, `.env`.
 * Чек-лист повтора — по отчёту и ответу:
 *   1. Прочитал GEMINI.md папки проекта (`replay.readGeminiMd`), не открывал
 *      и не искал `.env` и вне папки, кроме сохранённых страниц agy
 *      (`replay.envOpened` и `replay.outsideProject` пусты; в них и view_file,
 *      и места поиска grep_search, find_by_name, list_dir).
 *   2. Требует полноты отрицательного поиска: источник покрывает всё окно,
 *      страницы выдачи пройдены, цитата обосновывает результат (это поймал Codex).
 *   3. Не пишет «утечек нет» шире свидетельства: участок уже затронут прежними
 *      обращениями, свидетельство — только этот шаг.
 *   4. Слабые места, записанные в поправках, — не достоинство: проверяет, что
 *      вывод участка оговорён условием (полнота реестра); неоговорённое — «пробел».
 *   5. Пункты, которых шаг не касается (сиды), — «не относится: …».
 *   6. Нет выдуманных разделов: каждый названный раздел — из файла в
 *      `filesOpened` или из материала (02.10 — «Эталоны и бейзлайны»).
 *   7. Факты — первоисточник (реестр ЦБ, moex.com, а не сайт агентства о себе),
 *      дата проверки — из строки «[дата: …]» шапки, без непрошеных фактов;
 *      обращений к вебу (`webCalls`) не больше ~15.
 * Запуск: npm run build && node scripts/gemini-probe.mjs --timing --model
 * gemini-3.8-flash-high --out <файл> (модель проверки 02.10); Pro high — без --model.
 *
 * **--kill-resume [--model <slug>] [--cwd <папка>] [--out <файл>]** (пометка
 * CUT_NOTE, 03.10): ход с вебом снимается остановкой дерева процессов (как
 * killTree панели) сразу после начала первого шага инструмента, затем новый
 * процесс с --conversation получает другой короткий вопрос и ещё один —
 * «о чём был предыдущий вопрос». Видно, что agy сохранил от снятого хода.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { replayTrace } from "./gemini-replay.mjs";

const require = createRequire(import.meta.url);
const { GeminiAdapter, formatForGemini } = require("../out/adapters/gemini.js");
const { readJsonLines } = require("../out/adapters/jsonLines.js");
const { killTree, spawnProcess } = require("../out/adapters/process.js");
const { resolveGeminiCommand } = require("../out/geminiBinary.js");
const {
  EXCLUDE_DEFAULT_COMPONENTS,
  WEB_BUDGET,
  agySettingsPath,
  checkReadOnlyRules,
  reviewerAgentMarkdown,
  rulesRefusal,
} = require("../out/geminiSetup.js");
const { fetchGeminiUsage } = require("../out/geminiUsage.js");
const { VERDICT_REQUEST } = require("../out/verdict.js");

const KEEP_DEFAULT = process.argv.includes("--keep-default-components");
const DENY_CHECK = process.argv.includes("--deny-check");
const TIMING = process.argv.includes("--timing");
const KILL_RESUME = process.argv.includes("--kill-resume");

/** Значение флага «--name value»; нет флага — fallback. */
function argValue(name, fallback) {
  const at = process.argv.indexOf(name);
  return at >= 0 && at + 1 < process.argv.length ? process.argv[at + 1] : fallback;
}
const AGENT = KEEP_DEFAULT ? "agent-panel-reviewer-probe-full" : "agent-panel-reviewer-probe";

const launch = resolveGeminiCommand("agy", process.env.LOCALAPPDATA, process.env.PATH);
if (!launch) throw new Error("agy не найден");
const settings = agySettingsPath(homedir());
const refusal = rulesRefusal(checkReadOnlyRules(settings), settings);
if (refusal) throw new Error(`${refusal}. Добавьте правила кнопкой в панели и повторите.`);

if (DENY_CHECK) {
  await runDenyCheck();
  process.exit(0);
}

/**
 * Отказ agy по региону: бывает разовым, повторяется один раз через минуту.
 * Приходит и концом процесса, и строкой result со status ERROR при живом
 * процессе — после долгого молчания (03.10: 108 с без единой строки).
 */
class EligibilityError extends Error {
  constructor(session, turn) {
    super("Eligibility check failed");
    const lines = turn ?? session.lines;
    this.attempt = {
      at: new Date(session.startedAt).toISOString(),
      args: session.args,
      silentMs: lines.length ? lines[0].t : null,
      exit: session.exit ?? null,
      lines: lines.map((e) => ({ t: e.t, stream: e.stream, line: e.line })),
    };
  }
}

const isEligibilityFailure = (turn) =>
  turn.some((e) => e.info.eligibility || (e.info.kind === "result" && /Eligibility check failed/i.test(String(e.info.error ?? ""))));

async function withEligibilityRetry(run, mode) {
  const attempts = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) {
      console.error("agy: Eligibility check failed — повтор через минуту");
      await new Promise((r) => setTimeout(r, 60_000));
    }
    try {
      await run();
      return;
    } catch (err) {
      if (!(err instanceof EligibilityError)) throw err;
      attempts.push(err.attempt);
    }
  }
  // Оба запуска отказаны: отчёт всё равно пишется — отказ и есть результат пробы.
  console.log(writeReport({ mode, eligibilityFailed: true, attempts }));
  process.exitCode = 2;
}

/** Пробный агент с тем же agent.md, что у рецензента панели; путь — чтобы убрать в finally. */
function writeProbeAgent(name) {
  const agentFile = join(homedir(), ".gemini", "config", "agents", name, "agent.md");
  mkdirSync(dirname(agentFile), { recursive: true });
  writeFileSync(agentFile, reviewerAgentMarkdown(name, EXCLUDE_DEFAULT_COMPONENTS));
  return dirname(agentFile);
}

/**
 * Разбор одной строки вывода agy — без текста целиком: тип события, шаг,
 * состояние, есть ли text_delta, usage, имя инструмента.
 */
function classifyLine(stream, line) {
  if (stream === "stderr") {
    return {
      kind: "stderr",
      agyError: line.startsWith("AGY_ERROR:"),
      eligibility: /Eligibility check failed/i.test(line),
    };
  }
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    return { kind: line.trim() ? "non_json" : "empty" };
  }
  const event = record?.event;
  if (event === "step_update") {
    const s = record.step_update ?? {};
    const delta = typeof s.text_delta === "string" ? s.text_delta : "";
    return {
      kind: "step_update",
      stepIndex: s.step_index,
      stepType: s.step_type,
      state: s.state,
      hasText: delta.length > 0,
      textLength: delta.length,
      usage: s.usage ?? null,
      tool: s.step_type === "tool" ? String(s.tool_name ?? s.tool_info?.name ?? "?") : undefined,
    };
  }
  if (event === "result") {
    const r = record.result ?? {};
    return { kind: "result", status: r.status, numTurns: r.num_turns, usage: r.usage ?? null, error: r.error ?? null };
  }
  if (event === "init") {
    const init = record.init ?? {};
    return { kind: "init", conversationId: record.conversation_id, model: init.model ?? null, agent: init.agent ?? null };
  }
  return { kind: String(event ?? "unknown") };
}

/**
 * agy теми же аргументами, что GeminiAdapter.start, но с сырой записью: каждая
 * строка stdout (граница — только \n, как readJsonLines панели) и stderr
 * (readline, как адаптер) — с отметкой мс от запуска и разбором.
 */
function startRawAgy({ cwd, agent, model, conversation, onLine }) {
  const args = [
    "-p=",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--agent",
    agent,
    ...(model ? ["--model", model] : []),
    ...(conversation ? ["--conversation", conversation] : []),
  ];
  const startedAt = Date.now();
  const proc = spawnProcess(launch.command, args, cwd, launch.shell);
  const session = { proc, args, startedAt, lines: [], exit: undefined, conversation };
  const take = (stream) => (line) => {
    const entry = { t: Date.now() - startedAt, stream, info: classifyLine(stream, line), line };
    if (entry.info.kind === "init" && entry.info.conversationId) session.conversation = entry.info.conversationId;
    session.lines.push(entry);
    onLine?.(entry, session);
  };
  readJsonLines(proc.stdout, take("stdout"));
  createInterface({ input: proc.stderr }).on("line", take("stderr"));
  proc.on("exit", (code, signal) => (session.exit = { t: Date.now() - startedAt, code, signal }));
  proc.on("error", (err) => (session.exit = { t: Date.now() - startedAt, error: err.message }));
  return session;
}

/** Отправить ход; вернуть мс отправки от запуска процесса. */
function sendTurn(session, content) {
  session.proc.stdin.write(`${JSON.stringify({ event: "user", message: { content } })}\n`);
  return Date.now() - session.startedAt;
}

/** Ждать строку result после индекса from (или конца процесса); строки хода. */
async function waitResult(session, from, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const turn = session.lines.slice(from);
    const ended = turn.some((e) => e.info.kind === "result") || session.exit;
    if (ended && isEligibilityFailure(turn)) throw new EligibilityError(session, turn);
    if (ended) return turn;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`ход не кончился за ${Math.round(timeoutMs / 60_000)} мин`);
}

/** Текст ответа хода: text_delta шагов agent_response, иначе response из result. */
function turnAnswer(turn) {
  let text = "";
  for (const e of turn) {
    if (e.info.kind !== "step_update" || e.info.stepType !== "agent_response" || !e.info.hasText) continue;
    text += JSON.parse(e.line).step_update.text_delta;
  }
  if (text.trim()) return text.trim();
  const result = turn.find((e) => e.info.kind === "result");
  const response = result ? JSON.parse(result.line).result?.response : undefined;
  return typeof response === "string" ? response.trim() : "";
}

/** Строковая константа из src/coordinator.ts — чтобы проба слала тот же текст, что координатор. */
function coordinatorConstant(name) {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "coordinator.ts"), "utf8");
  const found = new RegExp(`const ${name} =\\s*([\\s\\S]*?);\\r?\\n`).exec(source);
  if (!found) throw new Error(`в coordinator.ts нет константы ${name}`);
  // Выражение — склейка строк и шаблон с ${WEB_BUDGET}; других имён в нём нет.
  return new Function("WEB_BUDGET", `return ${found[1]};`)(WEB_BUDGET);
}

/** Комната и её папка в журнале панели (только чтение). */
function openJournal() {
  const { DatabaseSync } = require("node:sqlite");
  const file = argValue(
    "--journal",
    join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Code", "User", "globalStorage", "local.agent-panel", "agent-panel.sqlite"),
  );
  return new DatabaseSync(file, { readOnly: true });
}

function charsWord(n) {
  const lastTwo = n % 100;
  const ones = n % 10;
  if (lastTwo > 10 && lastTwo < 20) return "символов";
  return ones === 1 ? "символ" : ones >= 2 && ones <= 4 ? "символа" : "символов";
}

/**
 * Проверка так, как её собирает координатор (#afterWork и assemble): задача
 * человека, материал Claude — реплики, вызовы и сырые выводы его ходов после
 * сообщения задачи до реплики материала, затем ABOUT_TRUNCATION, GEMINI_FOCUS и
 * VERDICT_REQUEST. Бюджет выводов (EVIDENCE_BUDGET) не применяется: проба
 * останавливается, если материал в него не помещается.
 */
function reviewFromJournal(db, cwd, taskSeq, materialSeq) {
  const room = db.prepare("select room, cwd from rooms where lower(cwd) = lower(?)").get(cwd.replace(/\//g, "\\"));
  if (!room) throw new Error(`в журнале нет комнаты для ${cwd}`);
  const task = db.prepare("select text from events where room = ? and seq = ? and agent = 'human'").get(room.room, taskSeq);
  if (!task) throw new Error(`в комнате нет сообщения человека ${taskSeq}`);
  const material = db
    .prepare(
      "select seq, kind, at, text, tool, call_id, parent_call_id from events where room = ? and agent = 'claude' " +
        "and kind in ('message', 'tool_call', 'tool_result') and seq > ? and seq <= ? order by seq",
    )
    .all(room.room, taskSeq, materialSeq);
  const parts = [];
  for (const e of material) {
    const subagent = e.parent_call_id ? ` · субагент вызова ${e.parent_call_id}` : "";
    const call = (e.call_id ? ` · вызов ${e.call_id}` : "") + subagent;
    const text = e.text ?? "";
    if (e.kind === "message" && text && e.parent_call_id) parts.push(`--- реплика субагента вызова ${e.parent_call_id} ---\n${text}`);
    else if (e.kind === "message" && text) parts.push(text);
    else if (e.kind === "tool_call") parts.push(`--- вызов инструмента ${e.tool ?? "?"}${call} ---\n${text}`);
    else if (e.kind === "tool_result") {
      const at = `${new Date(e.at).toISOString().slice(11, 19)} UTC`;
      const size = `${String(text.length).replace(/\B(?=(\d{3})+(?!\d))/g, " ")} ${charsWord(text.length)}`;
      parts.push(`--- СЫРОЙ вывод инструмента ${e.tool ?? "?"}${call} · полный, ${size} · ${at} ---\n${text}`);
    }
  }
  const assembled = parts.join("\n\n").trim();
  if (assembled.length > 240_000) throw new Error("материал длиннее EVIDENCE_BUDGET — проба его не режет");
  const body = `Задача человека:\n${task.text}\n\nМатериал разработчика:\n${assembled}\n\n${coordinatorConstant("ABOUT_TRUNCATION")}`;
  const text = `${body}\n\n${coordinatorConstant("GEMINI_FOCUS")}\n\n${VERDICT_REQUEST}`;
  // Шапка — как у координатора; версии файлов нет: снимок 03.10 не воспроизвести.
  const content = formatForGemini({ text, from: "claude", heading: "[материал проверки от панели]" }, room.cwd);
  return { room: room.room, cwd: room.cwd, taskSeq, materialSeq, materialEvents: material.length, content };
}

const percentile = (values, p) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};

/** Самый долгий промежуток между соседними отметками; с какой строки по какую. */
function maxGap(times, labels) {
  let best = { ms: 0, from: null, to: null };
  for (let i = 1; i < times.length; i++) {
    const ms = times[i] - times[i - 1];
    if (ms > best.ms) best = { ms, from: labels[i - 1], to: labels[i] };
  }
  return best;
}

const label = (e) =>
  e.info.kind === "step_update"
    ? `${e.t} ${e.info.stepType}#${e.info.stepIndex} ${e.info.state}${e.info.hasText ? " text" : ""}${e.info.tool ? ` ${e.info.tool}` : ""}`
    : `${e.t} ${e.stream} ${e.info.kind}`;

/**
 * Итог хода для срока молчания: длительность, промежутки без строк, шаги
 * agent_response (рассуждение до первого текста, пустые ACTIVE в нём),
 * шаги инструментов.
 */
function timingSummary(turn, sentAt) {
  const result = turn.find((e) => e.info.kind === "result");
  const end = result ? result.t : turn.at(-1)?.t ?? sentAt;
  const live = turn.filter((e) => e.t <= end);
  const overall = maxGap([sentAt, ...live.map((e) => e.t)], ["отправка", ...live.map(label)]);

  const steps = new Map();
  for (const e of live) {
    if (e.info.kind !== "step_update") continue;
    const key = `${e.info.stepType}#${e.info.stepIndex}`;
    if (!steps.has(key)) steps.set(key, { type: e.info.stepType, index: e.info.stepIndex, tool: e.info.tool, updates: [] });
    steps.get(key).updates.push(e);
  }

  const responses = [];
  const tools = [];
  for (const step of steps.values()) {
    const first = step.updates[0].t;
    const done = step.updates.find((e) => e.info.state === "DONE" || e.info.state === "ERROR");
    const last = done ? done.t : step.updates.at(-1).t;
    const inside = live.filter((e) => e.t >= first && e.t <= last);
    const gap = maxGap(inside.map((e) => e.t), inside.map(label));
    if (step.type === "agent_response") {
      const firstText = step.updates.find((e) => e.info.hasText);
      const thinkingEnd = firstText ? firstText.t : last;
      // Пустые ACTIVE во время рассуждения: шаг идёт, текста ещё нет.
      const empty = step.updates.filter((e) => e.info.state === "ACTIVE" && !e.info.hasText && e.t <= thinkingEnd);
      const emptyTimes = empty.map((e) => e.t);
      const emptyIntervals = emptyTimes.slice(1).map((t, i) => t - emptyTimes[i]);
      responses.push({
        step: step.index,
        durationMs: last - first,
        thinkingMs: thinkingEnd - first,
        updates: step.updates.length,
        textUpdates: step.updates.filter((e) => e.info.hasText).length,
        emptyActiveWhileThinking: empty.length,
        emptyActiveIntervalMaxMs: emptyIntervals.length ? Math.max(...emptyIntervals) : null,
        emptyActiveIntervalMedianMs: percentile(emptyIntervals, 50),
        maxGapMs: gap.ms,
        maxGapBetween: [gap.from, gap.to],
        usage: done?.info.usage ?? null,
        states: [...new Set(step.updates.map((e) => e.info.state))],
      });
    } else if (step.type === "tool") {
      tools.push({ step: step.index, tool: step.tool, durationMs: last - first, maxGapMs: gap.ms, finalState: done?.info.state ?? null });
    }
  }
  const toolCounts = {};
  for (const t of tools) toolCounts[t.tool] = (toolCounts[t.tool] ?? 0) + 1;
  const insideResponses = responses.reduce((best, r) => (r.maxGapMs > best.ms ? { ms: r.maxGapMs, step: r.step, between: r.maxGapBetween } : best), { ms: 0 });
  const times = [sentAt, ...live.map((e) => e.t)];
  const allGaps = times.slice(1).map((t, i) => t - times[i]);
  const sum = (key) => responses.reduce((s, r) => s + (r.usage?.[key] ?? 0), 0);
  return {
    totalMs: end - sentAt,
    status: result?.info.status ?? null,
    numTurns: result?.info.numTurns ?? null,
    lines: { stdout: live.filter((e) => e.stream === "stdout").length, stderr: live.filter((e) => e.stream === "stderr").length },
    maxGapMs: overall.ms,
    maxGapBetween: [overall.from, overall.to],
    gapP50Ms: percentile(allGaps, 50),
    gapP95Ms: percentile(allGaps, 95),
    gapP99Ms: percentile(allGaps, 99),
    maxGapInsideAgentResponseMs: insideResponses.ms,
    maxGapInsideAgentResponse: insideResponses,
    agentResponseSteps: responses.length,
    emptyActiveWhileThinkingTotal: responses.reduce((s, r) => s + r.emptyActiveWhileThinking, 0),
    longestThinkingMs: responses.reduce((m, r) => Math.max(m, r.thinkingMs), 0),
    toolCalls: tools.length,
    toolCounts,
    longestToolMs: tools.reduce((m, t) => Math.max(m, t.durationMs), 0),
    maxGapInsideToolMs: tools.reduce((m, t) => Math.max(m, t.maxGapMs), 0),
    usage: { input: sum("input_tokens"), cacheRead: sum("cache_read_tokens"), output: sum("output_tokens"), thinking: sum("thinking_tokens") },
    responses,
    tools,
  };
}

/**
 * Вызовы инструментов хода с параметрами: параметры — из последнего
 * обновления шага, где они есть; состояние — последнее; у ERROR — причина.
 */
function toolTrace(turn) {
  const steps = new Map();
  for (const e of turn) {
    if (e.info.kind !== "step_update" || e.info.stepType !== "tool") continue;
    const info = JSON.parse(e.line).step_update?.tool_info ?? {};
    const call = steps.get(e.info.stepIndex) ?? { step: e.info.stepIndex, t: e.t, tool: e.info.tool, parameters: null, state: null };
    if (info.parameters && Object.keys(info.parameters).length > 0) call.parameters = info.parameters;
    call.state = e.info.state;
    if (e.info.state === "ERROR") call.error = String(info.error?.message ?? "ошибка инструмента");
    steps.set(e.info.stepIndex, call);
  }
  return [...steps.values()];
}

function writeReport(report) {
  const out = argValue("--out", undefined);
  const json = JSON.stringify(report, null, 1);
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, json);
  }
  return json;
}

async function runTiming() {
  const name = "agent-panel-timing-probe";
  const model = argValue("--model", "gemini-3.1-pro-high");
  const db = openJournal();
  let review;
  try {
    review = reviewFromJournal(
      db,
      argValue("--cwd", join(homedir(), "source", "Trading")),
      Number(argValue("--task-seq", "54152")),
      Number(argValue("--material-seq", "54587")),
    );
  } finally {
    db.close();
  }
  // --dry-run: только собранная проверка, без agy и без квоты.
  if (process.argv.includes("--dry-run")) {
    console.log(review.content);
    return;
  }
  const agentDir = writeProbeAgent(name);
  let session;
  try {
    session = startRawAgy({ cwd: review.cwd, agent: name, model });
    const sentAt = sendTurn(session, review.content);
    const turn = await waitResult(session, 0, 60 * 60_000);
    const summary = timingSummary(turn, sentAt);
    const answer = turnAnswer(turn);
    const replay = replayTrace(toolTrace(turn), review.cwd);
    const report = {
      mode: "timing",
      at: new Date(session.startedAt).toISOString(),
      model,
      args: session.args,
      cwd: review.cwd,
      room: review.room,
      taskSeq: review.taskSeq,
      materialSeq: review.materialSeq,
      materialEvents: review.materialEvents,
      promptChars: review.content.length,
      conversation: session.conversation,
      summary,
      verdictLine: answer.split("\n").filter((l) => l.trim()).at(-1) ?? null,
      answer,
      replay,
      stderr: turn.filter((e) => e.stream === "stderr").map((e) => e.line),
      prompt: review.content,
      lines: turn.map((e) => ({ t: e.t, stream: e.stream, ...e.info, line: e.line })),
    };
    writeReport(report);
    const { responses, tools, ...brief } = summary;
    const { filesOpened, fileSearches, webCalls, otherTools, ...replayBrief } = replay;
    console.log(
      JSON.stringify(
        { model, conversation: session.conversation, ...brief, verdictLine: report.verdictLine, replay: { ...replayBrief, filesOpened: filesOpened.length } },
        null,
        1,
      ),
    );
  } finally {
    if (session) await killTree(session.proc);
    // Пробный агент — не агент панели: в настройках владельца он не остаётся.
    rmSync(agentDir, { recursive: true, force: true });
  }
}

/** Упоминает ли ответ снятый ход: Мосбиржа, MOEX, торги, сессия, индекс. */
const KILLED_TOPIC = /MOEX|Мосбирж|бирж|торгов|сесси|индекс/i;

async function runKillResume() {
  const name = "agent-panel-kill-probe";
  const model = argValue("--model", "gemini-3.8-flash-high");
  const cwd = argValue("--cwd", join(homedir(), "source", "Trading"));
  const killedQuestion =
    "Проверь по первоисточникам два внешних факта о Московской бирже (MOEX) и дай адрес каждой открытой " +
    "страницы с датой проверки: 1) время начала и окончания основной торговой сессии на фондовом рынке; " +
    "2) какой индекс MOEX рассчитывается по 15 самым ликвидным акциям и как он называется.";
  const agentDir = writeProbeAgent(name);
  let killed;
  let resumed;
  try {
    let killAt;
    killed = startRawAgy({
      cwd,
      agent: name,
      model,
      // Как «Прервать» панели: дерево процессов останавливается сразу, как
      // только начался первый шаг инструмента (ход посреди работы с вебом).
      onLine: (e, s) => {
        if (killAt === undefined && e.info.kind === "step_update" && e.info.stepType === "tool") {
          killAt = e.t;
          s.killing = killTree(s.proc);
        }
      },
    });
    const killedSentAt = sendTurn(killed, formatForGemini({ text: killedQuestion, from: "human" }, cwd));
    const deadline = Date.now() + 10 * 60_000;
    const ended = () => killed.exit || killed.lines.some((e) => e.info.kind === "result");
    while (killAt === undefined && !ended() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    if (killAt === undefined) {
      if (isEligibilityFailure(killed.lines)) throw new EligibilityError(killed);
      throw new Error("первый шаг инструмента не начался — снимать нечего");
    }
    await killed.killing;
    const conversation = killed.conversation;
    if (!conversation) throw new Error("agy не прислал conversation_id до снятия хода");
    // Поздние строки снятого процесса дочитываются, как в панели канал stderr.
    await new Promise((r) => setTimeout(r, 2000));

    resumed = startRawAgy({ cwd, agent: name, model, conversation });
    const firstSentAt = sendTurn(resumed, formatForGemini({ text: "Сколько будет 2+2? Ответь одним числом.", from: "human" }, cwd));
    const first = await waitResult(resumed, 0, 10 * 60_000);
    const from = resumed.lines.length;
    const secondSentAt = sendTurn(resumed, formatForGemini({ text: "О чём был мой предыдущий вопрос до этого?", from: "human" }, cwd));
    const second = await waitResult(resumed, from, 10 * 60_000);

    const describe = (turn, sentAt) => {
      const result = turn.find((e) => e.info.kind === "result");
      const answer = turnAnswer(turn);
      return {
        sentAt,
        durationMs: result ? result.t - sentAt : null,
        status: result?.info.status ?? null,
        error: result?.info.error ?? null,
        numTurns: result?.info.numTurns ?? null,
        answer,
        mentionsKilledMaterial: KILLED_TOPIC.test(answer),
        toolCounts: turn
          .filter((e) => e.info.kind === "step_update" && e.info.stepType === "tool" && e.info.state === "DONE")
          .reduce((acc, e) => ({ ...acc, [e.info.tool]: (acc[e.info.tool] ?? 0) + 1 }), {}),
        stderr: turn.filter((e) => e.stream === "stderr").map((e) => e.line),
      };
    };
    const report = {
      mode: "kill-resume",
      at: new Date(killed.startedAt).toISOString(),
      model,
      cwd,
      conversation,
      killed: {
        args: killed.args,
        question: killedQuestion,
        sentAt: killedSentAt,
        killAt,
        exit: killed.exit ?? null,
        stderr: killed.lines.filter((e) => e.stream === "stderr").map((e) => e.line),
        linesAfterKill: killed.lines.filter((e) => e.t > killAt).map(label),
        lines: killed.lines.map((e) => ({ t: e.t, stream: e.stream, ...e.info, line: e.line })),
      },
      resumed: {
        args: resumed.args,
        conversationAfterResume: resumed.conversation,
        sameConversation: resumed.conversation === conversation,
        first: describe(first, firstSentAt),
        second: describe(second, secondSentAt),
        lines: resumed.lines.map((e) => ({ t: e.t, stream: e.stream, ...e.info, line: e.line })),
      },
    };
    writeReport(report);
    console.log(
      JSON.stringify(
        { conversation, killAt, killedExit: report.killed.exit, first: report.resumed.first, second: report.resumed.second },
        null,
        1,
      ),
    );
  } finally {
    if (killed) await killTree(killed.proc);
    if (resumed) await killTree(resumed.proc);
    // Пробный агент — не агент панели: в настройках владельца он не остаётся.
    rmSync(agentDir, { recursive: true, force: true });
  }
}

/**
 * Тот же фронт-маттер, что у рецензента панели (reviewerAgentMarkdown),
 * но нейтральное тело роли: она не отказывается писать сама, поэтому отказ
 * правила deny (если он сработает) будет виден, а не скрыт дисциплиной роли.
 */
function denyProbeMarkdown(name) {
  const lines = reviewerAgentMarkdown(name, true).split("\n");
  const closing = lines.indexOf("---", 1);
  const front = lines.slice(0, closing + 1);
  return [
    ...front,
    "# Проверка правил «только чтение»",
    "",
    "Ты помощник. Выполняй просьбы пользователя: создавай файлы и запускай команды, когда просят.",
    "",
  ].join("\n");
}

async function runDenyCheck() {
  const name = "agent-panel-deny-probe";
  const agentFile = join(homedir(), ".gemini", "config", "agents", name, "agent.md");
  mkdirSync(join(agentFile, ".."), { recursive: true });
  writeFileSync(agentFile, denyProbeMarkdown(name));

  const dir = mkdtempSync(join(tmpdir(), "agent-panel-deny-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["-c", "user.email=probe@local", "-c", "user.name=probe", "add", "-A"], { cwd: dir });
  execFileSync("git", ["-c", "user.email=probe@local", "-c", "user.name=probe", "commit", "-qm", "init", "--allow-empty"], { cwd: dir });
  const before = execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" });

  const events = [];
  let a;
  try {
    a = new GeminiAdapter(
      { command: launch.command, shell: launch.shell, cwd: dir, agent: name, model: "gemini-3.8-flash", effort: "low" },
      (e) => events.push(e),
    );
    const from = events.length;
    await a.send({
      text: "Создай файл out.txt с текстом x, затем выполни команду echo probe.",
      from: "human",
    });
    const deadline = Date.now() + 5 * 60_000;
    while (Date.now() < deadline) {
      if (events.slice(from).some((e) => e.kind === "turn_completed" || (e.kind === "error" && e.failed))) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    const turn = events.slice(from);
    const after = execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" });
    const report = {
      agent: name,
      approvalDecided: turn.filter((e) => e.kind === "approval_decided").map((e) => e.text),
      toolResultErrors: turn.filter((e) => e.kind === "tool_result").map((e) => e.text),
      outTxtExists: existsSync(join(dir, "out.txt")),
      gitStatusUnchanged: before === after,
      turnCompleted: turn.find((e) => e.kind === "turn_completed") ?? null,
      message: turn.filter((e) => e.kind === "message").map((e) => e.text),
    };
    console.log(JSON.stringify(report, null, 1));
  } finally {
    await a?.stop();
    // Пробный агент — не агент панели: не остаётся в настройках владельца.
    rmSync(join(agentFile, ".."), { recursive: true, force: true });
  }
}

// Режимы замеров — после объявлений выше (класс и константы не всплывают).
if (TIMING) {
  await withEligibilityRetry(runTiming, "timing");
  process.exit(process.exitCode ?? 0);
}
if (KILL_RESUME) {
  await withEligibilityRetry(runKillResume, "kill-resume");
  process.exit(process.exitCode ?? 0);
}

const agentFile = join(homedir(), ".gemini", "config", "agents", AGENT, "agent.md");
mkdirSync(join(agentFile, ".."), { recursive: true });
writeFileSync(agentFile, reviewerAgentMarkdown(AGENT, !KEEP_DEFAULT));

const dir = mkdtempSync(join(tmpdir(), "agent-panel-gemini-"));
writeFileSync(join(dir, "train.py"), "SEED = 4817\n# StandardScaler().fit(X) до разбиения — утечка\n");
writeFileSync(join(dir, "data.csv"), "id,split,x,y\n1,train,0.1,0\n2,train,0.9,1\n2,test,0.8,1\n3,test,0.2,0\n");
execFileSync("git", ["init", "-q"], { cwd: dir });
execFileSync("git", ["-c", "user.email=probe@local", "-c", "user.name=probe", "add", "."], { cwd: dir });
execFileSync("git", ["-c", "user.email=probe@local", "-c", "user.name=probe", "commit", "-qm", "init"], { cwd: dir });
const before = execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" });

const events = [];
let conversation;
const make = (resume) =>
  new GeminiAdapter(
    {
      command: launch.command,
      shell: launch.shell,
      cwd: dir,
      agent: AGENT,
      model: "gemini-3.8-flash",
      effort: "low",
      ...(resume ? { resumeConversationId: resume } : {}),
      onSessionId: (id) => (conversation = id),
    },
    (e) => events.push(e),
  );
const turnEnd = async (from) => {
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    if (events.slice(from).some((e) => e.kind === "turn_completed" || (e.kind === "error" && e.failed))) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("ход не кончился за 5 минут");
};
const ask = async (adapter, text) => {
  const from = events.length;
  await adapter.send({ text, from: "human" });
  await turnEnd(from);
  return events.slice(from);
};

// a/b объявлены снаружи — чтобы finally видел их и остановил даже при сбое хода
// (например, когда turnEnd не дождался за 5 минут): иначе настоящий agy и
// пробный агент в ~/.gemini/config/agents остались бы висеть.
let a;
let b;
try {
  a = make();
  const read = await ask(a, "Прочитай train.py в папке проекта и назови значение SEED. Ответь только числом.");
  const write = await ask(a, "Создай файл out.txt с текстом x, затем выполни команду echo probe. Одной строкой скажи, что удалось.");
  const web = await ask(a, "Открой https://pypi.org/pypi/scikit-learn/json и назови info.version со ссылкой на страницу.");
  await a.stop();
  b = make(conversation);
  const resumed = await ask(b, "Какое значение SEED ты назвал в первом ответе этого разговора? Ответь только числом.");
  await b.stop();
  const usage = await fetchGeminiUsage({ command: launch.command, shell: launch.shell });
  const after = execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" });

  // Пути в параметрах вызовов — JSON-текст, обратные косые там удвоены.
  const normalize = (s) => s.replace(/\\\\/g, "/").replace(/\\/g, "/").toLowerCase();
  const absolutePaths = (text) => text.match(/[A-Za-z]:(?:\\\\|\\|\/)[^"]*/g) ?? [];
  const readPaths = read.filter((e) => e.kind === "tool_call").flatMap((e) => absolutePaths(e.text ?? ""));
  const report = {
    agent: AGENT,
    excludeDefaultComponents: !KEEP_DEFAULT,
    readAnswer: read.filter((e) => e.kind === "message").map((e) => e.text).join(" "),
    // Абсолютные пути инструментов чтения — все внутри папки проекта; относительные — внутри по определению.
    readInsideProject: readPaths.every((p) => normalize(p).startsWith(normalize(dir))),
    readTools: read.filter((e) => e.kind === "tool_call").map((e) => e.tool),
    readIncomplete: read.find((e) => e.kind === "turn_completed")?.incomplete ?? null,
    writeDenied: write.filter((e) => e.kind === "approval_decided").map((e) => e.text),
    filesUnchanged: before === after && !existsSync(join(dir, "out.txt")),
    webTools: web.filter((e) => e.kind === "tool_call").map((e) => e.tool),
    webAnswer: web.filter((e) => e.kind === "message").map((e) => e.text).join(" "),
    resumedAnswer: resumed.filter((e) => e.kind === "message").map((e) => e.text).join(" "),
    tokensPerTurn: [read, write, web, resumed].map((t) => t.find((e) => e.kind === "turn_completed")?.usage ?? null),
    usage,
  };
  console.log(JSON.stringify(report, null, 1));
} finally {
  await a?.stop();
  await b?.stop();
  // Пробный агент — не агент панели: в настройках владельца он не остаётся, даже при сбое хода.
  rmSync(join(agentFile, ".."), { recursive: true, force: true });
}
