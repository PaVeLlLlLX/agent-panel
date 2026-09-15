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
 *   ThreadItem: agentMessage, commandExecution, fileChange, mcpToolCall, reasoning…
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
 * Как и у адаптера Claude: stderr — диагностика, плановая остановка — не
 * авария, обработчики error на процессе и stdin обязательны.
 */
import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface, Interface } from "node:readline";
import {
  Adapter,
  AgentPrompt,
  ApprovalDecision,
  EventSink,
  PanelEvent,
  clamp,
  newEventId,
  stripAnsi,
} from "./types.js";

export interface CodexOptions {
  readonly command: string;
  readonly commandArgs?: readonly string[];
  readonly cwd: string;
  readonly resumeThreadId?: string;
  readonly reviewerInstructions?: string;
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

interface Ожидание {
  readonly resolve: (значение: unknown) => void;
  readonly reject: (ошибка: Error) => void;
}

export class CodexAdapter implements Adapter {
  readonly id = "codex" as const;

  #процесс: ChildProcessWithoutNullStreams | undefined;
  #строки: Interface | undefined;
  #ветка: string | undefined;
  #ход: string | undefined;
  #занят = false;
  #следующийId = 1;
  readonly #ожидания = new Map<number, Ожидание>();
  readonly #останавливаемые = new WeakSet<object>();
  readonly #отчитанные = new WeakSet<object>();
  readonly решения: ApprovalDecision[] = [];

  constructor(
    private readonly опции: CodexOptions,
    private readonly sink: EventSink,
  ) {}

  get busy(): boolean {
    return this.#занят;
  }

  get sessionId(): string | undefined {
    return this.#ветка;
  }

