/**
 * Адаптер Claude Code: запуск через CLI в режиме потока.
 *
 * Формат не угадан, а проверен запуском на этой машине (Claude Code 2.1.259):
 *
 *   claude -p --input-format stream-json --output-format stream-json
 *          --verbose --include-partial-messages
 *
 * Ввод: по одной строке NDJSON на реплику,
 *   {"type":"user","message":{"role":"user","content":[{"type":"text","text":"…"}]}}
 * Контекст между репликами сохраняется, session_id один и тот же,
 * на каждую реплику приходит свой `result`. Это проверено двумя репликами:
 * вторая вспомнила число из первой.
 *
 * Вывод, наблюдённые виды записей:
 *   system/init            — session_id, tools, model, cwd, permissionMode
 *   stream_event           — обёртка событий Anthropic API:
 *     content_block_delta с delta.type = text_delta      (.text)
 *                          или delta.type = input_json_delta (.partial_json)
 *   assistant              — message.content[]: блоки tool_use или text
 *   user                   — message.content[]: блоки tool_result
 *   result                 — session_id, is_error, num_turns, permission_denials
 *
 * **Почему input_json_delta не превращается в «инструмент выполняется».**
 * Эти дельты — формирование АРГУМЕНТОВ вызова. Инструмент в этот момент ещё
 * не запущен. Показать их как выполнение значило бы врать человеку о
 * состоянии, а различение состояний — требование постановки.
 */
import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface, Interface } from "node:readline";
import {
  Adapter,
  AgentPrompt,
  EventSink,
  PanelEvent,
  clamp,
  newEventId,
} from "./types.js";

export interface ClaudeOptions {
  readonly command: string;
  readonly cwd: string;
  /** Продолжить существующую сессию вместо новой. */
  readonly resumeSessionId?: string;
  /** Дополнительные аргументы: модель, разрешения, ограничения инструментов. */
  readonly extraArgs?: readonly string[];
  /** Вызывается, когда становится известен session_id (асинхронно). */
  readonly onSessionId?: (id: string) => void;
}

export class ClaudeAdapter implements Adapter {
  readonly id = "claude" as const;

  #процесс: ChildProcessWithoutNullStreams | undefined;
  #строки: Interface | undefined;
  #сессия: string | undefined;
  #занят = false;
  #прерван = false;
  #ходИдёт: string | undefined;
  /** Незавершённые вызовы инструментов: callId -> имя. */
  readonly #вызовы = new Map<string, string>();

  constructor(
    private readonly опции: ClaudeOptions,
    private readonly sink: EventSink,
  ) {}

  get busy(): boolean {
    return this.#занят;
  }

  get sessionId(): string | undefined {
    return this.#сессия;
  }

  async start(): Promise<void> {
    if (this.#процесс) {
      throw new Error("адаптер Claude уже запущен");
    }
    // При перезапуске после прерывания продолжается та же сессия.
    const продолжить = this.опции.resumeSessionId ?? this.#сессия;
    const аргументы = [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      ...(продолжить ? ["--resume", продолжить] : []),
      ...(this.опции.extraArgs ?? []),
    ];
    const процесс = spawn(this.опции.command, аргументы, {
      cwd: this.опции.cwd,
      shell: process.platform === "win32",
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    this.#процесс = процесс;

    this.#строки = createInterface({ input: процесс.stdout });
    this.#строки.on("line", (строка) => this.#разобрать(строка));

    // stderr не смешивается с потоком: строка, не являющаяся JSON, иначе
    // выглядела бы как повреждённое событие протокола.
    процесс.stderr.on("data", (кусок: Buffer) => {
      const текст = кусок.toString("utf8").trim();
      if (текст) this.#выдать("error", "turn", { text: clamp(текст) });
    });

    процесс.on("exit", (код, сигнал) => {
      this.#занят = false;
      this.#выдать("error", "turn", {
        text: `процесс Claude завершился: код ${код}, сигнал ${сигнал}`,
      });
    });
  }

