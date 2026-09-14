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
 * И одно свойство, которое легко потерять: агент бывает занят. Отправка
 * занятому агенту не теряется и не прерывает его ход — она встаёт в очередь.
 * Иначе реплика исчезала бы молча.
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
}

export class Coordinator {
  #раунд = 0;
  #снимок: Snapshot | undefined;
  /** Законченные события с момента последней передачи — материал для рецензии. */
  readonly #накопленное: PanelEvent[] = [];
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
    return this.#снимок;
  }

  /**
   * Событие от любого адаптера.
   *
   * Здесь же решается, не пора ли передать материал второму агенту: ход
   * закончился — значит есть что показать.
   */
  handle(событие: PanelEvent): void {
    const сПометкой: PanelEvent = this.#снимок
      ? { ...событие, snapshot: this.#снимок.id }
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
      this.#накопленное.push(сПометкой);
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
    this.#накопленное.length = 0;
    this.#снимок = await takeSnapshot(this.опции.cwd);
    const prompt: AgentPrompt = {
      text: текст,
      from: "human",
      snapshot: describeSnapshot(this.#снимок),
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

    const материал = this.#собрать();
    if (!материал) return;
    this.#накопленное.length = 0;
    this.#раунд += 1;

    // Снимок берётся В МОМЕНТ ПЕРЕДАЧИ, а не в момент ответа: замечание
    // относится к тому состоянию файлов, которое рецензент видел.
    this.#снимок = await takeSnapshot(this.опции.cwd);
    const кому: AgentId = кто === "claude" ? "codex" : "claude";
    await this.#отправить(кому, {
      text: материал,
      from: кто,
      snapshot: describeSnapshot(this.#снимок),
    });
  }

  /**
   * Материал для второго агента.
   *
   * Вызовы инструментов и их результаты идут отдельными блоками с пометкой
   * «сырой вывод», чтобы получатель не путал его с утверждением автора.
   */
  #собрать(): string | undefined {
    if (this.#накопленное.length === 0) return undefined;
    const части: string[] = [];
    for (const е of this.#накопленное) {
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

  async #отправить(кому: AgentId, prompt: AgentPrompt): Promise<void> {
    const адаптер = кому === "claude" ? this.claude : this.codex;
    if (адаптер.busy) {
      this.#очередь.push({ to: кому, prompt });
      return;
    }
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
    for (let i = this.#очередь.length - 1; i >= 0; i -= 1) {
      const запись = this.#очередь[i];
      if (!запись) continue;
      const адаптер = запись.to === "claude" ? this.claude : this.codex;
      if (адаптер.busy) continue;
      this.#очередь.splice(i, 1);
      await this.#отправить(запись.to, запись.prompt);
    }
  }
}

/** Что уходит второму агенту. Поток и рассуждения — не уходят. */
const ПЕРЕДАВАЕМЫЕ = new Set<PanelEvent["kind"]>([
  "message",
  "tool_call",
  "tool_result",
]);
