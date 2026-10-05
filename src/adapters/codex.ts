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
 * **Папка проверок** (ступень 2, переключатель комнаты): запись — только в
 * папку рецензента вне репозитория, профилем прав в config ветки (без поля
 * sandbox). Решения пробы 05.10 (docs/research/2026-10-05-проба-песочницы-codex.md):
 * под unelevated команды под профилем идут, только если рабочая папка ветки —
 * сама папка, поэтому проект Codex читает по абсолютным путям; профиль не
 * сохраняется при продолжении — config передаётся при каждом thread/resume;
 * принятие профиля видно только по ответу thread/start|resume. Перед веткой —
 * самопроверка command/exec (запись в папку проходит, в проект — нет). Любой
 * провал — ветка «только чтение» (ступень 1) и строка в ленте, ход не провален.
 * Процесс app-server с папкой проверок запускается в ней: его рабочая папка
 * для command/exec — тоже корень записи (живой цикл 05.10, вечер).
 *
 * **Команды чтения рецензенту разрешены** (ступень 1, 05.10): rg, git,
 * python -c над кодом — он проверяет утверждения сам, а не по пересказу.
 * Read-only запрещает запись, но не чтение и не сеть: запрет путей из
 * `forbidden` (данные и секреты проекта), сети, долгих и фоновых процессов —
 * правило роли, а не гарантия песочницы. Команду с запрещённым путём в
 * ходе проверки панель прерывает по её началу (стоп-сигнал, coordinator.ts);
 * чтение через импорт кода проекта стоп-сигнал не видит.
 *
 * # Субагенты
 *
 * Codex может запустить субагентов в своих ветках (живой цикл 05.10, вечер:
 * GPT-6.1-Sol xhigh — двух). Их turn/*, item/* и расход идут по тому же
 * соединению с их threadId. Ход Codex ведёт только своя ветка: конец хода
 * субагента — не отзыв Codex, его реплика — не реплика Codex; его команды —
 * инструменты хода (#childNotification). Прерывание хода (человек,
 * стоп-сигнал) прерывает и идущие ходы субагентов — каждый своим
 * turn/interrupt; не принят или номера хода нет — процесс снимается.
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
import { existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { rootAnchored, withoutRoot } from "../forbiddenPaths.js";
import { ensureReviewFolder, oversizeNote } from "../reviewFolder.js";
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
  HONESTY_LINE,
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
   * в роль рецензента. Нет или пусто — роль без запрета путей. Меняется
   * настройкой при открытой комнате: {@link CodexAdapter.setForbidden}.
   */
  readonly forbidden?: readonly string[];
  /** Модель хода; "" или нет — по умолчанию. */
  readonly model?: string;
  /** Уровень рассуждения хода; "" или нет — по умолчанию. */
  readonly effort?: string;
  readonly shell?: boolean;
  readonly onSessionId?: (id: string) => void;
  /**
   * Папка проверок рецензента (ступень 2). Нет — ветка «только чтение»
   * (ступень 1). Меняется переключателем комнаты: {@link CodexAdapter.setReview}.
   */
  readonly review?: CodexReview;
}

/** Папка, в которую рецензент пишет и где запускает свои скрипты. */
export interface CodexReview {
  readonly folder: string;
  /** Размер папки в байтах, после которого при запуске процесса — строка в ленте; по умолчанию 500 МБ. */
  readonly sizeLimit?: number;
}

/** Имя профиля прав рецензента в config ветки. */
export const REVIEW_PROFILE = "agent-panel-review";
/** Срок одной команды самопроверки: первая команда под песочницей ставит права на папку. */
const SELF_CHECK_MS = 30_000;
/** Запись в путь из argv: путь не попадает в код, кавычки и пробелы в нём не мешают. */
const WRITE_PROBE = ["python", "-c", "import sys; open(sys.argv[1], 'w').write('agent-panel')"];

interface ThreadResponse {
  readonly thread?: { readonly id?: string };
  /** Поля прав ветки (app-server 0.159, проба 05.10): по ним видно, принят ли профиль. */
  readonly cwd?: unknown;
  readonly sandbox?: {
    readonly type?: unknown;
    readonly writableRoots?: unknown;
    readonly networkAccess?: unknown;
    readonly excludeTmpdirEnvVar?: unknown;
  } | null;
  readonly activePermissionProfile?: { readonly id?: unknown } | null;
}

