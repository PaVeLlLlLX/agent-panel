/**
 * Адаптер Claude Code: запуск через CLI в режиме потока.
 *
 * Формат снят запуском на этой машине (Claude Code 2.1.259):
 *
 *   claude -p --input-format stream-json --output-format stream-json
 *          --verbose --include-partial-messages --setting-sources project,local
 *
 * Ввод — по строке NDJSON на реплику; контекст и session_id сохраняются между
 * репликами, на каждую приходит свой `result`.
 *
 * Вывод: system/init, stream_event (text_delta / input_json_delta), assistant
 * (text / tool_use), user (tool_result), result (is_error, num_turns,
 * permission_denials).
 *
 * Решения, за которые заплачено живыми прогонами:
 *
 * **`--setting-sources project,local`.** Без него дочерняя сессия загружает
 * пользовательский settings.json со всеми хуками, и Stop-хук приходит в неё
 * как реплика. `--bare` не годится — он не читает OAuth.
 *
 * **stderr — диагностика, а не ошибка.** Служебные логи показывались красной
 * репликой с цветовыми кодами.
 *
 * **Остановка — всем деревом и с подтверждением.** См. process.ts.
 *
 * **Ошибка записи в stdin — отказ канала.** Прежде она уходила только в
 * диагностику, send() завершался успешно, агент оставался «занятым» навсегда.
 *
 * input_json_delta не показывается как «инструмент выполняется»: это
 * формирование аргументов, а не выполнение.
 */
import { ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, Interface } from "node:readline";
import { запуститьПроцесс, остановитьДерево } from "./process.js";
import {
  Adapter,
  AgentPrompt,
  EventSink,
  PanelEvent,
  clamp,
  newEventId,
  stripAnsi,
} from "./types.js";

export interface ClaudeOptions {
  readonly command: string;
  /** Аргументы перед флагами Claude — например путь к скрипту. */
  readonly commandArgs?: readonly string[];
  readonly cwd: string;
  readonly resumeSessionId?: string;
  readonly extraArgs?: readonly string[];
  /** Источники настроек. По умолчанию без пользовательских; "" — флаг не передаётся. */
  readonly settingSources?: string;
  /** Запуск через оболочку. По умолчанию на Windows — да: иначе не запустить claude.cmd. */
  readonly shell?: boolean;
  readonly onSessionId?: (id: string) => void;
}

/**
 * Отказы в разрешениях из result: `{ tool_name, tool_use_id, tool_input }`.
 * Форма снята с настоящего result живого прогона.
 */
function разобратьОтказы(значение: unknown): string[] {
  if (!Array.isArray(значение)) return [];
  return значение.map((о) => {
    const запись = (о ?? {}) as { tool_name?: unknown; tool_input?: Record<string, unknown> };
    const вход = запись.tool_input ?? {};
    const суть =
      typeof вход["command"] === "string"
        ? вход["command"]
        : typeof вход["file_path"] === "string"
          ? вход["file_path"]
          : JSON.stringify(вход);
    return clamp(`${String(запись.tool_name ?? "?")}: ${суть}`, 300);
  });
}

export class ClaudeAdapter implements Adapter {
  readonly id = "claude" as const;

  #процесс: ChildProcessWithoutNullStreams | undefined;
  #строки: Interface | undefined;
  #сессия: string | undefined;
  #занят = false;
  #ходИдёт: string | undefined;
  readonly #вызовы = new Map<string, string>();
  readonly #останавливаемые = new WeakSet<object>();
  readonly #отчитанные = new WeakSet<object>();

  constructor(
    private readonly опции: ClaudeOptions,
    private readonly sink: EventSink,
  ) {
    this.#сессия = опции.resumeSessionId;
  }

  get busy(): boolean {
    return this.#занят;
  }

  get sessionId(): string | undefined {
    return this.#сессия;
  }

