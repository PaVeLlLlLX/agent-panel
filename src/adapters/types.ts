/**
 * Общая модель событий комнаты.
 *
 * Зачем один тип на двух агентов. Claude отдаёт поток stream-json, Codex —
 * JSON-RPC нотификации app-server. Форматы разные, но панели и журналу нужно
 * одно и то же: кто, что и в каком состоянии. Если каждый адаптер понесёт в
 * интерфейс свою структуру, различать состояния придётся в UI, и любое
 * изменение протокола потечёт до разметки.
 *
 * Различение состояний обязательно, и это не украшение: завершение генерации
 * аргументов инструмента ещё НЕ означает, что инструмент выполнен. Панель,
 * показывающая одно вместо другого, врёт о том, что происходит.
 */

/**
 * Кто произвёл событие. `human` нужен, чтобы журнал был полным; `system` —
 * служебные сообщения панели. Без него «Предел раундов достигнут» в живом
 * прогоне показывался как реплика человека.
 */
export type AgentId = "claude" | "codex" | "human" | "system";

/**
 * Видимость события.
 *
 * `stream` — для человека, появляется по мере получения, второму агенту НЕ
 * передаётся. `turn` — законченная реплика, её можно передавать.
 *
 * Разделение существенно: если пересылать каждую дельту, каждая новая буква
 * запускала бы очередной ответ второго агента.
 */
export type Visibility = "stream" | "turn";

export type EventKind =
  /** Прирост текста. Только для показа человеку. */
  | "text_delta"
  /** Законченная реплика агента. Пригодна для передачи второму агенту. */
  | "message"
  /** Агент СФОРМИРОВАЛ вызов инструмента. Выполнение ещё не началось. */
  | "tool_call"
  /** Инструмент выполняется. */
  | "tool_running"
  /** Результат инструмента получен. Сырой, не пересказ агента. */
  | "tool_result"
  /** Начало и конец хода. */
  | "turn_started"
  | "turn_completed"
  /** Запрос одобрения от агента к клиенту (запись, команда, патч). */
  | "approval_requested"
  /** Решение по запросу одобрения, с причиной. */
  | "approval_decided"
  /** Сбой адаптера или агента. */
  | "error"
  /**
   * Служебный вывод процесса: логи stderr, запуск, плановая остановка.
   * Не реплика беседы. В живом прогоне лог Codex показался красной
   * репликой — отсюда отдельный вид.
   */
  | "diagnostic";

export interface PanelEvent {
  readonly id: string;
  readonly agent: AgentId;
  readonly kind: EventKind;
  readonly visibility: Visibility;
  /** Миллисекунды epoch. Порядок в журнале задаётся не этим, а seq. */
  readonly at: number;
  /** Текст для показа. Для tool_result — сырой вывод, обрезанный по длине. */
  readonly text?: string;
  /** Имя инструмента для tool_* событий. */
  readonly tool?: string;
  /** Идентификатор вызова инструмента: связывает call, running и result. */
  readonly callId?: string;
  /**
   * У запроса и решения разрешения callId — id запроса, а это — id вызова
   * инструмента, о котором спрашивают (у Claude tool_use_id). По нему панель
   * окрашивает бусину вызова, когда человек отказал.
   */
  readonly toolCallId?: string;
  /**
   * Вызов инструмента, запустивший субагента, чьё это действие или реплика
   * (у Claude — parent_tool_use_id). Нет — действие самого агента.
   */
  readonly parentCallId?: string;
  /** У turn_completed: токены хода. */
  readonly usage?: TurnUsage;
  /** У turn_completed: последнее сведение о лимите агента. */
  readonly limit?: LimitInfo;
  /** Ход, в который вошло событие. */
  readonly turnId?: string;
  /**
   * Версия файлов, к которой относится событие.
   *
   * Обязательна для рецензии: если разработчик продолжил правки после начала
   * проверки, замечания относятся к предыдущему снимку, и панель должна это
   * показать. Иначе агенты будут спорить о разных состояниях кода.
   */
  readonly snapshot?: string;
  /** Необработанная запись протокола — для разбора расхождений. */
  readonly raw?: unknown;
  /**
   * Полный текст, если `text` обрезан для показа. Нужен рецензенту: он не
   * запускает команды и зависит от вывода, который ему принесли. В журнал не
   * пишется (там есть `raw`), в webview не уходит — см. forDisplay.
   */
  readonly full?: string;
  /**
   * Ожидаемый результат не будет получен: у turn_completed — ход провалился
   * или прерван, у error — процесс агента умер. Координатор по этой отметке
   * перестаёт ждать ответа.
   */
  readonly failed?: boolean;
  /**
   * Отказы в разрешениях за ход, по строке на отказ: «Bash: git …».
   * Приходят при is_error: false, поэтому по failed их не отличить.
   */
  readonly denials?: readonly string[];
  /**
   * У approval_requested: правила, которые добавит «разрешить в этой сессии»,
   * в виде «Bash(mkdir x *)». Пусто — такой кнопки нет.
   */
  readonly sessionRules?: readonly string[];
}

