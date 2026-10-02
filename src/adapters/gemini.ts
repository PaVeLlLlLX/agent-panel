/**
 * Адаптер Gemini: Antigravity CLI (agy) в режиме потока.
 *
 * Формат снят живой пробой 02.10.2026 (agy 1.2.14,
 * docs/research/2026-10-02-проба-agy.md):
 *
 *   agy -p= --input-format stream-json --output-format stream-json --agent agent-panel-reviewer
 *
 * Один процесс — много ходов: ход — строка {"event":"user","message":{"content":"…"}}.
 * Вывод: init (conversation_id), step_update (user_input; agent_response с
 * text_delta и usage; tool с tool_info), result на каждый ход.
 *
 * Решения, за которые заплачено пробой:
 *
 * **`-p=` с пустым значением.** `-p` без значения съедает следующий флаг как
 * текст запроса, `-p` последним — «flag needs an argument».
 *
 * **Расход хода — сумма usage шагов agent_response.** usage у result
 * накопительный и после --conversation включает расход прежнего процесса
 * (119 580 токенов на ходу, стоившем ~14 000). Предполагается, что
 * input_tokens уже включает чтение кеша, как у OpenAI; пробой не проверено.
 *
 * **Пустой ответ и прирост denied_actions — проверки не было.** Действие, на
 * которое нужно согласие, без интерфейса отклоняется мягко: ход кончается со
 * status SUCCESS и пустым response, шаг бывает DONE без ошибки. Отметка
 * incomplete говорит координатору «не проверял», но только когда ответа нет
 * вовсе: прирост denied_actions при непустом ответе incomplete не ставит —
 * отказы всё равно видны координатору через denials (M8, финальная рецензия
 * 02.10). denied_actions копится за процесс, поэтому новые отказы считаются
 * по приросту.
 *
 * **Только чтение — правила agy, а не tools агента.** Список tools в agent.md
 * инструменты не ограничивает (проба); запись и команды запрещены правилами
 * deny в настройках agy. beforeStart проверяет их на КАЖДОМ ходу, не только
 * перед запуском процесса: разговор возобновляемый, и правила могли пропасть
 * между ходами — тогда живой процесс останавливается, а не продолжает молча
 * (I2, финальная рецензия 02.10).
 *
 * **Прервать — остановка процесса.** Управляющих сообщений в stream-json нет;
 * следующий ход продолжит разговор через --conversation.
 *
 * **stderr — диагностика.** Строка AGY_ERROR и отказ по региону запоминаются
 * причиной хода: без них «ход завершён: ERROR» ничего не объясняет.
 */
import { ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, Interface } from "node:readline";
import { sameChoice } from "../models.js";
import { geminiModelSlug, parseGeminiModels } from "../geminiCatalog.js";
import { REVIEWER_AGENT } from "../geminiSetup.js";
import { spawnProcess, killTree } from "./process.js";
import {
  Adapter,
  AgentPrompt,
  EventSink,
  ModelChoice,
  ModelOption,
  NO_USAGE,
  PanelEvent,
  TurnUsage,
  addUsage,
  clamp,
  clampKeepingFull,
  newEventId,
  stripAnsi,
} from "./types.js";

export interface GeminiOptions {
  readonly command: string;
  /** Аргументы перед флагами agy — например путь к скрипту фальшивого agy. */
  readonly commandArgs?: readonly string[];
  readonly cwd: string;
  readonly resumeConversationId?: string;
  /** Свой агент agy (--agent); по умолчанию REVIEWER_AGENT. */
  readonly agent?: string;
  /** Семейство модели (gemini-3.1-pro); "" или нет — модель из настроек agy. */
  readonly model?: string;
  /** Уровень (low, medium, high); "" — уровень по умолчанию семейства. */
  readonly effort?: string;
  /** Запуск через оболочку; для agy.exe — false. По умолчанию на Windows — да. */
  readonly shell?: boolean;
  readonly onSessionId?: (id: string) => void;
  /** Перед запуском процесса: причина не запускать (нет правил «только чтение»); undefined — можно. */
  readonly beforeStart?: () => string | undefined;
}

/** Сообщение ходу agy: кто прислал, где искать файлы, к какой версии относится. */
export function formatForGemini(prompt: AgentPrompt, cwd: string): string {
  const heading = prompt.heading ?? (prompt.from === "human" ? "[от человека]" : "[от панели]");
  const version = prompt.snapshot ? `\n[версия файлов: ${prompt.snapshot}]` : "";
  return `${heading}\n[папка проекта: ${cwd} — ищи и читай файлы только в ней]${version}\n${prompt.text}`;
}

