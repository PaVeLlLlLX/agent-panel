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
  /** Сколько ждать Gemini после ответа Codex, мс (GEMINI_WAIT_MS). */
  readonly geminiWaitMs?: number;
}

type Role = "work" | "review" | "direct";

/** Сколько ждать Gemini после ответа Codex, по умолчанию (agentPanel.geminiWaitMinutes). */
export const GEMINI_WAIT_MS = 10 * 60_000;

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
  deadline: NodeJS.Timeout | undefined;
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

/** Напоминание о полосах Gemini к каждой проверке; роль целиком — в agent.md (geminiSetup.ts). */
const GEMINI_FOCUS =
  "Ты второй рецензент: проверь методологию эксперимента (чек-лист: утечки, разбиения, метрики, бейзлайн, " +
  "сиды и разброс, обоснованность выводов — у каждого пункта «свидетельство: …» или «пробел: …») и факты " +
  "вне репозитория (с адресом страницы и датой проверки). Код целиком не перепроверяй — это делает Codex. " +
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

function reviewBlock(title: string, outcome: ReviewOutcome, current: Snapshot): string {
  // Причина отказа — не замечание к работе разработчика, поэтому Claude её не
  // видит здесь: она остаётся в строке ленты «Gemini не проверял: …» (M5).
  if (outcome.kind === "unchecked") return `— ${title} — не проверял (это не замечание, исправлять нечего)`;
  if (outcome.verdict === "accepted") return `— ${title} — принято`;
  const shift =
    outcome.snapshot && outcome.snapshot.id !== current.id
      ? `\n\nФайлы изменились после начала проверки: замечания относятся к версии ${describeSnapshot(outcome.snapshot)}, сейчас ${describeSnapshot(current)}.`
      : "";
  return `— ${title} —\n${outcome.text}${shift}`;
}