  async start(): Promise<void> {
    if (this.#процесс) throw new Error("адаптер Codex уже запущен");
    const процесс = spawn(this.опции.command, [...(this.опции.commandArgs ?? []), "app-server"], {
      cwd: this.опции.cwd,
      shell: process.platform === "win32",
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    this.#процесс = процесс;

    this.#строки = createInterface({ input: процесс.stdout });
    this.#строки.on("line", (строка) => this.#разобрать(строка));
    createInterface({ input: процесс.stderr }).on("line", (строка) => {
      const текст = stripAnsi(строка).trim();
      if (текст) this.#выдать("diagnostic", "stream", { text: clamp(текст) });
    });
    процесс.stdin.on("error", (беда) => {
      this.#выдать("diagnostic", "stream", { text: `запись в Codex не удалась: ${беда.message}` });
    });
    процесс.on("error", (беда) => this.#конец(процесс, `Codex не запустился: ${беда.message}`));
    процесс.on("exit", (код, сигнал) =>
      this.#конец(процесс, `процесс Codex завершился неожиданно (код ${код}, сигнал ${сигнал}). Подробности — в диагностике.`),
    );

    try {
      await this.#запрос("initialize", {
        clientInfo: { name: "agent-panel", version: "0.1.0" },
        capabilities: {},
      });
      this.#уведомить("initialized", {});
      // Известная ветка (сохранённая или от прежнего процесса) продолжается,
      // иначе создаётся новая с инструкцией рецензента.
      const известная = this.#ветка ?? this.опции.resumeThreadId;
      const общие = { cwd: this.опции.cwd, sandbox: "read-only", approvalPolicy: "never" };
      const ответ = (await (известная
        ? this.#запрос("thread/resume", { ...общие, threadId: известная })
        : this.#запрос("thread/start", {
            ...общие,
            developerInstructions: this.опции.reviewerInstructions ?? ИНСТРУКЦИЯ_РЕЦЕНЗЕНТА,
          }))) as ОтветВетки;
      this.#установитьВетку(ответ.thread?.id ?? известная);
      this.#выдать("diagnostic", "stream", {
        text: `ветка ${String(this.#ветка).slice(0, 8)}, песочница read-only, одобрения never`,
      });
    } catch (беда) {
      // Недоделанный запуск не должен оставлять живой процесс без ветки:
      // следующая отправка решила бы, что всё готово.
      await this.stop();
      throw беда;
    }
  }

  #конец(процесс: ChildProcessWithoutNullStreams, текстОшибки: string): void {
    const текущий = this.#процесс === процесс;
    if (текущий) {
      this.#процесс = undefined;
      this.#занят = false;
      this.#ход = undefined;
    }
    const ожидаемо = this.#останавливаемые.has(процесс);
    if (текущий || ожидаемо) {
      const беда = new Error(ожидаемо ? "адаптер Codex остановлен" : текстОшибки);
      for (const [, о] of this.#ожидания) о.reject(беда);
      this.#ожидания.clear();
    }
    if (this.#отчитанные.has(процесс)) return;
    this.#отчитанные.add(процесс);
    if (ожидаемо) {
      this.#выдать("diagnostic", "stream", { text: "процесс Codex остановлен" });
    } else {
      this.#выдать("error", "turn", { text: текстОшибки, failed: true });
    }
  }

  #установитьВетку(id: string | undefined): void {
    if (!id || id === this.#ветка) return;
    this.#ветка = id;
    this.опции.onSessionId?.(id);
  }

  async send(prompt: AgentPrompt): Promise<void> {
    if (!this.#процесс) await this.start();
    const ветка = this.#ветка;
    if (!ветка) throw new Error("ветка Codex не создана");
    this.#занят = true;
    try {
      await this.#запрос("turn/start", {
        threadId: ветка,
        input: [{ type: "text", text: this.#оформить(prompt) }],
      });
    } catch (беда) {
      this.#занят = false;
      throw беда;
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
    if (!this.#ветка || !this.#ход) return;
    await this.#запрос("turn/interrupt", { threadId: this.#ветка, turnId: this.#ход }).catch(() => undefined);
    this.#занят = false;
  }

  async stop(): Promise<void> {
    this.#строки?.close();
    this.#строки = undefined;
    const процесс = this.#процесс;
    this.#процесс = undefined;
    this.#занят = false;
    this.#ход = undefined;
    for (const [, о] of this.#ожидания) о.reject(new Error("адаптер Codex остановлен"));
    this.#ожидания.clear();
    if (!процесс) return;
    this.#останавливаемые.add(процесс);
    процесс.stdin.end();
    процесс.kill();
  }

  /** Прочитать сохранённую историю ветки без возобновления и подписки. */
  async readThread(threadId: string): Promise<unknown> {
    return this.#запрос("thread/read", { threadId, includeTurns: true });
  }

  #запрос(метод: string, параметры: unknown): Promise<unknown> {
    const процесс = this.#процесс;
    if (!процесс) return Promise.reject(new Error("Codex не запущен"));
    const id = this.#следующийId++;
    return new Promise<unknown>((resolve, reject) => {
      this.#ожидания.set(id, { resolve, reject });
      процесс.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: метод, params: параметры })}\n`);
    });
  }

  #уведомить(метод: string, параметры: unknown): void {
    this.#процесс?.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: метод, params: параметры })}\n`);
  }

  #разобрать(строка: string): void {
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
      const ожидание = this.#ожидания.get(запись["id"]);
      this.#ожидания.delete(запись["id"]);
      if (!ожидание) return;
      if (запись["error"]) {
        ожидание.reject(new Error((запись["error"] as { message?: string }).message ?? "ошибка Codex"));
      } else {
        ожидание.resolve(запись["result"]);
      }
      return;
    }

    // Запрос сервера к клиенту: неизвестное не разрешается.
    if ("method" in запись && "id" in запись) {
      this.#отказать(запись);
      return;
    }
    this.#нотификация(запись);
  }

  #отказать(запись: Record<string, unknown>): void {
    const метод = String(запись["method"]);
    const причина = `рецензенту запрещены изменения: запрос «${метод}» отклонён панелью`;
    this.решения.push({ allow: false, reason: причина });
    this.#выдать("approval_requested", "turn", { text: метод, raw: запись });
    this.#выдать("approval_decided", "turn", { text: причина });
    this.#процесс?.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: запись["id"], error: { code: -32000, message: причина } })}\n`,
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
        this.#занят = true;
        this.#выдать("turn_started", "turn", {});
        return;
      }
      case "turn/completed": {
        const ход = (п["turn"] ?? {}) as { status?: string; error?: { message?: string } };
        this.#занят = false;
        this.#ход = undefined;
        const провал = ход.status === "failed" || ход.status === "interrupted";
        this.#выдать("turn_completed", "turn", {
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
      this.#выдать(завершён ? "tool_result" : "tool_call", "turn", {
        tool: вид,
        text: clamp(текст || JSON.stringify(элемент)),
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
  "Каждую проверку заканчивай строкой «ВЕРДИКТ: ПРИНЯТО» или",
  "«ВЕРДИКТ: ЕСТЬ ЗАМЕЧАНИЯ» — по ней панель решает, закончен ли цикл.",
].join("\n");
