/**
 * Координатор комнаты: кто кому что передаёт и когда остановиться.
 *
 * Три правила, каждое из которых закрывает свою ошибку.
 *
 * **Передаётся законченное, показывается всё.** Человек видит поток по мере
 * получения; второму агенту уходят только законченные реплики, вызовы
 * инструментов и их СЫРЫЕ результаты. Если пересылать дельты, каждая новая
 * буква запускала бы очередной ответ.
 *
 * **Сырой вывод, а не пересказ.** Рецензент лишён права запускать что-либо,
 * поэтому полностью зависит от того, что ему передали. Пересказ разработчика
 * вместо вывода инструмента — это механизм, которым в проект уже попал
 * неверный вывод, принятый без проверки. Поэтому tool_result идёт целиком.
 *
 * **Раунды считаются и кончаются.** Автоматический обмен без предела
 * превращается в двух агентов, спорящих сами с собой за счёт владельца.
 * Предел настраиваемый; ноль означает «только вручную».
 *
 * **Материал накапливается ПО АГЕНТУ.** Один общий накопитель приводил к
 * подмене авторства: Codex мог получить свой же комментарий с подписью «от
 * разработчика Claude», потому что после завершения хода уходило всё
 * содержимое накопителя от имени завершившего. Адресат «Оба» стоит по
 * умолчанию, так что сценарий был обычным, а не краевым.
 *
 * **Снимок версии привязан к ходу АГЕНТА, а не к комнате.** Одна общая
 * метка переписывалась репликой человека посреди проверки, и замечание
 * оказывалось привязано к состоянию, которого рецензент не видел.
 *
 * И одно свойство, которое легко потерять: агент бывает занят. Отправка
 * занятому агенту не теряется и не прерывает его ход — она встаёт в
 * очередь, и очередь выгружается В ПОРЯДКЕ ПОСТУПЛЕНИЯ. Выгрузка с конца
 * переставляла сообщения местами.
 */
import { Adapter, AgentId, AgentPrompt, PanelEvent } from "./adapters/types.js";
import { Journal } from "./journal.js";
import { Snapshot, describeSnapshot, takeSnapshot } from "./snapshot.js";

export type Addressee = "both" | "claude" | "codex";

export interface CoordinatorOptions {
  readonly room: string;
  readonly cwd: string;
  readonly maxAutoRounds: number;
  readonly onEvent: (событие: PanelEvent) => void;
}

interface Отложенное {
  readonly to: AgentId;
  readonly prompt: AgentPrompt;
  readonly снимок?: Snapshot;
}

export class Coordinator {
  #раунд = 0;
  /** Снимок последней задачи человека: им помечаются его реплики. */
  #снимокКомнаты: Snapshot | undefined;
  /** Снимок, с которым начался текущий ход каждого агента. */
  readonly #снимки = new Map<AgentId, Snapshot>();
  /** Материал по агенту: смешивать нельзя, иначе подменяется авторство. */
  readonly #накопители = new Map<AgentId, PanelEvent[]>();
  readonly #очередь: Отложенное[] = [];
  #автоматика = true;

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