function pairView(pair: ReviewPair, reviewers: readonly Reviewer[]): PairView {
  const sides: Partial<Record<Reviewer, PairSide>> = {};
  for (const r of reviewers) {
    const outcome = pair.outcomes.get(r);
    sides[r] = !outcome
      ? { state: "waiting" }
      : outcome.kind === "verdict"
        ? { state: "done", verdict: outcome.verdict }
        : { state: "unchecked", reason: outcome.reason };
  }
  return { round: pair.round, sides };
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
  /** Открытые запросы разрешений: id запроса → агент, который спросил. */
  readonly #requests = new Map<string, AgentId>();
  /** Заметки памяти, приложенные к задаче текущего цикла: их видит и рецензент. */
  #taskMemory: string | undefined;
  #trail: Step[] = [];
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
      approvals: this.#requests.size,
      trail: this.#trail.map((sh) => ({ ...sh })),
      auto: this.#auto,
      claudeBusy: this.claude.busy,
      codexBusy: this.codex.busy,
      geminiBusy: this.options.gemini?.busy ?? false,
      reviewers: this.#reviewers(),
      pair: this.#pair ? pairView(this.#pair, this.#reviewers()) : undefined,
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

    if (marked.visibility === "turn" && FORWARDED_KINDS.has(marked.kind)) {
      const buffer = this.#buffers.get(worker) ?? [];
      buffer.push(marked);
      this.#buffers.set(worker, buffer);
    }

    if (worker === "claude" && marked.kind === "turn_completed") void this.refreshClaudeUsage();
    if (worker === "gemini" && marked.kind === "turn_completed") void this.refreshGeminiUsage();

    if (marked.kind === "approval_requested" && marked.callId) {
      this.#requests.set(marked.callId, worker);
      this.#refresh();
    } else if (marked.kind === "approval_decided" && marked.callId) {
      this.#requests.delete(marked.callId);
      this.#refresh();
    } else if (marked.kind === "turn_completed" && marked.unsolicited) {
      if (marked.limit) this.#limits[worker] = marked.limit;
      void this.#autonomousFinished(worker);
    } else if (marked.kind === "turn_completed") {
      if (marked.limit) this.#limits[worker] = marked.limit;
      void this.#turnFinished(worker, marked);
    } else if (marked.kind === "error" && marked.failed) {
      for (const [id, who] of this.#requests) if (who === worker) this.#requests.delete(id);
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
    const adapter = this.#adapter(agent);
    if (!adapter) return;
    const accepted = (await adapter.answerApproval?.(id, choice)) ?? false;
    // Не принят — запрос уже закрыт на стороне агента; карточка не должна висеть.
    if (!accepted) this.#requests.delete(id);
    this.#refresh();
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
    if (agent === "gemini") {
      // Gemini — не арбитр: новая сессия для него не должна рвать весь цикл
      // (M6, финальная рецензия 02.10). Если пара сейчас ждёт его ответа,
      // засчитать «не проверял» и дать Codex доводить проверку одному —
      // #resetWait здесь не нужен, процесс всё равно остановит forgetSession ниже.
      const pair = this.#pair;
      if (pair && this.#isCurrent(pair.cycle) && pair.waiting.has("gemini")) {
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
    await adapter.forgetSession?.();
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
    this.#pair = {
      cycle,
      round,
      waiting: new Set<Reviewer>(geminiOut ? ["codex", "gemini"] : ["codex"]),
      outcomes: new Map(),
      deadline: undefined,
    };
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
    if (geminiOut && this.#isCurrent(cycle)) sends.push(this.#send(geminiOut));
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

  /** Codex ответил — Gemini ждём не дольше geminiWaitMs; не успел — «не проверял». */
  #watchGemini(pair: ReviewPair): void {
    const limit = this.options.geminiWaitMs ?? GEMINI_WAIT_MS;
    pair.deadline = setTimeout(() => {
      pair.deadline = undefined;
      if (this.#pair !== pair || !this.#isCurrent(pair.cycle)) return;
      void this.#recordOutcome(pair, "gemini", { kind: "unchecked", reason: `не успел за ${waitWords(limit)} после ответа Codex` });
    }, limit);
  }

  /** Сведение: строже побеждает; сбой Gemini — итог по Codex. */
  async #mergePair(pair: ReviewPair): Promise<void> {
    const codex = pair.outcomes.get("codex");
    if (!codex || codex.kind !== "verdict") return;
    const gemini = pair.outcomes.get("gemini");
    if (!gemini) {
      await this.#afterReview(codex, pair.cycle);
      return;
    }
    const verdicts: Verdict[] = [codex.verdict, ...(gemini.kind === "verdict" ? [gemini.verdict] : [])];
    const combined: Verdict = verdicts.includes("human")
      ? "human"
      : verdicts.includes("missing")
        ? "missing"
        : verdicts.includes("remarks")
          ? "remarks"
          : "accepted";
    this.#verdict = combined;
    const geminiWords = gemini.kind === "verdict" ? VERDICT_WORDS[gemini.verdict] : `не проверял (${gemini.reason})`;
    this.#report(`Итог проверки ${pair.round}: Codex — ${VERDICT_WORDS[codex.verdict]}, Gemini — ${geminiWords}.`);
    if (gemini.kind === "unchecked") this.#report(`Gemini не проверял: ${gemini.reason}. Итог — по вердикту Codex.`);
    const current = await this.#capture(this.options.cwd);
    if (!this.#isCurrent(pair.cycle)) return;
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
        text:
          `Замечания рецензентов (проверка ${pair.round}):\n\n` +
          `${reviewBlock("Codex — код", codex, current)}\n\n` +
          `${reviewBlock("Gemini — методология и факты", gemini, current)}\n\n` +
          "Исправьте или обоснуйте несогласие по каждому пункту.",
        from: "codex",
        heading: "[замечания рецензентов Codex и Gemini]",
        snapshot: describeSnapshot(codex.snapshot ?? current),
      },
      target: { role: "work", cycle: pair.cycle },
      snapshot: current,
    };
    const who = (v: Verdict) =>
      [codex, gemini]
        .filter((o) => o.kind === "verdict" && o.verdict === v)
        .map((o) => (o === codex ? "Codex" : "Gemini"))
        .join(" и ");
    if (combined === "human") {
      const asking = who("human");
      this.#hold(outgoing, `${asking} ${asking.includes(" и ") ? "просят" : "просит"} вашего решения: обмен остановлен. Отзывы можно отправить Claude.`);
      return;
    }
    if (combined === "missing") {
      const silent = who("missing");
      this.#hold(outgoing, `${silent} ${silent.includes(" и ") ? "не вынесли" : "не вынес"} вердикт: решите, передавать ли отзывы разработчику.`);
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

    try {
      await adapter.send(o.prompt);
    } catch (err) {
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
 * Выводы инструментов уходят рецензенту целиком, пока помещаются в бюджет
 * проверки. Длиннее — начало и конец с указанием пропущенного диапазона, и
 * заголовок говорит «неполный». Прежде рецензенту уходил текст, обрезанный
 * для показа (64 000 символов), а пометка «сырой вывод» завышала полноту
 * переданного — замечание исследования Codex 27.09.2026.
 */
const ABOUT_TRUNCATION =
  "У каждого вывода инструмента в заголовке указана полнота. «Полный» — передан целиком. " +
  "«Неполный» — вывод длиннее бюджета проверки: показаны начало и конец, пропущенный диапазон " +
  "указан внутри вывода. Полный вывод хранится в журнале панели — если он нужен, попросите человека.";

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
