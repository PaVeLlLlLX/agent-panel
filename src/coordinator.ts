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
 * предел, выключены автораунды — пересылка не уходит, но и не пропадает:
 * человек видит её и отправляет сам.
 *
 * **Каждый ход знает, зачем он.** Цель хода (работа в цикле, проверка в цикле
 * или прямой вопрос) записывается при отправке и снимается при завершении.
 * Иначе ответ на мимоходный вопрос ушёл бы рецензенту как работа по задаче.
 *
 * **Устаревшее не доставляется.** Новая задача отменяет пересылки прежней.
 *
 * Сохранены прежние правила: передаётся законченное, сырой вывод идёт
 * целиком, материал копится по агенту, снимок версии закреплён за ходом.
 */
import { Adapter, AgentId, AgentPrompt, PanelEvent } from "./adapters/types.js";
import { Journal } from "./journal.js";
import { Snapshot, describeSnapshot, takeSnapshot } from "./snapshot.js";
import { VERDICT_REQUEST, Verdict, parseVerdict } from "./verdict.js";

export type Route = "review" | "both" | "claude" | "codex";

export type Stage =
  | "idle"
  | "working"
  | "reviewing"
  | "held"
  | "accepted"
  | "stopped";

export interface RoomState {
  readonly task: string | undefined;
  readonly stage: Stage;
  readonly round: number;
  readonly maxRounds: number;
  readonly verdict: Verdict | undefined;
  readonly held: { readonly to: AgentId; readonly reason: string } | undefined;
  readonly queued: number;
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

export class Coordinator {
  #цикл = 0;
  #этап: Stage = "idle";
  #задача: string | undefined;
  #раунд = 0;
  #вердикт: Verdict | undefined;
  #удержано: (Отправка & { причина: string }) | undefined;
  #автоматика = true;
  #снимокКомнаты: Snapshot | undefined;
  readonly #снимки = new Map<AgentId, Snapshot>();
  readonly #накопители = new Map<AgentId, PanelEvent[]>();
  readonly #цели = new Map<AgentId, Цель[]>();
  readonly #очередь: Отправка[] = [];

  constructor(
    private readonly claude: Adapter,
    private readonly codex: Adapter,
    private readonly journal: Journal,
    private readonly опции: CoordinatorOptions,
  ) {}

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
        ? { to: this.#удержано.to, reason: this.#удержано.причина }
        : undefined,
      queued: this.#очередь.length,
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
    const сПометкой: PanelEvent = снимок
      ? { ...событие, snapshot: снимок.id }
      : событие;
    this.journal.append(this.опции.room, сПометкой);
    this.опции.onEvent(сПометкой);

    if (агент !== "claude" && агент !== "codex") return;

    if (сПометкой.visibility === "turn" && ПЕРЕДАВАЕМЫЕ.has(сПометкой.kind)) {
      const накопитель = this.#накопители.get(агент) ?? [];
      накопитель.push(сПометкой);
      this.#накопители.set(агент, накопитель);
    }

    if (сПометкой.kind === "turn_completed") {
      void this.#ходЗакончен(агент, сПометкой.failed === true);
    } else if (сПометкой.kind === "error" && сПометкой.failed) {
      void this.#агентУпал(агент);
    } else if (сПометкой.kind === "turn_started") {
      this.#обновить();
    }
  }

  async fromHuman(текст: string, маршрут: Route): Promise<void> {
    this.#снимокКомнаты = await takeSnapshot(this.опции.cwd);
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
    const прямо: Цель = { роль: "direct", цикл: undefined };

    if (маршрут === "review") {
      this.#начатьЦикл(текст);
      await this.#отправить({
        to: "claude",
        prompt,
        цель: { роль: "work", цикл: this.#цикл },
        снимок: this.#снимокКомнаты,
      });
    } else {
      for (const кому of маршрут === "both"
        ? (["claude", "codex"] as const)
        : [маршрут]) {
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
    if (у.цель.роль === "review") this.#раунд += 1;
    this.#этап = у.цель.роль === "review" ? "reviewing" : "working";
    await this.#отправить(у);
    this.#обновить();
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

  #начатьЦикл(задача: string): void {
    const устаревшие = this.#очередь.filter((о) => о.цель.цикл !== undefined);
    if (устаревшие.length > 0) {
      for (const о of устаревшие) this.#очередь.splice(this.#очередь.indexOf(о), 1);
      this.#сообщить(
        `Новая задача: не доставлено устаревших пересылок прежней — ${устаревшие.length}.`,
      );
    }
    if (this.#удержано?.цель.цикл !== undefined) this.#удержано = undefined;
    this.#цикл += 1;
    this.#задача = задача;
    this.#раунд = 0;
    this.#вердикт = undefined;
    this.#этап = "working";
  }

  #сброситьОжидание(этап: Stage): void {
    this.#цикл += 1; // всё, что принадлежало прежнему циклу, теперь чужое
    this.#цели.clear();
    this.#удержано = undefined;
    this.#этап = этап;
  }