  async send(prompt: AgentPrompt): Promise<void> {
    // После прерывания процесс поднимается заново с той же сессией:
    // иначе прерывание было бы необратимым выключением агента.
    if (!this.#процесс && this.#прерван) {
      this.#прерван = false;
      await this.start();
    }
    const процесс = this.#процесс;
    if (!процесс) throw new Error("адаптер Claude не запущен");
    const запись = {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: this.#оформить(prompt) }],
      },
    };
    this.#занят = true;
    процесс.stdin.write(`${JSON.stringify(запись)}\n`);
  }

  /**
   * Кто прислал реплику — часть сообщения, а не только журнала.
   *
   * Без пометки агент не отличит замечание рецензента от указания человека,
   * а это разные по весу вещи: указание человека исполняется, замечание
   * рецензента обсуждается.
   */
  #оформить(prompt: AgentPrompt): string {
    const шапка =
      prompt.from === "human"
        ? "[от человека]"
        : prompt.from === "codex"
          ? "[замечание рецензента Codex]"
          : "[от Claude]";
    const версия = prompt.snapshot
      ? `\n[версия файлов: ${prompt.snapshot}]`
      : "";
    return `${шапка}${версия}\n${prompt.text}`;
  }

  /**
   * Прерывание хода, после которого разговор можно продолжить.
   *
   * У CLI в режиме print отдельной команды прерывания нет, поэтому
   * прерывание — это остановка процесса. Но прежняя версия на этом и
   * останавливалась: следующее сообщение получало «адаптер Claude не
   * запущен», то есть кнопка «Прервать ход» выключала агента насовсем.
   *
   * Теперь запомненный session_id позволяет поднять процесс заново с
   * `--resume`, и история сохраняется.
   */
  async interrupt(): Promise<void> {
    const сессия = this.#сессия;
    await this.stop();
    this.#сессия = сессия;
    this.#прерван = true;
  }

  async stop(): Promise<void> {
    this.#строки?.close();
    this.#строки = undefined;
    const процесс = this.#процесс;
    this.#процесс = undefined;
    this.#занят = false;
    if (!процесс) return;
    процесс.stdin.end();
    процесс.kill();
  }

  #разобрать(строка: string): void {
    const обрезанная = строка.trim();
    if (!обрезанная) return;
    let запись: Record<string, unknown>;
    try {
      запись = JSON.parse(обрезанная) as Record<string, unknown>;
    } catch {
      // Не JSON — это сбой, а не событие. Прятать его нельзя: человек должен
      // видеть повреждённый поток, а не молчание.
      this.#выдать("error", "turn", {
        text: clamp(`строка вне протокола: ${обрезанная}`),
      });
      return;
    }

    const вид = запись["type"];
    if (typeof запись["session_id"] === "string") {
      const прежняя = this.#сессия;
      this.#сессия = запись["session_id"];
      // Идентификатор приходит АСИНХРОННО, уже после start(). Если о нём
      // не сообщить, вызывающий сохранит привязку до его появления, и
      // после перезапуска панель покажет старую историю, разговаривая с
      // новой сессией, которая о ней не знает.
      if (прежняя !== this.#сессия) {
        this.опции.onSessionId?.(this.#сессия);
      }
    }

    if (вид === "system" && запись["subtype"] === "init") {
      this.#выдать("turn_started", "turn", {
        text: `сессия ${String(запись["session_id"]).slice(0, 8)}, модель ${String(запись["model"])}`,
        raw: запись,
      });
      return;
    }

    if (вид === "stream_event") {
      this.#дельта(запись);
      return;
    }

    if (вид === "assistant") {
      this.#блокиАссистента(запись);
      return;
    }

    if (вид === "user") {
      this.#блокиПользователя(запись);
      return;
    }

    if (вид === "result") {
      this.#занят = false;
      this.#ходИдёт = undefined;
      const ошибка = запись["is_error"] === true;
      this.#выдать(ошибка ? "error" : "turn_completed", "turn", {
        text: ошибка
          ? `ход завершён с ошибкой: ${String(запись["stop_reason"] ?? "причина не указана")}`
          : `ход завершён, реплик ${String(запись["num_turns"])}`,
        raw: запись,
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
    if (!дельта) return;
    if (дельта["type"] === "text_delta" && typeof дельта["text"] === "string") {
      this.#выдать("text_delta", "stream", { text: дельта["text"] });
    }
    // input_json_delta намеренно не порождает события: это формирование
    // аргументов, а не выполнение. См. описание модуля.
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
      // Сырой вывод, а не пересказ. Рецензент, лишённый права запускать
      // что-либо, зависит от этого текста; пересказ разработчика здесь —
      // именно тот механизм, которым в проект уже попал неверный вывод.
      const текст =
        typeof содержимое === "string"
          ? содержимое
          : JSON.stringify(содержимое ?? null);
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
    const сообщение = запись["message"] as Record<string, unknown> | undefined;
    const содержимое = сообщение?.["content"];
    return Array.isArray(содержимое)
      ? (содержимое as Record<string, unknown>[])
      : [];
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
