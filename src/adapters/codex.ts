/**
 * Адаптер Codex: JSON-RPC поверх stdio через `codex app-server`.
 *
 * Формы сообщений взяты из схемы `codex app-server generate-json-schema`
 * (Codex 0.153.0), а не угаданы:
 *   ответ thread/start / resume — { thread: { id } }
 *   turn/started                — { threadId, turn: { id, status } }
 *   item/agentMessage/delta     — { delta, itemId, threadId, turnId }
 *   item/completed              — { item: ThreadItem, threadId, turnId }
 *   turn/completed              — { threadId, turn: { id, status, error? } }
 *   TurnStatus = completed | interrupted | failed | inProgress
 *
 * # Разделение ролей
 *
 * **Запись файлов запрещена, и это проверяемо.** Ветка запускается с
 * `sandbox: "read-only"` и `approvalPolicy: "never"`, а на любой запрос
 * одобрения от сервера панель отвечает отказом.
 *
 * **Команды чтения рецензенту разрешены** (ступень 1, 05.10): rg, git,
 * python -c над кодом — он проверяет утверждения сам, а не по пересказу.
 * Read-only запрещает запись, но не чтение и не сеть: запрет путей из
 * `forbidden` (данные и секреты проекта), сети, долгих и фоновых процессов —
 * правило роли, а не гарантия песочницы.
 *
 * # Жизненный цикл процесса
 *
 * Найдено рецензентом и воспроизведено тестами:
 *
 * **Ожидания запросов принадлежат процессу, а не адаптеру.** Поздний exit
 * старого процесса отклонял запросы только что запущенного нового и убивал
 * его запуск.
 *
 * **Отправки ждут общей готовности.** Второе сообщение, пришедшее во время
 * запуска, видело процесс, но не ветку, и терялось с «ветка не создана».
 *
 * **Ошибка записи — отказ канала**, а не строка диагностики: иначе запрос
 * остаётся в ожидании навсегда.
 *
 * **Остановка — всем деревом и с подтверждением.** См. process.ts.
 */
import { ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { readJsonLines, LineReader } from "./jsonLines.js";
import { spawnProcess, killTree } from "./process.js";
import {
  Adapter,
  AgentPrompt,
  ApprovalDecision,
  EventSink,
  ModelChoice,
  ModelOption,
  PanelEvent,
  clamp,
  clampKeepingFull,
  LimitInfo,
  TurnUsage,
  newEventId,
  stripAnsi,
} from "./types.js";

export interface CodexOptions {
  readonly command: string;
  readonly commandArgs?: readonly string[];
  readonly cwd: string;
  readonly resumeThreadId?: string;
  readonly reviewerInstructions?: string;
  /**
   * Запрещённые фрагменты путей (agentPanel.reviewerForbidden): вписываются
   * в роль рецензента. Нет или пусто — роль без запрета путей.
   */
  readonly forbidden?: readonly string[];
  /** Модель хода; "" или нет — по умолчанию. */
  readonly model?: string;
  /** Уровень рассуждения хода; "" или нет — по умолчанию. */
  readonly effort?: string;
  readonly shell?: boolean;
  readonly onSessionId?: (id: string) => void;
}

interface ThreadResponse {
  readonly thread?: { readonly id?: string };
}

const TOOL_ITEMS = new Set([
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "dynamicToolCall",
  "functionCallOutput",
  "webSearch",
  "collabAgentToolCall",
]);

/**
 * Каталог из model/list — поля из схемы Model (Codex 0.153.0): `model,
 * displayName, description, hidden, isDefault, defaultReasoningEffort,
 * supportedReasoningEfforts[].reasoningEffort`. Скрытые не показываются.
 */
function codexCatalog(models: readonly Record<string, unknown>[]): {
  list: ModelOption[];
  isDefault: string | undefined;
} {
  const visible = models.filter((m) => m["hidden"] !== true && typeof (m["model"] ?? m["id"]) === "string");
  const defaultModel = visible.find((m) => m["isDefault"] === true) ?? visible[0];
  const makeOption = (m: Record<string, unknown>): Omit<ModelOption, "id" | "label"> => ({
    description: String(m["description"] ?? ""),
    efforts: (Array.isArray(m["supportedReasoningEfforts"]) ? (m["supportedReasoningEfforts"] as { reasoningEffort?: unknown }[]) : [])
      .map((u) => String(u.reasoningEffort ?? ""))
      .filter(Boolean),
    ...(typeof m["defaultReasoningEffort"] === "string" ? { defaultEffort: m["defaultReasoningEffort"] } : {}),
  });
  const name = (m: Record<string, unknown>) => String(m["displayName"] ?? m["model"] ?? m["id"]);
  return {
    list: [
      defaultModel
        ? { id: "", label: `по умолчанию (${name(defaultModel)})`, ...makeOption(defaultModel) }
        : { id: "", label: "по умолчанию", description: "", efforts: [] },
      ...visible.map((m) => ({ id: String(m["model"] ?? m["id"]), label: name(m), ...makeOption(m) })),
    ],
    isDefault: defaultModel ? String(defaultModel["model"] ?? defaultModel["id"]) : undefined,
  };
}

interface Waiter {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

/** Всё, что принадлежит одному запущенному процессу. */
interface Context {
  readonly proc: ChildProcessWithoutNullStreams;
  readonly lines: LineReader;
  readonly waiters: Map<number, Waiter>;
  stopped: boolean;
  reported: boolean;
}

function add(a: TurnUsage, b: TurnUsage): TurnUsage {
  return { input: a.input + b.input, cached: a.cached + b.cached, output: a.output + b.output };
}

function subtract(a: TurnUsage, b: TurnUsage): TurnUsage {
  return { input: a.input - b.input, cached: a.cached - b.cached, output: a.output - b.output };
}

function nonNegative(a: TurnUsage): TurnUsage {
  return { input: Math.max(0, a.input), cached: Math.max(0, a.cached), output: Math.max(0, a.output) };
}

export class CodexAdapter implements Adapter {
  /**
   * Расход хода. app-server шлёт накопительный итог по ветке (total) и итог
   * последнего запроса модели (last), с turnId. Ход считается от основы
   * «итог минус последний запрос» в первом уведомлении хода: так верно и для
   * первого хода возобновлённой ветки, и для хода из нескольких запросов.
   * Уведомления чужого хода (повтор при возобновлении) не учитываются; сброс
   * итога после сжатия контекста переносит набранное (рецензия Codex 28.09).
   */
  #baseline: TurnUsage | undefined;
  #carry: TurnUsage = { input: 0, cached: 0, output: 0 };
  #previousTotal: TurnUsage | undefined;
  #turnUsage: TurnUsage | undefined;
  #limit: LimitInfo | undefined;

  #newUsageTurn(): void {
    this.#baseline = undefined;
    this.#carry = { input: 0, cached: 0, output: 0 };
    this.#previousTotal = undefined;
    this.#turnUsage = undefined;
  }

  #accountUsage(info: unknown, notifiedTurn: unknown): void {
    // Расход — только своего хода: с turnId — если он совпадает с известным
    // текущим; без turnId — если ход идёт (рецензия Codex 28.09).
    const turn = typeof notifiedTurn === "string" ? notifiedTurn : undefined;
    if (turn !== undefined ? turn !== this.#turn : !this.#busy) return;
    const s = (info ?? {}) as Record<string, unknown>;
    const parseUsage = (o: unknown): TurnUsage | undefined => {
      const z = o as Record<string, unknown> | undefined;
      if (!z || typeof z["inputTokens"] !== "number") return undefined;
      return {
        input: z["inputTokens"] as number,
        cached: typeof z["cachedInputTokens"] === "number" ? (z["cachedInputTokens"] as number) : 0,
        output: typeof z["outputTokens"] === "number" ? (z["outputTokens"] as number) : 0,
      };
    };
    const result = parseUsage(s["total"]);
    const lastIndex = parseUsage(s["last"]) ?? { input: 0, cached: 0, output: 0 };
    if (!result) {
      if (s["last"]) this.#turnUsage = add(this.#turnUsage ?? this.#carry, lastIndex);
      return;
    }
    const previous = this.#previousTotal;
    if (!this.#baseline) {
      this.#baseline = nonNegative(subtract(result, lastIndex));
    } else if (previous && (result.input < previous.input || result.output < previous.output)) {
      // Итог сброшен (сжатие контекста): набранное до сброса переносится.
      this.#carry = add(this.#carry, nonNegative(subtract(previous, this.#baseline)));
      this.#baseline = nonNegative(subtract(result, lastIndex));
    }
    this.#previousTotal = result;
    this.#turnUsage = add(this.#carry, nonNegative(subtract(result, this.#baseline)));
  }

  readonly id = "codex" as const;

  #ctx: Context | undefined;
  #launch: Promise<void> | undefined;
  #thread: string | undefined;
  /** После «новой сессии» ветка из настроек комнаты не возобновляется. */
  #noResume = false;
  #turn: string | undefined;
  /** Ходы, прерванные человеком: их поздний turn/completed не закрывает новый. */
  readonly #interrupted = new Set<string>();
  /** Номер последней отправки: сбой прежней не трогает занятость новой. */
  #sends = 0;
  #busy = false;
  #nextId = 1;
  readonly decisions: ApprovalDecision[] = [];
  #choice: ModelChoice;
  /** Выбор хоть раз передавался: модель остаётся у ветки, и умолчание надо назвать явно. */
  #choiceChanged: boolean;
  #catalog: readonly ModelOption[] | undefined;
  #defaultModel: string | undefined;

  constructor(
    private readonly options: CodexOptions,
    private readonly sink: EventSink,
  ) {
    this.#choice = { model: options.model ?? "", effort: options.effort ?? "" };
    this.#choiceChanged = Boolean(options.model || options.effort);
  }

  get busy(): boolean {
    return this.#busy;
  }

  async forgetSession(): Promise<void> {
    // Сначала забыть, потом останавливать — как у Claude.
    this.#thread = undefined;
    this.#noResume = true;
    await this.stop();
  }

  get sessionId(): string | undefined {
    return this.#thread;
  }

  async start(): Promise<void> {
    if (this.#ctx) throw new Error("адаптер Codex уже запущен");
    const proc = spawnProcess(
      this.options.command,
      [...(this.options.commandArgs ?? []), "app-server"],
      this.options.cwd,
      this.options.shell,
    );
    const k: Context = {
      proc,
      lines: readJsonLines(proc.stdout, (line) => this.#parse(k, line)),
      waiters: new Map(),
      stopped: false,
      reported: false,
    };
    this.#ctx = k;

    createInterface({ input: proc.stderr }).on("line", (line) => {
      const text = stripAnsi(line).trim();
      if (text) this.#emit("diagnostic", "stream", { text: clamp(text) });
    });
    proc.stdin.on("error", (err) => this.#channelFailure(k, err));
    proc.on("error", (err) => this.#end(k, `Codex не запустился: ${err.message}`));
    proc.on("exit", (code, signal) =>
      this.#end(k, `процесс Codex завершился неожиданно (код ${code}, сигнал ${signal}). Подробности — в диагностике.`),
    );

    try {
      await this.#request(k, "initialize", {
        clientInfo: { name: "agent-panel", version: "0.1.0" },
        capabilities: {},
      });
      this.#notify(k, "initialized", {});
      // Известная ветка продолжается, иначе создаётся новая. Известная — своя
      // ветка рецензента комнаты (codexOptions.ts); чат владельца с 05.10 не
      // продолжается. Роль задаётся в обоих случаях: между запусками могли
      // смениться роль и запрещённые пути, а ветка помнит прежние.
      // thread/resume принимает developerInstructions наравне с thread/start
      // (схема app-server 0.153.0).
      const known = this.#thread ?? (this.#noResume ? undefined : this.options.resumeThreadId);
      const common = {
        cwd: this.options.cwd,
        sandbox: "read-only",
        approvalPolicy: "never",
        developerInstructions: this.options.reviewerInstructions ?? reviewerRole(this.options.forbidden ?? []),
      };
      const reply = (await (known
        ? this.#request(k, "thread/resume", { ...common, threadId: known })
        : this.#request(k, "thread/start", common))) as ThreadResponse;
      this.#setThread(reply.thread?.id ?? known);
      this.#emit("diagnostic", "stream", {
        text: `ветка ${String(this.#thread).slice(0, 8)}, песочница read-only, одобрения never`,
      });
    } catch (err) {
      // Останавливать только СВОЙ процесс: к этому моменту мог быть запущен новый.
      if (this.#ctx === k) await this.stop();
      throw err;
    }
  }

  #end(k: Context, errorText: string): void {
    if (this.#ctx === k) {
      this.#ctx = undefined;
      this.#launch = undefined;
      this.#busy = false;
      this.#turn = undefined;
      // Как в stop(): номера ходов нового процесса могут совпасть (рецензия Codex 28.09).
      this.#interrupted.clear();
    }
    const err = new Error(k.stopped ? "адаптер Codex остановлен" : errorText);
    for (const [, o] of k.waiters) o.reject(err);
    k.waiters.clear();
    if (k.reported) return;
    k.reported = true;
    if (k.stopped) {
      this.#emit("diagnostic", "stream", { text: "процесс Codex остановлен" });
    } else {
      this.#emit("error", "turn", { text: errorText, failed: true });
    }
  }

  #channelFailure(k: Context, err: Error): void {
    this.#end(k, `канал связи с Codex сломан: ${err.message}`);
    void killTree(k.proc);
  }

  #setThread(id: string | undefined): void {
    if (!id || id === this.#thread) return;
    this.#thread = id;
    this.options.onSessionId?.(id);
  }

  async send(prompt: AgentPrompt): Promise<void> {
    // Проверка и запуск — синхронно до первого ожидания: второе сообщение,
    // пришедшее во время запуска, ждёт того же запуска, а не теряется.
    const mine = ++this.#sends;
    if (!this.#ctx) this.#launch = this.start();
    // Занят с начала отправки: «Прервать» во время запуска процесса должно
    // её отменить, а не пропустить (рецензия Codex 28.09).
    this.#busy = true;
    const launch = this.#launch;
    try {
      await launch;
      const k = this.#ctx;
      const thread = this.#thread;
      if (!k || !thread || this.#launch !== launch) throw new Error("отправка Codex прервана до начала хода");
      await this.#request(k, "turn/start", {
        threadId: thread,
        ...this.#modelParams(),
        input: [{ type: "text", text: this.#format(prompt) }],
      });
    } catch (err) {
      // Более поздняя отправка уже идёт (процесс умер при запуске, координатор
      // отправил следующее): её занятость не снимать (рецензия Codex 28.09).
      if (mine === this.#sends) this.#busy = false;
      throw err;
    }
  }

  setModel(choice: ModelChoice): void {
    this.#choice = { model: choice.model, effort: choice.effort };
    if (choice.model || choice.effort) this.#choiceChanged = true;
  }

  /**
   * model и effort для turn/start. Переданная модель остаётся у ветки, поэтому
   * возврат к «по умолчанию» называет модель и её уровень явно — по каталогу.
   */
  #modelParams(): { model?: string; effort?: string } {
    if (!this.#choiceChanged) return {};
    const model = this.#choice.model || this.#defaultModel;
    const level = this.#choice.effort || this.#catalog?.find((o) => o.id === this.#choice.model)?.defaultEffort;
    return { ...(model ? { model: model } : {}), ...(level ? { effort: level } : {}) };
  }

  /** Модели из model/list отдельного короткого процесса: ветка не создаётся. */
  async listModels(): Promise<readonly ModelOption[]> {
    const proc = spawnProcess(
      this.options.command,
      [...(this.options.commandArgs ?? []), "app-server"],
      this.options.cwd,
      this.options.shell,
    );
    proc.stderr.resume();
    proc.stdin.on("error", () => undefined);
    const waiters = new Map<number, Waiter>();
    let next = 1;
    let timer: NodeJS.Timeout | undefined;
    const writeMessage = (record: unknown) => proc.stdin.write(`${JSON.stringify(record)}\n`);
    const lines = readJsonLines(proc.stdout, (line) => {
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      if (typeof record["id"] !== "number" || "method" in record) return;
      const waiter = waiters.get(record["id"]);
      waiters.delete(record["id"]);
      if (!waiter) return;
      if (record["error"]) waiter.reject(new Error((record["error"] as { message?: string }).message ?? "ошибка Codex"));
      else waiter.resolve(record["result"]);
    });
    const request = (method: string, params: unknown) =>
      new Promise<unknown>((resolve, reject) => {
        const id = next++;
        waiters.set(id, { resolve, reject });
        writeMessage({ jsonrpc: "2.0", id, method: method, params: params });
      });
    const failed = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Codex не прислал список моделей за 30 с")), 30_000);
      proc.on("error", reject);
      proc.on("exit", (code) => reject(new Error(`Codex завершился, не прислав список моделей (код ${code})`)));
    });
    // Выход процесса после ответа — штатный: отказ провала никто не ждёт.
    failed.catch(() => undefined);
    const job = (async () => {
      await request("initialize", { clientInfo: { name: "agent-panel", version: "0.1.0" }, capabilities: {} });
      writeMessage({ jsonrpc: "2.0", method: "initialized", params: {} });
      const all: Record<string, unknown>[] = [];
      let cursor: unknown;
      for (let page = 0; page < 10; page += 1) {
        const reply = (await request("model/list", cursor ? { cursor: cursor } : {})) as
          | { data?: unknown; nextCursor?: unknown }
          | undefined;
        if (Array.isArray(reply?.data)) all.push(...(reply.data as Record<string, unknown>[]));
        cursor = reply?.nextCursor;
        if (!cursor) break;
      }
      return all;
    })();
    job.catch(() => undefined);
    try {
      const { list, isDefault } = codexCatalog(await Promise.race([job, failed]));
      this.#catalog = list;
      this.#defaultModel = isDefault;
      return list;
    } finally {
      clearTimeout(timer);
      lines.close();
      await killTree(proc);
    }
  }

  #format(prompt: AgentPrompt): string {
    const heading =
      prompt.from === "human"
        ? "[от человека]"
        : prompt.from === "claude"
          ? "[от разработчика Claude]"
          : "[от панели]";
    const version = prompt.snapshot ? `\n[версия файлов: ${prompt.snapshot}]` : "";
    return `${heading}${version}\n${prompt.text}`;
  }

  async interrupt(): Promise<void> {
    const k = this.#ctx;
    if (!k) return;
    if (this.#thread && this.#turn) {
      // Конец прерванного хода придёт позже ответа; к новому ходу он не
      // относится. Ход забывается сразу: следующее прерывание до начала
      // нового хода не должно уйти прежнему (рецензия Codex 28.09).
      const turn = this.#turn;
      this.#interrupted.add(turn);
      this.#turn = undefined;
      await this.#request(k, "turn/interrupt", { threadId: this.#thread, turnId: turn }).catch(() => undefined);
      this.#busy = false;
      return;
    }
    // Ход запускается, но его идентификатор ещё не пришёл: прервать нечего
    // адресно. Останавливается процесс; следующая отправка продолжит ветку.
    if (this.#busy) await this.stop();
  }

  async stop(): Promise<void> {
    const k = this.#ctx;
    this.#ctx = undefined;
    this.#launch = undefined;
    this.#busy = false;
    this.#turn = undefined;
    // Номера ходов нового процесса могут совпасть с прежними.
    this.#interrupted.clear();
    if (!k) return;
    k.stopped = true;
    for (const [, o] of k.waiters) o.reject(new Error("адаптер Codex остановлен"));
    k.waiters.clear();
    k.lines.close();
    await killTree(k.proc);
  }

  /** Прочитать сохранённую историю ветки без возобновления и подписки. */
  async readThread(threadId: string): Promise<unknown> {
    const k = this.#ctx;
    if (!k) throw new Error("Codex не запущен");
    return this.#request(k, "thread/read", { threadId, includeTurns: true });
  }

  #request(k: Context, method: string, params: unknown): Promise<unknown> {
    if (k.stopped || this.#ctx !== k) return Promise.reject(new Error("Codex не запущен"));
    const id = this.#nextId++;
    return new Promise<unknown>((resolve, reject) => {
      k.waiters.set(id, { resolve, reject });
      k.proc.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method: method, params: params })}\n`,
        (err) => {
          if (err) this.#channelFailure(k, err);
        },
      );
    });
  }

  #notify(k: Context, method: string, params: unknown): void {
    k.proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: method, params: params })}\n`, (err) => {
      if (err) this.#channelFailure(k, err);
    });
  }

  #parse(k: Context, line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      this.#emit("diagnostic", "stream", { text: clamp(`строка вне протокола: ${stripAnsi(trimmed)}`) });
      return;
    }

    if (typeof record["id"] === "number" && !("method" in record)) {
      const waiter = k.waiters.get(record["id"]);
      k.waiters.delete(record["id"]);
      if (!waiter) return;
      if (record["error"]) {
        waiter.reject(new Error((record["error"] as { message?: string }).message ?? "ошибка Codex"));
      } else {
        waiter.resolve(record["result"]);
      }
      return;
    }

    // Строки остановленного или заменённого процесса не должны менять
    // состояние текущего.
    if (this.#ctx !== k) return;

    // Запрос сервера к клиенту: неизвестное не разрешается.
    if ("method" in record && "id" in record) {
      this.#deny(k, record);
      return;
    }
    this.#notification(record);
  }

  #deny(k: Context, record: Record<string, unknown>): void {
    const method = String(record["method"]);
    const reason = `рецензенту запрещены изменения: запрос «${method}» отклонён панелью`;
    this.decisions.push({ allow: false, reason: reason });
    this.#emit("approval_requested", "turn", { text: method, raw: record });
    this.#emit("approval_decided", "turn", { text: reason });
    k.proc.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: record["id"], error: { code: -32000, message: reason } })}\n`,
      (err) => {
        if (err) this.#channelFailure(k, err);
      },
    );
  }

  #notification(record: Record<string, unknown>): void {
    const method = String(record["method"] ?? "");
    const p = (record["params"] ?? {}) as Record<string, unknown>;

    switch (method) {
      case "thread/started":
        this.#setThread((p["thread"] as { id?: string } | undefined)?.id);
        return;
      case "turn/started": {
        const turn = (p["turn"] as { id?: string } | undefined)?.id;
        this.#turn = typeof turn === "string" ? turn : undefined;
        this.#newUsageTurn();
        this.#busy = true;
        this.#emit("turn_started", "turn", {});
        return;
      }
      case "thread/tokenUsage/updated": {
        this.#accountUsage(p["tokenUsage"], p["turnId"]);
        return;
      }
      case "account/rateLimits/updated": {
        const windowLabel = ((p["rateLimits"] ?? {}) as Record<string, unknown>)["primary"] as Record<string, unknown> | undefined;
        if (windowLabel && typeof windowLabel["usedPercent"] === "number") {
          const minutes = windowLabel["windowDurationMins"];
          this.#limit = {
            percent: windowLabel["usedPercent"],
            window: minutes === 10080 ? "week" : minutes === 300 ? "five_hour" : `${String(minutes)} min`,
            ...(typeof windowLabel["resetsAt"] === "number" ? { resetsAt: windowLabel["resetsAt"] * 1000 } : {}),
          };
        }
        return;
      }
      case "turn/completed": {
        const turn = (p["turn"] ?? {}) as { id?: unknown; status?: string; error?: { message?: string } };
        if (typeof turn.id === "string" && this.#interrupted.delete(turn.id)) {
          // Человек уже знает о прерывании, координатор уже сбросил ожидание:
          // поздний конец не закрывает ни новый ход, ни «ничей» (рецензии Codex 28.09).
          this.#emit("diagnostic", "stream", { text: "поздний конец прерванного хода Codex пропущен" });
          return;
        }
        this.#busy = false;
        this.#turn = undefined;
        const failed = turn.status === "failed" || turn.status === "interrupted";
        const usage = this.#turnUsage;
        this.#newUsageTurn();
        this.#emit("turn_completed", "turn", {
          ...(usage ? { usage: usage } : {}),
          ...(this.#limit ? { limit: this.#limit } : {}),
          raw: p,
          ...(failed
            ? {
                failed: true,
                text: `ход завершён: ${turn.status}${turn.error?.message ? ` — ${turn.error.message}` : ""}`,
              }
            : {}),
        });
        return;
      }
      case "item/started":
        this.#item(p, false);
        return;
      case "item/completed":
        this.#item(p, true);
        return;
      case "item/agentMessage/delta":
      case "item/reasoning/textDelta":
      case "item/reasoning/summaryTextDelta":
      case "item/commandExecution/outputDelta":
      case "process/outputDelta": {
        if (this.#fromInterrupted(p)) return;
        const text = this.#textOf(p["delta"] ?? p["chunk"] ?? p["text"] ?? p["output"]);
        if (text) this.#emit("text_delta", "stream", { text: text });
        return;
      }
      case "process/exited":
        this.#emit("tool_result", "turn", { tool: "process", text: clamp(JSON.stringify(p)), raw: p });
        return;
      default:
        return;
    }
  }

  /**
   * Событие прерванного хода: его поздние элементы не должны войти в ответ
   * нового — например, в материал следующей проверки (рецензия Codex 28.09).
   */
  #fromInterrupted(p: Record<string, unknown>): boolean {
    return typeof p["turnId"] === "string" && this.#interrupted.has(p["turnId"]);
  }

  #item(p: Record<string, unknown>, completed: boolean): void {
    if (this.#fromInterrupted(p)) return;
    const makeEl = (p["item"] ?? p) as Record<string, unknown>;
    const kind = String(makeEl["type"] ?? "");
    const text = this.#textOf(makeEl["text"] ?? makeEl["content"]);

    if (kind === "agentMessage") {
      if (completed && text) this.#emit("message", "turn", { text: clamp(text) });
      return;
    }
    if (TOOL_ITEMS.has(kind)) {
      // id элемента связывает начало и конец одного инструмента: без него
      // панель рисовала две бусины на вызов (рецензия Codex 28.09).
      this.#emit(completed ? "tool_result" : "tool_call", "turn", {
        tool: kind,
        ...(typeof makeEl["id"] === "string" ? { callId: makeEl["id"] } : {}),
        ...clampKeepingFull(text || JSON.stringify(makeEl)),
        raw: makeEl,
      });
    }
  }

  #textOf(value: unknown): string {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) {
      return value
        .map((el) => (typeof el === "string" ? el : typeof (el as { text?: unknown })?.text === "string" ? (el as { text: string }).text : ""))
        .join("");
    }
    return "";
  }

  #emit(
    kind: PanelEvent["kind"],
    visibility: PanelEvent["visibility"],
    rest: Partial<PanelEvent>,
  ): void {
    this.sink({
      id: newEventId(),
      agent: this.id,
      kind,
      visibility,
      at: Date.now(),
      ...(this.#turn ? { turnId: this.#turn } : {}),
      ...rest,
    } as PanelEvent);
  }
}

/**
 * Роль рецензента Codex. Ступень 1 (спека 05.10): репозиторий он читает
 * командами сам; запрещённые пути — данные и секреты проекта, которые
 * песочница read-only от чтения не закрывает.
 */
export function reviewerRole(forbidden: readonly string[]): string {
  return [
    "Ты рецензент в общей комнате с человеком и разработчиком Claude Code.",
    "",
    "Проверяй постановку, код и выводы.",
    "- Читай репозиторий сам: rg, git log/show/diff, python -c над кодом. Сырой вывод Claude",
    "  по-прежнему главное свидетельство о запусках, которые ты не повторяешь.",
    "- Не изменяй проект, не ходи в сеть, не запускай долгие и фоновые процессы.",
    ...(forbidden.length > 0
      ? [
          `- Не открывай и не читай пути: ${forbidden.join(", ")}. Это данные или секреты проекта:`,
          "  обращение к ним — нарушение правил проекта, даже без расчёта.",
        ]
      : []),
    "",
    "Тебе передаются законченные реплики разработчика и СЫРОЙ вывод его",
    "инструментов. Опирайся на сырой вывод, а не на пересказ.",
    "",
    "Замечания относятся к версии файлов из шапки реплики.",
    "",
    "Каждую проверку заканчивай ПОСЛЕДНЕЙ строкой ровно «ВЕРДИКТ: ПРИНЯТО»,",
    "«ВЕРДИКТ: ЕСТЬ ЗАМЕЧАНИЯ» или «ВЕРДИКТ: НУЖНО РЕШЕНИЕ ЧЕЛОВЕКА» — без",
    "цитаты, без блока кода, без текста после неё. Последний — когда без",
    "решения или данных человека продолжать обмен бессмысленно: иначе панель",
    "будет пересылать ответы до предела проверок. Без вердикта ответ ждёт",
    "решения человека.",
  ].join("\n");
}
