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
 * **Запрет запуска команд технически НЕ обеспечен.** Read-only сам по себе
 * выполнение не запрещает; инструкция рецензенту — просьба, а не гарантия.
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
import { createInterface, Interface } from "node:readline";
import { запуститьПроцесс, остановитьДерево } from "./process.js";
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
  /** Модель хода; "" или нет — по умолчанию. */
  readonly model?: string;
  /** Уровень рассуждения хода; "" или нет — по умолчанию. */
  readonly effort?: string;
  readonly shell?: boolean;
  readonly onSessionId?: (id: string) => void;
}

interface ОтветВетки {
  readonly thread?: { readonly id?: string };
}

const ИНСТРУМЕНТАЛЬНЫЕ = new Set([
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
function каталогCodex(модели: readonly Record<string, unknown>[]): {
  список: ModelOption[];
  поУмолчанию: string | undefined;
} {
  const видимые = модели.filter((м) => м["hidden"] !== true && typeof (м["model"] ?? м["id"]) === "string");
  const умолчание = видимые.find((м) => м["isDefault"] === true) ?? видимые[0];
  const вариант = (м: Record<string, unknown>): Omit<ModelOption, "id" | "label"> => ({
    description: String(м["description"] ?? ""),
    efforts: (Array.isArray(м["supportedReasoningEfforts"]) ? (м["supportedReasoningEfforts"] as { reasoningEffort?: unknown }[]) : [])
      .map((у) => String(у.reasoningEffort ?? ""))
      .filter(Boolean),
    ...(typeof м["defaultReasoningEffort"] === "string" ? { defaultEffort: м["defaultReasoningEffort"] } : {}),
  });
  const имя = (м: Record<string, unknown>) => String(м["displayName"] ?? м["model"] ?? м["id"]);
  return {
    список: [
      умолчание
        ? { id: "", label: `по умолчанию (${имя(умолчание)})`, ...вариант(умолчание) }
        : { id: "", label: "по умолчанию", description: "", efforts: [] },
      ...видимые.map((м) => ({ id: String(м["model"] ?? м["id"]), label: имя(м), ...вариант(м) })),
    ],
    поУмолчанию: умолчание ? String(умолчание["model"] ?? умолчание["id"]) : undefined,
  };
}

interface Ожидание {
  readonly resolve: (значение: unknown) => void;
  readonly reject: (ошибка: Error) => void;
}

/** Всё, что принадлежит одному запущенному процессу. */
interface Контекст {
  readonly процесс: ChildProcessWithoutNullStreams;
  readonly строки: Interface;
  readonly ожидания: Map<number, Ожидание>;
  остановлен: boolean;
  отчитан: boolean;
}

function сложить(а: TurnUsage, б: TurnUsage): TurnUsage {
  return { input: а.input + б.input, cached: а.cached + б.cached, output: а.output + б.output };
}

function вычесть(а: TurnUsage, б: TurnUsage): TurnUsage {
  return { input: а.input - б.input, cached: а.cached - б.cached, output: а.output - б.output };
}

function неОтрицательно(а: TurnUsage): TurnUsage {
  return { input: Math.max(0, а.input), cached: Math.max(0, а.cached), output: Math.max(0, а.output) };
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
  #основа: TurnUsage | undefined;
  #перенос: TurnUsage = { input: 0, cached: 0, output: 0 };
  #прежнийИтог: TurnUsage | undefined;
  #расходХода: TurnUsage | undefined;
  #лимит: LimitInfo | undefined;

  #новыйХодРасхода(): void {
    this.#основа = undefined;
    this.#перенос = { input: 0, cached: 0, output: 0 };
    this.#прежнийИтог = undefined;
    this.#расходХода = undefined;
  }

  #учестьРасход(сведения: unknown, ходУведомления: unknown): void {
    // Расход — только своего хода: с turnId — если он совпадает с известным
    // текущим; без turnId — если ход идёт (рецензия Codex 28.09).
    const ход = typeof ходУведомления === "string" ? ходУведомления : undefined;
    if (ход !== undefined ? ход !== this.#ход : !this.#занят) return;
    const с = (сведения ?? {}) as Record<string, unknown>;
    const разобрать = (о: unknown): TurnUsage | undefined => {
      const з = о as Record<string, unknown> | undefined;
      if (!з || typeof з["inputTokens"] !== "number") return undefined;
      return {
        input: з["inputTokens"] as number,
        cached: typeof з["cachedInputTokens"] === "number" ? (з["cachedInputTokens"] as number) : 0,
        output: typeof з["outputTokens"] === "number" ? (з["outputTokens"] as number) : 0,
      };
    };
    const итог = разобрать(с["total"]);
    const последний = разобрать(с["last"]) ?? { input: 0, cached: 0, output: 0 };
    if (!итог) {
      if (с["last"]) this.#расходХода = сложить(this.#расходХода ?? this.#перенос, последний);
      return;
    }
    const прежний = this.#прежнийИтог;
    if (!this.#основа) {
      this.#основа = неОтрицательно(вычесть(итог, последний));
    } else if (прежний && (итог.input < прежний.input || итог.output < прежний.output)) {
      // Итог сброшен (сжатие контекста): набранное до сброса переносится.
      this.#перенос = сложить(this.#перенос, неОтрицательно(вычесть(прежний, this.#основа)));
      this.#основа = неОтрицательно(вычесть(итог, последний));
    }
    this.#прежнийИтог = итог;
    this.#расходХода = сложить(this.#перенос, неОтрицательно(вычесть(итог, this.#основа)));
  }

  readonly id = "codex" as const;

  #к: Контекст | undefined;
  #запуск: Promise<void> | undefined;
  #ветка: string | undefined;
  /** После «новой сессии» ветка из настроек комнаты не возобновляется. */
  #безВозобновления = false;
  #ход: string | undefined;
  /** Ходы, прерванные человеком: их поздний turn/completed не закрывает новый. */
  readonly #прерванные = new Set<string>();
  #занят = false;
  #следующийId = 1;
  readonly решения: ApprovalDecision[] = [];
  #выбор: ModelChoice;
  /** Выбор хоть раз передавался: модель остаётся у ветки, и умолчание надо назвать явно. */
  #выборМенялся: boolean;
  #каталог: readonly ModelOption[] | undefined;
  #модельПоУмолчанию: string | undefined;

  constructor(
    private readonly опции: CodexOptions,
    private readonly sink: EventSink,
  ) {
    this.#выбор = { model: опции.model ?? "", effort: опции.effort ?? "" };
    this.#выборМенялся = Boolean(опции.model || опции.effort);
  }

  get busy(): boolean {
    return this.#занят;
  }

  async forgetSession(): Promise<void> {
    // Сначала забыть, потом останавливать — как у Claude.
    this.#ветка = undefined;
    this.#безВозобновления = true;
    await this.stop();
  }

  get sessionId(): string | undefined {
    return this.#ветка;
  }

  async start(): Promise<void> {
    if (this.#к) throw new Error("адаптер Codex уже запущен");
    const процесс = запуститьПроцесс(
      this.опции.command,
      [...(this.опции.commandArgs ?? []), "app-server"],
      this.опции.cwd,
      this.опции.shell,
    );
    const к: Контекст = {
      процесс,
      строки: createInterface({ input: процесс.stdout }),
      ожидания: new Map(),
      остановлен: false,
      отчитан: false,
    };
    this.#к = к;

    к.строки.on("line", (строка) => this.#разобрать(к, строка));
    createInterface({ input: процесс.stderr }).on("line", (строка) => {
      const текст = stripAnsi(строка).trim();
      if (текст) this.#выдать("diagnostic", "stream", { text: clamp(текст) });
    });
    процесс.stdin.on("error", (беда) => this.#сбойКанала(к, беда));
    процесс.on("error", (беда) => this.#конец(к, `Codex не запустился: ${беда.message}`));
    процесс.on("exit", (код, сигнал) =>
      this.#конец(к, `процесс Codex завершился неожиданно (код ${код}, сигнал ${сигнал}). Подробности — в диагностике.`),
    );

    try {
      await this.#запрос(к, "initialize", {
        clientInfo: { name: "agent-panel", version: "0.1.0" },
        capabilities: {},
      });
      this.#уведомить(к, "initialized", {});
      // Известная ветка продолжается, иначе создаётся новая.
      // Роль задаётся в обоих случаях: ветка, заведённая в приложении Codex,
      // помнит свою прежнюю роль разработчика, а в панели он рецензент.
      // thread/resume принимает developerInstructions наравне с thread/start
      // (схема app-server 0.153.0).
      const известная = this.#ветка ?? (this.#безВозобновления ? undefined : this.опции.resumeThreadId);
      const общие = {
        cwd: this.опции.cwd,
        sandbox: "read-only",
        approvalPolicy: "never",
        developerInstructions: this.опции.reviewerInstructions ?? ИНСТРУКЦИЯ_РЕЦЕНЗЕНТА,
      };
      const ответ = (await (известная
        ? this.#запрос(к, "thread/resume", { ...общие, threadId: известная })
        : this.#запрос(к, "thread/start", общие))) as ОтветВетки;
      this.#установитьВетку(ответ.thread?.id ?? известная);
      this.#выдать("diagnostic", "stream", {
        text: `ветка ${String(this.#ветка).slice(0, 8)}, песочница read-only, одобрения never`,
      });
    } catch (беда) {
      // Останавливать только СВОЙ процесс: к этому моменту мог быть запущен новый.
      if (this.#к === к) await this.stop();
      throw беда;
    }
  }

  #конец(к: Контекст, текстОшибки: string): void {
    if (this.#к === к) {
      this.#к = undefined;
      this.#запуск = undefined;
      this.#занят = false;
      this.#ход = undefined;
    }
    const беда = new Error(к.остановлен ? "адаптер Codex остановлен" : текстОшибки);
    for (const [, о] of к.ожидания) о.reject(беда);
    к.ожидания.clear();
    if (к.отчитан) return;
    к.отчитан = true;
    if (к.остановлен) {
      this.#выдать("diagnostic", "stream", { text: "процесс Codex остановлен" });
    } else {
      this.#выдать("error", "turn", { text: текстОшибки, failed: true });
    }
  }

  #сбойКанала(к: Контекст, беда: Error): void {
    this.#конец(к, `канал связи с Codex сломан: ${беда.message}`);
    void остановитьДерево(к.процесс);
  }

  #установитьВетку(id: string | undefined): void {
    if (!id || id === this.#ветка) return;
    this.#ветка = id;
    this.опции.onSessionId?.(id);
  }

  async send(prompt: AgentPrompt): Promise<void> {
    // Проверка и запуск — синхронно до первого ожидания: второе сообщение,
    // пришедшее во время запуска, ждёт того же запуска, а не теряется.
    if (!this.#к) this.#запуск = this.start();
    // Занят с начала отправки: «Прервать» во время запуска процесса должно
    // её отменить, а не пропустить (рецензия Codex 28.09).
    this.#занят = true;
    const запуск = this.#запуск;
    try {
      await запуск;
      const к = this.#к;
      const ветка = this.#ветка;
      if (!к || !ветка || this.#запуск !== запуск) throw new Error("отправка Codex прервана до начала хода");
      await this.#запрос(к, "turn/start", {
        threadId: ветка,
        ...this.#параметрыМодели(),
        input: [{ type: "text", text: this.#оформить(prompt) }],
      });
    } catch (беда) {
      this.#занят = false;
      throw беда;
    }
  }

  setModel(выбор: ModelChoice): void {
    this.#выбор = { model: выбор.model, effort: выбор.effort };
    if (выбор.model || выбор.effort) this.#выборМенялся = true;
  }

  /**
   * model и effort для turn/start. Переданная модель остаётся у ветки, поэтому
   * возврат к «по умолчанию» называет модель и её уровень явно — по каталогу.
   */
  #параметрыМодели(): { model?: string; effort?: string } {
    if (!this.#выборМенялся) return {};
    const модель = this.#выбор.model || this.#модельПоУмолчанию;
    const уровень = this.#выбор.effort || this.#каталог?.find((о) => о.id === this.#выбор.model)?.defaultEffort;
    return { ...(модель ? { model: модель } : {}), ...(уровень ? { effort: уровень } : {}) };
  }

  /** Модели из model/list отдельного короткого процесса: ветка не создаётся. */
  async listModels(): Promise<readonly ModelOption[]> {
    const процесс = запуститьПроцесс(
      this.опции.command,
      [...(this.опции.commandArgs ?? []), "app-server"],
      this.опции.cwd,
      this.опции.shell,
    );
    процесс.stderr.resume();
    процесс.stdin.on("error", () => undefined);
    const строки = createInterface({ input: процесс.stdout });
    const ожидания = new Map<number, Ожидание>();
    let следующий = 1;
    let таймер: NodeJS.Timeout | undefined;
    const написать = (запись: unknown) => процесс.stdin.write(`${JSON.stringify(запись)}\n`);
    строки.on("line", (строка) => {
      let запись: Record<string, unknown>;
      try {
        запись = JSON.parse(строка) as Record<string, unknown>;
      } catch {
        return;
      }
      if (typeof запись["id"] !== "number" || "method" in запись) return;
      const ожидание = ожидания.get(запись["id"]);
      ожидания.delete(запись["id"]);
      if (!ожидание) return;
      if (запись["error"]) ожидание.reject(new Error((запись["error"] as { message?: string }).message ?? "ошибка Codex"));
      else ожидание.resolve(запись["result"]);
    });
    const запрос = (метод: string, параметры: unknown) =>
      new Promise<unknown>((resolve, reject) => {
        const id = следующий++;
        ожидания.set(id, { resolve, reject });
        написать({ jsonrpc: "2.0", id, method: метод, params: параметры });
      });
    const провал = new Promise<never>((_, reject) => {
      таймер = setTimeout(() => reject(new Error("Codex не прислал список моделей за 30 с")), 30_000);
      процесс.on("error", reject);
      процесс.on("exit", (код) => reject(new Error(`Codex завершился, не прислав список моделей (код ${код})`)));
    });
    // Выход процесса после ответа — штатный: отказ провала никто не ждёт.
    провал.catch(() => undefined);
    const работа = (async () => {
      await запрос("initialize", { clientInfo: { name: "agent-panel", version: "0.1.0" }, capabilities: {} });
      написать({ jsonrpc: "2.0", method: "initialized", params: {} });
      const все: Record<string, unknown>[] = [];
      let курсор: unknown;
      for (let страница = 0; страница < 10; страница += 1) {
        const ответ = (await запрос("model/list", курсор ? { cursor: курсор } : {})) as
          | { data?: unknown; nextCursor?: unknown }
          | undefined;
        if (Array.isArray(ответ?.data)) все.push(...(ответ.data as Record<string, unknown>[]));
        курсор = ответ?.nextCursor;
        if (!курсор) break;
      }
      return все;
    })();
    работа.catch(() => undefined);
    try {
      const { список, поУмолчанию } = каталогCodex(await Promise.race([работа, провал]));
      this.#каталог = список;
      this.#модельПоУмолчанию = поУмолчанию;
      return список;
    } finally {
      clearTimeout(таймер);
      строки.close();
      await остановитьДерево(процесс);
    }
  }

  #оформить(prompt: AgentPrompt): string {
    const шапка =
      prompt.from === "human"
        ? "[от человека]"
        : prompt.from === "claude"
          ? "[от разработчика Claude]"
          : "[от панели]";
    const версия = prompt.snapshot ? `\n[версия файлов: ${prompt.snapshot}]` : "";
    return `${шапка}${версия}\n${prompt.text}`;
  }

  async interrupt(): Promise<void> {
    const к = this.#к;
    if (!к) return;
    if (this.#ветка && this.#ход) {
      // Конец прерванного хода придёт позже ответа; к новому ходу он не
      // относится. Ход забывается сразу: следующее прерывание до начала
      // нового хода не должно уйти прежнему (рецензия Codex 28.09).
      const ход = this.#ход;
      this.#прерванные.add(ход);
      this.#ход = undefined;
      await this.#запрос(к, "turn/interrupt", { threadId: this.#ветка, turnId: ход }).catch(() => undefined);
      this.#занят = false;
      return;
    }
    // Ход запускается, но его идентификатор ещё не пришёл: прервать нечего
    // адресно. Останавливается процесс; следующая отправка продолжит ветку.
    if (this.#занят) await this.stop();
  }

  async stop(): Promise<void> {
    const к = this.#к;
    this.#к = undefined;
    this.#запуск = undefined;
    this.#занят = false;
    this.#ход = undefined;
    // Номера ходов нового процесса могут совпасть с прежними.
    this.#прерванные.clear();
    if (!к) return;
    к.остановлен = true;
    for (const [, о] of к.ожидания) о.reject(new Error("адаптер Codex остановлен"));
    к.ожидания.clear();
    к.строки.close();
    await остановитьДерево(к.процесс);
  }

  /** Прочитать сохранённую историю ветки без возобновления и подписки. */
  async readThread(threadId: string): Promise<unknown> {
    const к = this.#к;
    if (!к) throw new Error("Codex не запущен");
    return this.#запрос(к, "thread/read", { threadId, includeTurns: true });
  }

  #запрос(к: Контекст, метод: string, параметры: unknown): Promise<unknown> {
    if (к.остановлен || this.#к !== к) return Promise.reject(new Error("Codex не запущен"));
    const id = this.#следующийId++;
    return new Promise<unknown>((resolve, reject) => {
      к.ожидания.set(id, { resolve, reject });
      к.процесс.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method: метод, params: параметры })}\n`,
        (беда) => {
          if (беда) this.#сбойКанала(к, беда);
        },
      );
    });
  }

  #уведомить(к: Контекст, метод: string, параметры: unknown): void {
    к.процесс.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: метод, params: параметры })}\n`, (беда) => {
      if (беда) this.#сбойКанала(к, беда);
    });
  }

  #разобрать(к: Контекст, строка: string): void {
    const обрезанная = строка.trim();
    if (!обрезанная) return;
    let запись: Record<string, unknown>;
    try {
      запись = JSON.parse(обрезанная) as Record<string, unknown>;
    } catch {
      this.#выдать("diagnostic", "stream", { text: clamp(`строка вне протокола: ${stripAnsi(обрезанная)}`) });
      return;
    }

    if (typeof запись["id"] === "number" && !("method" in запись)) {
      const ожидание = к.ожидания.get(запись["id"]);
      к.ожидания.delete(запись["id"]);
      if (!ожидание) return;
      if (запись["error"]) {
        ожидание.reject(new Error((запись["error"] as { message?: string }).message ?? "ошибка Codex"));
      } else {
        ожидание.resolve(запись["result"]);
      }
      return;
    }

    // Строки остановленного или заменённого процесса не должны менять
    // состояние текущего.
    if (this.#к !== к) return;

    // Запрос сервера к клиенту: неизвестное не разрешается.
    if ("method" in запись && "id" in запись) {
      this.#отказать(к, запись);
      return;
    }
    this.#нотификация(запись);
  }

  #отказать(к: Контекст, запись: Record<string, unknown>): void {
    const метод = String(запись["method"]);
    const причина = `рецензенту запрещены изменения: запрос «${метод}» отклонён панелью`;
    this.решения.push({ allow: false, reason: причина });
    this.#выдать("approval_requested", "turn", { text: метод, raw: запись });
    this.#выдать("approval_decided", "turn", { text: причина });
    к.процесс.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: запись["id"], error: { code: -32000, message: причина } })}\n`,
      (беда) => {
        if (беда) this.#сбойКанала(к, беда);
      },
    );
  }

  #нотификация(запись: Record<string, unknown>): void {
    const метод = String(запись["method"] ?? "");
    const п = (запись["params"] ?? {}) as Record<string, unknown>;

    switch (метод) {
      case "thread/started":
        this.#установитьВетку((п["thread"] as { id?: string } | undefined)?.id);
        return;
      case "turn/started": {
        const ход = (п["turn"] as { id?: string } | undefined)?.id;
        this.#ход = typeof ход === "string" ? ход : undefined;
        this.#новыйХодРасхода();
        this.#занят = true;
        this.#выдать("turn_started", "turn", {});
        return;
      }
      case "thread/tokenUsage/updated": {
        this.#учестьРасход(п["tokenUsage"], п["turnId"]);
        return;
      }
      case "account/rateLimits/updated": {
        const окно = ((п["rateLimits"] ?? {}) as Record<string, unknown>)["primary"] as Record<string, unknown> | undefined;
        if (окно && typeof окно["usedPercent"] === "number") {
          const минут = окно["windowDurationMins"];
          this.#лимит = {
            percent: окно["usedPercent"],
            window: минут === 10080 ? "week" : минут === 300 ? "five_hour" : `${String(минут)} min`,
            ...(typeof окно["resetsAt"] === "number" ? { resetsAt: окно["resetsAt"] * 1000 } : {}),
          };
        }
        return;
      }
      case "turn/completed": {
        const ход = (п["turn"] ?? {}) as { id?: unknown; status?: string; error?: { message?: string } };
        if (typeof ход.id === "string" && this.#прерванные.delete(ход.id)) {
          if (this.#занят) {
            // Новый ход уже идёт: поздний конец прерванного его не закрывает
            // (рецензия Codex 28.09).
            this.#выдать("diagnostic", "stream", { text: "поздний конец прерванного хода Codex пропущен — идёт новый ход" });
            return;
          }
        }
        this.#занят = false;
        this.#ход = undefined;
        const провал = ход.status === "failed" || ход.status === "interrupted";
        const расход = this.#расходХода;
        this.#новыйХодРасхода();
        this.#выдать("turn_completed", "turn", {
          ...(расход ? { usage: расход } : {}),
          ...(this.#лимит ? { limit: this.#лимит } : {}),
          raw: п,
          ...(провал
            ? {
                failed: true,
                text: `ход завершён: ${ход.status}${ход.error?.message ? ` — ${ход.error.message}` : ""}`,
              }
            : {}),
        });
        return;
      }
      case "item/started":
        this.#элемент(п, false);
        return;
      case "item/completed":
        this.#элемент(п, true);
        return;
      case "item/agentMessage/delta":
      case "item/reasoning/textDelta":
      case "item/reasoning/summaryTextDelta":
      case "item/commandExecution/outputDelta":
      case "process/outputDelta": {
        const текст = this.#текстИз(п["delta"] ?? п["chunk"] ?? п["text"] ?? п["output"]);
        if (текст) this.#выдать("text_delta", "stream", { text: текст });
        return;
      }
      case "process/exited":
        this.#выдать("tool_result", "turn", { tool: "process", text: clamp(JSON.stringify(п)), raw: п });
        return;
      default:
        return;
    }
  }

  #элемент(п: Record<string, unknown>, завершён: boolean): void {
    const элемент = (п["item"] ?? п) as Record<string, unknown>;
    const вид = String(элемент["type"] ?? "");
    const текст = this.#текстИз(элемент["text"] ?? элемент["content"]);

    if (вид === "agentMessage") {
      if (завершён && текст) this.#выдать("message", "turn", { text: clamp(текст) });
      return;
    }
    if (ИНСТРУМЕНТАЛЬНЫЕ.has(вид)) {
      // id элемента связывает начало и конец одного инструмента: без него
      // панель рисовала две бусины на вызов (рецензия Codex 28.09).
      this.#выдать(завершён ? "tool_result" : "tool_call", "turn", {
        tool: вид,
        ...(typeof элемент["id"] === "string" ? { callId: элемент["id"] } : {}),
        ...clampKeepingFull(текст || JSON.stringify(элемент)),
        raw: элемент,
      });
    }
  }

  #текстИз(значение: unknown): string {
    if (typeof значение === "string") return значение;
    if (Array.isArray(значение)) {
      return значение
        .map((э) => (typeof э === "string" ? э : typeof (э as { text?: unknown })?.text === "string" ? (э as { text: string }).text : ""))
        .join("");
    }
    return "";
  }

  #выдать(
    kind: PanelEvent["kind"],
    visibility: PanelEvent["visibility"],
    остальное: Partial<PanelEvent>,
  ): void {
    this.sink({
      id: newEventId(),
      agent: this.id,
      kind,
      visibility,
      at: Date.now(),
      ...(this.#ход ? { turnId: this.#ход } : {}),
      ...остальное,
    } as PanelEvent);
  }
}

export const ИНСТРУКЦИЯ_РЕЦЕНЗЕНТА = [
  "Ты рецензент в общей комнате с человеком и разработчиком Claude Code.",
  "",
  "Проверяй постановку, код и выводы. Файлы не изменяй — это запрещено",
  "технически. Команды не запускай.",
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
