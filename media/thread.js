/**
 * Язык нитей: чистая геометрия и смысл интерфейса, без DOM.
 *
 * Облик согласован с владельцем 27.09.2026
 * (docs/specs/2026-09-27-облик-язык-нитей.md): агенты — огоньки своего
 * цвета (Claude тёплый, Codex холодный, человек белый), связи — нити, работа —
 * частицы на нити. Смысл передаёт форма, а не подписи: определения уровней —
 * только в подсказках.
 *
 * Здесь всё, что считается: какие уровни показывать, где узлы, сколько
 * частиц, когда нить ветвится, как этап координатора становится «Эстафетой»
 * и «Дорожкой цикла», какую форму получает бусина действия. panel.js только
 * переводит результат в разметку.
 *
 * Работает и в webview (глобальный PanelThread), и в node для тестов.
 * Зависит от PanelFormat (format.js) — он подключается раньше.
 */
(function () {
  /** Уровни рассуждения по возрастанию; так их называют CLI обоих агентов. */
  const УРОВНИ = ["low", "medium", "high", "xhigh", "max", "ultra"];
  const НАЗВАНИЯ = {
    low: "Низкое",
    medium: "Среднее",
    high: "Высокое",
    xhigh: "Очень высокое",
    max: "Максимум",
    ultra: "Ультра",
    ultracode: "Ultracode",
  };

  /**
   * У каждого агента своя однотонная гамма: владелец просил, чтобы нити
   * различались, а цвета внутри одной нити не спорили друг с другом.
   */
  const ПАЛИТРА = {
    claude: {
      low: "#8C7C70", medium: "#AE8868", high: "#C99264", xhigh: "#DE9C60", max: "#F0A862",
      ultra: "#FFC27A", ultracode: "#FFC27A",
      start: "#5E5249", tip: "#FFD9A0",
      flare: "linear-gradient(90deg, #8C7C70 0%, #F0A862 70%, #FFD9A0 100%)",
    },
    codex: {
      low: "#6F808C", medium: "#5B94A6", high: "#4FA7B6", xhigh: "#4CB9C3", max: "#5BCBD0",
      ultra: "#9AE6EA", ultracode: "#9AE6EA",
      start: "#46525C", tip: "#C8F4F6",
      flare: "linear-gradient(90deg, #6F808C 0%, #4CB9C3 60%, #C8F4F6 100%)",
    },
  };

  /**
   * Определения — по документации 27.09.2026: Anthropic, «Effort»
   * (platform.claude.com/docs/en/build-with-claude/effort); OpenAI, «Models»
   * (learn.chatgpt.com/docs/models); Claude Academy об Ultracode.
   */
  const ПОДСКАЗКИ = {
    claude: {
      low: "Самое экономное: меньше рассуждений и вызовов инструментов. Для простых задач",
      medium: "Баланс скорости, цены и качества. По умолчанию у Opus 5.5",
      high: "Столько рассуждений, сколько нужно задаче. По умолчанию у Opus 5 и Sonnet 5",
      xhigh: "Для долгой агентной работы: задачи на полчаса и дольше",
      max: "Без ограничений на расход. Выигрыш часто невелик, возможен перебор",
      ultracode: "Не уровень, а режим Claude Code: «Очень высокое» плюс рабочие процессы с несколькими агентами",
    },
    codex: {
      low: "Короткое рассуждение, быстрее всего",
      medium: "Обычная глубина рассуждения",
      high: "Рассуждает глубже",
      xhigh: "Ещё глубже и дольше",
      max: "Больше времени на одну задачу: вся глубина в одном непрерывном рассуждении",
      ultra: "Максимум плюс автоматическая раздача частей задачи субагентам параллельно",
    },
  };

  /** Уровни модели по возрастанию. Ultracode — режим Claude Code, только если доступен. */
  function effortLevels(агент, efforts, { ultracode = false } = {}) {
    const палитра = ПАЛИТРА[агент] ?? ПАЛИТРА.codex;
    const подсказки = ПОДСКАЗКИ[агент] ?? ПОДСКАЗКИ.codex;
    const известные = УРОВНИ.filter((id) => efforts.includes(id));
    const прочие = efforts.filter((id) => !УРОВНИ.includes(id));
    const уровни = [...известные, ...прочие].map((id) => ({
      id,
      name: НАЗВАНИЯ[id] ?? id,
      color: палитра[id] ?? палитра.max,
      tip: подсказки[id] ?? "",
      fork: id === "ultra",
      mode: false,
    }));
    if (агент === "claude" && ultracode) {
      уровни.push({
        id: "ultracode",
        name: НАЗВАНИЯ.ultracode,
        color: палитра.ultracode,
        tip: подсказки.ultracode,
        fork: true,
        mode: true,
      });
    }
    return уровни;
  }

  /**
   * Уровень по умолчанию — только если его сообщил каталог модели. Claude
   * своего умолчания не сообщает (у Opus 5.5 это «Среднее», у прочих
   * «Высокое» — но это документация, а не ответ CLI), и догадка показала бы
   * неизвестное как известное.
   */
  function defaultEffort(вариант) {
    const уровни = вариант?.efforts ?? [];
    return вариант?.defaultEffort && уровни.includes(вариант.defaultEffort) ? вариант.defaultEffort : "";
  }

  /**
   * Раскладка нити уровня рассуждения в полосе шириной width (px).
   * selectedId "" — уровень по умолчанию; если и он неизвестен (defaultId ""),
   * ни один узел не выбран: решает агент.
   */
  function threadLayout(агент, уровни, selectedId, defaultId, width = 328) {
    if (!уровни || уровни.length === 0) return null;
    const палитра = ПАЛИТРА[агент] ?? ПАЛИТРА.codex;
    const последний = уровни.length - 1;
    const естьВетвление = уровни.some((у) => у.fork);
    // Справа место под ветки субагентов, если уровень с ветвлением есть.
    const конец = width - (естьВетвление ? 44 : 10);
    const центр = (i) => (последний === 0 ? 10 : 10 + (i * (конец - 10)) / последний);
    const поИд = (id) => уровни.findIndex((у) => у.id === id);
    const поУмолчанию = поИд(defaultId);
    const выбран = поИд(selectedId) >= 0 ? поИд(selectedId) : поУмолчанию;
    if (выбран < 0) return безВыбора(уровни, центр, концоСплошной(уровни, центр));
    const уровень = уровни[выбран];
    const ранг = УРОВНИ.indexOf(уровень.id) >= 0 ? УРОВНИ.indexOf(уровень.id) : уровень.mode ? 5 : выбран;
    const режим = уровни.findIndex((у) => у.mode);
    const конецСплошной = концоСплошной(уровни, центр);
    const глубина = уровень.id === "max";
    const длительность = 3.2 - ранг * 0.42;
    const частиц = ранг === 0 ? 0 : 4 + ранг * 2;
    const кольцо = 2.2 - ранг * 0.22;
    return {
      label: уровень.name,
      color: уровень.color,
      tipColor: палитра.tip,
      baseWidth: конецСплошной - 10,
      modeSegment:
        режим > 0
          ? { left: центр(режим - 1), width: центр(режим) - центр(режим - 1), lit: выбран >= режим }
          : null,
      litWidth: Math.min(центр(выбран), конецСплошной) - 10,
      litTop: глубина ? 20.5 : 21,
      litHeight: глубина ? 3 : 2,
      litFill: уровень.fork ? палитра.flare : `linear-gradient(90deg, ${палитра.start} 0%, ${уровень.color} 100%)`,
      flowWidth: центр(выбран) - 10,
      particles: Array.from({ length: частиц }, (_, k) => ({
        dur: длительность.toFixed(2) + "s",
        delay: (-(k * длительность) / частиц).toFixed(2) + "s",
      })),
      fork: уровень.fork,
      forkLeft: центр(выбран) + 7,
      branches: [-32, 0, 32].map((угол, k) => ({ angle: угол + "deg", delay: (-k * 0.37).toFixed(2) + "s" })),
      deep: глубина,
      ringLeft: центр(выбран) - 7,
      ringDur: кольцо.toFixed(2) + "s",
      ringDelay: (-кольцо / 2).toFixed(2) + "s",
      defaultLeft: поУмолчанию >= 0 ? центр(поУмолчанию) - 1 : null,
      nodes: уровни.map((у, i) => ({
        id: у.id,
        name: у.name,
        tip: у.tip,
        mode: у.mode,
        current: i === выбран,
        center: центр(i),
        left: центр(i) - 14,
        size: i === выбран ? 14 : 8,
        fill: i === выбран && уровень.fork ? палитра.flare : i <= выбран ? у.color : у.mode ? "transparent" : "var(--нить-пусто)",
        border: у.mode && i > выбран ? "1.5px solid var(--нить-край)" : "0",
        glow: i === выбран ? `0 0 12px ${у.color}` : "none",
      })),
    };
  }

  /** Сплошная часть нити кончается на последнем уровне; режим (Ultracode) — за пунктиром. */
  function концоСплошной(уровни, центр) {
    const режим = уровни.findIndex((у) => у.mode);
    return режим > 0 ? центр(режим - 1) : центр(уровни.length - 1);
  }

  /** Нить, на которой ничего не выбрано: тусклые узлы, поток стоит, кольца нет. */
  function безВыбора(уровни, центр, конецСплошной) {
    const режим = уровни.findIndex((у) => у.mode);
    return {
      label: "По умолчанию",
      color: "",
      tipColor: "",
      baseWidth: конецСплошной - 10,
      modeSegment: режим > 0 ? { left: центр(режим - 1), width: центр(режим) - центр(режим - 1), lit: false } : null,
      litWidth: 0,
      litTop: 21,
      litHeight: 2,
      litFill: "none",
      flowWidth: 0,
      particles: [],
      fork: false,
      forkLeft: 0,
      branches: [],
      deep: false,
      ringLeft: null,
      ringDur: "0s",
      ringDelay: "0s",
      defaultLeft: null,
      nodes: уровни.map((у, i) => ({
        id: у.id,
        name: у.name,
        tip: у.tip,
        mode: у.mode,
        current: false,
        center: центр(i),
        left: центр(i) - 14,
        size: 8,
        fill: у.mode ? "transparent" : "var(--нить-пусто)",
        border: у.mode ? "1.5px solid var(--нить-край)" : "0",
        glow: "none",
      })),
    };
  }

  const ВЕРДИКТЫ = {
    accepted: "принято",
    remarks: "есть замечания",
    human: "нужно ваше решение",
    missing: "вердикт не вынесен",
  };

  /** «Эстафета»: кто работает, куда бегут частицы, подпись и счёт проверок. */
  function relayView(с) {
    const sub = ВЕРДИКТЫ[с.verdict] ?? "";
    const rounds = Array.from({ length: Math.max(0, с.maxRounds ?? 0) }, (_, i) => i < (с.round ?? 0));
    const вид = (active, label, flow) => ({ active, label, flow, sub, rounds });
    // Открытый запрос разрешения важнее этапа цикла: без ответа никто не двинется.
    if (с.approvals > 0) return вид("human", "Ждёт разрешения", "none");
    switch (с.stage) {
      case "held": return вид("human", "Ждёт вашего решения", "none");
      case "working": return вид("claude", "Claude работает", "to-claude");
      case "reviewing": return вид("codex", "Codex проверяет", "to-codex");
      case "accepted": return вид("accepted", "Работа принята", "none");
      default:
        if (с.claudeBusy) return вид("claude", "Claude отвечает", "to-claude");
        if (с.codexBusy) return вид("codex", "Codex отвечает", "to-codex");
        return вид("idle", с.stage === "stopped" ? "Остановлено" : "Ожидание", "none");
    }
  }

  /**
   * «Дорожка цикла»: пройденные шаги, текущий и пустые шаги оставшихся
   * проверок. trail — след координатора: { who: task|claude|codex|you, mark? }.
   */
  function trackSteps(trail, { stage, maxRounds }) {
    if (!trail || trail.length === 0) return [];
    const идёт = stage === "working" || stage === "reviewing" || stage === "held";
    const шаги = trail.map((ш) => ({ who: ш.who, mark: ш.mark ?? "", state: "done" }));
    if (идёт) шаги[шаги.length - 1].state = "current";
    if (stage === "working" || stage === "reviewing") {
      let осталось = Math.max(0, (maxRounds ?? 0) - trail.filter((ш) => ш.who === "codex").length);
      const пустые = [];
      if (trail[trail.length - 1].who === "claude" && осталось > 0) {
        пустые.push("codex");
        осталось -= 1;
      }
      for (; осталось > 0; осталось -= 1) пустые.push("claude", "codex");
      for (const who of пустые) шаги.push({ who, mark: "", state: "ghost" });
    }
    return шаги;
  }

  /** Бусина действия: форма по виду (команда, чтение, правка, прочее), состояние отдельно. */
  function beadFor(инструмент, status) {
    const вид = globalThis.PanelFormat.toolCategory(инструмент);
    const shape =
      вид === "command" ? "square" : вид === "read" || вид === "search" ? "ring" : вид === "edit" ? "diamond" : "dot";
    return { shape, status };
  }

  /** Счётчики действий хода: только ненулевые, отказы — отдельно. */
  function actionCounters(имена, отказано) {
    const счёт = { command: 0, read: 0, edit: 0, other: 0 };
    for (const имя of имена) {
      const вид = globalThis.PanelFormat.toolCategory(имя);
      const группа = вид === "command" ? "command" : вид === "read" || вид === "search" ? "read" : вид === "edit" ? "edit" : "other";
      счёт[группа] += 1;
    }
    const итог = ["command", "read", "edit", "other"].filter((k) => счёт[k] > 0).map((kind) => ({ kind, n: счёт[kind] }));
    if (отказано > 0) итог.push({ kind: "denied", n: отказано });
    return итог;
  }

  const ЗНАЧЕНИЯ = { "ПРИНЯТО": "accepted", "ЕСТЬ ЗАМЕЧАНИЯ": "remarks", "НУЖНО РЕШЕНИЕ ЧЕЛОВЕКА": "human" };
  const ОГРАДА = /^ {0,3}(`{3,}|~{3,})/;

  /**
   * Строка вердикта для показа: значок и слова, под ними исходная строка.
   * Только оформление — вердикт для цикла читает src/verdict.ts из исходного
   * текста. Здесь правило уже: строка должна быть последней, точной, вне кода
   * и вне цитаты; сомнительное остаётся обычным текстом, ничего не теряется.
   */
  function verdictLine(текст) {
    if (!текст) return null;
    // Перевод строки кодом, а не escape-записью: инструменты правки превращают её в настоящий знак.
    const строки = текст.split(String.fromCharCode(10)).map((с) => с.trimEnd());
    let конец = строки.length - 1;
    while (конец >= 0 && строки[конец].trim() === "") конец -= 1;
    if (конец < 0) return null;
    const последняя = строки[конец];
    const м = /^ВЕРДИКТ: (.+?)\s*$/u.exec(последняя);
    if (!м || !ЗНАЧЕНИЯ[м[1]]) return null;
    // Нечётное число оград выше — строка внутри незакрытого блока кода.
    const оград = строки.slice(0, конец).filter((с) => ОГРАДА.test(с)).length;
    if (оград % 2 === 1) return null;
    return {
      verdict: ЗНАЧЕНИЯ[м[1]],
      line: последняя.trim(),
      body: строки.slice(0, конец).join(String.fromCharCode(10)).replace(/\s+$/u, ""),
    };
  }

  const api = { effortLevels, defaultEffort, threadLayout, relayView, trackSteps, beadFor, actionCounters, verdictLine };
  globalThis.PanelThread = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
