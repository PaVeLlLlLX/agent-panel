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
export type AgentId = "claude" | "codex" | "gemini" | "human" | "system";

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
  | "diagnostic"
  /**
   * Действие человека в панели, кроме его сообщений: отправил удержанное,
   * переключил автопересылку. agent — human; лента показывает строкой
   * «Вы: …». Журнал 04–05.10: по нему этих решений было не восстановить.
   */
  | "action"
  /**
   * Материал проверки, ушедший рецензенту, — полный текст сообщения панели;
   * agent — рецензент, которому он ушёл. Только для журнала: в ленту не
   * идёт (это мегабайты), рецензентам дальше не пересылается.
   */
  | "material";

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
  /**
   * У turn_started и turn_completed: ход начат агентом без сообщения панели.
   * Claude так продолжает, когда кончилась его фоновая команда (живая трасса
   * 28.09, CLI 2.1.220). К задаче и к рецензии такой ход не относится.
   */
  readonly unsolicited?: boolean;
  /** У turn_completed: токены хода. Журнал хранит их (колонка usage). */
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
   * У turn_completed рецензента Gemini: ход кончился, а проверки не было —
   * пустой ответ или действие отклонено без запроса (живая проба agy
   * 02.10.2026). Причина словами; координатор засчитывает «не проверял».
   */
  readonly incomplete?: string;
  /**
   * У turn_completed: ход состоялся, но агент после ответа сообщил об ошибке
   * (agy: status ERROR при полном ответе — живой прогон 04.10). Текст ошибки.
   * Ход не провален, а лента показывает текст конца хода только у провала —
   * по этой отметке она показывает ошибку уведомлением.
   */
  readonly lateError?: string;
  /**
   * У approval_requested: правила, которые добавит «разрешить в этой сессии»,
   * в виде «Bash(mkdir x *)». Пусто — такой кнопки нет.
   */
  readonly sessionRules?: readonly string[];
  /**
   * У approval_requested вопроса Claude (AskUserQuestion): вопросы с
   * вариантами. Есть — это вопрос человеку, а не запрос разрешения: ответ
   * уходит через answerQuestion, «без вопросов» его не закрывает.
   */
  readonly questions?: readonly AskQuestion[];
}

/**
 * Вопрос Claude человеку — форма ввода AskUserQuestion (документация Agent
 * SDK, user-input, прочитано 05.10.2026; журнал панели, seq 66068).
 */
export interface AskQuestion {
  readonly question: string;
  /** Короткая подпись вопроса (до 12 символов по документации). */
  readonly header?: string;
  readonly options: readonly { readonly label: string; readonly description?: string }[];
  /** Можно выбрать несколько вариантов: ответ — метки через «, ». */
  readonly multiSelect?: boolean;
}

/** Предел одного ответа человека на вопрос: свой текст из поля «Свой ответ». */
const ANSWER_LIMIT = 4_000;

/**
 * Ответы на вопрос из webview — «текст вопроса → ответ». Сообщение webview —
 * ввод извне: всё, кроме непустого объекта строк не длиннее ANSWER_LIMIT, —
 * undefined. Пустой объект — «человек не ответил», а не ответ.
 */
export function questionAnswers(value: unknown): Record<string, string> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return undefined;
  if (entries.some(([, answer]) => typeof answer !== "string" || answer.length > ANSWER_LIMIT)) return undefined;
  return Object.fromEntries(entries) as Record<string, string>;
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
  /** Заголовок сообщения вместо выведенного из from — например «[замечания рецензентов Codex и Gemini]». */
  readonly heading?: string;
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
   * У вопроса (questions) принимается только отказ: «разрешить» без ответов
   * агент прочёл бы как «человек не ответил».
   * Нет метода — агент разрешений у человека не спрашивает.
   */
  answerApproval?(id: string, choice: ApprovalChoice): Promise<boolean>;
  /**
   * Ответ человека на вопрос агента: текст вопроса → метка варианта, метки
   * через «, » или свой текст. false — такого открытого вопроса нет или нет
   * ни одного ответа на заданный вопрос (тогда вопрос остаётся открытым).
   * Нет метода — агент вопросов человеку не задаёт.
   */
  answerQuestion?(id: string, answers: Readonly<Record<string, string>>): Promise<boolean>;
  /**
   * Новая сессия: процесс останавливается, следующий запуск начинается без
   * возобновления прежней сессии или ветки. Прежняя остаётся в истории агента.
   */
  forgetSession?(): Promise<void>;
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
  /**
   * Когда текущий процесс агента последний раз что-то вывел (строка stdout
   * или stderr), мс epoch. Признак жизни для срока молчания Gemini: его
   * адаптер не показывает шагов модели без текста и говорит о каждом
   * инструменте один раз, так что по событиям долгое рассуждение неотличимо
   * от зависания (живой прогон 03.10). Нет — агент такого не сообщает.
   */
  readonly lastOutputAt?: number | undefined;
  /**
   * Расход идущего хода до его конца; undefined — хода нет или расхода ещё
   * нет. Нужен, когда панель снимает ход сама: turn_completed у снятого хода
   * не будет, а потраченные токены — расход задачи.
   */
  readonly pendingUsage?: TurnUsage | undefined;
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

export function addUsage(a: TurnUsage, b: TurnUsage): TurnUsage {
  return { input: a.input + b.input, cached: a.cached + b.cached, output: a.output + b.output };
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

/**
 * Строка для всех агентов комнаты — просьба владельца 05.10 после живого
 * цикла, где отзыв субагента Codex («принято») сошёл за отзыв самого Codex.
 * Codex — первая строка роли (codex.ts), Gemini — в начале роли agy
 * (geminiSetup.ts), Claude — --append-system-prompt (claude.ts).
 */
export const HONESTY_LINE = "Будь честен в своём ответе.";

/** Предел длины текста события. Сырые выводы инструментов бывают огромными. */
export const MAX_TEXT = 64_000;

export function clamp(text: string, max = MAX_TEXT): string {
  if (text.length <= max) return text;
  const cutCount = text.length - max;
  return `${text.slice(0, max)}\n… обрезано ${cutCount} символов`;
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
export function forDisplay(event: PanelEvent): PanelEvent {
  if (event.raw === undefined && event.full === undefined) return event;
  const { raw: _raw, full: _full, ...light } = event;
  return light;
}

/** Цветовые коды терминала: в панели они видны как мусор вида `[2m…[0m`. */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}

let counter = 0;
export function newEventId(): string {
  counter += 1;
  return `e${Date.now().toString(36)}-${counter.toString(36)}`;
}
