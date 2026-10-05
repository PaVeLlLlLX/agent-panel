/**
 * Координатор комнаты: кто кому что передаёт и когда остановиться.
 *
 * Живой прогон 14 сентября показал, что прежний порядок разговора не работает.
 * Сообщение уходило обоим сразу, ответы расходились по времени, и Claude пять
 * секунд спорил с замечанием, которое Codex уже отозвал. Отсюда устройство:
 *
 * **Маршруты с разным смыслом.**
 *   review — задача с рецензией: Claude работает, Codex проверяет, строго по
 *            очереди, пока рецензент не примет работу;
 *   all    — вопрос всем агентам комнаты: каждый отвечает независимо (Claude,
 *            Codex и Gemini, если он подключён), друг другу ничего не
 *            пересылается;
 *   claude / codex / gemini — прямой вопрос одному, без пересылки; Gemini
 *            без agy отвечает объяснением, а не отправкой.
 *
 * **Цикл кончается по итогу, а не по счёту.** Рецензент выносит вердикт.
 * «Принято» завершает цикл, «есть замечания» возвращает работу. Предел
 * раундов остаётся ограничителем расходов.
 *
 * **Недоставленное удерживается, а не теряется.** Нет вердикта, достигнут
 * предел, выключена автопересылка, отказы в разрешениях — пересылка не уходит,
 * но и не пропадает: человек видит причину и решает сам.
 *
 * **Каждый ход знает, зачем он.** Цель хода (работа в цикле, проверка в цикле
 * или прямой вопрос) записывается ДО отправки и снимается при завершении.
 * Регистрация после отправки проигрывала быстрому агенту: его ответ целиком
 * успевал прийти раньше, чем завершалась отправка, и проверка засчитывалась
 * как прямой вопрос.
 *
 * **Каждое продолжение знает, к какому циклу оно относится.** Продолжение
 * ждёт снимок версии; за это время могут прийти новая задача или остановка.
 * Поэтому цикл и задача передаются продолжению неизменными, а после каждого
 * ожидания проверяется, что цикл всё ещё текущий. Иначе Codex получал задачу
 * B с материалом A, а остановленный цикл оживал.
 *
 * **Устаревшее не доставляется.** Новая задача, остановка и прерывание
 * убирают из очереди пересылки прежнего цикла, а выгрузка очереди отбрасывает
 * всё, что относится к нетекущему циклу.
 *
 * Сохранены прежние правила: передаётся законченное, сырой вывод идёт
 * целиком, материал копится по агенту, снимок версии закреплён за ходом.
 */
import {
  Adapter,
  AgentId,
  AgentPrompt,
  ApprovalChoice,
  LimitInfo,
  MAX_TEXT,
  NO_USAGE,
  PanelEvent,
  TurnUsage,
  addUsage,
} from "./adapters/types.js";
import { WEB_BUDGET } from "./geminiSetup.js";
import { Journal } from "./journal.js";
import { Snapshot, describeSnapshot, takeSnapshot } from "./snapshot.js";
import { VERDICT_REQUEST, Verdict, parseVerdict } from "./verdict.js";
import type { ClaudeUsage } from "./claudeUsage.js";
import type { GeminiUsage } from "./geminiUsage.js";

export type Route = "review" | "all" | "claude" | "codex" | "gemini";

/** Кто проверяет работу Claude: Codex — всегда, Gemini — если agy найден. */
export type Reviewer = "codex" | "gemini";

/** Агенты комнаты: у каждого процесс, расход и лимиты. */
type Worker = "claude" | "codex" | "gemini";
const WORKERS = new Set<AgentId>(["claude", "codex", "gemini"]);

const GEMINI_MISSING =
  "Gemini не подключён: agy не найден. Установите Antigravity CLI или укажите путь в agentPanel.geminiCommand.";

export type Stage = "idle" | "working" | "reviewing" | "held" | "accepted" | "stopped";

/** Недельная доля Claude в состоянии комнаты: проценты недели и окна сессии. */
export interface ClaudeWeek {
  readonly percent: number;
  readonly session?: number;
  readonly resets?: string;
  /** Когда получено, мс epoch. */
  readonly at: number;
  /** Последний запрос не дал доли: показывается прежняя, со временем. */
  readonly stale?: boolean;
}

/** Квота Gemini из agy /usage; session — пятичасовое окно. */
export type GeminiWeek = ClaudeWeek;

export interface RoomState {
  readonly task: string | undefined;
  readonly stage: Stage;
  readonly round: number;
  readonly maxRounds: number;
  readonly verdict: Verdict | undefined;
  /**
   * Удержанное: send — переслать дальше, retry — заново отдать Claude его
   * рабочую задачу (после отказов в разрешениях).
   */
  readonly held:
    | { readonly to: AgentId; readonly reason: string; readonly action: "send" | "retry" | "review" }
    | undefined;
  readonly queued: number;
  /** Запросы разрешений, ждущие ответа человека. Пока они есть, ход агента стоит. */
  readonly approvals: number;
  /**
   * Вопросы агента человеку (AskUserQuestion), ждущие ответа. Отдельно от
   * разрешений: этап «Эстафеты» — «Ждёт ответа на вопрос», а не «разрешения».
   */
  readonly questions: number;
  /**
   * След текущего цикла для «Дорожки»: кто получал работу и чем кончилась
   * каждая проверка (✓ принято, ! замечания, ? решение человека, – без вердикта).
   */
  readonly trail: readonly Step[];
  readonly auto: boolean;
  readonly claudeBusy: boolean;
  readonly codexBusy: boolean;
  readonly geminiBusy: boolean;
  /** Кто проверяет: ["codex"] или ["codex", "gemini"]. */
  readonly reviewers: readonly Reviewer[];
  /** Последняя проверка пары. */
  readonly pair: PairView | undefined;
  /** Расход с начала текущей задачи и последние сведения о лимитах агентов. */
  readonly usage: {
    readonly task: { readonly claude: TurnUsage; readonly codex: TurnUsage; readonly gemini: TurnUsage };
    readonly limits: {
      readonly claude?: LimitInfo;
      readonly codex?: LimitInfo;
      readonly gemini?: LimitInfo;
      /** Недельная доля Claude из /usage (см. claudeUsage.ts). */
      readonly claudeWeek?: ClaudeWeek;
      /** Квота Gemini из agy /usage (geminiUsage.ts). */
      readonly geminiWeek?: GeminiWeek;
    };
  };
  readonly snapshot: string | undefined;
}

export interface CoordinatorOptions {
  readonly room: string;
  readonly cwd: string;
  readonly maxAutoRounds: number;
  readonly onEvent: (event: PanelEvent) => void;
  readonly onState?: (state: RoomState) => void;
  /** Снимок версии файлов. Подменяется в тестах, чтобы воспроизводить гонки. */
  readonly snapshot?: (cwd: string) => Promise<Snapshot>;
  /** Сколько символов выводов инструментов уходит рецензенту за проверку (по умолчанию EVIDENCE_BUDGET). */
  readonly evidenceBudget?: number;
  /**
   * Поиск заметок памяти к сообщению человека (см. memory.ts). Нет — заметки
   * не прикладываются. Ошибка поиска сообщения не задерживает.
   */
  readonly memory?: (text: string, cwd: string) => Promise<{ readonly text: string; readonly titles: readonly string[] } | undefined>;
  /**
   * Недельная доля лимита Claude (claudeUsage.ts). Спрашивается после хода
   * Claude и при открытии панели, не чаще claudeUsageEveryMs. Нет — доли нет.
   */
  readonly claudeUsage?: () => Promise<ClaudeUsage | undefined>;
  /** Не чаще, мс; по умолчанию 5 минут. */
  readonly claudeUsageEveryMs?: number;
  /** Gemini — второй рецензент (src/adapters/gemini.ts). Нет — agy не найден: проверяет один Codex. */
  readonly gemini?: Adapter;
  /** Квота Gemini (geminiUsage.ts): после его хода и при открытии, не чаще geminiUsageEveryMs. */
  readonly geminiUsage?: () => Promise<GeminiUsage | undefined>;
  /** Не чаще, мс; по умолчанию 5 минут. */
  readonly geminiUsageEveryMs?: number;
  /**
   * Предел токенов задачи (вход и выход обоих агентов). Достигнут —
   * автоматическая передача ждёт решения человека. 0 или нет — без предела.
   */
  readonly taskTokenLimit?: number;
  /** Сколько ждать Gemini после замечаний Codex, мс (GEMINI_WAIT_MS). */
  readonly geminiWaitMs?: number;
  /** Сколько Gemini может не подавать признаков жизни, мс (GEMINI_SILENCE_MS). */
  readonly geminiSilenceMs?: number;
  /** Предел ожидания Gemini, когда Codex принял работу или просит решения, мс (GEMINI_SAFETY_MS). */
  readonly geminiSafetyMs?: number;
}

type Role = "work" | "review" | "direct";

/**
 * Сколько ждать Gemini после ответа Codex, если Codex нашёл замечания:
 * Claude в это время простаивает (agentPanel.geminiWaitMinutes). Живой прогон
 * 03.10: Flash high проверял 8,7 мин, ~7 из них — около 40 обращений к вебу,
 * и уложился за 1,6 мин до прежнего срока в 10 мин.
 */
export const GEMINI_WAIT_MS = 20 * 60_000;

/**
 * Сколько Gemini может молчать (ни строки вывода, ни события), пока
 * проверяет. Это только детектор зависания, всё остальное ограничивают
 * сроки. Замеры 04.10 (повтор проверки Trading, scripts/gemini-probe.mjs
 * --timing, по прогону на модель): наибольшее молчание вывода — 34,6 с у
 * Flash high и 23,4 с у Pro high. Пока модель рассуждает, agy не пишет
 * ничего, даже пустых ACTIVE, так что рассуждение молчит целиком и в эти
 * числа входит. Верхняя оценка по журналу 03.10 — 105,7 с без событий в ходе
 * Flash без инструментов; втрое — 5,3 мин, отсюда 6 мин, а не 5.
 */
export const GEMINI_SILENCE_MS = 6 * 60_000;

/**
 * Предел ожидания Gemini, когда Codex принял работу, просит решения или не
 * вынес вердикт: тогда итог без Gemini был бы ложным «Цикл завершён», и его
 * ждут, пока он работает, — но не дольше этого.
 */
export const GEMINI_SAFETY_MS = 45 * 60_000;

/** Пометка к первому сообщению Gemini после хода, снятого панелью (R11, дизайн 03.10). */
const CUT_NOTE = "[прошлый ход прерван панелью — его материал устарел, проверяй только этот]";

interface Target {
  readonly role: Role;
  /** Номер цикла; у прямого вопроса отсутствует. */
  readonly cycle: number | undefined;
  /** У проверки — её номер: поздний ответ прежней проверки не входит в новую. */
  readonly round?: number;
}

