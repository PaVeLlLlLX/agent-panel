/**
 * Координатор комнаты: кто кому что передаёт и когда остановиться.
 *
 * Живой прогон 14 сентября показал, что прежний порядок разговора не работает.
 * Сообщение уходило обоим сразу, ответы расходились по времени, и Claude пять
 * секунд спорил с замечанием, которое Codex уже отозвал. Отсюда устройство:
 *
 * **Три маршрута с разным смыслом.**
 *   review — задача с рецензией: Claude работает, Codex проверяет, строго по
 *            очереди, пока рецензент не примет работу;
 *   both   — вопрос обоим: оба отвечают независимо, друг другу ничего не
 *            пересылается;
 *   claude / codex — прямой вопрос одному, без пересылки.
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
import { Adapter, AgentId, AgentPrompt, ApprovalChoice, PanelEvent } from "./adapters/types.js";
import { Journal } from "./journal.js";
import { Snapshot, describeSnapshot, takeSnapshot } from "./snapshot.js";
import { VERDICT_REQUEST, Verdict, parseVerdict } from "./verdict.js";

export type Route = "review" | "both" | "claude" | "codex";

export type Stage = "idle" | "working" | "reviewing" | "held" | "accepted" | "stopped";

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
    | { readonly to: AgentId; readonly reason: string; readonly action: "send" | "retry" }
    | undefined;
  readonly queued: number;
  /** Запросы разрешений, ждущие ответа человека. Пока они есть, ход агента стоит. */
  readonly approvals: number;
  readonly auto: boolean;
  readonly claudeBusy: boolean;
  readonly codexBusy: boolean;
  readonly snapshot: string | undefined;
}

export interface CoordinatorOptions {
  readonly room: string;
  readonly cwd: string;
  readonly maxAutoRounds: number;
  readonly onEvent: (событие: PanelEvent) => void;
  readonly onState?: (состояние: RoomState) => void;
  /** Снимок версии файлов. Подменяется в тестах, чтобы воспроизводить гонки. */
  readonly snapshot?: (cwd: string) => Promise<Snapshot>;
}

type Роль = "work" | "review" | "direct";

interface Цель {
  readonly роль: Роль;
  /** Номер цикла; у прямого вопроса отсутствует. */
  readonly цикл: number | undefined;
}

interface Отправка {
  readonly to: AgentId;
  readonly prompt: AgentPrompt;
  readonly цель: Цель;
  readonly снимок: Snapshot | undefined;
}

type Удержанное = Отправка & { причина: string; действие: "send" | "retry" };

export class Coordinator {
  #цикл = 0;
  #этап: Stage = "idle";
  #задача: string | undefined;
  #раунд = 0;
  #вердикт: Verdict | undefined;
  #удержано: Удержанное | undefined;
  /** Последняя рабочая отправка Claude в цикле — для повтора после отказов. */
  #последняяРабота: Отправка | undefined;
  #автоматика = true;
  #снимокКомнаты: Snapshot | undefined;
  readonly #снимки = new Map<AgentId, Snapshot>();
  readonly #накопители = new Map<AgentId, PanelEvent[]>();
  readonly #цели = new Map<AgentId, Цель[]>();
  readonly #очередь: Отправка[] = [];
  /** Открытые запросы разрешений: id запроса → агент, который спросил. */
  readonly #запросы = new Map<string, AgentId>();
  readonly #снять: (cwd: string) => Promise<Snapshot>;

  constructor(
    private readonly claude: Adapter,
    private readonly codex: Adapter,
    private readonly journal: Journal,
    private readonly опции: CoordinatorOptions,
  ) {
    this.#снять = опции.snapshot ?? takeSnapshot;
  }

  get round(): number {
    return this.#раунд;
  }

  get snapshot(): Snapshot | undefined {
    return this.#снимокКомнаты;
  }