/**
 * Решение человека по запросу разрешения: разрешить один раз, разрешить
 * такие вызовы до конца сессии агента, отклонить.
 */
export type ApprovalChoice = "allow" | "allowSession" | "deny";

/**
 * Модель, которую может выбрать человек. Список берётся у самого агента, а не
 * зашивается в код: модели меняются с версиями CLI. id "" — модель агента по
 * умолчанию; efforts пуст — уровня рассуждения у модели нет.
 */
export interface ModelOption {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly efforts: readonly string[];
  /** Уровень, который агент берёт, если не выбран никакой. */
  readonly defaultEffort?: string;
}

/** Выбор человека: модель и уровень рассуждения; "" — по умолчанию. */
export interface ModelChoice {
  readonly model: string;
  readonly effort: string;
}

/** Что панель просит агента сделать. */
export interface AgentPrompt {
  readonly text: string;
  /** Откуда пришло: человек или второй агент. Попадает в журнал. */
  readonly from: AgentId;
  /** Снимок версии, на который агент должен смотреть. */
  readonly snapshot?: string;
}

/**
 * Решение по запросу одобрения.
 *
 * Причина обязательна. Отказ без причины неотличим от сбоя, а панель должна
 * показывать человеку, ПОЧЕМУ рецензенту запрещено писать.
 */
export interface ApprovalDecision {
  readonly allow: boolean;
  readonly reason: string;
}

export interface Adapter {
  readonly id: AgentId;
  /** Запустить процесс агента. Повторный вызов на запущенном — ошибка. */
  start(): Promise<void>;
  /**
   * Отправить ввод. Если процесс не запущен — запускает его: агенты
   * поднимаются при первом сообщении, а не при открытии панели.
   */
  send(prompt: AgentPrompt): Promise<void>;
  /** Прервать текущий ход, не убивая процесс. */
  interrupt(): Promise<void>;
  /** Остановить процесс. */
  stop(): Promise<void>;
  /**
   * Ответить на запрос разрешения, который агент ждёт от человека.
   * false — запроса нет: уже решён или процесс, задавший его, остановлен.
   * Нет метода — агент разрешений у человека не спрашивает.
   */
  answerApproval?(id: string, choice: ApprovalChoice): Promise<boolean>;
  /** Модели агента. Поднимает отдельный короткий процесс: рабочая сессия не создаётся. */
  listModels?(): Promise<readonly ModelOption[]>;
  /** Модель и уровень со следующего хода; идущий ход не меняется. */
  setModel?(choice: ModelChoice): void;
  /**
   * Режим разрешений агента. Флаг запуска действует со следующего хода; до
   * перезапуска «без вопросов» исполняет сама панель.
   */
  setPermissionMode?(mode: string): void;
  /** Занят ли агент ходом прямо сейчас. */
  readonly busy: boolean;
  /** Идентификатор сессии агента, если известен: нужен для восстановления. */
  readonly sessionId: string | undefined;
}

export type EventSink = (event: PanelEvent) => void;

/** Токены хода: весь вход (вместе с кешем), из него — из кеша, и выход. */
export interface TurnUsage {
  readonly input: number;
  readonly cached: number;
  readonly output: number;
}

export const NO_USAGE: TurnUsage = { input: 0, cached: 0, output: 0 };

export function addUsage(а: TurnUsage, б: TurnUsage): TurnUsage {
  return { input: а.input + б.input, cached: а.cached + б.cached, output: а.output + б.output };
}

/**
 * Последнее сведение о лимите агента. Claude сообщает только статус окна
 * (rate_limit_event), Codex — долю использованного окна (account/rateLimits/updated).
 */
export interface LimitInfo {
  readonly status?: string;
  readonly percent?: number;
  readonly window?: string;
  /** Миллисекунды epoch. */
  readonly resetsAt?: number;
}

/** Предел длины текста события. Сырые выводы инструментов бывают огромными. */
export const MAX_TEXT = 64_000;

export function clamp(text: string, max = MAX_TEXT): string {
  if (text.length <= max) return text;
  const отрезано = text.length - max;
  return `${text.slice(0, max)}\n… обрезано ${отрезано} символов`;
}

/** Текст для показа и, если он обрезан, полный — для рецензента. */
export function clampKeepingFull(text: string): { text: string; full?: string } {
  return text.length > MAX_TEXT ? { text: clamp(text), full: text } : { text };
}

/**
 * Событие для webview: без полной записи протокола и полного текста. Интерфейсу
 * они не нужны, а один длинный вывод команды — это мегабайты в каждом
 * сообщении webview.
 */
export function forDisplay(событие: PanelEvent): PanelEvent {
  if (событие.raw === undefined && событие.full === undefined) return событие;
  const { raw: _raw, full: _full, ...лёгкое } = событие;
  return лёгкое;
}

/** Цветовые коды терминала: в панели они видны как мусор вида `[2m…[0m`. */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}

let счётчик = 0;
export function newEventId(): string {
  счётчик += 1;
  return `e${Date.now().toString(36)}-${счётчик.toString(36)}`;
}