/** Ответ command/exec, когда команда выполнилась (отказ песочницы приходит ошибкой JSON-RPC). */
interface ExecReply {
  readonly exitCode?: unknown;
  readonly stdout?: unknown;
  readonly stderr?: unknown;
}

/** Почему ветка пошла «только чтение»: what — в ленту, detail — в диагностику. */
interface Trouble {
  readonly what: string;
  readonly detail: string;
  /** Ветка уже загружена с чужими правами: её место — в новом процессе. */
  readonly loaded?: boolean;
}

/**
 * Профиль прав ветки: читать всё, писать в папку, сеть выключена; TEMP, TMP
 * и MPLCONFIGDIR команд — в папке, без __pycache__ (спецификация 05.10).
 */
function profileConfig(folder: string): Record<string, unknown> {
  const tmp = join(folder, "tmp");
  return {
    default_permissions: REVIEW_PROFILE,
    permissions: {
      [REVIEW_PROFILE]: { filesystem: { ":root": "read", [folder]: "write" }, network: { enabled: false } },
    },
    shell_environment_policy: {
      set: { TEMP: tmp, TMP: tmp, PYTHONDONTWRITEBYTECODE: "1", MPLCONFIGDIR: join(tmp, "mpl") },
    },
  };
}

/**
 * Политика command/exec — строгая форма: без excludeTmpdirEnvVar корнем
 * записи становится %TEMP% пользователя и всё, что в нём лежит (проба 05.10).
 * Та же — у исполнителя скриптов Gemini (checkRunner.ts).
 */
export function execPolicy(folder: string): Record<string, unknown> {
  return { type: "workspaceWrite", writableRoots: [folder], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true };
}

const samePath = (a: unknown, b: string): boolean => typeof a === "string" && resolve(a).toLowerCase() === resolve(b).toLowerCase();

/**
 * Принят ли профиль — по ответу thread/start|resume (решение пробы (а)):
 * рабочая папка — папка проверок, workspaceWrite без сети и без %TEMP%, корни
 * записи — только папка, активный профиль — наш. Расхождение словами или
 * undefined.
 */