  get state(): RoomState {
    return {
      task: this.#задача,
      stage: this.#этап,
      round: this.#раунд,
      maxRounds: this.опции.maxAutoRounds,
      verdict: this.#вердикт,
      held: this.#удержано
        ? { to: this.#удержано.to, reason: this.#удержано.причина, action: this.#удержано.действие }
        : undefined,
      queued: this.#очередь.length,
      approvals: this.#запросы.size,
      auto: this.#автоматика,
      claudeBusy: this.claude.busy,
      codexBusy: this.codex.busy,
      snapshot: this.#снимокКомнаты?.id,
    };
  }

  handle(событие: PanelEvent): void {
    const агент = событие.agent;
    const снимок =
      агент === "claude" || агент === "codex"
        ? (this.#снимки.get(агент) ?? this.#снимокКомнаты)
        : this.#снимокКомнаты;
    const сПометкой: PanelEvent = снимок ? { ...событие, snapshot: снимок.id } : событие;
    this.journal.append(this.опции.room, сПометкой);
    this.опции.onEvent(сПометкой);

    if (агент !== "claude" && агент !== "codex") return;

    if (сПометкой.visibility === "turn" && ПЕРЕДАВАЕМЫЕ.has(сПометкой.kind)) {
      const накопитель = this.#накопители.get(агент) ?? [];
      накопитель.push(сПометкой);
      this.#накопители.set(агент, накопитель);
    }

    if (сПометкой.kind === "approval_requested" && сПометкой.callId) {
      this.#запросы.set(сПометкой.callId, агент);
      this.#обновить();
    } else if (сПометкой.kind === "approval_decided" && сПометкой.callId) {
      this.#запросы.delete(сПометкой.callId);
      this.#обновить();
    } else if (сПометкой.kind === "turn_completed") {
      void this.#ходЗакончен(агент, сПометкой.failed === true, сПометкой.denials ?? []);
    } else if (сПометкой.kind === "error" && сПометкой.failed) {
      for (const [id, кто] of this.#запросы) if (кто === агент) this.#запросы.delete(id);
      void this.#агентУпал(агент);
    } else if (сПометкой.kind === "turn_started") {
      this.#обновить();
    }
  }

  async fromHuman(текст: string, маршрут: Route): Promise<void> {
    // Новая задача регистрируется ДО ожидания снимка: иначе продолжение
    // прежнего цикла, ждущее тот же снимок, успело бы отправить устаревшее.
    const цикл = маршрут === "review" ? this.#начатьЦикл(текст) : undefined;
    this.#обновить();

    this.#снимокКомнаты = await this.#снять(this.опции.cwd);
    this.handle({
      id: `h${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      agent: "human",
      kind: "message",
      visibility: "turn",
      at: Date.now(),
      text: текст,
    });
    const prompt: AgentPrompt = {
      text: текст,
      from: "human",
      snapshot: describeSnapshot(this.#снимокКомнаты),
    };

    if (цикл !== undefined) {
      if (!this.#текущий(цикл)) return;
      await this.#отправить({
        to: "claude",
        prompt,
        цель: { роль: "work", цикл },
        снимок: this.#снимокКомнаты,
      });
    } else {
      const прямо: Цель = { роль: "direct", цикл: undefined };
      for (const кому of маршрут === "both" ? (["claude", "codex"] as const) : [маршрут as AgentId]) {
        await this.#отправить({ to: кому, prompt, цель: прямо, снимок: this.#снимокКомнаты });
      }
    }
    this.#обновить();
  }

  /** Отправить удержанное по команде человека. */
  async releaseHeld(): Promise<void> {
    const у = this.#удержано;
    if (!у) return;
    this.#удержано = undefined;
    if (у.цель.цикл !== undefined && у.цель.цикл !== this.#цикл) {
      this.#обновить();
      return;
    }
    if (у.цель.роль === "review") this.#раунд += 1;
    this.#этап = у.цель.роль === "review" ? "reviewing" : "working";
    await this.#отправить(у);
    this.#обновить();
  }

  /** Решение человека по запросу разрешения — адаптеру того агента, который спросил. */
  async answerApproval(id: string, выбор: ApprovalChoice): Promise<void> {
    const агент = this.#запросы.get(id);
    if (!агент) return;
    const адаптер = агент === "claude" ? this.claude : this.codex;
    const принято = (await адаптер.answerApproval?.(id, выбор)) ?? false;
    // Не принят — запрос уже закрыт на стороне агента; карточка не должна висеть.
    if (!принято) this.#запросы.delete(id);
    this.#обновить();
  }

  /** Служебное сообщение панели в беседу и журнал — например, о смене модели. */
  notice(текст: string): void {
    this.#сообщить(текст);
  }

  setAuto(включена: boolean): void {
    this.#автоматика = включена;
    this.#обновить();
  }

  async stopAll(): Promise<void> {
    this.#сброситьОжидание("stopped");
    this.#очередь.length = 0;
    await Promise.allSettled([this.claude.stop(), this.codex.stop()]);
    this.#обновить();
  }

  async interruptAll(): Promise<void> {
    this.#сброситьОжидание("stopped");
    await Promise.allSettled([this.claude.interrupt(), this.codex.interrupt()]);
    this.#сообщить("Ход прерван человеком. Цикл рецензии остановлен.");
    this.#обновить();
  }

  // -------------------------------------------------------------------------

  /** Цикл текущий и не остановлен: только тогда продолжение имеет право действовать. */
  #текущий(цикл: number): boolean {
    return цикл === this.#цикл && this.#этап !== "stopped";
  }

  #начатьЦикл(задача: string): number {
    const устаревшие = this.#убратьПересылкиЦиклов();
    if (устаревшие > 0) {
      this.#сообщить(`Новая задача: не доставлено устаревших пересылок прежней — ${устаревшие}.`);
    }
    this.#цикл += 1;
    this.#удержано = undefined;
    this.#последняяРабота = undefined;
    this.#задача = задача;
    this.#раунд = 0;
    this.#вердикт = undefined;
    this.#этап = "working";
    return this.#цикл;
  }

  #сброситьОжидание(этап: Stage): void {
    this.#убратьПересылкиЦиклов();
    this.#цикл += 1; // всё, что принадлежало прежнему циклу, теперь чужое
    this.#цели.clear();
    this.#удержано = undefined;
    // Адаптеры закрывают свои запросы при остановке; здесь — на случай,
    // если закрытие не дойдёт (адаптер уже без процесса).
    this.#запросы.clear();
    this.#этап = этап;
  }

  /** Убрать из очереди всё, что относится к циклам; прямые сообщения человека остаются. */
  #убратьПересылкиЦиклов(): number {
    let убрано = 0;
    for (let i = this.#очередь.length - 1; i >= 0; i -= 1) {
      if (this.#очередь[i]?.цель.цикл !== undefined) {
        this.#очередь.splice(i, 1);
        убрано += 1;
      }
    }
    return убрано;
  }

  async #ходЗакончен(агент: AgentId, провал: boolean, отказы: readonly string[]): Promise<void> {
    const цель = this.#цели.get(агент)?.shift() ?? { роль: "direct", цикл: undefined };
    const материал = this.#забрать(агент);
    const цикл = цель.цикл;
    const текущий = цикл !== undefined && this.#текущий(цикл);

    if (текущий && провал) {
      this.#этап = "stopped";
      this.#сообщить(`Ход ${ИМЕНА[агент]} завершился с ошибкой — цикл рецензии остановлен.`);
    } else if (текущий && цель.роль === "work" && отказы.length > 0) {
      // Отказы — дело человека, а не рецензента: в живом прогоне три раунда
      // проверки ушли на спор о причинах блокировки.
      const повтор = this.#последняяРабота;
      if (повтор) {
        this.#удержать(
          повтор,
          `Claude получил отказы в разрешениях (${отказы.length}): ${отказы.join("; ")}. ` +
            "Проверка не запускалась. Разрешите эти действия или измените задачу, затем повторите.",
          "retry",
        );
      }
    } else if (текущий && цель.роль === "work") {
      await this.#послеРаботы(материал, цикл, this.#задача ?? "");
    } else if (текущий && цель.роль === "review") {
      await this.#послеПроверки(материал, цикл);
    } else if (отказы.length > 0) {
      this.#сообщить(`${ИМЕНА[агент]} получил отказы в разрешениях (${отказы.length}): ${отказы.join("; ")}.`);
    }

    await this.#выгрузитьОчередь();
    this.#обновить();
  }

  async #послеРаботы(материал: PanelEvent[], цикл: number, задача: string): Promise<void> {
    const текст = собрать(материал, true);
    if (!текст) {
      this.#этап = "stopped";
      this.#сообщить("Claude не выдал законченной реплики — проверять нечего.");
      return;
    }
    const снимок = await this.#снять(this.опции.cwd);
    if (!this.#текущий(цикл)) return;

    const отправка: Отправка = {
      to: "codex",
      prompt: {
        text: `Задача человека:\n${задача}\n\nМатериал разработчика:\n${текст}\n\n${VERDICT_REQUEST}`,
        from: "claude",
        snapshot: describeSnapshot(снимок),
      },
      цель: { роль: "review", цикл },
      снимок,
    };

    if (this.#раунд >= this.опции.maxAutoRounds) {
      this.#удержать(
        отправка,
        `Предел проверок (${this.опции.maxAutoRounds}) достигнут: работа Claude не проверена рецензентом.`,
      );
      return;
    }
    if (!this.#автоматика) {
      this.#удержать(отправка, "Автопересылка выключена: работа Claude ждёт отправки рецензенту.");
      return;
    }
    this.#раунд += 1;
    this.#этап = "reviewing";
    await this.#отправить(отправка);
  }

  async #послеПроверки(материал: PanelEvent[], цикл: number): Promise<void> {
    const текст = материал
      .filter((е) => е.kind === "message" && е.text)
      .map((е) => е.text as string)
      .join("\n\n");
    const вердикт = parseVerdict(текст);
    this.#вердикт = вердикт;

    if (вердикт === "accepted") {
      this.#этап = "accepted";
      this.#сообщить("Рецензент принял работу. Цикл завершён.");
      return;
    }

    const снимок = await this.#снять(this.опции.cwd);
    if (!this.#текущий(цикл)) return;

    const отправка: Отправка = {
      to: "claude",
      prompt: {
        text: `Замечания рецензента:\n${текст}\n\nИсправьте или обоснуйте несогласие по каждому пункту.`,
        from: "codex",
        snapshot: describeSnapshot(снимок),
      },
      цель: { роль: "work", цикл },
      снимок,
    };

    if (вердикт === "missing") {
      this.#удержать(отправка, "Рецензент не вынес вердикт: решите, передавать ли его ответ разработчику.");
      return;
    }
    if (!this.#автоматика) {
      this.#удержать(отправка, "Автопересылка выключена: замечания ждут отправки разработчику.");
      return;
    }
    this.#этап = "working";
    await this.#отправить(отправка);
  }

  #удержать(отправка: Отправка, причина: string, действие: "send" | "retry" = "send"): void {
    this.#удержано = { ...отправка, причина, действие };
    this.#этап = "held";
    this.#сообщить(причина);
  }

  async #агентУпал(агент: AgentId): Promise<void> {
    const ждали = (this.#цели.get(агент) ?? []).some((ц) => ц.цикл !== undefined && this.#текущий(ц.цикл));
    this.#цели.delete(агент);
    this.#накопители.delete(агент);
    if (ждали) {
      this.#этап = "stopped";
      this.#сообщить(`Процесс ${ИМЕНА[агент]} завершился — ждать ответа нельзя, цикл остановлен.`);
    }
    await this.#выгрузитьОчередь();
    this.#обновить();
  }

  #забрать(агент: AgentId): PanelEvent[] {
    const материал = this.#накопители.get(агент) ?? [];
    this.#накопители.set(агент, []);
    return материал;
  }

  async #отправить(о: Отправка): Promise<void> {
    const адаптер = о.to === "claude" ? this.claude : this.codex;
    if (адаптер.busy) {
      // Новее от того же цикла тому же адресату вытесняет старое.
      if (о.цель.цикл !== undefined) {
        for (let i = this.#очередь.length - 1; i >= 0; i -= 1) {
          const с = this.#очередь[i];
          if (с && с.to === о.to && с.цель.цикл === о.цель.цикл) this.#очередь.splice(i, 1);
        }
      }
      this.#очередь.push(о);
      return;
    }
    if (о.снимок) this.#снимки.set(о.to, о.снимок);
    if (о.to === "claude" && о.цель.роль === "work") this.#последняяРабота = о;
    this.#накопители.set(о.to, []);

    // Цель регистрируется ДО отправки: быстрый агент может завершить ход,
    // пока отправка ещё не вернула управление.
    const цели = this.#цели.get(о.to) ?? [];
    const цель = { ...о.цель };
    цели.push(цель);
    this.#цели.set(о.to, цели);

    try {
      await адаптер.send(о.prompt);
    } catch (беда) {
      const список = this.#цели.get(о.to);
      const i = список?.indexOf(цель) ?? -1;
      if (список && i >= 0) список.splice(i, 1);
      this.handle({
        id: `x${Date.now().toString(36)}`,
        agent: о.to,
        kind: "error",
        visibility: "turn",
        at: Date.now(),
        text: `не удалось отправить: ${(беда as Error).message}`,
      });
      if (о.цель.цикл !== undefined && о.цель.цикл === this.#цикл) {
        this.#этап = "stopped";
        this.#сообщить(`Отправка ${ИМЕНА[о.to]} не удалась — цикл остановлен.`);
      }
    }
  }

  async #выгрузитьОчередь(): Promise<void> {
    for (let i = 0; i < this.#очередь.length; ) {
      const о = this.#очередь[i];
      if (!о) {
        i += 1;
        continue;
      }
      // Пересылка нетекущего цикла устарела: отбросить, а не доставить.
      if (о.цель.цикл !== undefined && !this.#текущий(о.цель.цикл)) {
        this.#очередь.splice(i, 1);
        continue;
      }
      const адаптер = о.to === "claude" ? this.claude : this.codex;
      if (адаптер.busy) {
        i += 1;
        continue;
      }
      this.#очередь.splice(i, 1);
      await this.#отправить(о);
    }
  }

  #сообщить(текст: string): void {
    const событие: PanelEvent = {
      id: `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      agent: "system",
      kind: "message",
      visibility: "turn",
      at: Date.now(),
      text: текст,
    };
    this.journal.append(this.опции.room, событие);
    this.опции.onEvent(событие);
  }

  #обновить(): void {
    this.опции.onState?.(this.state);
  }
}

const ИМЕНА: Record<AgentId, string> = {
  claude: "Claude",
  codex: "Codex",
  human: "человека",
  system: "панели",
};

/** Что копится для передачи. Поток, диагностика и рассуждения — нет. */
const ПЕРЕДАВАЕМЫЕ = new Set<PanelEvent["kind"]>(["message", "tool_call", "tool_result"]);

/** Материал для другого агента; вывод инструментов помечен как сырой. */
function собрать(материал: PanelEvent[], сИнструментами: boolean): string | undefined {
  const части: string[] = [];
  for (const е of материал) {
    if (е.kind === "message" && е.text) части.push(е.text);
    else if (сИнструментами && е.kind === "tool_call") {
      части.push(`--- вызов инструмента ${е.tool ?? "?"} ---\n${е.text ?? ""}`);
    } else if (сИнструментами && е.kind === "tool_result") {
      части.push(`--- СЫРОЙ вывод инструмента ${е.tool ?? "?"} ---\n${е.text ?? ""}`);
    }
  }
  const текст = части.join("\n\n").trim();
  return текст.length > 0 ? текст : undefined;
}