  /**
   * Событие от любого адаптера.
   *
   * Здесь же решается, не пора ли передать материал второму агенту: ход
   * закончился — значит есть что показать.
   */
  handle(событие: PanelEvent): void {
    // Пометка берётся из снимка ХОДА этого агента, а не из общей метки
    // комнаты: иначе чужая реплика переписала бы версию идущего хода.
    const снимок =
      событие.agent === "human"
        ? this.#снимокКомнаты
        : (this.#снимки.get(событие.agent) ?? this.#снимокКомнаты);
    const сПометкой: PanelEvent = снимок
      ? { ...событие, snapshot: снимок.id }
      : событие;
    this.journal.append(this.опции.room, сПометкой);
    this.опции.onEvent(сПометкой);

    // Реплика человека НЕ накапливается как материал агента. Она уже
    // отправлена тому, кому адресована; попав в накопитель, она была бы
    // переслана второму агенту под видом вывода первого — то есть человек
    // оказался бы процитирован как агент.
    if (
      сПометкой.agent !== "human" &&
      сПометкой.visibility === "turn" &&
      ПЕРЕДАВАЕМЫЕ.has(сПометкой.kind)
    ) {
      const накопитель = this.#накопители.get(сПометкой.agent) ?? [];
      накопитель.push(сПометкой);
      this.#накопители.set(сПометкой.agent, накопитель);
    }

    if (сПометкой.kind === "turn_completed") {
      void this.#ходЗакончен(сПометкой.agent);
    }
    if (сПометкой.kind === "error") {
      // Ошибка снимает занятость, иначе очередь встанет навсегда.
      void this.#выгрузитьОчередь();
    }
  }

  /** Сообщение человека. Сбрасывает счётчик раундов: это новая задача. */
  async fromHuman(текст: string, кому: Addressee): Promise<void> {
    this.#раунд = 0;
    this.#накопители.clear();
    this.#снимокКомнаты = await takeSnapshot(this.опции.cwd);
    const prompt: AgentPrompt = {
      text: текст,
      from: "human",
      snapshot: describeSnapshot(this.#снимокКомнаты),
    };
    this.handle({
      id: `h${Date.now().toString(36)}`,
      agent: "human",
      kind: "message",
      visibility: "turn",
      at: Date.now(),
      text: текст,
    });
    if (кому === "both" || кому === "claude") {
      await this.#отправить("claude", prompt);
    }
    if (кому === "both" || кому === "codex") {
      await this.#отправить("codex", prompt);
    }
  }

  setAuto(включена: boolean): void {
    this.#автоматика = включена;
  }

  async stopAll(): Promise<void> {
    this.#автоматика = false;
    this.#очередь.length = 0;
    await Promise.allSettled([this.claude.stop(), this.codex.stop()]);
  }

  async interruptAll(): Promise<void> {
    await Promise.allSettled([
      this.claude.interrupt(),
      this.codex.interrupt(),
    ]);
  }

  async #ходЗакончен(кто: AgentId): Promise<void> {
    await this.#выгрузитьОчередь();
    if (!this.#автоматика || this.опции.maxAutoRounds <= 0) return;
    if (кто === "human") return;

    if (this.#раунд >= this.опции.maxAutoRounds) {
      this.опции.onEvent({
        id: `s${Date.now().toString(36)}`,
        agent: "human",
        kind: "message",
        visibility: "turn",
        at: Date.now(),
        text:
          `Предел автоматических раундов (${this.опции.maxAutoRounds}) ` +
          `достигнут. Дальше — по вашей команде.`,
      });
      return;
    }

    // Берётся ТОЛЬКО материал завершившего агента.
    const материал = this.#собрать(кто);
    if (!материал) return;
    this.#накопители.set(кто, []);
    this.#раунд += 1;

    // Снимок берётся в момент передачи и закрепляется за ходом получателя:
    // замечание относится к тому состоянию файлов, которое он увидел.
    const снимок = await takeSnapshot(this.опции.cwd);
    const кому: AgentId = кто === "claude" ? "codex" : "claude";
    await this.#отправить(
      кому,
      { text: материал, from: кто, snapshot: describeSnapshot(снимок) },
      снимок,
    );
  }

  /**
   * Материал для второго агента.
   *
   * Вызовы инструментов и их результаты идут отдельными блоками с пометкой
   * «сырой вывод», чтобы получатель не путал его с утверждением автора.
   */
  #собрать(кто: AgentId): string | undefined {
    const накопленное = this.#накопители.get(кто) ?? [];
    if (накопленное.length === 0) return undefined;
    const части: string[] = [];
    for (const е of накопленное) {
      if (е.kind === "message" && е.text) {
        части.push(е.text);
      } else if (е.kind === "tool_call") {
        части.push(`--- вызов инструмента ${е.tool ?? "?"} ---\n${е.text ?? ""}`);
      } else if (е.kind === "tool_result") {
        части.push(
          `--- СЫРОЙ вывод инструмента ${е.tool ?? "?"} ---\n${е.text ?? ""}`,
        );
      }
    }
    const собранное = части.join("\n\n").trim();
    return собранное.length > 0 ? собранное : undefined;
  }

  async #отправить(
    кому: AgentId,
    prompt: AgentPrompt,
    снимок?: Snapshot,
  ): Promise<void> {
    const адаптер = кому === "claude" ? this.claude : this.codex;
    if (адаптер.busy) {
      this.#очередь.push({ to: кому, prompt, ...(снимок ? { снимок } : {}) });
      return;
    }
    // Снимок закрепляется за ходом получателя ДО отправки: события,
    // которые он начнёт выдавать, помечаются тем, что он видел.
    const закрепить = снимок ?? this.#снимокКомнаты;
    if (закрепить) this.#снимки.set(кому, закрепить);
    try {
      await адаптер.send(prompt);
    } catch (беда) {
      this.опции.onEvent({
        id: `x${Date.now().toString(36)}`,
        agent: кому,
        kind: "error",
        visibility: "turn",
        at: Date.now(),
        text: `не удалось отправить: ${(беда as Error).message}`,
      });
    }
  }

  async #выгрузитьОчередь(): Promise<void> {
    // В ПОРЯДКЕ ПОСТУПЛЕНИЯ: обход с конца переставлял сообщения местами.
    for (let i = 0; i < this.#очередь.length; ) {
      const запись = this.#очередь[i];
      if (!запись) {
        i += 1;
        continue;
      }
      const адаптер = запись.to === "claude" ? this.claude : this.codex;
      if (адаптер.busy) {
        i += 1;
        continue;
      }
      this.#очередь.splice(i, 1);
      await this.#отправить(запись.to, запись.prompt, запись.снимок);
    }
  }
}

/** Что уходит второму агенту. Поток и рассуждения — не уходят. */
const ПЕРЕДАВАЕМЫЕ = new Set<PanelEvent["kind"]>([
  "message",
  "tool_call",
  "tool_result",
]);
