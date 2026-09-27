/**
 * Адаптер Claude Code: запуск через CLI в режиме потока.
 *
 * Формат снят запуском на этой машине (Claude Code 2.1.259):
 *
 *   claude -p --input-format stream-json --output-format stream-json
 *          --verbose --include-partial-messages --setting-sources project,local
 *          --permission-prompt-tool stdio
 *
 * Ввод — по строке NDJSON на реплику; контекст и session_id сохраняются между
 * репликами, на каждую приходит свой `result`.
 *
 * Вывод: system/init, stream_event (text_delta / input_json_delta), assistant
 * (text / tool_use), user (tool_result), result (is_error, num_turns,
 * permission_denials), control_request.
 *
 * Решения, за которые заплачено живыми прогонами:
 *
 * **`--setting-sources project,local`.** Без него дочерняя сессия загружает
 * пользовательский settings.json со всеми хуками, и Stop-хук приходит в неё
 * как реплика. `--bare` не годится — он не читает OAuth.
 *
 * **Разрешения спрашиваются у человека.** Без `--permission-prompt-tool stdio`
 * всё, что требует согласия, отклонялось молча, и в живом прогоне три проверки
 * ушли на спор о заблокированной команде. С флагом Claude пишет
 * `control_request` с подтипом `can_use_tool` и ждёт `control_response` —
 * форма снята пробой с Claude Code 2.1.220. «Разрешить в этой сессии»
 * передаёт только правила команды (`addRules`) с destination "session":
 * предложение приходит с localSettings, и записать его как есть значило бы
 * править файл настроек владельца; `setMode acceptEdits` разрешил бы все
 * правки сразу — шире, чем видит человек на кнопке.
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
import { sameChoice } from "../models.js";
import { запуститьПроцесс, остановитьДерево } from "./process.js";
import {
  Adapter,
  AgentPrompt,
  ApprovalChoice,
  EventSink,
  ModelChoice,
  ModelOption,
  PanelEvent,
  clamp,
  clampKeepingFull,
  addUsage,
  LimitInfo,
  NO_USAGE,
  TurnUsage,
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
  /** Режим разрешений (--permission-mode); "default" или нет — спрашивать. */
  readonly permissionMode?: string;
  /** Модель (--model); "" или нет — модель по умолчанию. */
  readonly model?: string;
  /** Уровень рассуждения (--effort); "" или нет — по умолчанию. */
  readonly effort?: string;
  readonly onSessionId?: (id: string) => void;
  /**
   * Сколько ждать продолжения хода после того, как фоновые субагенты
   * закончили, а Claude ещё не начал итоговый запрос (мс, по умолчанию 15 000: итоговый запрос по живой трассе начинается через 0,1 с).
   */
  readonly backgroundGraceMs?: number;
  /**
   * Сколько ждать хоть одной записи от процесса, пока ход держится ради
   * субагентов (мс, по умолчанию 10 минут). Субагент, не сообщивший о
   * завершении, иначе держал бы ход вечно (рецензия Codex 28.09).
   */
  readonly backgroundIdleMs?: number;
}

/**
 * Каталог моделей из ответа initialize — форма снята пробой с Claude Code
 * 2.1.220: `models[] { value, displayName, description, supportsEffort,
 * supportedEffortLevels }`. Вариант "default" становится пунктом «по умолчанию».
 */
function каталогClaude(модели: unknown): ModelOption[] {
  const список = (Array.isArray(модели) ? модели : []) as Record<string, unknown>[];
  const уровни = (м: Record<string, unknown>): string[] =>
    м["supportsEffort"] === true && Array.isArray(м["supportedEffortLevels"])
      ? (м["supportedEffortLevels"] as unknown[]).map(String)
      : [];
  const поУмолчанию = список.find((м) => м["value"] === "default");
  const имяУмолчания = поУмолчанию ? String(поУмолчанию["description"] ?? "").split(" · ")[0] : "";
  return [
    {
      id: "",
      label: имяУмолчания ? `по умолчанию (${имяУмолчания})` : "по умолчанию",
      description: String(поУмолчанию?.["description"] ?? ""),
      efforts: поУмолчанию ? уровни(поУмолчанию) : [],
    },
    ...список
      .filter((м) => typeof м["value"] === "string" && м["value"] !== "default")
      .map((м) => ({
        id: String(м["value"]),
        label: String(м["displayName"] ?? м["value"]),
        description: String(м["description"] ?? ""),
        efforts: уровни(м),
      })),
  ];
}