/** Токены одного вызова модели: вход, из него — чтение кеша, выход вместе с рассуждением. */
function toTurnUsage(usage: unknown): TurnUsage {
  const u = (usage ?? {}) as Record<string, unknown>;
  const num = (key: string) => (typeof u[key] === "number" ? (u[key] as number) : 0);
  return { input: num("input_tokens"), cached: num("cache_read_tokens"), output: num("output_tokens") + num("thinking_tokens") };
}

/** Причина из строки «AGY_ERROR: {…}» — её message, иначе вся строка. */
function agyErrorReason(line: string): string {
  try {
    const record = JSON.parse(line.slice("AGY_ERROR:".length)) as Record<string, unknown>;
    if (typeof record["message"] === "string") return record["message"];
  } catch {
    // не JSON — остаётся строка целиком
  }
  return line;
}

export class GeminiAdapter implements Adapter {
  readonly id = "gemini" as const;

  #proc: ChildProcessWithoutNullStreams | undefined;
  #lines: Interface | undefined;
  #conversation: string | undefined;
  #busy = false;
  #turnId: string | undefined;
  /** Расход хода — сумма usage его вызовов модели. */
  #turnUsage: TurnUsage = NO_USAGE;
  /** Текст по шагам agent_response: шаг приходит кусками text_delta. */
  readonly #texts = new Map<number, string>();
  /** Шаги tool, о которых уже сказано tool_call. */
  readonly #tools = new Set<number>();
  /** Реплика хода уже показана: response из result тогда не повторяется. */
  #answered = false;
  /** Сколько denied_actions уже засчитано в этом процессе: список копится за процесс. */
  #deniedSeen = 0;
  /** Причина из stderr для текущего хода: AGY_ERROR, отказ по региону. */
  #lastError: string | undefined;
  readonly #stopping = new WeakSet<object>();
  readonly #reported = new WeakSet<object>();
  #choice: ModelChoice;
  #processChoice: ModelChoice | undefined;
  #catalog: readonly ModelOption[] | undefined;

  constructor(
    private readonly options: GeminiOptions,
    private readonly sink: EventSink,
  ) {
    this.#conversation = options.resumeConversationId;
    this.#choice = { model: options.model ?? "", effort: options.effort ?? "" };
  }

  get busy(): boolean {
    return this.#busy;
  }

  get sessionId(): string | undefined {
    return this.#conversation;
  }

