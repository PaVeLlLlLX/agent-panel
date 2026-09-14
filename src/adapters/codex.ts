/**
 * Адаптер Codex: JSON-RPC поверх stdio через `codex app-server`.
 *
 * Протокол не угадан: схема выгружена командой
 * `codex app-server generate-json-schema --out DIR` (Codex 0.153.0) и формы
 * запросов взяты из неё.
 *
 * Используемые методы клиента:
 *   initialize        { capabilities, clientInfo }      clientInfo обязателен
 *   thread/start      { cwd, sandbox, approvalPolicy, developerInstructions }
 *   thread/resume     { threadId, ... }                 threadId обязателен
 *   turn/start        { threadId, input: UserInput[] }   оба обязательны
 *   turn/interrupt    { threadId, turnId }
 *   thread/read       читает сохранённую историю БЕЗ возобновления и подписки
 *
 * Нотификации сервера, на которые реагируем:
 *   thread/started, turn/started, turn/completed,
 *   item/started, item/completed, process/outputDelta, process/exited
 *
 * UserInput — размеченное объединение; текстовый вариант:
 *   { type: "text", text: "…" }
 *
 * SandboxMode = read-only | workspace-write | danger-full-access
 * AskForApproval = untrusted | on-request | never | { granular: … }
 *
 * # Разделение ролей и что именно обеспечено технически
 *
 * **Запись файлов запрещена и это проверяемо.** Ветка запускается с
 * `sandbox: "read-only"` и `approvalPolicy: "never"`: повышение прав не
 * запрашивается, а запись блокирует сама песочница. Плюс клиент по умолчанию
 * ОТКАЗЫВАЕТ на любой незнакомый запрос одобрения — принцип «неизвестное не
 * разрешено».
 *
 * **Запрет запуска команд технически НЕ обеспечен.** Режим read-only сам по
 * себе выполнение команд не запрещает. Инструкция рецензенту в
 * `developerInstructions` — это просьба, а не ограничение. Пока не найден
 * ключ конфигурации, отключающий инструмент оболочки, это ограничение
 * остаётся незакрытым, и приёмка обязана это фиксировать, а не выдавать
 * просьбу за гарантию.
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
} from "./types.js";

export interface CodexOptions {
  readonly command: string;
  readonly cwd: string;
  /** Продолжить сохранённую ветку вместо новой. */
  readonly resumeThreadId?: string;
  /** Роль рецензента, попадает в developerInstructions. */
  readonly reviewerInstructions?: string;
}

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
  /** Решения по запросам одобрения — для журнала и проверки приёмки. */
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
    const процесс = spawn(this.опции.command, ["app-server"], {
      cwd: this.опции.cwd,
      shell: process.platform === "win32",
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    this.#процесс = процесс;

    this.#строки = createInterface({ input: процесс.stdout });
    this.#строки.on("line", (строка) => this.#разобрать(строка));
    процесс.stderr.on("data", (кусок: Buffer) => {
      const текст = кусок.toString("utf8").trim();
      if (текст) this.#выдать("error", "turn", { text: clamp(текст) });
    });
    процесс.on("exit", (код, сигнал) => {
      this.#занят = false;
      this.#выдать("error", "turn", {
        text: `процесс Codex завершился: код ${код}, сигнал ${сигнал}`,
      });
    });

    await this.#запрос("initialize", {
      clientInfo: { name: "agent-panel", version: "0.1.0" },
      capabilities: {},
    });
    this.#уведомить("initialized", {});

    if (this.опции.resumeThreadId) {
      const ответ = (await this.#запрос("thread/resume", {
        threadId: this.опции.resumeThreadId,
        cwd: this.опции.cwd,
        sandbox: "read-only",
        approvalPolicy: "never",
      })) as { threadId?: string };
      this.#ветка = ответ.threadId ?? this.опции.resumeThreadId;
    } else {
      const ответ = (await this.#запрос("thread/start", {
        cwd: this.опции.cwd,
        sandbox: "read-only",
        approvalPolicy: "never",
        developerInstructions:
          this.опции.reviewerInstructions ?? ИНСТРУКЦИЯ_РЕЦЕНЗЕНТА,
      })) as { threadId?: string };
      this.#ветка = ответ.threadId;
    }
    this.#выдать("turn_started", "turn", {
      text: `ветка ${String(this.#ветка).slice(0, 8)}, песочница read-only, одобрения never`,
    });
  }

  async send(prompt: AgentPrompt): Promise<void> {
    if (!this.#процесс) throw new Error("адаптер Codex не запущен");
    const ветка = this.#ветка;
    if (!ветка) throw new Error("ветка Codex не создана");
    this.#занят = true;
    const текст = this.#оформить(prompt);
    await this.#запрос("turn/start", {
      threadId: ветка,
      input: [{ type: "text", text: текст }],
    });
  }

  #оформить(prompt: AgentPrompt): string {
    const шапка =
      prompt.from === "human"
        ? "[от человека]"
        : prompt.from === "claude"
          ? "[от разработчика Claude]"
          : "[от Codex]";
    const версия = prompt.snapshot
      ? `\n[версия файлов: ${prompt.snapshot}]`
      : "";
    return `${шапка}${версия}\n${prompt.text}`;
  }

  async interrupt(): Promise<void> {
    if (!this.#ветка || !this.#ход) return;
    await this.#запрос("turn/interrupt", {
      threadId: this.#ветка,
      turnId: this.#ход,
    });
    this.#занят = false;
  }

  async stop(): Promise<void> {
    this.#строки?.close();
    this.#строки = undefined;
    const процесс = this.#процесс;
    this.#процесс = undefined;
    this.#занят = false;
    for (const [, о] of this.#ожидания) {
      о.reject(new Error("адаптер Codex остановлен"));
    }
    this.#ожидания.clear();
    if (!процесс) return;
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
    const тело = { jsonrpc: "2.0", id, method: метод, params: параметры };
    return new Promise<unknown>((resolve, reject) => {
      this.#ожидания.set(id, { resolve, reject });
      процесс.stdin.write(`${JSON.stringify(тело)}\n`);
    });
  }

  #уведомить(метод: string, параметры: unknown): void {
    this.#процесс?.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: метод, params: параметры })}\n`,
    );
  }

  #разобрать(строка: string): void {
    const обрезанная = строка.trim();
    if (!обрезанная) return;
    let запись: Record<string, unknown>;
    try {
      запись = JSON.parse(обрезанная) as Record<string, unknown>;
    } catch {
      this.#выдать("error", "turn", {
        text: clamp(`строка вне протокола: ${обрезанная}`),
      });
      return;
    }

    // Ответ на наш запрос.
    if (typeof запись["id"] === "number" && !("method" in запись)) {
      const ожидание = this.#ожидания.get(запись["id"]);
      this.#ожидания.delete(запись["id"]);
      if (!ожидание) return;
      if (запись["error"]) {
        const е = запись["error"] as { message?: string };
        ожидание.reject(new Error(е.message ?? "ошибка Codex"));
      } else {
        ожидание.resolve(запись["result"]);
      }
      return;
    }

    // Запрос СЕРВЕРА к нам. Незнакомое не разрешается: принцип
    // «неизвестное запрещено» здесь заменяет доверие к настройкам.
    if ("method" in запись && "id" in запись) {
      this.#отказать(запись);
      return;
    }

    this.#нотификация(запись);
  }

  #отказать(запись: Record<string, unknown>): void {
    const метод = String(запись["method"]);
    const причина =
      `рецензенту запрещены изменения: запрос «${метод}» отклонён ` +
      `панелью по умолчанию`;
    this.решения.push({ allow: false, reason: причина });
    this.#выдать("approval_requested", "turn", { text: метод, raw: запись });
    this.#выдать("approval_decided", "turn", { text: причина });
    this.#процесс?.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: запись["id"],
        error: { code: -32000, message: причина },
      })}\n`,
    );
  }

  #нотификация(запись: Record<string, unknown>): void {
    const метод = String(запись["method"] ?? "");
    const п = (запись["params"] ?? {}) as Record<string, unknown>;

    switch (метод) {
      case "thread/started":
        if (typeof п["threadId"] === "string") this.#ветка = п["threadId"];
        return;
      case "turn/started":
        this.#ход = typeof п["turnId"] === "string" ? п["turnId"] : undefined;
        this.#занят = true;
        this.#выдать("turn_started", "turn", {});
        return;
      case "turn/completed":
        this.#занят = false;
        this.#ход = undefined;
        this.#выдать("turn_completed", "turn", { raw: п });
        return;
      case "item/started":
        this.#элемент(п, false);
        return;
      case "item/completed":
        this.#элемент(п, true);
        return;
      case "process/outputDelta": {
        const текст = this.#текстИз(п["chunk"] ?? п["delta"] ?? п["output"]);
        if (текст) this.#выдать("text_delta", "stream", { text: текст });
        return;
      }
      case "process/exited":
        this.#выдать("tool_result", "turn", {
          tool: "process",
          text: clamp(JSON.stringify(п)),
          raw: п,
        });
        return;
      default:
        return;
    }
  }

  /**
   * Элементы хода: сообщения агента, вызовы инструментов, рассуждения.
   *
   * Начало элемента и его завершение — разные состояния, и смешивать их
   * нельзя: «сформировал вызов» не равно «инструмент выполнен».
   */
  #элемент(п: Record<string, unknown>, завершён: boolean): void {
    const элемент = (п["item"] ?? п) as Record<string, unknown>;
    const вид = String(элемент["type"] ?? элемент["itemType"] ?? "");
    const текст = this.#текстИз(элемент["text"] ?? элемент["content"]);

    if (вид.includes("agent_message") || вид === "message") {
      if (завершён && текст) {
        this.#выдать("message", "turn", { text: clamp(текст) });
      }
      return;
    }
    if (вид.includes("command") || вид.includes("tool")) {
      this.#выдать(завершён ? "tool_result" : "tool_call", "turn", {
        tool: вид,
        text: clamp(текст || JSON.stringify(элемент)),
        raw: элемент,
      });
      return;
    }
    // Рассуждения показываются человеку, но второму агенту не передаются.
    if (вид.includes("reasoning") && текст) {
      this.#выдать("text_delta", "stream", { text: текст });
    }
  }

  #текстИз(значение: unknown): string {
    if (typeof значение === "string") return значение;
    if (Array.isArray(значение)) {
      return значение
        .map((э) =>
          typeof э === "string"
            ? э
            : typeof (э as { text?: unknown })?.text === "string"
              ? String((э as { text: string }).text)
              : "",
        )
        .filter(Boolean)
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
  "Твоя роль: проверять постановку, код и выводы. Файлы ты не изменяешь —",
  "это запрещено технически, песочница read-only, и попытки будут отклонены",
  "панелью. Команды не запускай.",
  "",
  "Тебе передаются законченные реплики разработчика и СЫРОЙ вывод его",
  "инструментов, а не его пересказ результатов. Опирайся на сырой вывод:",
  "пересказ — именно тот механизм, которым в проект однажды попал неверный",
  "вывод, принятый без проверки.",
  "",
  "Каждое замечание относится к версии файлов, указанной в шапке реплики.",
  "Если разработчик продолжил правки, твои замечания относятся к прежнему",
  "снимку, и это надо называть прямо.",
].join("\n");