interface Outgoing {
  readonly to: AgentId;
  readonly prompt: AgentPrompt;
  readonly target: Target;
  readonly snapshot: Snapshot | undefined;
}

type Held = Outgoing & {
  reason: string;
  action: "send" | "retry" | "review";
  /** Вторая половина удержанной пары — материал для Gemini. */
  companion?: Outgoing;
  /**
   * Удержаны замечания, сведённые из проверки с этим номером (цикл — в
   * target): поздний отзыв Gemini к ней ещё можно в них добавить.
   */
  pairRound?: number;
};

/** Исход проверки одного рецензента. */
type ReviewOutcome =
  | { readonly kind: "verdict"; readonly verdict: Verdict; readonly text: string; readonly snapshot: Snapshot | undefined }
  | { readonly kind: "unchecked"; readonly reason: string };
type VerdictOutcome = Extract<ReviewOutcome, { kind: "verdict" }>;

/** Проверка пары: кого ждём и что пришло. Остаётся после сведения — её показывает «Эстафета». */
interface ReviewPair {
  readonly cycle: number;
  readonly round: number;
  readonly waiting: Set<Reviewer>;
  readonly outcomes: Map<Reviewer, ReviewOutcome>;
  /** Единственные часы ожидания Gemini этой пары; переставляются при срабатывании. */
  deadline: NodeJS.Timeout | undefined;
  /** Когда ответил Codex, мс epoch: с него идут сроки Gemini. */
  codexAt?: number;
  /** Срок после ответа Codex: geminiWaitMs при замечаниях, geminiSafetyMs иначе. */
  limit?: number;
  /** Когда материал этой проверки действительно отдан Gemini, а не встал в очередь. */
  geminiSentAt?: number;
  /** Последнее событие Gemini, пока его ход — эта проверка (признак жизни без адаптера). */
  lastEventAt?: number;
  /** Срок при замечаниях Codex истёк, а Gemini ещё проверяет: его поздний отзыв можно принять. */
  overdue: boolean;
  /** Строка ленты для сведения вместо общей «Gemini не проверял: …». */
  note?: string;
  /**
   * Сведение ждёт снимок версии: поздний отзыв Gemini, пришедший сейчас,
   * сведение прочтёт само (рецензия 03.10 — иначе он терялся в этом окне).
   */
  merging?: boolean;
}

/** Сторона пары для интерфейса. */
export interface PairSide {
  readonly state: "waiting" | "done" | "unchecked";
  readonly verdict?: Verdict;
  readonly reason?: string;
}

export interface PairView {
  readonly round: number;
  readonly sides: Readonly<Partial<Record<Reviewer, PairSide>>>;
  /**
   * Codex ответил, Gemini ещё проверяет: до какого момента его ждут, мс
   * epoch. Верхняя граница — молчание может снять его раньше. «Эстафета»
   * показывает «срок ЧЧ:ММ» (R9, дизайн 03.10).
   */
  readonly waitUntil?: number;
}

export interface Step {
  readonly who: "task" | "claude" | "codex" | "gemini" | "you";
  /** У проверки — её номер: шаги Codex и Gemini одного номера рисуются ромбом. */
  readonly round?: number;
  mark?: string;
  /** Рецензент не проверял — причина. */
  unchecked?: string;
}

const MARKS: Record<Verdict, string> = { accepted: "✓", remarks: "!", human: "?", missing: "–" };

const VERDICT_WORDS: Record<Verdict, string> = {
  accepted: "принято",
  remarks: "есть замечания",
  human: "нужно решение человека",
  missing: "без вердикта",
};

/**
 * Напоминание о полосах Gemini к каждой проверке; роль целиком — в agent.md
 * (geminiSetup.ts). Бюджет веба — та же фраза, что в agent.md (живой прогон
 * 03.10: ~40 обращений к вебу за одну проверку). Правила проекта agy с
 * excludeDefaultComponents сам не подаёт (проба 04.10), и в проверке Trading
 * 02.10 Gemini их не открыл — поэтому напоминание прочитать их идёт с каждой
 * проверкой. Файл называет строка «[правила проекта: …]» шапки
 * (formatForGemini, живой прогон 04.10). Полноту отрицательного поиска в
 * повторе той проверки 04.10 не потребовала ни одна модель: обе сочли
 * строгий код ворот достаточным, — поэтому о ней напоминание тоже есть.
 * scripts/gemini-probe.mjs берёт это выражение из исходника и вычисляет с
 * одним WEB_BUDGET: других имён в нём быть не должно.
 */
const GEMINI_FOCUS =
  "Правила проекта: если в этом разговоре ты ещё не открывал файл из строки «[правила проекта: …]» шапки — открой его до проверки. " +
  "Ты второй рецензент: проверь методологию эксперимента (чек-лист: утечки, разбиения, регистрация, метрики и статистика, " +
  "бейзлайн, сиды и разброс, обоснованность выводов — у каждого пункта «свидетельство: …», «пробел: …» или " +
  "«не относится: <почему>») и факты вне репозитория (с адресом страницы и датой проверки из шапки «[дата: …]»). " +
  "Отрицательный результат поиска без показанной полноты — «пробел: …», даже если код ворот строгий; " +
  "процедура такого поиска, которая не требует покрытия окна, всех страниц выдачи и цитаты, — тоже «пробел: …»; " +
  "поля окна и цитаты в журнале — ещё не покрытие окна. " +
  `${WEB_BUDGET} Код целиком не перепроверяй — это делает Codex. ` +
  "Любой открытый «пробел: …» или найденный дефект методологии — это «ВЕРДИКТ: ЕСТЬ ЗАМЕЧАНИЯ»; дефект, " +
  "прямо предписанный самим поручением человека — «ВЕРДИКТ: НУЖНО РЕШЕНИЕ ЧЕЛОВЕКА»; «ВЕРДИКТ: ПРИНЯТО» — " +
  "только когда пробелов и дефектов нет.";