function profileMismatch(reply: ThreadResponse, folder: string): string | undefined {
  if (!samePath(reply.cwd, folder)) return `рабочая папка ${JSON.stringify(reply.cwd ?? null)}`;
  const sandbox = reply.sandbox ?? undefined;
  const roots = sandbox?.writableRoots;
  if (
    sandbox?.type !== "workspaceWrite" ||
    sandbox.networkAccess !== false ||
    sandbox.excludeTmpdirEnvVar !== true ||
    !Array.isArray(roots) ||
    roots.some((root) => !samePath(root, folder))
  ) {
    return `песочница ${JSON.stringify(reply.sandbox ?? null)}`;
  }
  if (reply.activePermissionProfile?.id !== REVIEW_PROFILE) {
    return `профиль ${JSON.stringify(reply.activePermissionProfile ?? null)}`;
  }
  return undefined;
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

function parseUsage(value: unknown): TurnUsage | undefined {
  const z = value as Record<string, unknown> | undefined;
  if (!z || typeof z["inputTokens"] !== "number") return undefined;
  return {
    input: z["inputTokens"] as number,
    cached: typeof z["cachedInputTokens"] === "number" ? (z["cachedInputTokens"] as number) : 0,
    output: typeof z["outputTokens"] === "number" ? (z["outputTokens"] as number) : 0,
  };
}

/**
 * Расход одной ветки за ход основной. app-server шлёт накопительный итог по
 * ветке (total) и итог последнего запроса модели (last). Ход считается от
 * основы «итог минус последний запрос» в первом уведомлении хода: так верно и
 * для первого хода возобновлённой ветки, и для хода из нескольких запросов;
 * сброс итога после сжатия контекста переносит набранное (рецензия Codex 28.09).
 */
class BranchUsage {
  #baseline: TurnUsage | undefined;
  #carry: TurnUsage = { input: 0, cached: 0, output: 0 };
  #previousTotal: TurnUsage | undefined;
  #usage: TurnUsage | undefined;

  get usage(): TurnUsage | undefined {
    return this.#usage;
  }

  account(info: unknown): void {
    const s = (info ?? {}) as Record<string, unknown>;
    const result = parseUsage(s["total"]);
    const lastIndex = parseUsage(s["last"]) ?? { input: 0, cached: 0, output: 0 };
    if (!result) {
      if (s["last"]) this.#usage = add(this.#usage ?? this.#carry, lastIndex);
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
    this.#usage = add(this.#carry, nonNegative(subtract(result, this.#baseline)));
  }
}

/** Сколько знаков реплики субагента идёт в строку диагностики; целиком она — в raw журнала. */
const CHILD_TEXT_CHARS = 2000;

/** Ветка субагента, которого запустил Codex. */
interface ChildThread {
  /**
   * Ход своей ветки, на который субагент работает (шедший при его
   * turn/started или первом уведомлении). Пока этот ход идёт, команды
   * субагента — часть хода; кончился или прерван — только лента и журнал.
   */
  owner: string | undefined;
  /**
   * Его turn/started уже был: следующий — «продолжил». Не «ветка уже
   * известна»: thread/status/changed ветки (схема 0.159) приходит и раньше
   * первого turn/started (рецензия цикла 05.10).
   */
  started: boolean;
  /** Ход субагента идёт: turn/started пришёл, turn/completed — ещё нет. */
  running: boolean;
  /** Номер идущего хода — для его turn/interrupt; turn/started без номера — undefined. */
  turn: string | undefined;
}

/** Короткое имя ветки: у веток одного хода первые 8 знаков UUIDv7 совпадают (это время). */
const shortThread = (id: string): string => id.slice(0, 13);

export class CodexAdapter implements Adapter {
  /**
   * Расход хода: своя ветка и ветки субагентов, работавших на этот ход
   * (живой цикл 05.10). Уведомления чужого хода своей ветки (повтор при
   * возобновлении) не учитываются (рецензия Codex 28.09).
   */
  #usage = new BranchUsage();
  readonly #childUsage = new Map<string, BranchUsage>();
  #limit: LimitInfo | undefined;

  #newUsageTurn(): void {
    this.#usage = new BranchUsage();
    this.#childUsage.clear();
  }

  #accountUsage(info: unknown, notifiedTurn: unknown): void {
    // Расход — только своего хода: с turnId — если он совпадает с известным
    // текущим; без turnId — если ход идёт (рецензия Codex 28.09).
    const turn = typeof notifiedTurn === "string" ? notifiedTurn : undefined;
    if (turn !== undefined ? turn !== this.#turn : !this.#busy) return;
    this.#usage.account(info);
  }

  /** Расход субагента — пока идёт ход основной ветки, на который он работает. */
  #accountChildUsage(child: string, info: unknown): void {
    if (!this.#working(child)) return;
    let counter = this.#childUsage.get(child);
    if (!counter) {
      counter = new BranchUsage();
      this.#childUsage.set(child, counter);
    }
    counter.account(info);
  }

  /** Расход хода: своей ветки и субагентов; ничего не пришло — undefined. */
  #turnUsage(): TurnUsage | undefined {
    let total = this.#usage.usage;
    for (const counter of this.#childUsage.values()) {
      const usage = counter.usage;
      if (usage) total = total ? add(total, usage) : usage;
    }
    return total;
  }

  readonly id = "codex" as const;

  #ctx: Context | undefined;
  #launch: Promise<void> | undefined;
  #thread: string | undefined;
  /** После «новой сессии» ветка из настроек комнаты не возобновляется. */
  #noResume = false;
  #turn: string | undefined;
  /**
   * Ветки субагентов, которых запустил Codex (живой цикл 05.10, вечер): номер
   * ветки → её состояние (ChildThread).
   */
  readonly #children = new Map<string, ChildThread>();
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
  /** Папка проверок, которую хочет комната; со следующего запуска процесса. */
  #review: CodexReview | undefined;
  /** С какой папкой (желанием комнаты) запущен нынешний процесс: сменилась — перезапуск между ходами. */
  #launchedFolder: string | undefined;
  /** Запрещённые пути, которые хочет комната; роль с ними — со следующего запуска процесса. */
  #forbidden: readonly string[];
  /** С какими запрещёнными путями запущен нынешний процесс: сменились — перезапуск между ходами. */
  #launchedForbidden: string | undefined;
  /**
   * Пока проверяется ответ на профиль, номер ветки из thread/started
   * придерживается: ветка с чужими правами не должна стать веткой комнаты.
   */
  #heldThread: { id: string | undefined } | undefined;

  constructor(
    private readonly options: CodexOptions,
    private readonly sink: EventSink,
  ) {
    this.#choice = { model: options.model ?? "", effort: options.effort ?? "" };
    this.#choiceChanged = Boolean(options.model || options.effort);
    this.#review = options.review;
    this.#forbidden = options.forbidden ?? [];
  }

  /**
   * Переключатель комнаты «Проверки рецензентов». Профиль прав задаётся при
   * thread/start|resume, поэтому действует со следующего хода: send()
   * перезапускает процесс между ходами, ветка продолжается.
   */
  setReview(review: CodexReview | undefined): void {
    this.#review = review;
  }

  /**
   * Настройка agentPanel.reviewerForbidden сменилась при открытой комнате.
   * Роль задаётся при thread/start|resume, поэтому, как и переключатель
   * проверок, — со следующего хода: send() перезапускает процесс между
   * ходами, ветка продолжается.
   */
  setForbidden(forbidden: readonly string[]): void {
    this.#forbidden = forbidden;
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
    const review = this.#review;
    this.#launchedFolder = review?.folder;
    this.#launchedForbidden = JSON.stringify(this.#forbidden);
    let trouble: Trouble | undefined;
    if (review) {
      // До запуска процесса: корень записи учитывается, только если существует.
      try {
        ensureReviewFolder(review.folder);
        this.#warnSize(review);
      } catch (err) {
        trouble = { what: "папка проверок не создана", detail: (err as Error).message };
      }
    }
    // С папкой проверок процесс запускается в ней. Рабочая папка процесса
    // app-server для command/exec — лишний корень записи, даже когда cwd и
    // writableRoots запроса называют только папку: процесс, запущенный в
    // проекте, писал в проект, а unelevated-песочница навсегда давала проекту
    // право записи (живой цикл и живая проверка 05.10, вечер). Ветка «только
    // чтение» и в этом процессе получает cwd проекта в thread/start. Папку не
    // создать — процесс в проекте: в несуществующей папке он не запустится.
    const processCwd = review && !trouble ? review.folder : this.options.cwd;
    let k = this.#spawn(processCwd);
    try {
      await this.#initialize(k);
      // Известная ветка продолжается, иначе создаётся новая. Известная — своя
      // ветка рецензента комнаты (codexOptions.ts); чат владельца с 05.10 не
      // продолжается. Роль задаётся в обоих случаях: между запусками могли
      // смениться роль и запрещённые пути, а ветка помнит прежние.
      // thread/resume принимает developerInstructions наравне с thread/start
      // (схема app-server 0.153.0).
      const known = this.#thread ?? (this.#noResume ? undefined : this.options.resumeThreadId);
      if (review && !trouble) {
        // Самопроверка — перед каждым запуском процесса: Codex обновляется
        // вместе с расширением, и профиль может перестать действовать.
        trouble = await this.#selfCheck(k, review.folder);
        if (!trouble) {
          trouble = await this.#openWithProfile(k, review.folder, known);
          if (!trouble) return;
        }
      }
      if (trouble) {
        this.#fallBack(trouble);
        if (trouble.loaded) {
          // Новый процесс становится текущим сразу: отправка, пришедшая за это
          // время, ждёт этого же запуска. Прежний снимается до того, как новый
          // откроет ветку, — два процесса с одной веткой не работают.
          const previous = k;
          k = this.#spawn(processCwd);
          await this.#retire(previous);
          await this.#initialize(k);
        }
      }
      const common = {
        cwd: this.options.cwd,
        sandbox: "read-only",
        approvalPolicy: "never",
        developerInstructions: this.#role(undefined),
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

  /**
   * Процесс app-server в папке cwd с разбором его вывода; становится текущим.
   * Команда ищется от проекта, как в listModels: папка проверок открыта
   * рецензенту на запись, и подложенный им codex.bat не должен запуститься
   * (рецензия цикла 05.10, process.ts).
   */
  #spawn(cwd: string): Context {
    const proc = spawnProcess(
      this.options.command,
      [...(this.options.commandArgs ?? []), "app-server"],
      cwd,
      this.options.shell,
      this.options.cwd,
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
    return k;
  }

  async #initialize(k: Context): Promise<void> {
    await this.#request(k, "initialize", {
      clientInfo: { name: "agent-panel", version: "0.1.0" },
      capabilities: {},
    });
    this.#notify(k, "initialized", {});
  }

  /** Роль ветки: с папкой проверок — с её правилами (ступень 2). */
  #role(checks: { folder: string; project: string } | undefined): string {
    return this.options.reviewerInstructions ?? reviewerRole(this.#forbidden, checks);
  }

  /** Папка больше предела — строка в ленте при запуске процесса: чистит её владелец. */
  #warnSize(review: CodexReview): void {
    const note = oversizeNote(review.folder, "Codex", review.sizeLimit);
    if (note) this.#emit("error", "turn", { text: note });
  }

  /**
   * Самопроверка песочницы без хода модели (спецификация 05.10, решение
   * пробы (в)): command/exec со строгой политикой пишет в папку — должно
   * пройти, затем в проект — песочница должна отказать, файла быть не должно.
   * Возвращает, что не так; всё в порядке — undefined. Процесс умер или
   * остановлен — исключение: это не провал песочницы.
   */
  async #selfCheck(k: Context, folder: string): Promise<Trouble | undefined> {
    const write = async (target: string): Promise<{ reply?: ExecReply; error?: string }> => {
      try {
        const params = { command: [...WRITE_PROBE, target], cwd: folder, sandboxPolicy: execPolicy(folder), timeoutMs: SELF_CHECK_MS };
        return { reply: ((await this.#request(k, "command/exec", params)) ?? {}) as ExecReply };
      } catch (err) {
        if (this.#ctx !== k || k.stopped) throw err;
        return { error: (err as Error).message };
      }
    };
    const outcome = (o: { reply?: ExecReply; error?: string }): string =>
      o.error ?? `код ${String(o.reply?.exitCode)}${o.reply?.stderr ? `, ${String(o.reply.stderr).trim()}` : ""}`;

    try {
      const inFolder = join(folder, "probe.txt");
      rmSync(inFolder, { force: true });
      const first = await write(inFolder);
      const written = existsSync(inFolder);
      rmSync(inFolder, { force: true });
      if (first.reply?.exitCode !== 0 || !written) {
        return { what: "запись в папку проверок не прошла", detail: `${outcome(first)}; файл ${written ? "есть" : "не создан"}` };
      }

      // Файл с этим именем — только наш: прежний остаток иначе сошёл бы за прорыв.
      const inProject = join(this.options.cwd, ".agent-panel-probe");
      rmSync(inProject, { force: true });
      const second = await write(inProject);
      if (existsSync(inProject)) {
        rmSync(inProject, { force: true });
        return { what: "запись в проект прошла", detail: `${outcome(second)}; файл создан и удалён` };
      }
      // Отказ песочницы — ошибка JSON-RPC «sandbox denied» (проба 05.10); обычный
      // ненулевой выход без файла — тоже отказ. Другая ошибка (нет command/exec,
      // превышено время) — запрет записи не доказан.
      if (second.error !== undefined && !/sandbox denied/i.test(second.error)) {
        return { what: "запись в проект не проверена", detail: second.error };
      }
      if (second.error === undefined && second.reply?.exitCode === 0) {
        return { what: "запись в проект прошла", detail: `${outcome(second)}; файла нет` };
      }
      return undefined;
    } catch (err) {
      if (this.#ctx !== k || k.stopped) throw err;
      return { what: "самопроверка не выполнилась", detail: (err as Error).message };
    }
  }

  /**
   * Ветка с профилем прав: рабочая папка — папка проверок (под unelevated
   * иначе Codex не запускает ни одной команды, проба 05.10), config — при
   * каждом start и resume (без него профиль не сохраняется), поля sandbox нет.
   * Принят ли профиль — по ответу. Всё в порядке — undefined.
   */
  async #openWithProfile(k: Context, folder: string, known: string | undefined): Promise<Trouble | undefined> {
    const params = {
      cwd: folder,
      approvalPolicy: "never",
      developerInstructions: this.#role({ folder, project: this.options.cwd }),
      config: profileConfig(folder),
    };
    this.#heldThread = { id: undefined };
    let reply: ThreadResponse;
    try {
      reply = ((await (known
        ? this.#request(k, "thread/resume", { ...params, threadId: known })
        : this.#request(k, "thread/start", params))) ?? {}) as ThreadResponse;
    } catch (err) {
      this.#heldThread = undefined;
      // Процесс умер или остановлен — это не отказ в профиле.
      if (this.#ctx !== k || k.stopped) throw err;
      return { what: "профиль прав не принят", detail: (err as Error).message };
    }
    const held = this.#heldThread;
    this.#heldThread = undefined;
    const mismatch = profileMismatch(reply, folder);
    if (mismatch) return { what: "ответ на профиль прав не тот", detail: mismatch, loaded: true };
    this.#setThread(reply.thread?.id ?? held.id ?? known);
    this.#emit("diagnostic", "stream", {
      text: `ветка ${String(this.#thread).slice(0, 8)}, профиль ${REVIEW_PROFILE}: запись только в ${folder}, сеть выключена профилем, одобрения never`,
    });
    return undefined;
  }

  /** Откат на «только чтение»: что не так — в ленту строкой без провала хода, подробности — в диагностику. */
  #fallBack(trouble: Trouble): void {
    this.#emit("diagnostic", "stream", {
      text: clamp(`песочница Codex не прошла проверку: ${trouble.what} — ${trouble.detail}`),
    });
    this.#emit("error", "turn", {
      text: `Песочница Codex не прошла проверку (${trouble.what}): проверка идёт в режиме «только чтение».`,
    });
  }

  /**
   * Прежний процесс запуска (ветка загружена с чужими правами) — снять, не
   * трогая занятость и запуск: текущий уже новый, и поздний exit прежнего
   * их не сбросит (#end сверяет процесс).
   */
  async #retire(k: Context): Promise<void> {
    k.stopped = true;
    for (const [, o] of k.waiters) o.reject(new Error("адаптер Codex остановлен"));
    k.waiters.clear();
    k.lines.close();
    await killTree(k.proc);
  }

  #end(k: Context, errorText: string): void {
    if (this.#ctx === k) {
      this.#ctx = undefined;
      this.#launch = undefined;
      this.#busy = false;
      this.#turn = undefined;
      // Как в stop(): номера ходов нового процесса могут совпасть (рецензия Codex 28.09).
      this.#interrupted.clear();
      this.#children.clear();
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
    // Переключатель проверок или запрещённые пути сменились: профиль прав и
    // роль задаются при thread/start|resume — процесс перезапускается между
    // ходами, ветка продолжается (как смена модели у Claude). Остановка — без
    // ожидания: её синхронная часть уже сняла процесс, а запуск ниже должен
    // остаться синхронным.
    if (this.#ctx && !this.#busy) {
      const switched = this.#launchedFolder !== this.#review?.folder;
      if (switched || this.#launchedForbidden !== JSON.stringify(this.#forbidden)) {
        this.#emit("diagnostic", "stream", {
          text: `${switched ? "проверки рецензента переключены" : "запрещённые пути сменились"} — перезапуск Codex с той же веткой`,
        });
        void this.stop().catch(() => undefined);
      }
    }
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
      // Идущие ходы субагентов прерываются каждый своим turn/interrupt:
      // снимает ли app-server субагентов вместе с ходом основной ветки, не
      // проверено, а стоп-сигнал на команде субагента должен остановить именно
      // его (рецензия цикла 05.10). Прерываются все идущие — и запущенные
      // прежним ходом: «Прервать» останавливает работу Codex целиком.
      const children = [...this.#children].filter(([, c]) => c.running);
      const unnumbered = children.find(([, c]) => c.turn === undefined);
      if (unnumbered) {
        // Номера хода нет — прервать адресно нечем; снимается процесс.
        this.#emit("diagnostic", "stream", {
          text: `номер хода субагента ${shortThread(unnumbered[0])} неизвестен — процесс Codex остановлен`,
        });
        await this.stop();
        return;
      }
      let refused: string | undefined;
      const childRefusals: string[] = [];
      await Promise.all([
        this.#request(k, "turn/interrupt", { threadId: this.#thread, turnId: turn }).catch((err: Error) => {
          refused = err.message;
        }),
        ...children.map(([child, c]) => {
          const childTurn = c.turn;
          return this.#request(k, "turn/interrupt", { threadId: child, turnId: childTurn }).catch((err: Error) => {
            // Ход субагента успел кончиться сам (его turn/completed пришёл
            // раньше отказа) — отказ ничего не значит.
            if (c.running && c.turn === childTurn) childRefusals.push(`субагента ${shortThread(child)} (${err.message})`);
          });
        }),
      ]);
      // Сервер прерывание не принял: ход может идти дальше, а его элементы
      // адаптер уже отбрасывает (#interrupted) — команды пропали бы из ленты и
      // журнала (итоговая рецензия 05.10); субагент читал бы дальше. Процесс
      // снимается, следующая отправка продолжит ветку. Процесс уже другой или
      // остановлен — не трогать.
      const what = refused !== undefined ? `хода (${refused})` : childRefusals[0];
      if (what !== undefined && this.#ctx === k && !k.stopped) {
        this.#emit("diagnostic", "stream", { text: `Codex не принял прерывание ${what} — процесс остановлен` });
        await this.stop();
        return;
      }
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
    this.#children.clear();
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

    const child = this.#childOf(p);
    if (child !== undefined) {
      this.#childNotification(child, method, p);
      return;
    }

    switch (method) {
      case "thread/started": {
        const thread = (p["thread"] ?? {}) as { id?: unknown; parentThreadId?: unknown };
        const id = typeof thread.id === "string" ? thread.id : undefined;
        // Ветка субагента — не ветка рецензента комнаты: её номер не
        // становится своим и не пишется в журнал (живой цикл 05.10).
        if (typeof thread.parentThreadId === "string" || (id !== undefined && this.#thread !== undefined && id !== this.#thread)) {
          return;
        }
        if (this.#heldThread) this.#heldThread.id = id;
        else this.#setThread(id);
        return;
      }
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
        const usage = this.#turnUsage();
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
   * Ветка уведомления — чужая: номер есть и не совпадает со своей. Своей ещё
   * нет — чужих не бывает: субагентов запускает ход своей ветки.
   */
  #childOf(p: Record<string, unknown>): string | undefined {
    const thread = p["threadId"];
    return typeof thread === "string" && this.#thread !== undefined && thread !== this.#thread ? thread : undefined;
  }

  /** Ход своей ветки, на который субагент работает, ещё идёт. */
  #working(child: string): boolean {
    const owner = this.#children.get(child)?.owner;
    return owner !== undefined && owner === this.#turn;
  }

  /**
   * Уведомление ветки субагента. Живой цикл 05.10, вечер: Codex запустил
   * двух субагентов, их уведомления шли по тому же соединению, и конец хода
   * первого («ВЕРДИКТ: ПРИНЯТО») панель приняла за отзыв Codex — пара
   * закрылась «принято», а ответ своей ветки с замечаниями пропал.
   *
   * Ход Codex ведёт только своя ветка. Начало и конец хода субагента — строки
   * диагностики, занятость и ход они не трогают. Команды и правки субагента —
   * инструменты хода (лента, журнал, свидетельство, стоп-сигнал), raw помечен
   * его веткой. Его реплика — диагностика, а не реплика Codex: в отзыв и
   * вердикт она не входит. Расход субагента входит в расход хода. Дельты
   * текста, рассуждений и вывода команд субагента в поток ответа не идут.
   */
  #childNotification(child: string, method: string, p: Record<string, unknown>): void {
    let entry = this.#children.get(child);
    if (!entry) {
      entry = { owner: this.#turn, started: false, running: false, turn: undefined };
      this.#children.set(child, entry);
    }
    switch (method) {
      case "turn/started": {
        const turn = (p["turn"] as { id?: unknown } | undefined)?.id;
        const again = entry.started;
        // Субагент работает на ход своей ветки, шедший при его начале.
        entry.owner = this.#turn;
        entry.started = true;
        entry.running = true;
        entry.turn = typeof turn === "string" ? turn : undefined;
        this.#emit("diagnostic", "stream", {
          text: again ? `субагент ${shortThread(child)} продолжил` : `Codex запустил субагента ${shortThread(child)}`,
        });
        return;
      }
      case "turn/completed": {
        const turn = (p["turn"] ?? {}) as { id?: unknown; status?: unknown };
        if (entry.turn === undefined || turn.id === entry.turn) {
          entry.running = false;
          entry.turn = undefined;
        }
        const status = turn.status;
        const how = status === undefined || status === "completed" ? "" : `: ${String(status)}`;
        this.#emit("diagnostic", "stream", { text: `субагент ${shortThread(child)} закончил${how}` });
        return;
      }
      case "thread/tokenUsage/updated":
        this.#accountChildUsage(child, p["tokenUsage"]);
        return;
      case "item/started":
      case "item/completed":
        this.#childItem(child, p, method === "item/completed");
        return;
      default:
        return;
    }
  }

  #childItem(child: string, p: Record<string, unknown>, completed: boolean): void {
    const item = (p["item"] ?? p) as Record<string, unknown>;
    const kind = String(item["type"] ?? "");
    const text = this.#textOf(item["text"] ?? item["content"]);
    const raw = { ...item, threadId: child };
    if (kind === "agentMessage") {
      if (completed && text) this.#emit("diagnostic", "stream", { text: clamp(`субагент Codex: ${text}`, CHILD_TEXT_CHARS), raw });
      return;
    }
    if (!TOOL_ITEMS.has(kind)) return;
    // Ход, на который работал субагент, кончился или прерван: команда — в
    // ленте и журнале (и для стоп-сигнала), но не в материале хода, иначе
    // вошла бы в свидетельство следующей проверки (как поздние элементы
    // прерванного хода, рецензия Codex 28.09).
    this.#emitFor(this.#children.get(child)?.owner, completed ? "tool_result" : "tool_call", this.#working(child) ? "turn" : "stream", {
      tool: kind,
      ...(typeof item["id"] === "string" ? { callId: item["id"] } : {}),
      ...clampKeepingFull(text || JSON.stringify(item)),
      raw,
    });
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
    this.#emitFor(this.#turn, kind, visibility, rest);
  }

  /** Событие хода turn — не обязательно текущего (команда позднего субагента). */
  #emitFor(
    turn: string | undefined,
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
      ...(turn ? { turnId: turn } : {}),
      ...rest,
    } as PanelEvent);
  }
}