const ПОДПИСЬ_БЕЗ_ВОПРОСОВ = "разрешено панелью: режим «без вопросов»";

/** Запрос разрешения, на который человек ещё не ответил. */
interface ОткрытыйЗапрос {
  /** Процесс, задавший вопрос: ответ в перезапущенный процесс не имеет смысла. */
  readonly процесс: ChildProcessWithoutNullStreams;
  readonly вход: unknown;
  readonly вызов: string | undefined;
  /** Предложения addRules, переписанные на destination "session". */
  readonly правила: readonly Record<string, unknown>[];
}

/** Суть ввода инструмента для человека: команда, путь или весь ввод. */
function сутьВвода(вход: unknown): string {
  const запись = (вход ?? {}) as Record<string, unknown>;
  if (typeof запись["command"] === "string") return запись["command"];
  if (typeof запись["file_path"] === "string") return запись["file_path"];
  return JSON.stringify(запись, null, 1);
}

/**
 * Отказы в разрешениях из result: `{ tool_name, tool_use_id, tool_input }`.
 * Форма снята с настоящего result живого прогона. Отказы, данные человеком
 * в панели, пропускаются: это решение, а не блокировка.
 */
function разобратьОтказы(значение: unknown, решённыеЧеловеком: Set<string>): string[] {
  if (!Array.isArray(значение)) return [];
  const отказы: string[] = [];
  for (const о of значение) {
    const запись = (о ?? {}) as { tool_name?: unknown; tool_use_id?: unknown; tool_input?: unknown };
    if (typeof запись.tool_use_id === "string" && решённыеЧеловеком.delete(запись.tool_use_id)) continue;
    отказы.push(clamp(`${String(запись.tool_name ?? "?")}: ${сутьВвода(запись.tool_input)}`, 300));
  }
  return отказы;
}

/** Правила «на сессию» из permission_suggestions: только addRules. */
function правилаСессии(предложения: unknown): Record<string, unknown>[] {
  if (!Array.isArray(предложения)) return [];
  return предложения
    .filter((п): п is Record<string, unknown> => {
      const запись = (п ?? {}) as Record<string, unknown>;
      return запись["type"] === "addRules" && Array.isArray(запись["rules"]);
    })
    .map((п) => ({ ...п, destination: "session" }));
}

/** «Bash(mkdir x *)» — как правило видно человеку на кнопке. */
function подписиПравил(правила: readonly Record<string, unknown>[]): string[] {
  return правила.flatMap((п) =>
    (п["rules"] as { toolName?: unknown; ruleContent?: unknown }[]).map((r) =>
      typeof r.ruleContent === "string" && r.ruleContent
        ? `${String(r.toolName ?? "?")}(${r.ruleContent})`
        : String(r.toolName ?? "?"),
    ),
  );
}

/**
 * Текст результата инструмента. Настоящий Claude отдаёт его строкой или
 * массивом блоков; блоки текста склеиваются как текст — прежде массив уходил
 * рецензенту JSON-строкой с экранированными переводами строк. Прочие блоки
 * (изображения) остаются JSON: выдумывать им текст нельзя.
 */
export function текстРезультата(содержимое: unknown): string {
  if (typeof содержимое === "string") return содержимое;
  if (!Array.isArray(содержимое)) return JSON.stringify(содержимое ?? null);
  return содержимое
    .map((блок: unknown) => {
      const б = блок as Record<string, unknown> | null;
      return б && б["type"] === "text" && typeof б["text"] === "string" ? б["text"] : JSON.stringify(блок);
    })
    .join(String.fromCharCode(10));
}

/** Чей субагент: parent_tool_use_id записи, если она не от самого Claude. */
function родительИз(запись: Record<string, unknown>): { parentCallId?: string } {
  const id = запись["parent_tool_use_id"];
  return typeof id === "string" && id ? { parentCallId: id } : {};
}