function waitWords(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)} мин` : `${Math.max(1, Math.round(ms / 1000))} с`;
}

function movedNote(reviewed: Snapshot | undefined, current: Snapshot): string {
  return reviewed && reviewed.id !== current.id
    ? ` Файлы изменились за время проверки: принята версия ${describeSnapshot(reviewed)}, сейчас ${describeSnapshot(current)}.`
    : "";
}

function reviewBlock(title: string, outcome: ReviewOutcome, current: Snapshot | undefined): string {
  // Причина отказа — не замечание к работе разработчика, поэтому Claude её не
  // видит здесь: она остаётся в строке ленты «Gemini не проверял: …» (M5).
  if (outcome.kind === "unchecked") return `— ${title} — не проверял (это не замечание, исправлять нечего)`;
  if (outcome.verdict === "accepted") return `— ${title} — принято`;
  const shift =
    outcome.snapshot && current && outcome.snapshot.id !== current.id
      ? `\n\nФайлы изменились после начала проверки: замечания относятся к версии ${describeSnapshot(outcome.snapshot)}, сейчас ${describeSnapshot(current)}.`
      : "";
  return `— ${title} —\n${outcome.text}${shift}`;
}

/** Общее сообщение Claude по итогу пары; его же пересобирает поздний отзыв Gemini (R7). */
function mergedText(round: number, codex: ReviewOutcome, gemini: ReviewOutcome, current: Snapshot | undefined): string {
  return (
    `Замечания рецензентов (проверка ${round}):\n\n` +
    `${reviewBlock("Codex — код", codex, current)}\n\n` +
    `${reviewBlock("Gemini — методология и факты", gemini, current)}\n\n` +
    "Исправьте или обоснуйте несогласие по каждому пункту."
  );
}

/** Сведение пары: строже побеждает. */
function strictest(verdicts: readonly Verdict[]): Verdict {
  return verdicts.includes("human")
    ? "human"
    : verdicts.includes("missing")
      ? "missing"
      : verdicts.includes("remarks")
        ? "remarks"
        : "accepted";
}

/** Кто из пары вынес этот вердикт: «Codex», «Gemini» или «Codex и Gemini». */
function whoSaid(v: Verdict, codex: ReviewOutcome, gemini: ReviewOutcome): string {
  return [codex, gemini]
    .filter((o) => o.kind === "verdict" && o.verdict === v)
    .map((o) => (o === codex ? "Codex" : "Gemini"))
    .join(" и ");
}

function humanHoldReason(codex: ReviewOutcome, gemini: ReviewOutcome): string {
  const asking = whoSaid("human", codex, gemini);
  return `${asking} ${asking.includes(" и ") ? "просят" : "просит"} вашего решения: обмен остановлен. Отзывы можно отправить Claude.`;
}

/** Местное время ЧЧ:ММ — для строк ленты о сроках Gemini. */
function clockTime(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function pairView(pair: ReviewPair, reviewers: readonly Reviewer[], waitUntil: number | undefined): PairView {
  const sides: Partial<Record<Reviewer, PairSide>> = {};
  for (const r of reviewers) {
    const outcome = pair.outcomes.get(r);
    sides[r] = !outcome
      ? { state: "waiting" }
      : outcome.kind === "verdict"
        ? { state: "done", verdict: outcome.verdict }
        : { state: "unchecked", reason: outcome.reason };
  }
  return { round: pair.round, sides, ...(waitUntil !== undefined ? { waitUntil } : {}) };
}

export class Coordinator {
  #cycle = 0;
  /** Сколько раз человек останавливал или прерывал: сообщение, ждавшее поиска, после этого не уходит. */
  #stops = 0;
  /** Расход с начала задачи и последние сведения о лимитах. */
  #usage: Record<Worker, TurnUsage> = { claude: NO_USAGE, codex: NO_USAGE, gemini: NO_USAGE };
  #limits: Partial<Record<Worker, LimitInfo>> = {};
  #claudeWeek: ClaudeWeek | undefined;
  #geminiWeek: GeminiWeek | undefined;
  #shareAskedAt = 0;
  #shareInFlight = false;
  #geminiAskedAt = 0;
  #geminiInFlight = false;
  #stage: Stage = "idle";
  #task: string | undefined;
  #round = 0;
  #verdict: Verdict | undefined;
  #held: Held | undefined;
  #pair: ReviewPair | undefined;
  /** Последняя рабочая отправка Claude в цикле — для повтора после отказов. */
  #lastWork: Outgoing | undefined;
  #auto = true;
  #roomSnapshot: Snapshot | undefined;
  readonly #snapshots = new Map<AgentId, Snapshot>();
  readonly #buffers = new Map<AgentId, PanelEvent[]>();
  readonly #targets = new Map<AgentId, Target[]>();
  readonly #queue: Outgoing[] = [];
  /** Открытые запросы разрешений и вопросы: id запроса → агент, который спросил. */
  readonly #requests = new Map<string, AgentId>();
  /** Какие из открытых запросов — вопросы человеку: на них отвечают answerQuestion. */
  readonly #questions = new Set<string>();
  /** Заметки памяти, приложенные к задаче текущего цикла: их видит и рецензент. */
  #taskMemory: string | undefined;
  #trail: Step[] = [];
  /**
   * Панель сняла ход Gemini (молчание, предел, новая проверка, «Прервать»):
   * следующее его сообщение говорит, что прошлый ход прерван и устарел.
   * Иначе возобновлённый разговор может продолжить прерванную проверку
   * (R11; живая проба «снять и продолжить» не проводилась — нужна квота).
   */
  #geminiCut = false;
  readonly #capture: (cwd: string) => Promise<Snapshot>;

  constructor(
    private readonly claude: Adapter,
    private readonly codex: Adapter,
    private readonly journal: Journal,
    private readonly options: CoordinatorOptions,
  ) {
    this.#capture = options.snapshot ?? takeSnapshot;
  }

  get round(): number {
    return this.#round;
  }

  get snapshot(): Snapshot | undefined {
    return this.#roomSnapshot;
  }

  get state(): RoomState {
    return {
      task: this.#task,
      stage: this.#stage,
      round: this.#round,
      maxRounds: this.options.maxAutoRounds,
      verdict: this.#verdict,
      held: this.#held
        ? { to: this.#held.to, reason: this.#held.reason, action: this.#held.action }
        : undefined,
      queued: this.#queue.length,
      approvals: this.#requests.size - this.#questions.size,
      questions: this.#questions.size,
      trail: this.#trail.map((sh) => ({ ...sh })),
      auto: this.#auto,
      claudeBusy: this.claude.busy,
      codexBusy: this.codex.busy,
      geminiBusy: this.options.gemini?.busy ?? false,
      reviewers: this.#reviewers(),
      pair: this.#pair ? pairView(this.#pair, this.#reviewers(), this.#waitUntil(this.#pair)) : undefined,
      usage: {
        task: { claude: this.#usage.claude, codex: this.#usage.codex, gemini: this.#usage.gemini },
        limits: {
          ...this.#limits,
          ...(this.#claudeWeek ? { claudeWeek: this.#claudeWeek } : {}),
          ...(this.#geminiWeek ? { geminiWeek: this.#geminiWeek } : {}),
        },
      },
      snapshot: this.#roomSnapshot?.id,
    };
  }

  handle(event: PanelEvent): void {
    const agent = event.agent;
    const snapshot = WORKERS.has(agent) ? (this.#snapshots.get(agent) ?? this.#roomSnapshot) : this.#roomSnapshot;
    const marked: PanelEvent = snapshot ? { ...event, snapshot: snapshot.id } : event;
    this.journal.append(this.options.room, marked);
    this.options.onEvent(marked);

    if (!WORKERS.has(agent)) return;
    const worker = agent as Worker;

    // Любое событие Gemini, пока его ход — проверка ждущей пары, — признак
    // жизни для срока молчания (вместе с lastOutputAt адаптера).
    if (worker === "gemini") {
      const pair = this.#pair;
      if (pair && pair.waiting.has("gemini") && this.#geminiOnPair(pair)) pair.lastEventAt = Date.now();
    }

    if (marked.visibility === "turn" && FORWARDED_KINDS.has(marked.kind)) {
      const buffer = this.#buffers.get(worker) ?? [];
      buffer.push(marked);
      this.#buffers.set(worker, buffer);
    }

    if (worker === "claude" && marked.kind === "turn_completed") void this.refreshClaudeUsage();
    if (worker === "gemini" && marked.kind === "turn_completed") void this.refreshGeminiUsage();

    if (marked.kind === "approval_requested" && marked.callId) {
      this.#requests.set(marked.callId, worker);
      if (marked.questions) this.#questions.add(marked.callId);
      else this.#questions.delete(marked.callId);
      this.#refresh();
    } else if (marked.kind === "approval_decided" && marked.callId) {
      this.#closeRequest(marked.callId);
      this.#refresh();
    } else if (marked.kind === "turn_completed" && marked.unsolicited) {
      if (marked.limit) this.#limits[worker] = marked.limit;
      void this.#autonomousFinished(worker);
    } else if (marked.kind === "turn_completed") {
      if (marked.limit) this.#limits[worker] = marked.limit;
      void this.#turnFinished(worker, marked);
    } else if (marked.kind === "error" && marked.failed) {
      for (const [id, who] of this.#requests) if (who === worker) this.#closeRequest(id);
      void this.#agentCrashed(worker, marked.text);
    } else if (marked.kind === "turn_started") {
      if (marked.unsolicited) {
        this.#report(
          `${NAMES[worker]} продолжил сам${marked.text ? ` (${marked.text})` : ""}. ` +
            "Этот ход не относится к задаче: рецензенту не передаётся и в расход задачи не входит; " +
            "сообщения ему подождут конца хода.",
        );
      }
      this.#refresh();
    }
  }

  /**
   * Недельная доля Claude: не чаще claudeUsageEveryMs и не два запроса сразу.
   * Сбой — доля остаётся прежней (или неизвестной), работа не задерживается.
   */
  async refreshClaudeUsage(): Promise<void> {
    const ask = this.options.claudeUsage;
    if (!ask || this.#shareInFlight) return;
    const period = this.options.claudeUsageEveryMs ?? 5 * 60_000;
    if (this.#shareAskedAt && Date.now() - this.#shareAskedAt < period) return;
    this.#shareInFlight = true;
    this.#shareAskedAt = Date.now();
    try {
      const fraction = await ask();
      if (fraction) {
        this.#claudeWeek = {
          percent: fraction.weekPercent,
          ...(fraction.sessionPercent !== undefined ? { session: fraction.sessionPercent } : {}),
          ...(fraction.weekResets ? { resets: fraction.weekResets } : {}),
          at: Date.now(),
        };
      } else {
        this.#shareStale();
      }
    } catch {
      this.#shareStale();
    } finally {
      this.#shareInFlight = false;
      this.#refresh();
    }
  }

  /** Новой доли нет: прежняя остаётся, но помечена (рецензия Codex 28.09); нулём не становится. */
  #shareStale(): void {
    if (this.#claudeWeek && !this.#claudeWeek.stale) this.#claudeWeek = { ...this.#claudeWeek, stale: true };
  }

  /** Квота Gemini: не чаще geminiUsageEveryMs; сбой — прежняя помечается устаревшей, нулём не становится. */
  async refreshGeminiUsage(): Promise<void> {
    const ask = this.options.geminiUsage;
    if (!ask || this.#geminiInFlight) return;
    const period = this.options.geminiUsageEveryMs ?? 5 * 60_000;
    if (this.#geminiAskedAt && Date.now() - this.#geminiAskedAt < period) return;
    this.#geminiInFlight = true;
    this.#geminiAskedAt = Date.now();
    const markStale = () => {
      if (this.#geminiWeek && !this.#geminiWeek.stale) this.#geminiWeek = { ...this.#geminiWeek, stale: true };
    };
    try {
      const quota = await ask();
      if (quota) {
        this.#geminiWeek = {
          percent: quota.weekPercent,
          ...(quota.windowPercent !== undefined ? { session: quota.windowPercent } : {}),
          ...(quota.weekResets ? { resets: quota.weekResets } : {}),
          at: Date.now(),
        };
      } else {
        markStale();
      }
    } catch {
      markStale();
    } finally {
      this.#geminiInFlight = false;
      this.#refresh();
    }
  }

  async fromHuman(text: string, route: Route): Promise<void> {
    // Новая задача регистрируется ДО ожидания снимка: иначе продолжение
    // прежнего цикла, ждущее тот же снимок, успело бы отправить устаревшее.
    const cycle = route === "review" ? this.#startCycle(text) : undefined;
    this.#refresh();

    // Остановка во время снимка или поиска по памяти отменяет сообщение
    // (рецензия Codex 28.09: прежде счётчик запоминался после снимка).
    const stops = this.#stops;
    this.#roomSnapshot = await this.#capture(this.options.cwd);
    this.handle({
      id: `h${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      agent: "human",
      kind: "message",
      visibility: "turn",
      at: Date.now(),
      text: text,
    });
    const memory = await this.#searchMemory(text);
    if (this.#stops !== stops) {
      // Человек остановил панель, пока шёл поиск: сообщение не уходит.
      this.#report("Сообщение не отправлено: панель остановлена, пока оно готовилось (снимок файлов, поиск по памяти).");
      this.#refresh();
      return;
    }
    if (cycle !== undefined && !this.#isCurrent(cycle)) return;
    // Заметки называются человеку, только когда сообщение действительно уходит.
    if (memory) this.#report(memory.note);
    if (cycle !== undefined) this.#taskMemory = memory?.block;
    const prompt: AgentPrompt = {
      text: memory ? `${text}${NL}${NL}${memory.block}` : text,
      from: "human",
      snapshot: describeSnapshot(this.#roomSnapshot),
    };

    if (cycle !== undefined) {
      await this.#send({
        to: "claude",
        prompt,
        target: { role: "work", cycle },
        snapshot: this.#roomSnapshot,
      });
    } else {
      const direct: Target = { role: "direct", cycle: undefined };
      if (route === "gemini" && !this.options.gemini) {
        this.#report(GEMINI_MISSING);
      } else {
        const recipients: AgentId[] =
          route === "all" ? ["claude", "codex", ...(this.options.gemini ? (["gemini"] as const) : [])] : [route as AgentId];
        for (const recipient of recipients) {
          await this.#send({ to: recipient, prompt, target: direct, snapshot: this.#roomSnapshot });
        }
      }
    }
    this.#refresh();
  }

  /**
   * Заметки памяти к сообщению человека — с пояснением для агента и строкой
   * для человека: какие заметки ушли агентам, он должен видеть.
   */
  async #searchMemory(text: string): Promise<{ block: string; note: string } | undefined> {
    if (!this.options.memory) return undefined;
    try {
      const found = await this.options.memory(text, this.options.cwd);
      if (!found) return undefined;
      const titles = found.titles.map((title) => `«${title}»`).join(", ");
      return {
        block: `${ABOUT_MEMORY}${NL}${NL}${found.text}`,
        note: `Память: к сообщению приложены заметки (${found.titles.length}): ${titles}.`,
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.#report(`Поиск по памяти не удался: ${reason}. Сообщение ушло без заметок.`);
      return undefined;
    }
  }

  /** Расход задачи достиг предела agentPanel.taskTokenLimit. */
  #overLimit(): boolean {
    const limit = this.options.taskTokenLimit ?? 0;
    return limit > 0 && this.#taskTokens() >= limit;
  }

  #taskTokens(): number {
    return Object.values(this.#usage).reduce((sum, u) => sum + u.input + u.output, 0);
  }

  #limitReason(what: string): string {
    return (
      `Расход задачи — ${this.#taskTokens()} токенов — достиг предела ${this.options.taskTokenLimit} ` +
      `(agentPanel.taskTokenLimit): ${what}. Решите, продолжать ли.`
    );
  }

  /** Отправить удержанное по команде человека. */
  async releaseHeld(): Promise<void> {
    const u = this.#held;
    if (!u) return;
    this.#held = undefined;
    if (u.target.cycle !== undefined && u.target.cycle !== this.#cycle) {
      this.#refresh();
      return;
    }
    if (u.target.role === "review") {
      this.#round += 1;
      this.#stage = "reviewing";
      await this.#startPair({ to: u.to, prompt: u.prompt, target: u.target, snapshot: u.snapshot }, u.companion);
    } else {
      this.#stage = "working";
      await this.#send(u);
    }
    this.#refresh();
  }

  /** Решение человека по запросу разрешения — адаптеру того агента, который спросил. */
  async answerApproval(id: string, choice: ApprovalChoice): Promise<void> {
    const agent = this.#requests.get(id);
    if (!agent) return;
    // На вопрос отвечают ответами; «разрешить» без них Claude прочёл бы как
    // «человек не ответил» (журнал 04–05.10). Принимается только отказ.
    if (this.#questions.has(id) && choice !== "deny") return;
    const adapter = this.#adapter(agent);
    if (!adapter) return;
    const accepted = (await adapter.answerApproval?.(id, choice)) ?? false;
    // Не принят — запрос уже закрыт на стороне агента; карточка не должна висеть.
    if (!accepted) this.#closeRequest(id);
    this.#refresh();
  }

  /** Ответ человека на вопрос агента — адаптеру того агента, который спросил. */
  async answerQuestion(id: string, answers: Readonly<Record<string, string>>): Promise<void> {
    const agent = this.#requests.get(id);
    // Пустой ответ адаптер не примет и вопрос не закроет — снимать его здесь
    // нельзя, как и при «разрешить» на вопрос.
    if (!agent || !this.#questions.has(id) || Object.keys(answers).length === 0) return;
    const adapter = this.#adapter(agent);
    if (!adapter) return;
    const accepted = (await adapter.answerQuestion?.(id, answers)) ?? false;
    // Не принят — вопрос уже закрыт на стороне агента; карточка не должна висеть.
    if (!accepted) this.#closeRequest(id);
    this.#refresh();
  }

  #closeRequest(id: string): void {
    this.#requests.delete(id);
    this.#questions.delete(id);
  }

  /** Служебное сообщение панели в беседу и журнал — например, о смене модели. */
  notice(text: string): void {
    this.#report(text);
  }

  setAuto(enabled: boolean): void {
    this.#auto = enabled;
    this.#refresh();
  }

  async stopAll(): Promise<void> {
    this.#stops += 1;
    if (this.options.gemini?.busy) this.#geminiCut = true;
    this.#resetWait("stopped");
    this.#queue.length = 0;
    await Promise.allSettled(this.#adapters().map((a) => a.stop()));
    this.#refresh();
  }

  /**
   * Новая сессия агента: прежняя остаётся в его истории, но агент её больше
   * не помнит. Нужна, когда возобновляемая сессия разрослась: каждый ход
   * возобновляет её целиком, а расход растёт с длиной контекста.
   */
  async newSession(agent: Worker): Promise<void> {
    const adapter = this.#adapter(agent);
    if (!adapter) return;
    const previousSession = adapter.sessionId;
    // Журнал — раньше остановки: закрытие панели во время неё не вернёт
    // прежнюю привязку (рецензия Codex 28.09).
    this.journal.forgetSession(this.options.room, agent);
    let forgetting: Promise<void> | undefined;
    if (agent === "gemini") {
      // Gemini — не арбитр: новая сессия для него не должна рвать весь цикл
      // (M6, финальная рецензия 02.10). Если пара сейчас ждёт его ответа,
      // засчитать «не проверял» и дать Codex доводить проверку одному —
      // #resetWait здесь не нужен, процесс останавливает forgetSession.
      // Цели и материал хода снимаются ДО первого ожидания: иначе конец
      // следующего хода (прямой вопрос) брал прежнюю цель проверки и
      // становился «поздним ответом» (остаток M6, дизайн 03.10, R12).
      const pair = this.#pair;
      const wasWaiting = pair !== undefined && this.#isCurrent(pair.cycle) && pair.waiting.has("gemini");
      forgetting = this.#cutGemini("forget");
      if (pair && wasWaiting) {
        await this.#recordOutcome(pair, "gemini", { kind: "unchecked", reason: "новая сессия Gemini" });
      }
    } else if (adapter.busy) {
      // Ход обрывается вместе с процессом: ждать его ответа циклу нечего.
      this.#stops += 1;
      this.#resetWait("stopped");
    }
    if (this.#held?.to === agent) {
      // Новая сессия не знает прежнего разговора: передача без него бессмысленна.
      this.#held = undefined;
      this.#stage = "stopped";
      this.#report(`Удержанная передача ${NAMES[agent]} снята: новая сессия не знает прежнего разговора. Поставьте задачу заново.`);
    }
    await (forgetting ?? adapter.forgetSession?.());
    this.#report(
      `Новая сессия ${NAMES[agent]}: прежняя${previousSession ? ` (${previousSession.slice(0, 8)})` : ""} сохранена в истории ` +
        `${NAMES[agent]}, но следующий ход её не продолжит — агент не будет помнить прежних разговоров.`,
    );
    // Сообщения, ждавшие занятого агента, уходят в новую сессию.
    await this.#flushQueue();
    this.#refresh();
  }

  async interruptAll(): Promise<void> {
    this.#stops += 1;
    if (this.options.gemini?.busy) this.#geminiCut = true;
    this.#resetWait("stopped");
    // Прямые сообщения человека ждали конца хода, а его теперь не будет.
    // Отправлять их сразу нельзя: человек мог прервать именно чтобы отменить,
    // а поздний конец прерванного хода мешал бы новому. Сняты и названы
    // (рецензии Codex 28.09); пересылки цикла сняты выше.
    const removed = this.#queue.length;
    this.#queue.length = 0;
    await Promise.allSettled(this.#adapters().map((a) => a.interrupt()));
    // Написанное человеком уже после нажатия (пока агенты прерывались, оно
    // встало в очередь) — новое намерение: отправить (рецензия Codex 28.09).
    await this.#flushQueue();
    this.#report(
      "Ход прерван человеком. Цикл рецензии остановлен." +
        (removed > 0 ? ` Не отправлено сообщений из очереди: ${removed} — при необходимости отправьте заново.` : ""),
    );
    this.#refresh();
  }

  // -------------------------------------------------------------------------

  /** Цикл текущий и не остановлен: только тогда продолжение имеет право действовать. */
  #isCurrent(cycle: number): boolean {
    return cycle === this.#cycle && this.#stage !== "stopped";
  }

  #startCycle(task: string): number {
    // Идущая проверка Gemini прежней задачи новой не нужна: снять её, иначе
    // она держит Gemini, а материал новой ждёт в очереди (R6, дизайн 03.10).
    const stopping = this.#dropStaleGemini(undefined, undefined, "новая задача");
    if (stopping) {
      void stopping.then(async () => {
        await this.#flushQueue();
        this.#refresh();
      });
    }
    const stale = this.#dropCycleForwards();
    if (stale > 0) {
      this.#report(`Новая задача: не доставлено устаревших пересылок прежней — ${stale}.`);
    }
    this.#clearPair();
    this.#cycle += 1;
    this.#held = undefined;
    this.#lastWork = undefined;
    this.#taskMemory = undefined;
    this.#usage = { claude: NO_USAGE, codex: NO_USAGE, gemini: NO_USAGE };
    this.#trail = [{ who: "task" }];
    this.#task = task;
    this.#round = 0;
    this.#verdict = undefined;
    this.#stage = "working";
    return this.#cycle;
  }

  #resetWait(stage: Stage): void {
    this.#dropCycleForwards();
    this.#clearPair();
    this.#cycle += 1; // всё, что принадлежало прежнему циклу, теперь чужое
    this.#targets.clear();
    this.#held = undefined;
    // Адаптеры закрывают свои запросы при остановке; здесь — на случай,
    // если закрытие не дойдёт (адаптер уже без процесса).
    this.#requests.clear();
    this.#questions.clear();
    this.#stage = stage;
  }

  /** Убрать из очереди всё, что относится к циклам; прямые сообщения человека остаются. */
  #dropCycleForwards(): number {
    let removedCount = 0;
    for (let i = this.#queue.length - 1; i >= 0; i -= 1) {
      if (this.#queue[i]?.target.cycle !== undefined) {
        this.#queue.splice(i, 1);
        removedCount += 1;
      }
    }
    return removedCount;
  }

  async #turnFinished(agent: Worker, ended: PanelEvent): Promise<void> {
    const failed = ended.failed === true;
    const denials = ended.denials ?? [];
    const usage = ended.usage;
    const target = this.#targets.get(agent)?.shift() ?? { role: "direct", cycle: undefined };
    // Расход — задаче, к циклу которой относится ход: поздний ход прежней
    // задачи и прямой вопрос в неё не идут (рецензия Codex 28.09).
    if (usage && target.cycle !== undefined && target.cycle === this.#cycle) {
      this.#usage[agent] = addUsage(this.#usage[agent], usage);
    }
    const material = this.#take(agent);
    const cycle = target.cycle;
    const current = cycle !== undefined && this.#isCurrent(cycle);

    const reviewer = (agent === "codex" || agent === "gemini") && target.role === "review" ? agent : undefined;
    if (current && reviewer) {
      await this.#reviewFinished(reviewer, target, material, ended);
    } else if (current && failed) {
      this.#stage = "stopped";
      this.#report(`Ход ${NAMES[agent]} завершился с ошибкой — цикл рецензии остановлен.`);
    } else if (current && target.role === "work" && denials.length > 0) {
      // Отказы — дело человека, а не рецензента: в живом прогоне три раунда
      // проверки ушли на спор о причинах блокировки.
      const retry = this.#lastWork;
      if (retry) {
        this.#hold(
          retry,
          `Claude получил отказы в разрешениях (${denials.length}): ${denials.join("; ")}. ` +
            "Проверка не запускалась. Разрешите эти действия или измените задачу, затем повторите.",
          "retry",
        );
      }
    } else if (current && target.role === "work") {
      await this.#afterWork(material, cycle, this.#task ?? "");
    } else if (denials.length > 0) {
      this.#report(`${NAMES[agent]} получил отказы в разрешениях (${denials.length}): ${denials.join("; ")}.`);
    } else if (agent === "gemini" && target.role === "direct" && ended.incomplete) {
      // Прямой вопрос Gemini мимо цикла рецензии: «не проверял» здесь не
      // подходит (это не проверка), но и молчать о пустом ответе нельзя (M7).
      this.#report(`Gemini не ответил: ${ended.incomplete}.`);
    }

    await this.#flushQueue();
    this.#refresh();
  }

  /**
   * Ход, начатый агентом без сообщения панели: цель очереди он не занимает
   * (иначе ответ на следующее сообщение остался бы без адресата), его
   * реплики к материалу задачи не добавляются.
   */
  async #autonomousFinished(agent: Worker): Promise<void> {
    this.#take(agent);
    await this.#flushQueue();
    this.#refresh();
  }

  async #afterWork(material: PanelEvent[], cycle: number, task: string): Promise<void> {
    const text = assemble(material, true, this.options.evidenceBudget ?? EVIDENCE_BUDGET);
    if (!text) {
      this.#stage = "stopped";
      this.#report("Claude не выдал законченной реплики — проверять нечего.");
      return;
    }
    const snapshot = await this.#capture(this.options.cwd);
    if (!this.#isCurrent(cycle)) return;

    const memory = this.#taskMemory ? `${this.#taskMemory}${NL}${NL}` : "";
    const body = `Задача человека:\n${task}\n\n${memory}Материал разработчика:\n${text}\n\n${ABOUT_TRUNCATION}`;
    const target: Target = { role: "review", cycle, round: this.#round + 1 };
    const codexOut: Outgoing = {
      to: "codex",
      prompt: { text: `${body}\n\n${VERDICT_REQUEST}`, from: "claude", snapshot: describeSnapshot(snapshot) },
      target,
      snapshot,
    };
    const geminiOut: Outgoing | undefined = this.options.gemini
      ? {
          to: "gemini",
          prompt: {
            text: `${body}\n\n${GEMINI_FOCUS}\n\n${VERDICT_REQUEST}`,
            from: "claude",
            heading: "[материал проверки от панели]",
            snapshot: describeSnapshot(snapshot),
          },
          target,
          snapshot,
        }
      : undefined;
    const whom = geminiOut ? "рецензентами" : "рецензентом";
    const toWhom = geminiOut ? "рецензентам" : "рецензенту";

    if (this.#round >= this.options.maxAutoRounds) {
      this.#hold(codexOut, `Предел проверок (${this.options.maxAutoRounds}) достигнут: работа Claude не проверена ${whom}.`, "send", geminiOut);
      return;
    }
    if (this.#overLimit()) {
      this.#hold(codexOut, this.#limitReason(`работа Claude ждёт отправки ${toWhom}`), "send", geminiOut);
      return;
    }
    if (!this.#auto) {
      this.#hold(codexOut, `Автопересылка выключена: работа Claude ждёт отправки ${toWhom}.`, "send", geminiOut);
      return;
    }
    this.#round += 1;
    this.#stage = "reviewing";
    await this.#startPair(codexOut, geminiOut);
  }

  /** Проверка пары: оба получают один материал и снимок, след — до отправки. */
  async #startPair(codexOut: Outgoing, geminiOut: Outgoing | undefined): Promise<void> {
    const cycle = codexOut.target.cycle as number;
    this.#clearPair();
    const round = this.#round;
    // Поздняя проверка прежнего номера (срок истёк при замечаниях Codex, а
    // Gemini ещё работал) снимается до отправок: иначе материал этой проверки
    // ждал бы её конца в очереди, и опоздание переходило бы дальше (R6).
    const stopping = this.#dropStaleGemini(cycle, round, `началась проверка ${round}`);
    const pair: ReviewPair = {
      cycle,
      round,
      waiting: new Set<Reviewer>(geminiOut ? ["codex", "gemini"] : ["codex"]),
      outcomes: new Map(),
      deadline: undefined,
      overdue: false,
    };
    this.#pair = pair;
    if (cycle === this.#cycle) {
      this.#trail.push({ who: "codex", round });
      if (geminiOut) this.#trail.push({ who: "gemini", round });
    }
    // Рецензенты независимы: зависший запуск одного не задерживает другого, и
    // панель видит проверку сразу, а не после отправок. Живой прогон 03.10:
    // ответ на возобновление ветки Codex не разобрался, его отправка не
    // завершалась, Gemini материала не получил, а панель показывала «Claude
    // работает».
    this.#refresh();
    const sends = [this.#send(codexOut)];
    if (geminiOut && this.#isCurrent(cycle)) {
      // Снятый процесс сначала дорабатывает остановку: два agy на одном
      // разговоре не нужны. Codex этого не ждёт. За время остановки пару
      // могли свести или засчитать Gemini «не проверял» (новая сессия) —
      // тогда материал уже не нужен, как и в #flushQueue (рецензия 03.10).
      sends.push(
        stopping
          ? stopping.then(async () => {
              if (this.#isCurrent(cycle) && this.#pair === pair && pair.waiting.has("gemini")) await this.#send(geminiOut);
            })
          : this.#send(geminiOut),
      );
    }
    await Promise.all(sends);
    this.#refresh();
  }

  #clearPair(): void {
    if (this.#pair?.deadline) clearTimeout(this.#pair.deadline);
    this.#pair = undefined;
  }

  /** Ответ рецензента: поздний — не входит; сбой Codex — остановка; Gemini без проверки — «не проверял». */
  async #reviewFinished(agent: Reviewer, target: Target, material: PanelEvent[], ended: PanelEvent): Promise<void> {
    const pair = this.#pair;
    if (
      agent === "gemini" &&
      pair?.overdue &&
      pair.cycle === target.cycle &&
      pair.round === target.round &&
      this.#isCurrent(pair.cycle) &&
      !pair.waiting.has("gemini")
    ) {
      // Поздний отзыв принимается один раз. Страховка: цель проверки N уходит
      // Gemini один раз, первый поздний ответ её забирает, и второй конец хода
      // приходит прямым — сюда он при настоящей работе не доходит.
      pair.overdue = false;
      await this.#lateGemini(pair, material, ended);
      return;
    }
    if (!pair || pair.cycle !== target.cycle || pair.round !== target.round || !pair.waiting.has(agent)) {
      this.#report(`Поздний ответ ${NAMES[agent]} (проверка ${target.round ?? "?"}) в проверку не вошёл: она уже сведена или снята.`);
      return;
    }
    if (agent === "codex" && ended.failed) {
      this.#stage = "stopped";
      this.#clearPair();
      this.#report("Ход Codex завершился с ошибкой — цикл рецензии остановлен.");
      return;
    }
    const text = material
      .filter((e) => e.kind === "message" && e.text)
      .map((e) => e.text as string)
      .join("\n\n");
    const problem = agent === "gemini" ? (ended.failed ? ended.text || "ход завершился с ошибкой" : ended.incomplete) : undefined;
    const outcome: ReviewOutcome = problem
      ? { kind: "unchecked", reason: problem }
      : { kind: "verdict", verdict: parseVerdict(text), text, snapshot: this.#snapshots.get(agent) };
    await this.#recordOutcome(pair, agent, outcome);
  }

  async #recordOutcome(pair: ReviewPair, agent: Reviewer, outcome: ReviewOutcome): Promise<void> {
    if (!pair.waiting.delete(agent)) return;
    pair.outcomes.set(agent, outcome);
    const step = [...this.#trail].reverse().find((sh) => sh.who === agent && sh.round === pair.round);
    if (step && outcome.kind === "verdict") step.mark = MARKS[outcome.verdict];
    if (step && outcome.kind === "unchecked") step.unchecked = outcome.reason;
    if (pair.waiting.size === 0) {
      if (pair.deadline) clearTimeout(pair.deadline);
      pair.deadline = undefined;
      await this.#mergePair(pair);
    } else if (agent === "codex") {
      this.#watchGemini(pair);
    }
    this.#refresh();
  }

  /**
   * Codex ответил, Gemini ещё нет. Срок зависит от вердикта Codex (R1, дизайн
   * 03.10): при замечаниях Claude простаивает — ждём geminiWaitMs и сводим по
   * Codex, не останавливая Gemini; при принятии, просьбе решения или без
   * вердикта итог без Gemini был бы ложным — ждём, пока он работает, и
   * снимаем только по молчанию или пределу безопасности. Прежде один срок
   * в 10 мин сводил пару без Gemini, что бы Codex ни сказал, а процесс
   * работал дальше и держал очередь (живой прогон 03.10).
   */
  #watchGemini(pair: ReviewPair): void {
    const codex = pair.outcomes.get("codex");
    pair.codexAt = Date.now();
    pair.limit =
      codex?.kind === "verdict" && codex.verdict === "remarks"
        ? (this.options.geminiWaitMs ?? GEMINI_WAIT_MS)
        : (this.options.geminiSafetyMs ?? GEMINI_SAFETY_MS);
    this.#geminiTick(pair);
  }

  /** Ход Gemini, идущий сейчас (голова его целей), — проверка именно этой пары (R3). */
  #geminiOnPair(pair: ReviewPair): boolean {
    const head = this.#targets.get("gemini")?.[0];
    return head?.role === "review" && head.cycle === pair.cycle && head.round === pair.round;
  }

  /**
   * Часы Gemini (R3). Срок — от ответа Codex: он ограничивает простой Claude
   * (при замечаниях) или ожидание итога (иначе), и передача материала позже
   * его не продлевает (рецензия 03.10: иначе 20 минут становились почти 40,
   * 45 — почти 90). Молчание — от позднего из двух моментов, ответа Codex и
   * передачи материала (он мог ждать в очереди за прямым вопросом): признаки
   * жизни — вывод процесса и события, но только пока его ход — эта проверка.
   */
  #geminiClock(pair: ReviewPair): { ours: boolean; capAt: number; alive: number } | undefined {
    if (pair.codexAt === undefined || pair.limit === undefined) return undefined;
    const ours = this.#geminiOnPair(pair);
    const start = Math.max(pair.codexAt, pair.geminiSentAt ?? pair.codexAt);
    const output = ours ? (this.options.gemini?.lastOutputAt ?? 0) : 0;
    const event = ours ? (pair.lastEventAt ?? 0) : 0;
    return { ours, capAt: pair.codexAt + pair.limit, alive: Math.max(start, output, event) };
  }

  /** Срок ожидания Gemini для «Эстафеты»: только пока Codex ответил, а Gemini ещё проверяет. */
  #waitUntil(pair: ReviewPair): number | undefined {
    return pair.waiting.has("gemini") ? this.#geminiClock(pair)?.capAt : undefined;
  }

  /** Одни часы на пару (R4); unref — открытая панель не держит процесс (и тесты) живыми. */
  #armGemini(pair: ReviewPair, delay: number): void {
    if (pair.deadline) clearTimeout(pair.deadline);
    // setTimeout дольше 2^31−1 мс срабатывает сразу — огромный срок из настроек не должен крутить часы.
    pair.deadline = setTimeout(() => this.#geminiTick(pair), Math.min(Math.max(1, delay), 2_147_483_647));
    pair.deadline.unref();
  }

  /** Срабатывание часов: молчание, срок или перестановка часов на ближайший из них. */
  #geminiTick(pair: ReviewPair): void {
    if (pair.deadline) clearTimeout(pair.deadline); // вызов не из часов (#watchGemini) — часов не двое
    pair.deadline = undefined;
    if (this.#pair !== pair || !this.#isCurrent(pair.cycle)) return;
    if (!pair.waiting.has("gemini")) {
      if (pair.overdue) this.#overdueTick(pair);
      return;
    }
    const clock = this.#geminiClock(pair);
    if (!clock || pair.limit === undefined) return;
    const { ours, capAt, alive } = clock;
    const now = Date.now();
    const silence = this.options.geminiSilenceMs ?? GEMINI_SILENCE_MS;
    const limit = waitWords(pair.limit);
    // Предел безопасности — от ответа Codex при любом вердикте (рецензия 03.10,
    // проверка 2): срок при замечаниях из настроек может быть длиннее его.
    const safetyAt = (pair.codexAt as number) + (this.options.geminiSafetyMs ?? GEMINI_SAFETY_MS);
    if (ours && now >= alive + silence) {
      pair.note = this.#silenceNote(pair, silence, alive);
      void this.#stopGeminiReview(pair, `замолчал на ${waitWords(silence)} — остановлен`);
      return;
    }
    if (ours && now >= safetyAt && safetyAt < capAt) {
      pair.note = this.#safetyNote(pair);
      void this.#stopGeminiReview(pair, this.#safetyReason());
      return;
    }
    if (now < capAt) {
      this.#armGemini(pair, Math.min(capAt, ours ? Math.min(alive + silence, safetyAt) : capAt) - now);
      return;
    }
    if (!ours) {
      // Gemini занят другим ходом (прямой вопрос человека): его не снимаем,
      // а материал этой проверки ему уже не нужен — снять из очереди сразу.
      for (let i = this.#queue.length - 1; i >= 0; i -= 1) {
        const o = this.#queue[i];
        if (o && o.to === "gemini" && o.target.role === "review" && o.target.cycle === pair.cycle && o.target.round === pair.round) {
          this.#queue.splice(i, 1);
        }
      }
      pair.note = `Gemini был занят другим ходом и проверку ${pair.round} не начал. Итог — по Codex.`;
      void this.#recordOutcome(pair, "gemini", {
        kind: "unchecked",
        reason: `был занят другим ходом — материал проверки ${pair.round} не дошёл`,
      });
      return;
    }
    const codex = pair.outcomes.get("codex");
    if (codex?.kind === "verdict" && codex.verdict === "remarks") {
      // Claude простаивает — замечания Codex уходят ему, а Gemini работает
      // дальше: его поздний отзыв ещё может пригодиться (R7). Сторож
      // молчания и предела (#overdueTick) ставится сразу, а не после
      // сведения (рецензия 03.10, проверка 2): синхронная часть
      // #recordOutcome уже очистила часы, а сведение ещё ждёт снимок версии и
      // отправку Claude — всё это время опоздавший Gemini под контролем.
      pair.overdue = true;
      void this.#recordOutcome(pair, "gemini", { kind: "unchecked", reason: `не уложился в ${limit} после ответа Codex — ещё проверяет` });
      this.#geminiTick(pair);
      return;
    }
    pair.note = this.#safetyNote(pair);
    void this.#stopGeminiReview(pair, this.#safetyReason());
  }

  /** Строка итога пары, когда Gemini снят по молчанию. */
  #silenceNote(pair: ReviewPair, silence: number, alive: number): string {
    return (
      `Gemini ${waitWords(silence)} не подавал признаков жизни (последнее действие в ${clockTime(alive)}) — ` +
      `процесс остановлен. Итог проверки ${pair.round} — по Codex.`
    );
  }

  /** Строка итога пары, когда Gemini снят по пределу безопасности. */
  #safetyNote(pair: ReviewPair): string {
    return `Gemini не закончил за ${waitWords(this.options.geminiSafetyMs ?? GEMINI_SAFETY_MS)} после ответа Codex — процесс остановлен. Итог проверки ${pair.round} — по Codex.`;
  }

  #safetyReason(): string {
    return `не закончил за ${waitWords(this.options.geminiSafetyMs ?? GEMINI_SAFETY_MS)} после ответа Codex — остановлен`;
  }

  /**
   * Сторож опоздавшего Gemini (рецензия 03.10): пара уже сведена по Codex, а
   * Gemini ещё проверяет. Молчание и предел безопасности от ответа Codex
   * действуют и здесь; снятие пару заново не сводит — только освобождает
   * Gemini для очереди (прямой вопрос человека). Ход Gemini уже не эта
   * проверка (закончил, снят) — сторож больше не нужен.
   */
  #overdueTick(pair: ReviewPair): void {
    const clock = this.#geminiClock(pair);
    if (!clock || pair.codexAt === undefined || !clock.ours) {
      pair.overdue = false;
      return;
    }
    const now = Date.now();
    const silence = this.options.geminiSilenceMs ?? GEMINI_SILENCE_MS;
    const safety = this.options.geminiSafetyMs ?? GEMINI_SAFETY_MS;
    const safetyAt = pair.codexAt + safety;
    const who = `Gemini, опоздавший к проверке ${pair.round},`;
    if (now >= clock.alive + silence) {
      void this.#stopOverdueGemini(pair, {
        reason: `замолчал на ${waitWords(silence)} — остановлен`,
        note: this.#silenceNote(pair, silence, clock.alive),
        line: `${who} ${waitWords(silence)} не подавал признаков жизни (последнее действие в ${clockTime(clock.alive)}) — процесс остановлен; его отзыва не будет.`,
      });
      return;
    }
    if (now >= safetyAt) {
      void this.#stopOverdueGemini(pair, {
        reason: this.#safetyReason(),
        note: this.#safetyNote(pair),
        line: `${who} не закончил за ${waitWords(safety)} после ответа Codex — процесс остановлен; его отзыва не будет.`,
      });
      return;
    }
    this.#armGemini(pair, Math.min(clock.alive + silence, safetyAt) - now);
  }

  /**
   * Снять опоздавшего Gemini. Сведение ещё ждёт снимок (pair.merging) — исход
   * и строка итога заменяются на остановку, и сведение скажет о ней само,
   * а не «ещё проверяет»; иначе пара уже сведена — отдельная строка ленты.
   */
  async #stopOverdueGemini(pair: ReviewPair, stop: { reason: string; note: string; line: string }): Promise<void> {
    pair.overdue = false;
    const merging = pair.merging === true;
    if (merging) {
      pair.outcomes.set("gemini", { kind: "unchecked", reason: stop.reason });
      const step = [...this.#trail].reverse().find((sh) => sh.who === "gemini" && sh.round === pair.round);
      if (step) step.unchecked = stop.reason;
      pair.note = stop.note;
    }
    await this.#cutGemini("interrupt");
    if (!merging) this.#report(stop.line);
    await this.#flushQueue();
    this.#refresh();
  }

  /** Снять проверку Gemini этой пары (молчание, предел безопасности) и свести пару по Codex. */
  async #stopGeminiReview(pair: ReviewPair, reason: string): Promise<void> {
    await this.#cutGemini("interrupt");
    if (this.#pair === pair && this.#isCurrent(pair.cycle)) {
      await this.#recordOutcome(pair, "gemini", { kind: "unchecked", reason });
    }
    await this.#flushQueue();
    this.#refresh();
  }

  /**
   * Снять ход Gemini, начатый панелью (R5). Всё до первого ожидания —
   * синхронно: расход хода (turn_completed у снятого хода не будет), затем
   * цели и материал — иначе конец следующего хода взял бы цель снятого, — и
   * только потом остановка. Вызывающий ждёт возвращённое обещание.
   */
  #cutGemini(how: "interrupt" | "forget"): Promise<void> {
    const gemini = this.options.gemini;
    if (!gemini) return Promise.resolve();
    const head = this.#targets.get("gemini")?.[0];
    const partial = gemini.pendingUsage;
    if (partial && head?.cycle !== undefined && head.cycle === this.#cycle) {
      this.#usage.gemini = addUsage(this.#usage.gemini, partial);
    }
    this.#targets.delete("gemini");
    this.#buffers.delete("gemini");
    // Новая сессия не помнит прерванного хода — пометка ей не нужна.
    this.#geminiCut = how === "interrupt";
    const stopping = how === "interrupt" ? gemini.interrupt() : (gemini.forgetSession?.() ?? Promise.resolve());
    return stopping.catch(() => undefined);
  }

  /**
   * Каскад (R6): ход Gemini — проверка, не относящаяся к начинающейся паре
   * (cycle, round) или к новой задаче (undefined). Идёт — снять и сказать;
   * не идёт — убрать оставшиеся цели. Прямой вопрос человека не трогается.
   */
  #dropStaleGemini(cycle: number | undefined, round: number | undefined, why: string): Promise<void> | undefined {
    const gemini = this.options.gemini;
    const head = this.#targets.get("gemini")?.[0];
    if (!gemini || head?.role !== "review" || (head.cycle === cycle && head.round === round)) return undefined;
    if (!gemini.busy) {
      this.#targets.delete("gemini");
      this.#buffers.delete("gemini");
      return undefined;
    }
    const stopping = this.#cutGemini("interrupt");
    this.#report(`Поздняя проверка Gemini (проверка ${head.round ?? "?"}) снята: ${why}.`);
    return stopping;
  }

  /**
   * Поздний отзыв Gemini после срока при замечаниях Codex (R7). Удержанные
   * замечания этой пары ещё не ушли — отзыв входит в них; иначе Claude уже
   * работает по замечаниям Codex, и отзыв остаётся в ленте.
   */
  async #lateGemini(pair: ReviewPair, material: PanelEvent[], ended: PanelEvent): Promise<void> {
    const problem = ended.failed ? ended.text || "ход завершился с ошибкой" : ended.incomplete;
    if (problem) {
      this.#report(`Gemini так и не дал проверки ${pair.round}: ${problem}.`);
      return;
    }
    const text = material
      .filter((e) => e.kind === "message" && e.text)
      .map((e) => e.text as string)
      .join("\n\n");
    const late: VerdictOutcome = { kind: "verdict", verdict: parseVerdict(text), text, snapshot: this.#snapshots.get("gemini") };
    const v = late.verdict;
    pair.outcomes.set("gemini", late);
    if (pair.deadline) clearTimeout(pair.deadline); // сторож опоздавшего больше не нужен
    pair.deadline = undefined;
    const step = [...this.#trail].reverse().find((sh) => sh.who === "gemini" && sh.round === pair.round);
    if (step) {
      step.mark = MARKS[v];
      delete step.unchecked;
    }
    // Сведение ещё ждёт снимок версии: отзыв войдёт в итог (#mergePair читает
    // исход Gemini после снимка) — ни удержанного, ни отправленного ещё нет.
    if (pair.merging) {
      this.#refresh();
      return;
    }
    const codex = pair.outcomes.get("codex");
    const held = this.#held;
    const n = pair.round;
    if (codex && held && held.pairRound === pair.round && held.target.cycle === pair.cycle) {
      if (v === "accepted") {
        this.#report(`Gemini опоздал к проверке ${n}: принято.`);
      } else {
        this.#held = {
          ...held,
          prompt: { ...held.prompt, text: mergedText(n, codex, late, held.snapshot) },
          ...(v === "human" ? { reason: humanHoldReason(codex, late) } : {}),
        };
        this.#verdict = strictest([...(codex.kind === "verdict" ? [codex.verdict] : []), v]);
        this.#report(`Gemini опоздал к проверке ${n}, но успел до отправки: его отзыв добавлен к удержанным замечаниям.`);
      }
    } else {
      // Удержана другая передача (проверка N+1 по пределу или без
      // автопересылки, повтор после отказов): Claude уже закончил работу по
      // замечаниям Codex и ждёт человека — «Claude работает» было бы
      // неправдой (рецензия 03.10).
      const waits = held !== undefined && this.#stage === "held";
      const next = held?.action === "review" ? `; если отправите проверку ${n + 1}, Gemini получит её вместе с Codex` : "";
      const words: Record<Verdict, string> = {
        remarks: waits
          ? `Gemini опоздал к проверке ${n}: есть замечания (текст выше). Claude их не получил — он уже закончил ` +
            `работу по замечаниям Codex, и обмен ждёт вашего решения${next}.`
          : `Gemini опоздал к проверке ${n}: есть замечания (текст выше). Claude их не получил — он уже работает ` +
            `по замечаниям Codex; проверку ${n + 1} Gemini получит вместе с Codex.`,
        accepted: `Gemini опоздал к проверке ${n}: принято.`,
        human: waits
          ? `Gemini опоздал к проверке ${n} и просит вашего решения (текст выше); Claude уже закончил работу по ` +
            "замечаниям Codex, и обмен ждёт вашего решения."
          : `Gemini опоздал к проверке ${n} и просит вашего решения (текст выше); Claude работает по замечаниям ` +
            "Codex — при необходимости остановите его.",
        missing: `Gemini опоздал к проверке ${n} и не вынес вердикт (ответ выше).`,
      };
      this.#report(words[v]);
    }
    this.#refresh();
  }

  /** Сведение: строже побеждает; сбой Gemini — итог по Codex. */
  async #mergePair(pair: ReviewPair): Promise<void> {
    const codex = pair.outcomes.get("codex");
    if (!codex || codex.kind !== "verdict") return;
    if (!pair.outcomes.get("gemini")) {
      await this.#afterReview(codex, pair.cycle);
      return;
    }
    // Снимок — до чтения исхода Gemini (рецензия 03.10): поздний отзыв,
    // пришедший, пока снимок снимается, входит в итог, а не остаётся вне
    // замечаний со строкой «Claude уже работает».
    pair.merging = true;
    let current: Snapshot;
    try {
      current = await this.#capture(this.options.cwd);
    } finally {
      pair.merging = false;
    }
    if (!this.#isCurrent(pair.cycle)) return;
    const gemini = pair.outcomes.get("gemini") as ReviewOutcome;
    const verdicts: Verdict[] = [codex.verdict, ...(gemini.kind === "verdict" ? [gemini.verdict] : [])];
    const combined = strictest(verdicts);
    this.#verdict = combined;
    const geminiWords = gemini.kind === "verdict" ? VERDICT_WORDS[gemini.verdict] : `не проверял (${gemini.reason})`;
    this.#report(`Итог проверки ${pair.round}: Codex — ${VERDICT_WORDS[codex.verdict]}, Gemini — ${geminiWords}.`);
    if (gemini.kind === "unchecked") {
      // Сроки Gemini объясняются одной своей строкой (R13); прочие причины
      // (новая сессия, сбой, отказ отправки, пустой ответ) — общей.
      this.#report(pair.overdue ? this.#overdueNote(pair) : (pair.note ?? `Gemini не проверял: ${gemini.reason}. Итог — по вердикту Codex.`));
    }
    if (combined === "accepted") {
      this.#stage = "accepted";
      // Gemini не проверял — принятие на самом деле вынес один Codex, и
      // ленте не следует говорить «рецензенты» во множественном (T7-wording).
      const who = gemini.kind === "unchecked" ? "Codex принял работу (Gemini не проверял)." : "Рецензенты приняли работу.";
      this.#report(`${who} Цикл завершён.${movedNote(codex.snapshot, current)}`);
      return;
    }
    const outgoing: Outgoing = {
      to: "claude",
      prompt: {
        text: mergedText(pair.round, codex, gemini, current),
        from: "codex",
        heading: "[замечания рецензентов Codex и Gemini]",
        snapshot: describeSnapshot(codex.snapshot ?? current),
      },
      target: { role: "work", cycle: pair.cycle },
      snapshot: current,
    };
    // Удержанное помечено номером проверки: поздний отзыв Gemini к ней ещё
    // можно добавить, пока человек не отправил (R7).
    const hold = (reason: string) => {
      this.#hold(outgoing, reason);
      if (this.#held) this.#held.pairRound = pair.round;
    };
    if (combined === "human") {
      hold(humanHoldReason(codex, gemini));
      return;
    }
    if (combined === "missing") {
      const silent = whoSaid("missing", codex, gemini);
      hold(`${silent} ${silent.includes(" и ") ? "не вынесли" : "не вынес"} вердикт: решите, передавать ли отзывы разработчику.`);
      return;
    }
    if (this.#overLimit()) {
      hold(this.#limitReason("замечания ждут отправки разработчику"));
      return;
    }
    if (!this.#auto) {
      hold("Автопересылка выключена: замечания ждут отправки разработчику.");
      return;
    }
    this.#stage = "working";
    await this.#send(outgoing);
  }

  /** Пояснение к сроку при замечаниях Codex: что будет с поздним отзывом Gemini. */
  #overdueNote(pair: ReviewPair): string {
    const limit = waitWords(pair.limit ?? this.options.geminiWaitMs ?? GEMINI_WAIT_MS);
    // Сведение при замечаниях Codex удерживает только по пределу токенов или
    // выключенной автопересылке — те же условия, что ниже в #mergePair.
    return this.#overLimit() || !this.#auto
      ? `Gemini не уложился в ${limit} и ещё проверяет: если он закончит, пока замечания ждут вашего решения, его отзыв будет добавлен к ним.`
      : `Gemini не уложился в ${limit} и ещё проверяет: Claude получил замечания одного Codex. Если Gemini закончит до проверки ${pair.round + 1}, его ответ появится в ленте.`;
  }

  /** Комната без Gemini: прежний путь одного Codex. */
  async #afterReview(codex: VerdictOutcome, cycle: number): Promise<void> {
    const { verdict, text } = codex;
    this.#verdict = verdict;
    // Замечания относятся к версии, которую рецензент проверял. Текущая
    // снимается отдельно: разработчик работает уже с ней, и если дерево
    // ушло вперёд, это надо сказать, а не подменить подпись.
    const reviewed = codex.snapshot;
    const snapshot = await this.#capture(this.options.cwd);
    if (!this.#isCurrent(cycle)) return;
    if (verdict === "accepted") {
      this.#stage = "accepted";
      this.#report(`Рецензент принял работу. Цикл завершён.${movedNote(reviewed, snapshot)}`);
      return;
    }
    const shift =
      reviewed && reviewed.id !== snapshot.id
        ? `\n\nФайлы изменились после начала проверки: замечания относятся к версии ${describeSnapshot(reviewed)}, сейчас ${describeSnapshot(snapshot)}.`
        : "";
    const outgoing: Outgoing = {
      to: "claude",
      prompt: {
        text: `Замечания рецензента:\n${text}${shift}\n\nИсправьте или обоснуйте несогласие по каждому пункту.`,
        from: "codex",
        snapshot: describeSnapshot(reviewed ?? snapshot),
      },
      target: { role: "work", cycle },
      snapshot,
    };
    if (verdict === "human") {
      this.#hold(outgoing, "Рецензент просит вашего решения: обмен остановлен. Ответ Codex можно отправить Claude.");
      return;
    }
    if (verdict === "missing") {
      this.#hold(outgoing, "Рецензент не вынес вердикт: решите, передавать ли его ответ разработчику.");
      return;
    }
    if (this.#overLimit()) {
      this.#hold(outgoing, this.#limitReason("замечания ждут отправки разработчику"));
      return;
    }
    if (!this.#auto) {
      this.#hold(outgoing, "Автопересылка выключена: замечания ждут отправки разработчику.");
      return;
    }
    this.#stage = "working";
    await this.#send(outgoing);
  }

  #hold(outgoing: Outgoing, reason: string, action: "send" | "retry" = "send", companion?: Outgoing): void {
    this.#held = { ...outgoing, reason, action: companion ? "review" : action, ...(companion ? { companion } : {}) };
    if (outgoing.target.cycle === this.#cycle) this.#trail.push({ who: "you" });
    this.#stage = "held";
    this.#report(reason);
  }

  async #agentCrashed(agent: Worker, reason?: string): Promise<void> {
    const pending = this.#targets.get(agent) ?? [];
    this.#targets.delete(agent);
    this.#buffers.delete(agent);
    if (agent === "gemini") {
      // Gemini — не арбитр: его сбой — «не проверял», цикл идёт с Codex.
      // Причина хода — слова самой ошибки (T7-crash), а не общая заглушка.
      const pair = this.#pair;
      if (pair && this.#isCurrent(pair.cycle) && pending.some((t) => t.role === "review" && t.cycle === pair.cycle && t.round === pair.round)) {
        await this.#recordOutcome(pair, "gemini", { kind: "unchecked", reason: reason ?? "процесс Gemini завершился" });
      }
    } else if (pending.some((c) => c.cycle !== undefined && this.#isCurrent(c.cycle))) {
      this.#stage = "stopped";
      this.#clearPair();
      this.#report(`Процесс ${NAMES[agent]} завершился — ждать ответа нельзя, цикл остановлен.`);
    }
    await this.#flushQueue();
    this.#refresh();
  }

  #take(agent: AgentId): PanelEvent[] {
    const material = this.#buffers.get(agent) ?? [];
    this.#buffers.set(agent, []);
    return material;
  }

  async #send(o: Outgoing): Promise<void> {
    const adapter = this.#adapter(o.to);
    if (!adapter) {
      this.#report(`${NAMES[o.to]} не подключён — сообщение не отправлено.`);
      return;
    }
    if (adapter.busy) {
      // Новее от того же цикла тому же адресату вытесняет старое.
      if (o.target.cycle !== undefined) {
        for (let i = this.#queue.length - 1; i >= 0; i -= 1) {
          const s = this.#queue[i];
          if (s && s.to === o.to && s.target.cycle === o.target.cycle) this.#queue.splice(i, 1);
        }
      }
      this.#queue.push(o);
      return;
    }
    if (o.snapshot) this.#snapshots.set(o.to, o.snapshot);
    if (o.to === "claude" && o.target.role === "work") this.#lastWork = o;
    // След проверки пишет #startPair до отправки; здесь — только работа Claude.
    if (o.to === "claude" && o.target.role === "work" && o.target.cycle !== undefined && o.target.cycle === this.#cycle) {
      this.#trail.push({ who: "claude" });
    }
    this.#buffers.set(o.to, []);

    // Цель регистрируется ДО отправки: быстрый агент может завершить ход,
    // пока отправка ещё не вернула управление.
    const targets = this.#targets.get(o.to) ?? [];
    const target = { ...o.target };
    targets.push(target);
    this.#targets.set(o.to, targets);

    // Материал проверки действительно отдан Gemini: с этого момента идёт его
    // срок, если материал ждал в очереди дольше ответа Codex (R3).
    const reviewed = this.#pair;
    if (o.to === "gemini" && o.target.role === "review" && reviewed && reviewed.cycle === o.target.cycle && reviewed.round === o.target.round) {
      reviewed.geminiSentAt = Date.now();
      if (reviewed.codexAt !== undefined && reviewed.waiting.has("gemini")) {
        // Часы стояли на прежнем сроке без молчания: при ответе Codex ход
        // Gemini был чужим. Теперь он наш — переставить их на ближайшее из
        // молчания и срока, иначе зависший после передачи Gemini снимался бы
        // только по пределу (рецензия 03.10).
        this.#geminiTick(reviewed);
        this.#refresh(); // срок в «Эстафете» сдвинулся
      }
    }
    // Первое сообщение после хода, снятого панелью, говорит об этом (R11).
    const cutNote = o.to === "gemini" && this.#geminiCut;
    if (cutNote) this.#geminiCut = false;
    const prompt: AgentPrompt = cutNote ? { ...o.prompt, text: `${CUT_NOTE}${NL}${o.prompt.text}` } : o.prompt;

    try {
      await adapter.send(prompt);
    } catch (err) {
      if (cutNote) this.#geminiCut = true; // пометка не дошла — нужна следующему
      const list = this.#targets.get(o.to);
      const i = list?.indexOf(target) ?? -1;
      if (list && i >= 0) list.splice(i, 1);
      const reason = (err as Error).message;
      if (o.to === "gemini" && o.target.role === "review") {
        // Gemini не запустился (нет правил, нет agy, регион): «не проверял», цикл идёт с Codex.
        const pair = this.#pair;
        if (pair && pair.cycle === o.target.cycle && pair.round === o.target.round) {
          await this.#recordOutcome(pair, "gemini", { kind: "unchecked", reason });
        }
        return;
      }
      this.handle({
        id: `x${Date.now().toString(36)}`,
        agent: o.to,
        kind: "error",
        visibility: "turn",
        at: Date.now(),
        text: `не удалось отправить: ${reason}`,
      });
      if (o.target.cycle !== undefined && o.target.cycle === this.#cycle) {
        this.#stage = "stopped";
        this.#report(`Отправка ${NAMES[o.to]} не удалась — цикл остановлен.`);
      }
    }
  }

  async #flushQueue(): Promise<void> {
    for (let i = 0; i < this.#queue.length; ) {
      const o = this.#queue[i];
      if (!o) {
        i += 1;
        continue;
      }
      // Пересылка нетекущего цикла устарела: отбросить, а не доставить.
      if (o.target.cycle !== undefined && !this.#isCurrent(o.target.cycle)) {
        this.#queue.splice(i, 1);
        continue;
      }
      // Проверка Gemini устарела внутри ТЕКУЩЕГО цикла: пара, которой она
      // адресована, уже сведена (срок истёк, Codex не прошёл, пара снята)
      // или это не та пара, которую мы ждём. Доставлять её освободившемуся
      // Gemini незачем — ответ придёт «поздним» и потратит его квоту впустую.
      if (
        o.to === "gemini" &&
        o.target.role === "review" &&
        !(this.#pair && this.#pair.cycle === o.target.cycle && this.#pair.round === o.target.round && this.#pair.waiting.has("gemini"))
      ) {
        this.#queue.splice(i, 1);
        continue;
      }
      const adapter = this.#adapter(o.to);
      if (!adapter) {
        // Агента нет в комнате: ждать нечего, сообщение снимается.
        this.#queue.splice(i, 1);
        continue;
      }
      if (adapter.busy) {
        i += 1;
        continue;
      }
      this.#queue.splice(i, 1);
      await this.#send(o);
    }
  }

  #adapter(agent: AgentId): Adapter | undefined {
    if (agent === "claude") return this.claude;
    if (agent === "codex") return this.codex;
    if (agent === "gemini") return this.options.gemini;
    return undefined;
  }

  #adapters(): Adapter[] {
    return [this.claude, this.codex, ...(this.options.gemini ? [this.options.gemini] : [])];
  }

  #reviewers(): Reviewer[] {
    return this.options.gemini ? ["codex", "gemini"] : ["codex"];
  }

  #report(text: string): void {
    const event: PanelEvent = {
      id: `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      agent: "system",
      kind: "message",
      visibility: "turn",
      at: Date.now(),
      text: text,
    };
    this.journal.append(this.options.room, event);
    this.options.onEvent(event);
  }

  #refresh(): void {
    this.options.onState?.(this.state);
  }
}

const NAMES: Record<AgentId, string> = {
  claude: "Claude",
  codex: "Codex",
  gemini: "Gemini",
  human: "человека",
  system: "панели",
};

/** Сколько символов выводов инструментов по умолчанию уходит рецензенту за одну проверку. */
export const EVIDENCE_BUDGET = 240_000;

const NL = String.fromCharCode(10);

/**
 * Выводы инструментов уходят рецензенту целиком, пока вместе помещаются в
 * бюджет проверки. Иначе бюджет делится между ними (evidenceCap): вывод длиннее
 * своей доли — начало и конец с указанием пропущенного диапазона, и заголовок
 * говорит «неполный». Неполным бывает и вывод короче всего бюджета, поэтому
 * пояснение говорит о доле (прежнее «длиннее бюджета проверки» с этим
 * расходилось — рецензия Trading 03.10). Прежде рецензенту уходил текст,
 * обрезанный для показа (64 000 символов), а пометка «сырой вывод» завышала
 * полноту переданного — замечание исследования Codex 27.09.2026.
 */
const ABOUT_TRUNCATION =
  "У каждого вывода инструмента в заголовке указана полнота. «Полный» — передан целиком. " +
  "«Неполный» — вывод не поместился в свою долю бюджета проверки (бюджет общий на все выводы): " +
  "показаны начало и конец, пропущенный диапазон указан внутри вывода. Полный вывод хранится " +
  "в журнале панели — если он нужен, попросите человека.";

/** Заметки памяти — справка, а не поручение: агент должен это различать. */
const ABOUT_MEMORY =
  "Ниже — заметки из памяти проекта, найденные панелью по словам этого сообщения. Это не слова человека, " +
  "а справка: у заметок бывают даты, оговорки и поздние исправления — проверяйте их, прежде чем опираться.";

/** Что копится для передачи. Поток, диагностика и рассуждения — нет. */
const FORWARDED_KINDS = new Set<PanelEvent["kind"]>(["message", "tool_call", "tool_result"]);

/** Число с пробелами между разрядами: 99 005. */
function groupDigits(n: number): string {
  const digits = String(n);
  let result = "";
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) result += " ";
    result += digits[i];
  }
  return result;
}

function charsLabel(n: number): string {
  const lastTwo = n % 100;
  const ones = n % 10;
  const form =
    lastTwo > 10 && lastTwo < 20
      ? "символов"
      : ones === 1
        ? "символ"
        : ones >= 2 && ones <= 4
          ? "символа"
          : "символов";
  return `${groupDigits(n)} ${form}`;
}

/**
 * Предел длины одного вывода при общем бюджете: короткие выводы идут целиком,
 * остаток бюджета делится поровну между длинными. Infinity — режется ничего.
 */
export function evidenceCap(lengths: readonly number[], budget: number): number {
  if (lengths.reduce((sum, length) => sum + length, 0) <= budget) return Infinity;
  const ascending = [...lengths].sort((a, b) => a - b);
  let remainder = budget;
  let remaining = ascending.length;
  for (const length of ascending) {
    if (length > remainder / remaining) break;
    remainder -= length;
    remaining -= 1;
  }
  return Math.max(0, Math.floor(remainder / remaining));
}

/** Начало и конец текста в пределе; пропущенный диапазон назван словами. */
function excerpt(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const head = Math.floor(limit / 2);
  const tail = limit - head;
  const skipped =
    `[… пропущены символы ${groupDigits(head + 1)}–${groupDigits(text.length - tail)} ` +
    `из ${groupDigits(text.length)} …]`;
  return `${text.slice(0, head)}${NL}${skipped}${NL}${text.slice(text.length - tail)}`;
}

function time(at: number): string {
  return `${new Date(at).toISOString().slice(11, 19)} UTC`;
}

/** Материал для другого агента; у каждого вывода инструмента — источник и полнота. */
function assemble(
  material: PanelEvent[],
  withTools: boolean,
  budget: number = EVIDENCE_BUDGET,
): string | undefined {
  const toolOutputs = withTools ? material.filter((e) => e.kind === "tool_result") : [];
  const otherItems = material
    .filter((e) => e.kind !== "tool_result")
    .reduce((sum, e) => sum + (e.text?.length ?? 0), 0);
  // Реплики и вызовы идут целиком; выводам — остаток, но не меньше пятой части.
  const limit = evidenceCap(
    toolOutputs.map((e) => (e.full ?? e.text ?? "").length),
    Math.max(budget - otherItems, Math.floor(budget / 5)),
  );
  const parts: string[] = [];
  for (const e of material) {
    const subagent = e.parentCallId ? ` · субагент вызова ${e.parentCallId}` : "";
    const call = (e.callId ? ` · вызов ${e.callId}` : "") + subagent;
    if (e.kind === "message" && e.text && e.parentCallId) {
      // Слова субагента — не слова Claude.
      parts.push(`--- реплика субагента вызова ${e.parentCallId} ---${NL}${e.text}`);
    } else if (e.kind === "message" && e.text) parts.push(e.text);
    else if (withTools && e.kind === "tool_call") {
      parts.push(`--- вызов инструмента ${e.tool ?? "?"}${call} ---${NL}${e.text ?? ""}`);
    } else if (withTools && e.kind === "tool_result") {
      const full = e.full ?? e.text ?? "";
      const completeness =
        full.length <= limit
          ? `полный, ${charsLabel(full.length)}`
          : `неполный: показано ${groupDigits(limit)} из ${charsLabel(full.length)}`;
      parts.push(
        `--- СЫРОЙ вывод инструмента ${e.tool ?? "?"}${call} · ${completeness} · ${time(e.at)} ---${NL}` +
          excerpt(full, limit),
      );
    }
  }
  const text = parts.join(`${NL}${NL}`).trim();
  return text.length > 0 ? text : undefined;
}