/**
 * Строки роли о запрещённых путях. Фрагмент от корня проекта («./data/»,
 * forbiddenPaths.ts) назван отдельно и без «./»: одноимённые папки глубже
 * корня (у Trading — пакет кода tradingbot/data/) под запрет не попадают, и
 * роль не должна отбить чтение их кода (итоговая рецензия 05.10).
 */
function forbiddenLines(forbidden: readonly string[]): string[] {
  if (forbidden.length === 0) return [];
  const anywhere = forbidden.filter((f) => !rootAnchored(f));
  const atRoot = forbidden.filter(rootAnchored).map(withoutRoot);
  const named = [...(anywhere.length > 0 ? [anywhere.join(", ")] : []), ...(atRoot.length > 0 ? [`от корня проекта: ${atRoot.join(", ")}`] : [])];
  return [
    `- Не открывай и не читай пути: ${named.join("; ")}. Это данные или секреты проекта:`,
    "  обращение к ним — нарушение правил проекта, даже без расчёта.",
    ...(atRoot.length > 0 ? ["  Одноимённые папки глубже корня (например, пакет кода) под запрет не попадают."] : []),
  ];
}

/**
 * Роль рецензента Codex. Ступень 1 (спека 05.10): репозиторий он читает
 * командами сам; запрещённые пути — данные и секреты проекта, которые
 * песочница read-only от чтения не закрывает. Ступень 2 (checks): рабочая
 * папка ветки — папка проверок, скрипты и выводы — только в ней, проект — по
 * абсолютным путям; AGENTS.md проекта Codex из чужой рабочей папки, вероятно,
 * сам не подхватит (проба 05.10).
 */