/** Токены одного result: вход = без кеша + чтение кеша + запись кеша. */
function расходClaude(usage: unknown): TurnUsage {
  const у = (usage ?? {}) as Record<string, unknown>;
  const число = (ключ: string) => (typeof у[ключ] === "number" ? (у[ключ] as number) : 0);
  const изКеша = число("cache_read_input_tokens");
  return {
    input: число("input_tokens") + изКеша + число("cache_creation_input_tokens"),
    cached: изКеша,
    output: число("output_tokens"),
  };
}

export class ClaudeAdapter implements Adapter {
  readonly id = "claude" as const;

  #процесс: ChildProcessWithoutNullStreams | undefined;
  #строки: Interface | undefined;
  #сессия: string | undefined;
  #занят = false;
  #ходИдёт: string | undefined;
  readonly #вызовы = new Map<string, string>();
  readonly #запросы = new Map<string, ОткрытыйЗапрос>();
  /** tool_use_id вызовов, отклонённых человеком: в итоге хода это не отказ без спроса. */
  readonly #отклонённыеЧеловеком = new Set<string>();
  /**
   * Ход с фоновыми субагентами (живая трасса Claude Code 2.1.220, 28.09):
   * result приходит, пока субагент ещё работает, а после него Claude сам
   * начинает итоговый запрос — новый init, реплика, свой result. Ход
   * кончается, когда субагентов нет, открытых запросов нет и продолжения не
   * ждём. Фоновые Bash (task_type local_bash) ход не держат: сервер,
   * запущенный в фоне, закончить его не дал бы никогда.
   */
  readonly #субагенты = new Set<string>();
  #открытыхЗапросов = 0;
  #ждёмПродолжения = false;
  #ходДержится = false;
  #отложенныеОтказы: string[] = [];
  #срокПродолжения: NodeJS.Timeout | undefined;
  /** Расход хода — сумма по всем его result; лимит — последнее сведение CLI. */
  #расходХода: TurnUsage = NO_USAGE;
  #лимит: LimitInfo | undefined;
  /** Время последней записи процесса и срок тишины удерживаемого хода. */
  #последняяЗапись = 0;
  #срокТишины: NodeJS.Timeout | undefined;
  readonly #останавливаемые = new WeakSet<object>();
  readonly #отчитанные = new WeakSet<object>();
  /** Выбор человека и выбор, с которым запущен текущий процесс. */
  #выбор: ModelChoice;
  #выборПроцесса: ModelChoice | undefined;
  /** Режим разрешений человека и режим, с которым запущен текущий процесс. */
  #режим: string;
  #режимПроцесса: string | undefined;