  async #ходЗакончен(агент: AgentId, провал: boolean): Promise<void> {
    const цель = this.#цели.get(агент)?.shift() ?? { роль: "direct", цикл: undefined };
    const материал = this.#забрать(агент);
    const текущий = цель.цикл !== undefined && цель.цикл === this.#цикл;

    if (текущий && провал) {
      this.#этап = "stopped";
      this.#сообщить(
        `Ход ${ИМЕНА[агент]} завершился с ошибкой — цикл рецензии остановлен.`,
      );
    } else if (текущий && цель.роль === "work") {
      await this.#послеРаботы(материал);
    } else if (текущий && цель.роль === "review") {
      await this.#послеПроверки(материал);
    }

    await this.#выгрузитьОчередь();
    this.#обновить();
  }

  async #послеРаботы(материал: PanelEvent[]): Promise<void> {
    const текст = собрать(материал, true);
    if (!текст) {
      this.#этап = "stopped";
      this.#сообщить("Claude не выдал законченной реплики — проверять нечего.");
      return;
    }
    const снимок = await takeSnapshot(this.опции.cwd);
    const отправка: Отправка = {
      to: "codex",
      prompt: {
        text: `Задача человека:\n${this.#задача ?? ""}\n\nМатериал разработчика:\n${текст}\n\n${VERDICT_REQUEST}`,
        from: "claude",
        snapshot: describeSnapshot(снимок),
      },
      цель: { роль: "review", цикл: this.#цикл },
      снимок,
    };

    if (this.#раунд >= this.опции.maxAutoRounds) {
      this.#удержать(
        отправка,
        `Предел раундов (${this.опции.maxAutoRounds}) достигнут: работа Claude не проверена рецензентом.`,
      );
      return;
    }
    if (!this.#автоматика) {
      this.#удержать(отправка, "Автораунды выключены: работа Claude ждёт отправки рецензенту.");
      return;
    }
    this.#раунд += 1;
    this.#этап = "reviewing";
    await this.#отправить(отправка);
  }

  async #послеПроверки(материал: PanelEvent[]): Promise<void> {
    const реплики = материал
      .filter((е) => е.kind === "message" && е.text)
      .map((е) => е.text as string);
    const текст = реплики.join("\n\n");
    this.#вердикт = parseVerdict(текст);

    if (this.#вердикт === "accepted") {
      this.#этап = "accepted";
      this.#сообщить("Рецензент принял работу. Цикл завершён.");
      return;
    }

    const снимок = await takeSnapshot(this.опции.cwd);
    const отправка: Отправка = {
      to: "claude",
      prompt: {
        text: `Замечания рецензента:\n${текст}\n\nИсправьте или обоснуйте несогласие по каждому пункту.`,
        from: "codex",
        snapshot: describeSnapshot(снимок),
      },
      цель: { роль: "work", цикл: this.#цикл },
      снимок,
    };

    if (this.#вердикт === "missing") {
      this.#удержать(
        отправка,
        "Рецензент не вынес вердикт: решите, передавать ли его ответ разработчику.",
      );
      return;
    }
    if (!this.#автоматика) {
      this.#удержать(отправка, "Автораунды выключены: замечания ждут отправки разработчику.");
      return;
    }
    this.#этап = "working";
    await this.#отправить(отправка);
  }

  #удержать(отправка: Отправка, причина: string): void {
    this.#удержано = { ...отправка, причина };
    this.#этап = "held";
    this.#сообщить(причина);
  }

  async #агентУпал(агент: AgentId): Promise<void> {
    const ждали = (this.#цели.get(агент) ?? []).some(
      (ц) => ц.цикл !== undefined && ц.цикл === this.#цикл,
    );
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
    this.#накопители.set(о.to, []);
    try {
      await адаптер.send(о.prompt);
      const цели = this.#цели.get(о.to) ?? [];
      цели.push(о.цель);
      this.#цели.set(о.to, цели);
    } catch (беда) {
      this.handle({
        id: `x${Date.now().toString(36)}`,
        agent: о.to,
        kind: "error",
        visibility: "turn",
        at: Date.now(),
        text: `не удалось отправить: ${(беда as Error).message}`,
      });
      if (о.цель.цикл === this.#цикл) {
        this.#этап = "stopped";
        this.#сообщить(`Отправка ${ИМЕНА[о.to]} не удалась — цикл остановлен.`);
      }
    }
  }

  async #выгрузитьОчередь(): Promise<void> {
    for (let i = 0; i < this.#очередь.length; ) {
      const о = this.#очередь[i];
      const адаптер = о?.to === "claude" ? this.claude : this.codex;
      if (!о || адаптер.busy) {
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