export function reviewerRole(
  forbidden: readonly string[],
  checks?: { readonly folder: string; readonly project: string },
): string {
  return [
    HONESTY_LINE,
    "",
    "Ты рецензент в общей комнате с человеком и разработчиком Claude Code.",
    "",
    "Проверяй постановку, код и выводы.",
    "- Читай репозиторий сам: rg, git log/show/diff, python -c над кодом. Сырой вывод Claude",
    "  по-прежнему главное свидетельство о запусках, которые ты не повторяешь.",
    "- Не изменяй проект, не ходи в сеть, не запускай долгие и фоновые процессы.",
    ...forbiddenLines(forbidden),
    ...(checks
      ? [
          `- Рабочая папка ветки — папка проверок ${checks.folder}; проект — ${checks.project}.`,
          `  Команды над репозиторием — с абсолютными путями: rg … ${checks.project}, git -C ${checks.project} ….`,
          `  Правила проекта — в ${join(checks.project, "AGENTS.md")}: прочитай их, если ещё не читал.`,
          `- Скрипты и их выводы пиши только в ${checks.folder}; в замечании указывай путь скрипта и`,
          "  строки вывода. Работай на синтетике и числах из материала; данные проекта не",
          "  читай — ни напрямую, ни через импорт кода проекта.",
          "- Бюджет: не больше 20 команд и 10 минут счёта за проверку.",
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