  constructor(
    private readonly опции: ClaudeOptions,
    private readonly sink: EventSink,
  ) {
    this.#сессия = опции.resumeSessionId;
    this.#выбор = { model: опции.model ?? "", effort: опции.effort ?? "" };
    this.#режим = опции.permissionMode || "default";
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
      "--permission-prompt-tool",
      "stdio",
      ...(источники ? ["--setting-sources", источники] : []),
      ...(this.#выбор.model ? ["--model", this.#выбор.model] : []),
      ...(this.#выбор.effort ? ["--effort", this.#выбор.effort] : []),
      ...(this.#режим !== "default" ? ["--permission-mode", this.#режим] : []),
      // Перезапуск после падения или прерывания продолжает ту же сессию.
      ...(this.#сессия ? ["--resume", this.#сессия] : []),
      ...(this.опции.extraArgs ?? []),
    ];
    const процесс = запуститьПроцесс(this.опции.command, аргументы, this.опции.cwd, this.опции.shell);
    this.#процесс = процесс;
    this.#выборПроцесса = this.#выбор;
    this.#режимПроцесса = this.#режим;

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
      // Уведомлений умершего процесса уже не будет: его субагенты и срок
      // ожидания не должны держать или закрывать следующий ход.
      this.#сброситьФон();
    }
    this.#закрытьЗапросы(процесс, "запрос закрыт: процесс Claude завершился");
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
    // Модель и уровень задаются флагами запуска: сменились — процесс
    // перезапускается между ходами, --resume сохраняет контекст сессии.
    const сменилось =
      this.#выборПроцесса !== undefined &&
      (!sameChoice(this.#выборПроцесса, this.#выбор) || this.#режимПроцесса !== this.#режим);
    if (this.#процесс && !this.#занят && сменилось) {
      this.#выдать("diagnostic", "stream", {
        text: "модель, уровень или режим разрешений сменились — перезапуск с той же сессией",
      });
      await this.stop();
    }
    if (!this.#процесс) await this.start();
    const процесс = this.#процесс;
    if (!процесс) throw new Error("адаптер Claude не запущен");
    const запись = {
      type: "user",
      message: { role: "user", content: [{ type: "text", text: this.#оформить(prompt) }] },
    };
    this.#занят = true;
    this.#открытыхЗапросов = 0;
    this.#записать(процесс, запись);
  }

  /**
   * Режим разрешений со следующего хода — флагом запуска. «Без вопросов»
   * действует и сразу: открытые и новые запросы текущего процесса разрешает
   * панель. Проба на Claude Code 2.1.220 показала, что setMode
   * bypassPermissions в ответе на запрос повторных запросов не отключает.
   */
  setPermissionMode(режим: string): void {
    this.#режим = режим || "default";
    if (this.#режим !== "bypassPermissions") return;
    for (const id of [...this.#запросы.keys()]) void this.#решить(id, "allow", ПОДПИСЬ_БЕЗ_ВОПРОСОВ);
  }

  setModel(выбор: ModelChoice): void {
    this.#выбор = { model: выбор.model, effort: выбор.effort };
  }

  /**
   * Список моделей — из ответа на initialize отдельного короткого процесса:
   * рабочая сессия от этого не поднимается, модель не вызывается.
   */
  async listModels(): Promise<readonly ModelOption[]> {
    const источники = this.опции.settingSources ?? "project,local";
    const процесс = запуститьПроцесс(
      this.опции.command,
      [
        ...(this.опции.commandArgs ?? []),
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        ...(источники ? ["--setting-sources", источники] : []),
      ],
      this.опции.cwd,
      this.опции.shell,
    );
    процесс.stderr.resume();
    процесс.stdin.on("error", () => undefined);
    const строки = createInterface({ input: процесс.stdout });
    let таймер: NodeJS.Timeout | undefined;
    try {
      const ответ = await new Promise<Record<string, unknown>>((resolve, reject) => {
        таймер = setTimeout(() => reject(new Error("Claude не прислал список моделей за 30 с")), 30_000);
        процесс.on("error", reject);
        процесс.on("exit", (код) => reject(new Error(`Claude завершился, не прислав список моделей (код ${код})`)));
        строки.on("line", (строка) => {
          let запись: Record<string, unknown>;
          try {
            запись = JSON.parse(строка) as Record<string, unknown>;
          } catch {
            return;
          }
          const отклик = запись["response"] as Record<string, unknown> | undefined;
          if (запись["type"] !== "control_response" || отклик?.["request_id"] !== "models") return;
          if (отклик["subtype"] === "success") resolve((отклик["response"] ?? {}) as Record<string, unknown>);
          else reject(new Error(`Claude не отдал список моделей: ${String(отклик["error"] ?? "без причины")}`));
        });
        процесс.stdin.write(
          `${JSON.stringify({ type: "control_request", request_id: "models", request: { subtype: "initialize" } })}\n`,
        );
      });
      return каталогClaude(ответ["models"]);
    } finally {
      clearTimeout(таймер);
      строки.close();
      await остановитьДерево(процесс);
    }
  }

  async answerApproval(id: string, выбор: ApprovalChoice): Promise<boolean> {
    return this.#решить(id, выбор);
  }

  async #решить(id: string, выбор: ApprovalChoice, подпись?: string): Promise<boolean> {
    const запрос = this.#запросы.get(id);
    if (!запрос || запрос.процесс !== this.#процесс) return false;
    this.#запросы.delete(id);

    const наСессию = выбор === "allowSession" && запрос.правила.length > 0;
    const решение =
      выбор === "deny"
        ? { behavior: "deny", message: "Отклонено человеком в панели." }
        : {
            behavior: "allow",
            updatedInput: запрос.вход,
            ...(наСессию ? { updatedPermissions: запрос.правила } : {}),
          };
    if (выбор === "deny" && запрос.вызов) this.#отклонённыеЧеловеком.add(запрос.вызов);

    this.#записать(запрос.процесс, {
      type: "control_response",
      response: { subtype: "success", request_id: id, response: решение },
    });
    this.#выдать("approval_decided", "turn", {
      callId: id,
      ...(запрос.вызов ? { toolCallId: запрос.вызов } : {}),
      text:
        подпись ??
        (выбор === "deny"
          ? "отклонено человеком"
          : наСессию
            ? `разрешено в этой сессии: ${подписиПравил(запрос.правила).join(", ")}`
            : "разрешено"),
      raw: решение,
    });
    return true;
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
    this.#сброситьФон();
    if (!процесс) return;
    this.#останавливаемые.add(процесс);
    // Карточки закрываются сразу: после остановки ответ уже некому отдать,
    // а открытая карточка звала бы человека нажимать бесполезную кнопку.
    this.#закрытьЗапросы(процесс, "запрос закрыт: процесс Claude остановлен");
    await остановитьДерево(процесс);
  }

  #закрытьЗапросы(процесс: ChildProcessWithoutNullStreams, причина: string): void {
    for (const [id, запрос] of this.#запросы) {
      if (запрос.процесс !== процесс) continue;
      this.#запросы.delete(id);
      this.#выдать("approval_decided", "turn", {
        callId: id,
        ...(запрос.вызов ? { toolCallId: запрос.вызов } : {}),
        text: причина,
      });
    }
  }

  #записать(процесс: ChildProcessWithoutNullStreams, запись: unknown): void {
    процесс.stdin.write(`${JSON.stringify(запись)}\n`, (беда) => {
      if (беда) this.#сбойКанала(процесс, беда);
    });
  }

  #разобрать(строка: string): void {
    const обрезанная = строка.trim();
    if (!обрезанная) return;
    this.#последняяЗапись = Date.now();
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
      // Начало запроса модели: первого на сообщение или итогового после субагентов.
      this.#открытыхЗапросов += 1;
      this.#ждёмПродолжения = false;
      this.#отменитьСрок();
      this.#выдать("diagnostic", "stream", {
        text: `сессия ${String(запись["session_id"]).slice(0, 8)}, модель ${String(запись["model"])}`,
        raw: запись,
      });
    } else if (вид === "system") {
      this.#задача(запись);
    } else if (вид === "rate_limit_event") {
      const о = (запись["rate_limit_info"] ?? {}) as Record<string, unknown>;
      this.#лимит = {
        ...(typeof о["status"] === "string" ? { status: о["status"] } : {}),
        ...(typeof о["rateLimitType"] === "string" ? { window: о["rateLimitType"] } : {}),
        ...(typeof о["resetsAt"] === "number" ? { resetsAt: о["resetsAt"] * 1000 } : {}),
      };
    } else if (вид === "stream_event") {
      this.#дельта(запись);
    } else if (вид === "assistant") {
      this.#блокиАссистента(запись);
    } else if (вид === "user") {
      this.#блокиПользователя(запись);
    } else if (вид === "control_request") {
      this.#запросАгента(запись);
    } else if (вид === "result") {
      this.#открытыхЗапросов = Math.max(0, this.#открытыхЗапросов - 1);
      this.#расходХода = addUsage(this.#расходХода, расходClaude(запись["usage"]));
      const ошибка = запись["is_error"] === true;
      this.#отложенныеОтказы.push(...разобратьОтказы(запись["permission_denials"], this.#отклонённыеЧеловеком));
      if (!ошибка && (this.#субагенты.size > 0 || this.#открытыхЗапросов > 0 || this.#ждёмПродолжения)) {
        if (!this.#ходДержится) {
          this.#ходДержится = true;
          this.#следитьЗаТишиной();
          this.#выдать("diagnostic", "stream", {
            text:
              `ход продолжается: Claude ждёт субагентов (${this.#субагенты.size}) — ` +
              "итог и проверка будут после их работы",
          });
        }
        this.#назначитьСрок();
        return;
      }
      this.#закончитьХод(
        ошибка
          ? `ход завершён с ошибкой: ${String(запись["stop_reason"] ?? запись["subtype"] ?? "причина не указана")}`
          : `ход завершён, реплик ${String(запись["num_turns"])}`,
        ошибка,
        запись,
      );
    }
  }

  /** Фоновые задачи: следим только за субагентами (task_type local_agent). */
  #задача(запись: Record<string, unknown>): void {
    const вид = запись["subtype"];
    const id = typeof запись["task_id"] === "string" ? запись["task_id"] : undefined;
    const закончить = (задача: string | undefined) => {
      if (задача && this.#субагенты.delete(задача)) {
        // Субагент кончил — Claude сам начнёт итоговый запрос.
        this.#ждёмПродолжения = true;
        this.#назначитьСрок();
      }
    };
    if (вид === "task_started") {
      if (id && запись["task_type"] === "local_agent") this.#субагенты.add(id);
    } else if (вид === "task_notification") {
      закончить(id);
    } else if (вид === "task_updated") {
      const статус = (запись["patch"] as Record<string, unknown> | undefined)?.["status"];
      if (typeof статус === "string" && ["completed", "failed", "killed", "stopped", "cancelled"].includes(статус)) {
        закончить(id);
      }
    } else if (вид === "background_tasks_changed" && Array.isArray(запись["tasks"])) {
      const задачи = (запись["tasks"] as Record<string, unknown>[]).filter((з) => typeof з?.["task_id"] === "string");
      // Снимается только то, чего в снимке нет: известный id без task_type —
      // всё ещё идущий субагент (рецензия Codex 28.09).
      const вСнимке = new Set(задачи.map((з) => з["task_id"] as string));
      for (const задача of [...this.#субагенты]) if (!вСнимке.has(задача)) закончить(задача);
      for (const з of задачи) if (з["task_type"] === "local_agent") this.#субагенты.add(з["task_id"] as string);
    }
  }

  /**
   * Срок ожидания продолжения — только когда ход держится, субагентов уже нет,
   * запрос модели не открыт и разрешений никто не ждёт: иначе срок закрыл бы
   * живой ответ (рецензия Codex 28.09).
   */
  #назначитьСрок(): void {
    if (!this.#ходДержится || this.#субагенты.size > 0 || this.#срокПродолжения) return;
    if (this.#открытыхЗапросов > 0 || this.#запросы.size > 0) return;
    this.#срокПродолжения = setTimeout(() => {
      this.#срокПродолжения = undefined;
      if (this.#ходДержится) {
        this.#закончитьХод("ход завершён: субагенты закончили, продолжения от Claude не было", false);
      }
    }, this.опции.backgroundGraceMs ?? 15_000);
  }

  #отменитьСрок(): void {
    if (this.#срокПродолжения) clearTimeout(this.#срокПродолжения);
    this.#срокПродолжения = undefined;
    if (this.#срокТишины) clearTimeout(this.#срокТишины);
    this.#срокТишины = undefined;
  }

  /** Держится ход, а процесс молчит дольше backgroundIdleMs — ход закрывается. */
  #следитьЗаТишиной(): void {
    const предел = this.опции.backgroundIdleMs ?? 600_000;
    const проверить = () => {
      this.#срокТишины = undefined;
      if (!this.#ходДержится) return;
      const прошло = Date.now() - this.#последняяЗапись;
      if (прошло >= предел) {
        this.#субагенты.clear();
        this.#закончитьХод(
          `ход завершён: субагенты не сообщили о завершении за ${Math.round(предел / 1000)} с тишины`,
          false,
        );
      } else {
        this.#срокТишины = setTimeout(проверить, предел - прошло);
      }
    };
    if (this.#срокТишины) clearTimeout(this.#срокТишины);
    this.#срокТишины = setTimeout(проверить, предел);
  }

  /** Всё состояние фона — при остановке и смерти процесса. */
  #сброситьФон(): void {
    this.#субагенты.clear();
    // Расход умершего процесса к следующему ходу не относится (рецензия Codex 28.09).
    this.#расходХода = NO_USAGE;
    this.#сброситьХод();
  }

  /**
   * Состояние хода. Идущие субагенты не сбрасываются: если ход кончился
   * ошибкой при работающем субагенте, его поздний итог должен держать
   * следующий ход, а не закончить его своим result (рецензия Codex 28.09).
   */
  #сброситьХод(): void {
    this.#отменитьСрок();
    this.#открытыхЗапросов = 0;
    this.#ждёмПродолжения = false;
    this.#ходДержится = false;
    this.#отложенныеОтказы = [];
  }

  #закончитьХод(текст: string, ошибка: boolean, запись?: Record<string, unknown>): void {
    const отказы = this.#отложенныеОтказы;
    const расход = this.#расходХода;
    this.#расходХода = NO_USAGE;
    this.#сброситьХод();
    this.#занят = false;
    this.#ходИдёт = undefined;
    this.#выдать("turn_completed", "turn", {
      ...(отказы.length > 0 ? { denials: отказы } : {}),
      ...(расход.input + расход.output > 0 ? { usage: расход } : {}),
      ...(this.#лимит ? { limit: this.#лимит } : {}),
      text: текст,
      ...(запись ? { raw: запись } : {}),
      ...(ошибка ? { failed: true } : {}),
    });
  }

  /** Запрос агента к панели. Необслуживаемый получает ошибку: без ответа агент ждал бы вечно. */
  #запросАгента(запись: Record<string, unknown>): void {
    const процесс = this.#процесс;
    if (!процесс) return;
    const id = String(запись["request_id"] ?? "");
    const запрос = (запись["request"] ?? {}) as Record<string, unknown>;

    if (запрос["subtype"] !== "can_use_tool") {
      this.#выдать("diagnostic", "stream", {
        text: `запрос Claude «${String(запрос["subtype"])}» панелью не обслуживается — отвечено ошибкой`,
        raw: запись,
      });
      this.#записать(процесс, {
        type: "control_response",
        response: {
          subtype: "error",
          request_id: id,
          error: `панель не обслуживает запрос ${String(запрос["subtype"])}`,
        },
      });
      return;
    }

    const правила = правилаСессии(запрос["permission_suggestions"]);
    const вход = запрос["input"] ?? {};
    this.#запросы.set(id, {
      процесс,
      вход,
      вызов: typeof запрос["tool_use_id"] === "string" ? запрос["tool_use_id"] : undefined,
      правила,
    });

    const строки = [сутьВвода(вход)];
    if (typeof запрос["description"] === "string" && запрос["description"] !== строки[0]) {
      строки.push(запрос["description"]);
    }
    if (typeof запрос["blocked_path"] === "string") строки.push(`путь: ${запрос["blocked_path"]}`);

    this.#выдать("approval_requested", "turn", {
      tool: String(запрос["display_name"] ?? запрос["tool_name"] ?? "?"),
      callId: id,
      ...(typeof запрос["tool_use_id"] === "string" ? { toolCallId: запрос["tool_use_id"] } : {}),
      text: clamp(строки.join("\n")),
      sessionRules: подписиПравил(правила),
      raw: запись,
    });
    // Режим сменён на «без вопросов», а процесс ещё старый: разрешает панель.
    if (this.#режим === "bypassPermissions") void this.#решить(id, "allow", ПОДПИСЬ_БЕЗ_ВОПРОСОВ);
  }

  #дельта(запись: Record<string, unknown>): void {
    // Поток субагента в живой пузырь Claude не идёт: его текст придёт целиком
    // записью assistant с parent_tool_use_id.
    if (родительИз(запись).parentCallId) return;
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
    const родитель = родительИз(запись);
    for (const блок of this.#блоки(запись)) {
      if (блок["type"] === "text" && typeof блок["text"] === "string") {
        this.#выдать("message", "turn", { text: clamp(блок["text"]), ...родитель });
      } else if (блок["type"] === "tool_use") {
        const id = String(блок["id"] ?? "");
        const имя = String(блок["name"] ?? "?");
        this.#вызовы.set(id, имя);
        this.#выдать("tool_call", "turn", {
          ...родитель,
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
    const родитель = родительИз(запись);
    for (const блок of this.#блоки(запись)) {
      if (блок["type"] !== "tool_result") continue;
      const id = String(блок["tool_use_id"] ?? "");
      // Сырой вывод, а не пересказ: рецензент без права запуска зависит от него.
      const текст = текстРезультата(блок["content"]);
      this.#выдать("tool_result", "turn", {
        tool: this.#вызовы.get(id) ?? "?",
        callId: id,
        ...родитель,
        ...clampKeepingFull(текст),
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