  async start(): Promise<void> {
    if (this.#процесс) throw new Error("адаптер Claude уже запущен");
    const источники = this.опции.settingSources ?? "project,local";
    const аргументы = [
      ...(this.опции.commandArgs ?? []),
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      ...(источники ? ["--setting-sources", источники] : []),
      // Перезапуск после падения или прерывания продолжает ту же сессию.
      ...(this.#сессия ? ["--resume", this.#сессия] : []),
      ...(this.опции.extraArgs ?? []),
    ];
    const процесс = запуститьПроцесс(this.опции.command, аргументы, this.опции.cwd, this.опции.shell);
    this.#процесс = процесс;

    this.#строки = createInterface({ input: процесс.stdout });
    this.#строки.on("line", (строка) => this.#разобрать(строка));
    createInterface({ input: процесс.stderr }).on("line", (строка) => {
      const текст = stripAnsi(строка).trim();
      if (текст) this.#выдать("diagnostic", "stream", { text: clamp(текст) });
    });
    процесс.stdin.on("error", (беда) => this.#сбойКанала(процесс, беда));
    процесс.on("error", (беда) => this.#конец(процесс, `Claude не запустился: ${беда.message}`));
    процесс.on("exit", (код, сигнал) =>
      this.#конец(
        процесс,
        `процесс Claude завершился неожиданно (код ${код}, сигнал ${сигнал}). Подробности — в диагностике.`,
      ),
    );
  }

  #конец(процесс: ChildProcessWithoutNullStreams, текстОшибки: string): void {
    if (this.#процесс === процесс) {
      this.#процесс = undefined;
      this.#занят = false;
    }
    if (this.#отчитанные.has(процесс)) return;
    this.#отчитанные.add(процесс);
    if (this.#останавливаемые.has(процесс)) {
      this.#выдать("diagnostic", "stream", { text: "процесс Claude остановлен" });
    } else {
      this.#выдать("error", "turn", { text: текстОшибки, failed: true });
    }
  }

  /** Канал сломан при живом процессе: ответа не будет — это конец процесса. */
  #сбойКанала(процесс: ChildProcessWithoutNullStreams, беда: Error): void {
    this.#конец(процесс, `канал связи с Claude сломан: ${беда.message}`);
    void остановитьДерево(процесс);
  }

  async send(prompt: AgentPrompt): Promise<void> {
    if (!this.#процесс) await this.start();
    const процесс = this.#процесс;
    if (!процесс) throw new Error("адаптер Claude не запущен");
    const запись = {
      type: "user",
      message: { role: "user", content: [{ type: "text", text: this.#оформить(prompt) }] },
    };
    this.#занят = true;
    процесс.stdin.write(`${JSON.stringify(запись)}\n`, (беда) => {
      if (беда) this.#сбойКанала(процесс, беда);
    });
  }

  /** Кто прислал реплику — часть сообщения: указание человека и замечание рецензента весят по-разному. */
  #оформить(prompt: AgentPrompt): string {
    const шапка =
      prompt.from === "human"
        ? "[от человека]"
        : prompt.from === "codex"
          ? "[замечание рецензента Codex]"
          : "[от панели]";
    const версия = prompt.snapshot ? `\n[версия файлов: ${prompt.snapshot}]` : "";
    return `${шапка}${версия}\n${prompt.text}`;
  }

  /**
   * У CLI в режиме print нет команды прерывания хода, поэтому это остановка
   * процесса. Следующая отправка поднимет его заново с --resume той же сессии.
   */
  async interrupt(): Promise<void> {
    await this.stop();
  }

  async stop(): Promise<void> {
    this.#строки?.close();
    this.#строки = undefined;
    const процесс = this.#процесс;
    this.#процесс = undefined;
    this.#занят = false;
    if (!процесс) return;
    this.#останавливаемые.add(процесс);
    await остановитьДерево(процесс);
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

    if (typeof запись["session_id"] === "string" && запись["session_id"] !== this.#сессия) {
      // Идентификатор приходит асинхронно, уже после start().
      this.#сессия = запись["session_id"];
      this.опции.onSessionId?.(this.#сессия);
    }

    const вид = запись["type"];
    if (вид === "system" && запись["subtype"] === "init") {
      this.#выдать("diagnostic", "stream", {
        text: `сессия ${String(запись["session_id"]).slice(0, 8)}, модель ${String(запись["model"])}`,
        raw: запись,
      });
    } else if (вид === "stream_event") {
      this.#дельта(запись);
    } else if (вид === "assistant") {
      this.#блокиАссистента(запись);
    } else if (вид === "user") {
      this.#блокиПользователя(запись);
    } else if (вид === "result") {
      this.#занят = false;
      this.#ходИдёт = undefined;
      const ошибка = запись["is_error"] === true;
      const отказы = разобратьОтказы(запись["permission_denials"]);
      this.#выдать("turn_completed", "turn", {
        ...(отказы.length > 0 ? { denials: отказы } : {}),
        text: ошибка
          ? `ход завершён с ошибкой: ${String(запись["stop_reason"] ?? запись["subtype"] ?? "причина не указана")}`
          : `ход завершён, реплик ${String(запись["num_turns"])}`,
        raw: запись,
        ...(ошибка ? { failed: true } : {}),
      });
    }
  }

  #дельта(запись: Record<string, unknown>): void {
    const событие = запись["event"] as Record<string, unknown> | undefined;
    if (!событие) return;
    if (событие["type"] === "message_start") {
      this.#ходИдёт = newEventId();
      return;
    }
    if (событие["type"] !== "content_block_delta") return;
    const дельта = событие["delta"] as Record<string, unknown> | undefined;
    if (дельта?.["type"] === "text_delta" && typeof дельта["text"] === "string") {
      this.#выдать("text_delta", "stream", { text: дельта["text"] });
    }
  }

  #блокиАссистента(запись: Record<string, unknown>): void {
    for (const блок of this.#блоки(запись)) {
      if (блок["type"] === "text" && typeof блок["text"] === "string") {
        this.#выдать("message", "turn", { text: clamp(блок["text"]) });
      } else if (блок["type"] === "tool_use") {
        const id = String(блок["id"] ?? "");
        const имя = String(блок["name"] ?? "?");
        this.#вызовы.set(id, имя);
        this.#выдать("tool_call", "turn", {
          tool: имя,
          callId: id,
          text: clamp(JSON.stringify(блок["input"] ?? {}, null, 1)),
          raw: блок,
        });
        this.#выдать("tool_running", "stream", { tool: имя, callId: id });
      }
    }
  }

  #блокиПользователя(запись: Record<string, unknown>): void {
    for (const блок of this.#блоки(запись)) {
      if (блок["type"] !== "tool_result") continue;
      const id = String(блок["tool_use_id"] ?? "");
      const содержимое = блок["content"];
      // Сырой вывод, а не пересказ: рецензент без права запуска зависит от него.
      const текст = typeof содержимое === "string" ? содержимое : JSON.stringify(содержимое ?? null);
      this.#выдать("tool_result", "turn", {
        tool: this.#вызовы.get(id) ?? "?",
        callId: id,
        text: clamp(текст),
        raw: блок,
      });
      this.#вызовы.delete(id);
    }
  }

  #блоки(запись: Record<string, unknown>): Record<string, unknown>[] {
    const содержимое = (запись["message"] as Record<string, unknown> | undefined)?.["content"];
    return Array.isArray(содержимое) ? (содержимое as Record<string, unknown>[]) : [];
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
      ...(this.#ходИдёт ? { turnId: this.#ходИдёт } : {}),
      ...остальное,
    } as PanelEvent);
  }
}