  async start(): Promise<void> {
    if (this.#proc) throw new Error("адаптер Gemini уже запущен");
    const slug = geminiModelSlug(this.#choice, this.#catalog);
    const args = [
      ...(this.options.commandArgs ?? []),
      "-p=",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--agent",
      this.options.agent ?? REVIEWER_AGENT,
      ...(slug ? ["--model", slug] : []),
      // Перезапуск после прерывания или смены модели продолжает тот же разговор.
      ...(this.#conversation ? ["--conversation", this.#conversation] : []),
    ];
    const proc = spawnProcess(this.options.command, args, this.options.cwd, this.options.shell);
    this.#proc = proc;
    this.#deniedSeen = 0;
    this.#processChoice = this.#choice;
    this.#lines = createInterface({ input: proc.stdout });
    this.#lines.on("line", (line) => this.#parse(line));
    createInterface({ input: proc.stderr }).on("line", (line) => this.#stderr(proc, line));
    proc.stdin.on("error", (err) => this.#channelFailure(proc, err));
    proc.on("error", (err) => this.#end(proc, `Gemini не запустился: ${err.message}`));
    proc.on("exit", (code, signal) => this.#end(proc, `процесс Gemini завершился неожиданно (код ${code}, сигнал ${signal})`));
  }

  async send(prompt: AgentPrompt): Promise<void> {
    // Правила «только чтение» проверяются на КАЖДОМ ходу, не только при первом
    // запуске процесса: разговор возобновляемый, и правила могли пропасть
    // между ходами (находка I2, финальная рецензия 02.10). Живой процесс при
    // отказе останавливается — продолжать его молча нельзя.
    const refusal = this.options.beforeStart?.();
    if (refusal) {
      if (this.#proc) await this.stop();
      throw new Error(refusal);
    }
    // Модель — флаг запуска: сменилась — перезапуск между ходами, разговор тот же.
    const changed = this.#processChoice !== undefined && !sameChoice(this.#processChoice, this.#choice);
    if (this.#proc && !this.#busy && changed) {
      this.#emit("diagnostic", "stream", { text: "модель Gemini сменилась — перезапуск с тем же разговором" });
      await this.stop();
    }
    if (!this.#proc) await this.start();
    const proc = this.#proc;
    if (!proc) throw new Error("адаптер Gemini не запущен");
    this.#busy = true;
    this.#turnId = newEventId();
    this.#turnUsage = NO_USAGE;
    this.#texts.clear();
    this.#tools.clear();
    this.#answered = false;
    this.#lastError = undefined;
    this.#write(proc, { event: "user", message: { content: formatForGemini(prompt, this.options.cwd) } });
  }

  setModel(choice: ModelChoice): void {
    this.#choice = { model: choice.model, effort: choice.effort };
  }

  /** `agy models` отдельным коротким процессом: разговор не создаётся, модель не вызывается. */
  async listModels(): Promise<readonly ModelOption[]> {
    const proc = spawnProcess(this.options.command, [...(this.options.commandArgs ?? []), "models"], this.options.cwd, this.options.shell);
    proc.stdin.end();
    let output = "";
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => (output += chunk));
    proc.stderr.resume();
    let timer: NodeJS.Timeout | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error("agy не прислал список моделей за 30 с")), 30_000);
        proc.on("error", reject);
        proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`agy models завершился с кодом ${code}`))));
      });
    } finally {
      clearTimeout(timer);
      await killTree(proc);
    }
    this.#catalog = parseGeminiModels(output);
    return this.#catalog;
  }

  /** Управляющих сообщений у agy нет: прерывание — остановка, следующий ход продолжит разговор. */
  async interrupt(): Promise<void> {
    await this.stop();
  }

  async forgetSession(): Promise<void> {
    // Сначала забыть: отправка во время остановки запустит процесс уже без --conversation.
    this.#conversation = undefined;
    await this.stop();
  }

  async stop(): Promise<void> {
    this.#lines?.close();
    this.#lines = undefined;
    const proc = this.#proc;
    this.#proc = undefined;
    this.#busy = false;
    this.#turnId = undefined;
    if (!proc) return;
    this.#stopping.add(proc);
    await killTree(proc);
  }

  #end(proc: ChildProcessWithoutNullStreams, errorText: string): void {
    if (this.#proc === proc) {
      this.#proc = undefined;
      this.#busy = false;
      this.#turnId = undefined;
    }
    if (this.#reported.has(proc)) return;
    this.#reported.add(proc);
    if (this.#stopping.has(proc)) {
      this.#emit("diagnostic", "stream", { text: "процесс Gemini остановлен" });
    } else {
      this.#emit("error", "turn", { text: this.#lastError ? `${errorText}: ${this.#lastError}` : errorText, failed: true });
    }
  }

  /** Канал сломан при живом процессе: ответа не будет — это конец процесса. */
  #channelFailure(proc: ChildProcessWithoutNullStreams, err: Error): void {
    this.#end(proc, `канал связи с Gemini сломан: ${err.message}`);
    void killTree(proc);
  }

  #write(proc: ChildProcessWithoutNullStreams, record: unknown): void {
    proc.stdin.write(`${JSON.stringify(record)}\n`, (err) => {
      if (err) this.#channelFailure(proc, err);
    });
  }

  #stderr(proc: ChildProcessWithoutNullStreams, line: string): void {
    const text = stripAnsi(line).trim();
    if (!text) return;
    // Канал stderr не гарантированно дочитан к моменту killTree: поздняя строка
    // остановленного или заменённого процесса не должна объяснять ход, который
    // уже идёт в другом процессе (смена модели, «Прервать» и следующая отправка).
    if (proc === this.#proc) {
      if (text.startsWith("AGY_ERROR:")) this.#lastError = agyErrorReason(text);
      else if (/Eligibility check failed/i.test(text)) this.#lastError = "Antigravity отказал по региону (Eligibility check failed)";
    }
    this.#emit("diagnostic", "stream", { text: clamp(text) });
  }

  #parse(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      this.#emit("diagnostic", "stream", { text: clamp(`строка вне протокола: ${stripAnsi(trimmed)}`) });
      return;
    }
    const kind = record["event"];
    if (kind === "init") {
      const id = record["conversation_id"];
      if (typeof id === "string" && id && id !== this.#conversation) {
        this.#conversation = id;
        this.options.onSessionId?.(id);
      }
      const init = (record["init"] ?? {}) as Record<string, unknown>;
      this.#emit("diagnostic", "stream", {
        text:
          `разговор ${String(id ?? "?").slice(0, 8)}, модель ${String(init["model"] ?? "по умолчанию")}, ` +
          `агент ${String(init["agent"] ?? "—")}, режим ${String(init["permission_mode"] ?? "?")}`,
        raw: record,
      });
    } else if (kind === "step_update") {
      this.#step((record["step_update"] ?? {}) as Record<string, unknown>);
    } else if (kind === "result") {
      this.#result((record["result"] ?? {}) as Record<string, unknown>);
    }
  }

  #step(s: Record<string, unknown>): void {
    const index = typeof s["step_index"] === "number" ? s["step_index"] : -1;
    const state = String(s["state"] ?? "");
    const type = String(s["step_type"] ?? "");
    if (type === "user_input") {
      if (state === "DONE") this.#emit("turn_started", "turn", {});
      return;
    }
    if (type === "agent_response") {
      const delta = typeof s["text_delta"] === "string" ? s["text_delta"] : "";
      if (delta) {
        this.#texts.set(index, (this.#texts.get(index) ?? "") + delta);
        this.#emit("text_delta", "stream", { text: delta });
      }
      if (state !== "DONE") return;
      if (s["usage"]) this.#turnUsage = addUsage(this.#turnUsage, toTurnUsage(s["usage"]));
      const text = (this.#texts.get(index) ?? "").trim();
      this.#texts.delete(index);
      if (text) {
        this.#answered = true;
        this.#emit("message", "turn", { text: clamp(text) });
      }
      return;
    }
    if (type !== "tool") return;
    const info = (s["tool_info"] ?? {}) as Record<string, unknown>;
    const name = String(s["tool_name"] ?? info["name"] ?? "?");
    const callId = `${this.#conversation ?? "agy"}:${index}`;
    if (!this.#tools.has(index)) {
      this.#tools.add(index);
      this.#emit("tool_call", "turn", { tool: name, callId, text: clamp(JSON.stringify(info["parameters"] ?? {}, null, 1)), raw: s });
      this.#emit("tool_running", "stream", { tool: name, callId });
    }
    if (state !== "DONE" && state !== "ERROR") return;
    this.#tools.delete(index);
    const error = (info["error"] ?? {}) as Record<string, unknown>;
    const output =
      state === "ERROR"
        ? String(error["message"] ?? "ошибка инструмента")
        : typeof info["output"] === "string" && info["output"]
          ? info["output"]
          : "(вывод инструмента agy в поток не передаёт)";
    this.#emit("tool_result", "turn", { tool: name, callId, ...clampKeepingFull(output), raw: s });
    if (state === "ERROR" && /permission check failed/i.test(output)) {
      this.#emit("approval_decided", "turn", { callId, toolCallId: callId, text: `отклонено правилом «только чтение»: ${name}` });
    }
  }

  #result(r: Record<string, unknown>): void {
    const status = String(r["status"] ?? "");
    const response = typeof r["response"] === "string" ? r["response"].trim() : "";
    const denied = Array.isArray(r["denied_actions"]) ? (r["denied_actions"] as Record<string, unknown>[]) : [];
    const fresh = denied.slice(this.#deniedSeen).map((d) => String(d["display_name"] ?? d["action"] ?? "?"));
    this.#deniedSeen = Math.max(this.#deniedSeen, denied.length);
    const usage = this.#turnUsage;
    this.#turnUsage = NO_USAGE;
    const failed = status !== "SUCCESS";
    if (!failed && response && !this.#answered) this.#emit("message", "turn", { text: clamp(response) });
    const error = typeof r["error"] === "string" && r["error"] ? ` — ${r["error"]}` : "";
    // Неполная проверка — только когда ответа нет вовсе: прирост denied_actions
    // при непустом ответе сам по себе её не портит (M8, финальная рецензия
    // 02.10) — отказы всё равно видны координатору через denials.
    const incomplete = failed
      ? undefined
      : response
        ? undefined
        : fresh.length > 0
          ? `действия отклонены без запроса: ${fresh.join(", ")}`
          : "пустой ответ";
    this.#busy = false;
    this.#emit("turn_completed", "turn", {
      text: failed
        ? `ход завершён: ${status || "без статуса"}${error}${this.#lastError ? ` (${this.#lastError})` : ""}`
        : `ход завершён, ходов в разговоре ${String(r["num_turns"] ?? "?")}`,
      ...(usage.input + usage.output > 0 ? { usage } : {}),
      ...(fresh.length > 0 ? { denials: fresh } : {}),
      ...(incomplete ? { incomplete } : {}),
      ...(failed ? { failed: true } : {}),
      raw: r,
    });
    this.#turnId = undefined;
  }

  #emit(kind: PanelEvent["kind"], visibility: PanelEvent["visibility"], rest: Partial<PanelEvent>): void {
    this.sink({
      id: newEventId(),
      agent: this.id,
      kind,
      visibility,
      at: Date.now(),
      ...(this.#turnId ? { turnId: this.#turnId } : {}),
      ...rest,
    } as PanelEvent);
  }
}
