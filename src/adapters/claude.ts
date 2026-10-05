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
import { createInterface } from "node:readline";
import { sameChoice } from "../models.js";
import { readJsonLines, LineReader } from "./jsonLines.js";
import { spawnProcess, killTree } from "./process.js";
import {
  Adapter,
  AgentPrompt,
  ApprovalChoice,
  AskQuestion,
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
function claudeCatalog(models: unknown): ModelOption[] {
  const list = (Array.isArray(models) ? models : []) as Record<string, unknown>[];
  const levels = (m: Record<string, unknown>): string[] =>
    m["supportsEffort"] === true && Array.isArray(m["supportedEffortLevels"])
      ? (m["supportedEffortLevels"] as unknown[]).map(String)
      : [];
  const isDefault = list.find((m) => m["value"] === "default");
  const defaultName = isDefault ? String(isDefault["description"] ?? "").split(" · ")[0] : "";
  return [
    {
      id: "",
      label: defaultName ? `по умолчанию (${defaultName})` : "по умолчанию",
      description: String(isDefault?.["description"] ?? ""),
      efforts: isDefault ? levels(isDefault) : [],
    },
    ...list
      .filter((m) => typeof m["value"] === "string" && m["value"] !== "default")
      .map((m) => ({
        id: String(m["value"]),
        label: String(m["displayName"] ?? m["value"]),
        description: String(m["description"] ?? ""),
        efforts: levels(m),
      })),
  ];
}

const NO_QUESTIONS_NOTE = "разрешено панелью: режим «без вопросов»";

/** Кто прислал реплику — часть сообщения: указание человека и замечание рецензента весят по-разному. */
export function formatForClaude(prompt: AgentPrompt): string {
  const heading =
    prompt.heading ??
    (prompt.from === "human"
      ? "[от человека]"
      : prompt.from === "codex"
        ? "[замечание рецензента Codex]"
        : prompt.from === "gemini"
          ? "[замечание рецензента Gemini]"
          : "[от панели]");
  const version = prompt.snapshot ? `\n[версия файлов: ${prompt.snapshot}]` : "";
  return `${heading}${version}\n${prompt.text}`;
}

/** Запрос разрешения, на который человек ещё не ответил. */
interface OpenRequest {
  /** Процесс, задавший вопрос: ответ в перезапущенный процесс не имеет смысла. */
  readonly proc: ChildProcessWithoutNullStreams;
  readonly input: unknown;
  readonly call: string | undefined;
  /** Предложения addRules, переписанные на destination "session". */
  readonly rules: readonly Record<string, unknown>[];
  /**
   * Ответить должен человек (requires_user_interaction или AskUserQuestion):
   * режим «без вопросов» такой запрос не разрешает.
   */
  readonly interactive: boolean;
  /** Вопросы AskUserQuestion; нет — это обычный запрос разрешения. */
  readonly questions?: readonly AskedQuestion[];
}

/** Вопрос, как его видит человек, и его исходный текст — ключ ответа для Claude. */
interface AskedQuestion {
  readonly shown: AskQuestion;
  readonly key: string;
}

/** Пределы строк вопроса для показа: один огромный вопрос — мегабайты в webview. */
const QUESTION_LIMIT = 2_000;
const HEADER_LIMIT = 200;
const LABEL_LIMIT = 500;

/**
 * Вопросы из ввода AskUserQuestion: `questions[] { question, header, options[]
 * { label, description }, multiSelect }`. Строки обрезаются для показа, но
 * ключ ответа — исходный текст вопроса: по нему Claude сопоставляет ответы.
 */
function parseQuestions(input: unknown): AskedQuestion[] {
  const list = ((input ?? {}) as Record<string, unknown>)["questions"];
  if (!Array.isArray(list)) return [];
  return list.flatMap((item: unknown): AskedQuestion[] => {
    const q = (item ?? {}) as Record<string, unknown>;
    if (typeof q["question"] !== "string") return [];
    const options = (Array.isArray(q["options"]) ? q["options"] : []).flatMap((o: unknown) => {
      const option = (o ?? {}) as Record<string, unknown>;
      if (typeof option["label"] !== "string") return [];
      const description = option["description"];
      return [
        {
          label: clamp(option["label"], LABEL_LIMIT),
          ...(typeof description === "string" && description ? { description: clamp(description, QUESTION_LIMIT) } : {}),
        },
      ];
    });
    const header = q["header"];
    const multiSelect = q["multiSelect"];
    return [
      {
        key: q["question"],
        shown: {
          question: clamp(q["question"], QUESTION_LIMIT),
          ...(typeof header === "string" && header ? { header: clamp(header, HEADER_LIMIT) } : {}),
          options,
          ...(typeof multiSelect === "boolean" ? { multiSelect } : {}),
        },
      },
    ];
  });
}

/** Вопросы одной строкой каждый: «Выбор: Какой вариант? (а / б)». */
function questionLines(questions: readonly AskedQuestion[]): string {
  return questions
    .map(({ shown }) => {
      const labels = shown.options.map((o) => o.label).join(" / ");
      return `${shown.header ? `${shown.header}: ` : ""}${shown.question}${labels ? ` (${labels})` : ""}`;
    })
    .join("\n");
}

/** Суть ввода инструмента для человека: команда, путь или весь ввод. */
function inputGist(input: unknown): string {
  const record = (input ?? {}) as Record<string, unknown>;
  if (typeof record["command"] === "string") return record["command"];
  if (typeof record["file_path"] === "string") return record["file_path"];
  return JSON.stringify(record, null, 1);
}

/**
 * Отказы в разрешениях из result: `{ tool_name, tool_use_id, tool_input }`.
 * Форма снята с настоящего result живого прогона. Отказы, данные человеком
 * в панели, пропускаются: это решение, а не блокировка.
 */
function parseDenials(value: unknown, decidedByHuman: Set<string>): string[] {
  if (!Array.isArray(value)) return [];
  const denials: string[] = [];
  for (const o of value) {
    const record = (o ?? {}) as { tool_name?: unknown; tool_use_id?: unknown; tool_input?: unknown };
    if (typeof record.tool_use_id === "string" && decidedByHuman.delete(record.tool_use_id)) continue;
    denials.push(clamp(`${String(record.tool_name ?? "?")}: ${inputGist(record.tool_input)}`, 300));
  }
  return denials;
}

/** Правила «на сессию» из permission_suggestions: только addRules. */
function sessionRules(suggestions: unknown): Record<string, unknown>[] {
  if (!Array.isArray(suggestions)) return [];
  return suggestions
    .filter((p): p is Record<string, unknown> => {
      const record = (p ?? {}) as Record<string, unknown>;
      return record["type"] === "addRules" && Array.isArray(record["rules"]);
    })
    .map((p) => ({ ...p, destination: "session" }));
}

/** «Bash(mkdir x *)» — как правило видно человеку на кнопке. */
function ruleLabels(rules: readonly Record<string, unknown>[]): string[] {
  return rules.flatMap((p) =>
    (p["rules"] as { toolName?: unknown; ruleContent?: unknown }[]).map((r) =>
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
export function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content ?? null);
  return content
    .map((block: unknown) => {
      const b = block as Record<string, unknown> | null;
      return b && b["type"] === "text" && typeof b["text"] === "string" ? b["text"] : JSON.stringify(block);
    })
    .join(String.fromCharCode(10));
}

/** Чей субагент: parent_tool_use_id записи, если она не от самого Claude. */
function parentFrom(record: Record<string, unknown>): { parentCallId?: string } {
  const id = record["parent_tool_use_id"];
  return typeof id === "string" && id ? { parentCallId: id } : {};
}

/** Токены одного result: вход = без кеша + чтение кеша + запись кеша. */
function toTurnUsage(usage: unknown): TurnUsage {
  const u = (usage ?? {}) as Record<string, unknown>;
  const num = (key: string) => (typeof u[key] === "number" ? (u[key] as number) : 0);
  const fromCache = num("cache_read_input_tokens");
  return {
    input: num("input_tokens") + fromCache + num("cache_creation_input_tokens"),
    cached: fromCache,
    output: num("output_tokens"),
  };
}

export class ClaudeAdapter implements Adapter {
  readonly id = "claude" as const;

  #proc: ChildProcessWithoutNullStreams | undefined;
  #lines: LineReader | undefined;
  #session: string | undefined;
  #busy = false;
  #turnInProgress: string | undefined;
  readonly #calls = new Map<string, string>();
  readonly #requests = new Map<string, OpenRequest>();
  /** tool_use_id вызовов, отклонённых человеком: в итоге хода это не отказ без спроса. */
  readonly #deniedByHuman = new Set<string>();
  /**
   * Ход с фоновыми субагентами (живая трасса Claude Code 2.1.220, 28.09):
   * result приходит, пока субагент ещё работает, а после него Claude сам
   * начинает итоговый запрос — новый init, реплика, свой result. Ход
   * кончается, когда субагентов нет, открытых запросов нет и продолжения не
   * ждём. Фоновые Bash (task_type local_bash) ход не держат: сервер,
   * запущенный в фоне, закончить его не дал бы никогда.
   */
  readonly #subagents = new Set<string>();
  /**
   * Субагенты запроса без эха — хода самого CLI, начатого раньше сообщения
   * панели. Ход панели они не держат: их итог CLI пришлёт своим запросом
   * после, и он будет самостоятельным (рецензия Codex 28.09).
   */
  readonly #foreignSubagents = new Set<string>();
  /**
   * Ход, начатый самим Claude без сообщения панели: кончилась фоновая
   * команда, и CLI сам запускает запрос модели (init без send). Пока он идёт,
   * адаптер занят — сообщения панели ждут в очереди координатора.
   */
  #autonomous = false;
  /** Что сообщил CLI о последней кончившейся фоновой задаче не-субагенте. */
  #lastBackground: string | undefined;
  /**
   * Эхо сообщений (--replay-user-messages). CLI повторяет сообщение, когда
   * начинает его запрос, — после init (живая проба 28.09: сообщение, посланное
   * во время чужого запроса, повторено только в своём). Запрос, кончившийся
   * без эха, пока сообщение панели ждёт, начат самим CLI: сообщение ушло,
   * когда его init был ещё в пути (рецензия Codex 28.09). Пока эха в этом
   * процессе не было (старый CLI), различения нет — прежнее поведение.
   */
  #echoWorks = false;
  #awaitingEcho = 0;
  #requestWithoutEcho = false;
  /** Запрос без эха уже отвечал: свой запрос повторяет сообщение раньше ответа модели. */
  #answeredWithoutEcho = false;
  /** В процессе уже был result: стартовый init без сообщения — не ход. */
  #processAnswered = false;
  #openRequests = 0;
  #awaitingContinuation = false;
  #turnHeld = false;
  #deferredDenials: string[] = [];
  #continueDeadline: NodeJS.Timeout | undefined;
  /** Расход хода — сумма по всем его result; лимит — последнее сведение CLI. */
  #turnUsage: TurnUsage = NO_USAGE;
  #limit: LimitInfo | undefined;
  /** Время последней записи процесса и срок тишины удерживаемого хода. */
  #lastRecordAt = 0;
  #silenceDeadline: NodeJS.Timeout | undefined;
  readonly #stopping = new WeakSet<object>();
  readonly #reported = new WeakSet<object>();
  /** Выбор человека и выбор, с которым запущен текущий процесс. */
  #choice: ModelChoice;
  #processChoice: ModelChoice | undefined;
  /** Режим разрешений человека и режим, с которым запущен текущий процесс. */
  #mode: string;
  #processMode: string | undefined;

  constructor(
    private readonly options: ClaudeOptions,
    private readonly sink: EventSink,
  ) {
    this.#session = options.resumeSessionId;
    this.#choice = { model: options.model ?? "", effort: options.effort ?? "" };
    this.#mode = options.permissionMode || "default";
  }

  get busy(): boolean {
    return this.#busy;
  }

  get sessionId(): string | undefined {
    return this.#session;
  }

  async start(): Promise<void> {
    if (this.#proc) throw new Error("адаптер Claude уже запущен");
    const settingSources = this.options.settingSources ?? "project,local";
    const args = [
      ...(this.options.commandArgs ?? []),
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      // Эхо сообщения внутри его запроса (isReplay): по нему отличается
      // запрос, начатый самим CLI, от ответа на только что посланное.
      "--replay-user-messages",
      "--permission-prompt-tool",
      "stdio",
      ...(settingSources ? ["--setting-sources", settingSources] : []),
      ...(this.#choice.model ? ["--model", this.#choice.model] : []),
      ...(this.#choice.effort ? ["--effort", this.#choice.effort] : []),
      ...(this.#mode !== "default" ? ["--permission-mode", this.#mode] : []),
      // Перезапуск после падения или прерывания продолжает ту же сессию.
      ...(this.#session ? ["--resume", this.#session] : []),
      ...(this.options.extraArgs ?? []),
    ];
    const proc = spawnProcess(this.options.command, args, this.options.cwd, this.options.shell);
    this.#proc = proc;
    this.#echoWorks = false;
    this.#awaitingEcho = 0;
    this.#processAnswered = false;
    this.#processChoice = this.#choice;
    this.#processMode = this.#mode;

    this.#lines = readJsonLines(proc.stdout, (line) => this.#parse(line));
    createInterface({ input: proc.stderr }).on("line", (line) => {
      const text = stripAnsi(line).trim();
      if (text) this.#emit("diagnostic", "stream", { text: clamp(text) });
    });
    proc.stdin.on("error", (err) => this.#channelFailure(proc, err));
    proc.on("error", (err) => this.#end(proc, `Claude не запустился: ${err.message}`));
    proc.on("exit", (code, signal) =>
      this.#end(
        proc,
        `процесс Claude завершился неожиданно (код ${code}, сигнал ${signal}). Подробности — в диагностике.`,
      ),
    );
  }

  #end(proc: ChildProcessWithoutNullStreams, errorText: string): void {
    if (this.#proc === proc) {
      this.#proc = undefined;
      this.#busy = false;
      // Уведомлений умершего процесса уже не будет: его субагенты и срок
      // ожидания не должны держать или закрывать следующий ход.
      this.#resetBackground();
    }
    this.#closeRequests(proc, "запрос закрыт: процесс Claude завершился");
    if (this.#reported.has(proc)) return;
    this.#reported.add(proc);
    if (this.#stopping.has(proc)) {
      this.#emit("diagnostic", "stream", { text: "процесс Claude остановлен" });
    } else {
      this.#emit("error", "turn", { text: errorText, failed: true });
    }
  }

  /** Канал сломан при живом процессе: ответа не будет — это конец процесса. */
  #channelFailure(proc: ChildProcessWithoutNullStreams, err: Error): void {
    this.#end(proc, `канал связи с Claude сломан: ${err.message}`);
    void killTree(proc);
  }

  async send(prompt: AgentPrompt): Promise<void> {
    // Модель и уровень задаются флагами запуска: сменились — процесс
    // перезапускается между ходами, --resume сохраняет контекст сессии.
    const changed =
      this.#processChoice !== undefined &&
      (!sameChoice(this.#processChoice, this.#choice) || this.#processMode !== this.#mode);
    if (this.#proc && !this.#busy && changed) {
      this.#emit("diagnostic", "stream", {
        text: "модель, уровень или режим разрешений сменились — перезапуск с той же сессией",
      });
      await this.stop();
    }
    if (!this.#proc) await this.start();
    const proc = this.#proc;
    if (!proc) throw new Error("адаптер Claude не запущен");
    const record = {
      type: "user",
      message: { role: "user", content: [{ type: "text", text: formatForClaude(prompt) }] },
    };
    this.#busy = true;
    this.#openRequests = 0;
    this.#awaitingEcho += 1;
    this.#write(proc, record);
  }

  /**
   * Режим разрешений со следующего хода — флагом запуска. «Без вопросов»
   * действует и сразу: открытые и новые запросы текущего процесса разрешает
   * панель. Проба на Claude Code 2.1.220 показала, что setMode
   * bypassPermissions в ответе на запрос повторных запросов не отключает.
   * Вопросы человеку (AskUserQuestion) режим не закрывает: на них отвечает
   * человек, а «разрешить» без ответов Claude читает как «не ответил».
   */
  setPermissionMode(mode: string): void {
    this.#mode = mode || "default";
    if (this.#mode !== "bypassPermissions") return;
    for (const [id, request] of [...this.#requests]) {
      if (!request.interactive) void this.#decide(id, "allow", NO_QUESTIONS_NOTE);
    }
  }

  setModel(choice: ModelChoice): void {
    this.#choice = { model: choice.model, effort: choice.effort };
  }

  /**
   * Список моделей — из ответа на initialize отдельного короткого процесса:
   * рабочая сессия от этого не поднимается, модель не вызывается.
   */
  async listModels(): Promise<readonly ModelOption[]> {
    const settingSources = this.options.settingSources ?? "project,local";
    const proc = spawnProcess(
      this.options.command,
      [
        ...(this.options.commandArgs ?? []),
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        ...(settingSources ? ["--setting-sources", settingSources] : []),
      ],
      this.options.cwd,
      this.options.shell,
    );
    proc.stderr.resume();
    proc.stdin.on("error", () => undefined);
    let lines: LineReader | undefined;
    let timer: NodeJS.Timeout | undefined;
    try {
      const reply = await new Promise<Record<string, unknown>>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Claude не прислал список моделей за 30 с")), 30_000);
        proc.on("error", reject);
        proc.on("exit", (code) => reject(new Error(`Claude завершился, не прислав список моделей (код ${code})`)));
        lines = readJsonLines(proc.stdout, (line) => {
          let record: Record<string, unknown>;
          try {
            record = JSON.parse(line) as Record<string, unknown>;
          } catch {
            return;
          }
          const response = record["response"] as Record<string, unknown> | undefined;
          if (record["type"] !== "control_response" || response?.["request_id"] !== "models") return;
          if (response["subtype"] === "success") resolve((response["response"] ?? {}) as Record<string, unknown>);
          else reject(new Error(`Claude не отдал список моделей: ${String(response["error"] ?? "без причины")}`));
        });
        proc.stdin.write(
          `${JSON.stringify({ type: "control_request", request_id: "models", request: { subtype: "initialize" } })}\n`,
        );
      });
      return claudeCatalog(reply["models"]);
    } finally {
      clearTimeout(timer);
      lines?.close();
      await killTree(proc);
    }
  }

  async answerApproval(id: string, choice: ApprovalChoice): Promise<boolean> {
    // У вопроса «разрешить» без ответов — то самое «The user did not answer
    // the questions» (журнал 04–05.10): принимается только отказ.
    if (this.#requests.get(id)?.questions && choice !== "deny") return false;
    return this.#decide(id, choice);
  }

  /**
   * Ответ человека на AskUserQuestion: allow с исходными вопросами и answers
   * «текст вопроса → метка / метки через «, » / свой текст» (документация
   * Agent SDK, user-input, 05.10.2026). Ключи — исходный текст вопроса, даже
   * если человеку он показан обрезанным.
   */
  async answerQuestion(id: string, answers: Readonly<Record<string, string>>): Promise<boolean> {
    const request = this.#requests.get(id);
    if (!request?.questions) return false;
    const chosen: Record<string, string> = {};
    const lines: string[] = [];
    for (const { shown, key } of request.questions) {
      const value = Object.hasOwn(answers, key) ? answers[key] : Object.hasOwn(answers, shown.question) ? answers[shown.question] : undefined;
      if (typeof value !== "string") continue;
      chosen[key] = value;
      lines.push(`${shown.question} — ${value}`);
    }
    return this.#decide(id, "allow", clamp(`ответ человека: ${lines.join("; ") || "без ответов"}`), chosen);
  }

  async #decide(
    id: string,
    choice: ApprovalChoice,
    caption?: string,
    answers?: Readonly<Record<string, string>>,
  ): Promise<boolean> {
    const request = this.#requests.get(id);
    if (!request || request.proc !== this.#proc) return false;
    this.#requests.delete(id);

    const forSession = choice === "allowSession" && request.rules.length > 0;
    const question = request.questions !== undefined;
    const decision =
      choice === "deny"
        ? {
            behavior: "deny",
            message: question ? "Человек не стал отвечать на вопрос в панели." : "Отклонено человеком в панели.",
          }
        : {
            behavior: "allow",
            updatedInput: answers ? { ...(request.input as Record<string, unknown>), answers } : request.input,
            ...(forSession ? { updatedPermissions: request.rules } : {}),
          };
    if (choice === "deny" && request.call) this.#deniedByHuman.add(request.call);

    this.#write(request.proc, {
      type: "control_response",
      response: { subtype: "success", request_id: id, response: decision },
    });
    this.#emit("approval_decided", "turn", {
      callId: id,
      ...(request.call ? { toolCallId: request.call } : {}),
      text:
        caption ??
        (choice === "deny"
          ? question
            ? "человек не стал отвечать"
            : "отклонено человеком"
          : forSession
            ? `разрешено в этой сессии: ${ruleLabels(request.rules).join(", ")}`
            : "разрешено"),
      raw: decision,
    });
    return true;
  }

  /**
   * У CLI в режиме print нет команды прерывания хода, поэтому это остановка
   * процесса. Следующая отправка поднимет его заново с --resume той же сессии.
   */
  async interrupt(): Promise<void> {
    await this.stop();
  }

  async forgetSession(): Promise<void> {
    // Сначала забыть, потом останавливать: отправка, пришедшая во время
    // остановки, запустит процесс уже без --resume (рецензия Codex 28.09).
    this.#session = undefined;
    await this.stop();
  }

  async stop(): Promise<void> {
    this.#lines?.close();
    this.#lines = undefined;
    const proc = this.#proc;
    this.#proc = undefined;
    this.#busy = false;
    this.#resetBackground();
    if (!proc) return;
    this.#stopping.add(proc);
    // Карточки закрываются сразу: после остановки ответ уже некому отдать,
    // а открытая карточка звала бы человека нажимать бесполезную кнопку.
    this.#closeRequests(proc, "запрос закрыт: процесс Claude остановлен");
    await killTree(proc);
  }

  #closeRequests(proc: ChildProcessWithoutNullStreams, reason: string): void {
    for (const [id, request] of this.#requests) {
      if (request.proc !== proc) continue;
      this.#requests.delete(id);
      this.#emit("approval_decided", "turn", {
        callId: id,
        ...(request.call ? { toolCallId: request.call } : {}),
        text: reason,
      });
    }
  }

  #write(proc: ChildProcessWithoutNullStreams, record: unknown): void {
    proc.stdin.write(`${JSON.stringify(record)}\n`, (err) => {
      if (err) this.#channelFailure(proc, err);
    });
  }

  #parse(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    this.#lastRecordAt = Date.now();
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      this.#emit("diagnostic", "stream", { text: clamp(`строка вне протокола: ${stripAnsi(trimmed)}`) });
      return;
    }

    if (typeof record["session_id"] === "string" && record["session_id"] !== this.#session) {
      // Идентификатор приходит асинхронно, уже после start().
      this.#session = record["session_id"];
      this.options.onSessionId?.(this.#session);
    }

    const kind = record["type"];
    if (kind === "system" && record["subtype"] === "init") {
      // Начало запроса модели: первого на сообщение или итогового после субагентов.
      // Без сообщения панели и вне удерживаемого хода — Claude начал ход сам.
      if (!this.#busy) {
        if (this.#processAnswered) this.#startAutonomous();
      } else if (!this.#turnHeld && this.#echoWorks && this.#awaitingEcho > 0) {
        this.#requestWithoutEcho = true;
        this.#answeredWithoutEcho = false;
      }
      this.#openRequests += 1;
      this.#awaitingContinuation = false;
      this.#cancelDeadline();
      this.#emit("diagnostic", "stream", {
        text: `сессия ${String(record["session_id"]).slice(0, 8)}, модель ${String(record["model"])}`,
        raw: record,
      });
    } else if (kind === "system") {
      this.#task(record);
    } else if (kind === "rate_limit_event") {
      const o = (record["rate_limit_info"] ?? {}) as Record<string, unknown>;
      this.#limit = {
        ...(typeof o["status"] === "string" ? { status: o["status"] } : {}),
        ...(typeof o["rateLimitType"] === "string" ? { window: o["rateLimitType"] } : {}),
        ...(typeof o["resetsAt"] === "number" ? { resetsAt: o["resetsAt"] * 1000 } : {}),
      };
    } else if (kind === "stream_event") {
      // Эхо своего запроса приходит раньше первого stream_event (замер 28.09).
      if (this.#requestWithoutEcho) this.#answeredWithoutEcho = true;
      this.#delta(record);
    } else if (kind === "assistant") {
      if (this.#requestWithoutEcho) this.#answeredWithoutEcho = true;
      this.#assistantBlocks(record);
    } else if (kind === "user" && record["isReplay"] === true) {
      this.#echoWorks = true;
      this.#awaitingEcho = Math.max(0, this.#awaitingEcho - 1);
      this.#requestWithoutEcho = false;
    } else if (kind === "user") {
      this.#userBlocks(record);
    } else if (kind === "control_request") {
      this.#agentRequest(record);
    } else if (kind === "result" && this.#requestWithoutEcho && (record["is_error"] !== true || this.#answeredWithoutEcho)) {
      this.#processAnswered = true;
      this.#foreignRequestDone(record);
    } else if (kind === "result") {
      this.#processAnswered = true;
      if (this.#requestWithoutEcho) {
        // Ошибка раньше эха — свой запрос: принять его за чужой значило бы
        // ждать следующего вечно (рецензия Codex 28.09).
        this.#requestWithoutEcho = false;
        this.#awaitingEcho = Math.max(0, this.#awaitingEcho - 1);
      }
      this.#openRequests = Math.max(0, this.#openRequests - 1);
      this.#turnUsage = addUsage(this.#turnUsage, toTurnUsage(record["usage"]));
      const error = record["is_error"] === true;
      this.#deferredDenials.push(...parseDenials(record["permission_denials"], this.#deniedByHuman));
      if (!error && (this.#subagents.size > 0 || this.#openRequests > 0 || this.#awaitingContinuation)) {
        if (!this.#turnHeld) {
          this.#turnHeld = true;
          this.#watchSilence();
          this.#emit("diagnostic", "stream", {
            text:
              `ход продолжается: Claude ждёт субагентов (${this.#subagents.size}) — ` +
              "итог и проверка будут после их работы",
          });
        }
        this.#scheduleDeadline();
        return;
      }
      this.#finishTurn(
        error
          ? `ход завершён с ошибкой: ${String(record["stop_reason"] ?? record["subtype"] ?? "причина не указана")}`
          : `ход завершён, реплик ${String(record["num_turns"])}`,
        error,
        record,
      );
    }
  }

  /** Фоновые задачи: следим только за субагентами (task_type local_agent). */
  #task(record: Record<string, unknown>): void {
    const kind = record["subtype"];
    const id = typeof record["task_id"] === "string" ? record["task_id"] : undefined;
    const finish = (task: string | undefined) => {
      if (task && this.#foreignSubagents.delete(task)) return;
      if (task && this.#subagents.delete(task)) {
        // Субагент кончил — Claude сам начнёт итоговый запрос.
        this.#awaitingContinuation = true;
        this.#scheduleDeadline();
      }
    };
    if (kind === "task_started") {
      if (id && record["task_type"] === "local_agent") {
        (this.#requestWithoutEcho ? this.#foreignSubagents : this.#subagents).add(id);
      }
    } else if (kind === "task_notification") {
      if (id && !this.#subagents.has(id)) {
        const gist = record["summary"] ?? record["description"];
        this.#lastBackground = typeof gist === "string" && gist ? gist : undefined;
      }
      finish(id);
    } else if (kind === "task_updated") {
      const status = (record["patch"] as Record<string, unknown> | undefined)?.["status"];
      if (typeof status === "string" && ["completed", "failed", "killed", "stopped", "cancelled"].includes(status)) {
        finish(id);
      }
    } else if (kind === "background_tasks_changed" && Array.isArray(record["tasks"])) {
      const tasks = (record["tasks"] as Record<string, unknown>[]).filter((z) => typeof z?.["task_id"] === "string");
      // Снимается только то, чего в снимке нет: известный id без task_type —
      // всё ещё идущий субагент (рецензия Codex 28.09).
      const inSnapshot = new Set(tasks.map((z) => z["task_id"] as string));
      for (const task of [...this.#subagents, ...this.#foreignSubagents]) if (!inSnapshot.has(task)) finish(task);
      for (const z of tasks) {
        const task = z["task_id"] as string;
        if (z["task_type"] === "local_agent" && !this.#foreignSubagents.has(task)) this.#subagents.add(task);
      }
    }
  }

  /**
   * Срок ожидания продолжения — только когда ход держится, субагентов уже нет,
   * запрос модели не открыт и разрешений никто не ждёт: иначе срок закрыл бы
   * живой ответ (рецензия Codex 28.09).
   */
  #scheduleDeadline(): void {
    if (!this.#turnHeld || this.#subagents.size > 0 || this.#continueDeadline) return;
    if (this.#openRequests > 0 || this.#requests.size > 0) return;
    this.#continueDeadline = setTimeout(() => {
      this.#continueDeadline = undefined;
      if (this.#turnHeld) {
        this.#finishTurn("ход завершён: субагенты закончили, продолжения от Claude не было", false);
      }
    }, this.options.backgroundGraceMs ?? 15_000);
  }

  /** Срок продолжения. Срок тишины — отдельно: итоговый init его не снимает (рецензия Codex 28.09). */
  #cancelDeadline(): void {
    if (this.#continueDeadline) clearTimeout(this.#continueDeadline);
    this.#continueDeadline = undefined;
  }

  #cancelSilence(): void {
    if (this.#silenceDeadline) clearTimeout(this.#silenceDeadline);
    this.#silenceDeadline = undefined;
  }

  /** Держится ход, а процесс молчит дольше backgroundIdleMs — ход закрывается. */
  #watchSilence(): void {
    const limit = this.options.backgroundIdleMs ?? 600_000;
    const checkNow = () => {
      this.#silenceDeadline = undefined;
      if (!this.#turnHeld) return;
      const elapsed = Date.now() - this.#lastRecordAt;
      // Открытый запрос модели кончится своим result — тишина его не закрывает.
      if (elapsed >= limit && this.#openRequests === 0) {
        this.#subagents.clear();
        const result = this.#turnResult(
          `ход завершён: субагенты не сообщили о завершении за ${Math.round(limit / 1000)} с тишины`,
          false,
        );
        // Сначала процесс со всем деревом, потом конец хода: иначе очередь ушла
        // бы в умирающий процесс, а рецензия — к ещё живому субагенту, и его
        // поздние init/result закончили бы следующий ход (рецензии Codex 28.09).
        // Сессия сохранена — следующее сообщение её продолжит.
        void this.stop().then(() => this.#emit("turn_completed", "turn", result));
      } else if (elapsed >= limit) {
        this.#silenceDeadline = setTimeout(checkNow, limit);
      } else {
        this.#silenceDeadline = setTimeout(checkNow, limit - elapsed);
      }
    };
    if (this.#silenceDeadline) clearTimeout(this.#silenceDeadline);
    this.#silenceDeadline = setTimeout(checkNow, limit);
  }

  /** Всё состояние фона — при остановке и смерти процесса. */
  #resetBackground(): void {
    this.#subagents.clear();
    this.#foreignSubagents.clear();
    // Уведомление и эхо умершего процесса к новому не относятся (рецензия Codex 28.09).
    this.#lastBackground = undefined;
    this.#awaitingEcho = 0;
    this.#requestWithoutEcho = false;
    // Расход умершего процесса к следующему ходу не относится (рецензия Codex 28.09).
    this.#turnUsage = NO_USAGE;
    this.#resetTurn();
  }

  /**
   * Состояние хода. Идущие субагенты не сбрасываются: если ход кончился
   * ошибкой при работающем субагенте, его поздний итог должен держать
   * следующий ход, а не закончить его своим result (рецензия Codex 28.09).
   */
  #resetTurn(): void {
    this.#autonomous = false;
    this.#cancelDeadline();
    this.#cancelSilence();
    this.#openRequests = 0;
    this.#awaitingContinuation = false;
    this.#turnHeld = false;
    this.#deferredDenials = [];
  }

  #startAutonomous(): void {
    this.#autonomous = true;
    this.#busy = true;
    this.#emit("turn_started", "turn", { unsolicited: true, text: this.#autonomousReason() });
  }

  #autonomousReason(): string {
    const reason = this.#lastBackground;
    this.#lastBackground = undefined;
    return reason ? `фоновая задача закончилась: ${reason}` : "Claude начал ход без сообщения панели";
  }

  /**
   * Запрос без эха кончился, пока сообщение панели ждёт: это ход самого CLI,
   * начатый раньше, чем CLI принял сообщение. Он выдаётся самостоятельным
   * целиком; ход панели продолжается — его запрос придёт следом.
   */
  #foreignRequestDone(record: Record<string, unknown>): void {
    this.#requestWithoutEcho = false;
    this.#answeredWithoutEcho = false;
    this.#openRequests = Math.max(0, this.#openRequests - 1);
    const usage = toTurnUsage(record["usage"]);
    const denials = parseDenials(record["permission_denials"], this.#deniedByHuman);
    this.#emit("turn_started", "turn", { unsolicited: true, text: this.#autonomousReason() });
    this.#emit("turn_completed", "turn", {
      unsolicited: true,
      ...(denials.length > 0 ? { denials: denials } : {}),
      ...(usage.input + usage.output > 0 ? { usage: usage } : {}),
      ...(this.#limit ? { limit: this.#limit } : {}),
      text: "ход, начатый самим Claude, завершён",
      raw: record,
      ...(record["is_error"] === true ? { failed: true } : {}),
    });
  }

  #finishTurn(text: string, error: boolean, record?: Record<string, unknown>): void {
    const result = this.#turnResult(text, error, record);
    this.#busy = false;
    this.#turnInProgress = undefined;
    this.#emit("turn_completed", "turn", result);
  }

  /** Поля конца хода; состояние хода сбрасывается. */
  #turnResult(text: string, error: boolean, record?: Record<string, unknown>): Partial<PanelEvent> {
    const isAutonomous = this.#autonomous;
    const denials = this.#deferredDenials;
    const usage = this.#turnUsage;
    this.#turnUsage = NO_USAGE;
    this.#resetTurn();
    return {
      ...(isAutonomous ? { unsolicited: true } : {}),
      ...(denials.length > 0 ? { denials: denials } : {}),
      ...(usage.input + usage.output > 0 ? { usage: usage } : {}),
      ...(this.#limit ? { limit: this.#limit } : {}),
      text: text,
      ...(record ? { raw: record } : {}),
      ...(error ? { failed: true } : {}),
    };
  }

  /** Запрос агента к панели. Необслуживаемый получает ошибку: без ответа агент ждал бы вечно. */
  #agentRequest(record: Record<string, unknown>): void {
    const proc = this.#proc;
    if (!proc) return;
    const id = String(record["request_id"] ?? "");
    const request = (record["request"] ?? {}) as Record<string, unknown>;

    if (request["subtype"] !== "can_use_tool") {
      this.#emit("diagnostic", "stream", {
        text: `запрос Claude «${String(request["subtype"])}» панелью не обслуживается — отвечено ошибкой`,
        raw: record,
      });
      this.#write(proc, {
        type: "control_response",
        response: {
          subtype: "error",
          request_id: id,
          error: `панель не обслуживает запрос ${String(request["subtype"])}`,
        },
      });
      return;
    }

    const rules = sessionRules(request["permission_suggestions"]);
    const input = request["input"] ?? {};
    // Вопрос человеку: ответ — answers, а не «разрешить». Прочие запросы,
    // требующие человека, — обычная карточка, но без разрешения режимом.
    const questions = request["tool_name"] === "AskUserQuestion" ? parseQuestions(input) : undefined;
    const interactive = questions !== undefined || request["requires_user_interaction"] === true;
    this.#requests.set(id, {
      proc,
      input,
      call: typeof request["tool_use_id"] === "string" ? request["tool_use_id"] : undefined,
      rules,
      interactive,
      ...(questions ? { questions } : {}),
    });

    const lines = [questions ? questionLines(questions) : inputGist(input)];
    if (typeof request["description"] === "string" && request["description"] !== lines[0]) {
      lines.push(request["description"]);
    }
    if (typeof request["blocked_path"] === "string") lines.push(`путь: ${request["blocked_path"]}`);

    this.#emit("approval_requested", "turn", {
      tool: questions ? "AskUserQuestion" : String(request["display_name"] ?? request["tool_name"] ?? "?"),
      callId: id,
      ...(typeof request["tool_use_id"] === "string" ? { toolCallId: request["tool_use_id"] } : {}),
      text: clamp(lines.join("\n")),
      sessionRules: ruleLabels(rules),
      ...(questions ? { questions: questions.map((q) => q.shown) } : {}),
      raw: record,
    });
    // «Без вопросов» разрешает панель: режим сменён, а процесс ещё старый, или
    // CLI спрашивает и в этом режиме. Запрос, требующий человека, — нет: CLI
    // присылает AskUserQuestion и в bypassPermissions (журнал 04–05.10,
    // CLI 2.1.220 и 2.1.287), и ответ панели за человека лишал его вопроса.
    if (this.#mode === "bypassPermissions" && !interactive) void this.#decide(id, "allow", NO_QUESTIONS_NOTE);
  }

  #delta(record: Record<string, unknown>): void {
    // Поток субагента в живой пузырь Claude не идёт: его текст придёт целиком
    // записью assistant с parent_tool_use_id.
    if (parentFrom(record).parentCallId) return;
    const event = record["event"] as Record<string, unknown> | undefined;
    if (!event) return;
    if (event["type"] === "message_start") {
      this.#turnInProgress = newEventId();
      return;
    }
    if (event["type"] !== "content_block_delta") return;
    const delta = event["delta"] as Record<string, unknown> | undefined;
    if (delta?.["type"] === "text_delta" && typeof delta["text"] === "string") {
      this.#emit("text_delta", "stream", { text: delta["text"] });
    }
  }

  #assistantBlocks(record: Record<string, unknown>): void {
    const parent = parentFrom(record);
    for (const block of this.#blocks(record)) {
      if (block["type"] === "text" && typeof block["text"] === "string") {
        this.#emit("message", "turn", { text: clamp(block["text"]), ...parent });
      } else if (block["type"] === "tool_use") {
        const id = String(block["id"] ?? "");
        const name = String(block["name"] ?? "?");
        this.#calls.set(id, name);
        this.#emit("tool_call", "turn", {
          ...parent,
          tool: name,
          callId: id,
          text: clamp(JSON.stringify(block["input"] ?? {}, null, 1)),
          raw: block,
        });
        this.#emit("tool_running", "stream", { tool: name, callId: id });
      }
    }
  }

  #userBlocks(record: Record<string, unknown>): void {
    const parent = parentFrom(record);
    for (const block of this.#blocks(record)) {
      if (block["type"] !== "tool_result") continue;
      const id = String(block["tool_use_id"] ?? "");
      // Сырой вывод, а не пересказ: рецензент без права запуска зависит от него.
      const text = toolResultText(block["content"]);
      this.#emit("tool_result", "turn", {
        tool: this.#calls.get(id) ?? "?",
        callId: id,
        ...parent,
        ...clampKeepingFull(text),
        raw: block,
      });
      this.#calls.delete(id);
    }
  }

  #blocks(record: Record<string, unknown>): Record<string, unknown>[] {
    const content = (record["message"] as Record<string, unknown> | undefined)?.["content"];
    return Array.isArray(content) ? (content as Record<string, unknown>[]) : [];
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
      ...(this.#turnInProgress ? { turnId: this.#turnInProgress } : {}),
      ...rest,
    } as PanelEvent);
  }
}
