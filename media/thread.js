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
  const LEVELS = ["low", "medium", "high", "xhigh", "max", "ultra"];
  const TITLES = {
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
  const PALETTE = {
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
  const HINTS = {
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
  function effortLevels(agent, efforts, { ultracode = false } = {}) {
    const palette = PALETTE[agent] ?? PALETTE.codex;
    const hints = HINTS[agent] ?? HINTS.codex;
    const known = LEVELS.filter((id) => efforts.includes(id));
    const others = efforts.filter((id) => !LEVELS.includes(id));
    const levels = [...known, ...others].map((id) => ({
      id,
      name: TITLES[id] ?? id,
      color: palette[id] ?? palette.max,
      tip: hints[id] ?? "",
      fork: id === "ultra",
      mode: false,
    }));
    if (agent === "claude" && ultracode) {
      levels.push({
        id: "ultracode",
        name: TITLES.ultracode,
        color: palette.ultracode,
        tip: hints.ultracode,
        fork: true,
        mode: true,
      });
    }
    return levels;
  }

  /**
   * Уровень по умолчанию — только если его сообщил каталог модели. Claude
   * своего умолчания не сообщает (у Opus 5.5 это «Среднее», у прочих
   * «Высокое» — но это документация, а не ответ CLI), и догадка показала бы
   * неизвестное как известное.
   */
  function defaultEffort(makeOption) {
    const levels = makeOption?.efforts ?? [];
    return makeOption?.defaultEffort && levels.includes(makeOption.defaultEffort) ? makeOption.defaultEffort : "";
  }

  /**
   * Раскладка нити уровня рассуждения в полосе шириной width (px).
   * selectedId "" — уровень по умолчанию; если и он неизвестен (defaultId ""),
   * ни один узел не выбран: решает агент.
   */
  function threadLayout(agent, levels, selectedId, defaultId, width = 328) {
    if (!levels || levels.length === 0) return null;
    const palette = PALETTE[agent] ?? PALETTE.codex;
    const lastIndex = levels.length - 1;
    const hasFork = levels.some((u) => u.fork);
    // Справа место под ветки субагентов, если уровень с ветвлением есть.
    const end = width - (hasFork ? 44 : 10);
    const center = (i) => (lastIndex === 0 ? 10 : 10 + (i * (end - 10)) / lastIndex);
    const byId = (id) => levels.findIndex((u) => u.id === id);
    const isDefault = byId(defaultId);
    const selected = byId(selectedId) >= 0 ? byId(selectedId) : isDefault;
    if (selected < 0) return withoutSelection(levels, center, solidEndFor(levels, center));
    const level = levels[selected];
    const rank = LEVELS.indexOf(level.id) >= 0 ? LEVELS.indexOf(level.id) : level.mode ? 5 : selected;
    const mode = levels.findIndex((u) => u.mode);
    const solidEnd = solidEndFor(levels, center);
    const isDeep = level.id === "max";
    const duration = 3.2 - rank * 0.42;
    const particleCount = rank === 0 ? 0 : 4 + rank * 2;
    const ring = 2.2 - rank * 0.22;
    return {
      label: level.name,
      color: level.color,
      tipColor: palette.tip,
      baseWidth: solidEnd - 10,
      modeSegment:
        mode > 0
          ? { left: center(mode - 1), width: center(mode) - center(mode - 1), lit: selected >= mode }
          : null,
      litWidth: Math.min(center(selected), solidEnd) - 10,
      litTop: isDeep ? 20.5 : 21,
      litHeight: isDeep ? 3 : 2,
      litFill: level.fork ? palette.flare : `linear-gradient(90deg, ${palette.start} 0%, ${level.color} 100%)`,
      flowWidth: center(selected) - 10,
      particles: Array.from({ length: particleCount }, (_, k) => ({
        dur: duration.toFixed(2) + "s",
        delay: (-(k * duration) / particleCount).toFixed(2) + "s",
      })),
      fork: level.fork,
      forkLeft: center(selected) + 7,
      branches: [-32, 0, 32].map((angle, k) => ({ angle: angle + "deg", delay: (-k * 0.37).toFixed(2) + "s" })),
      deep: isDeep,
      ringLeft: center(selected) - 7,
      ringDur: ring.toFixed(2) + "s",
      ringDelay: (-ring / 2).toFixed(2) + "s",
      defaultLeft: isDefault >= 0 ? center(isDefault) - 1 : null,
      nodes: levels.map((u, i) => ({
        id: u.id,
        name: u.name,
        tip: u.tip,
        mode: u.mode,
        current: i === selected,
        center: center(i),
        left: center(i) - 14,
        size: i === selected ? 14 : 8,
        fill: i === selected && level.fork ? palette.flare : i <= selected ? u.color : u.mode ? "transparent" : "var(--нить-пусто)",
        border: u.mode && i > selected ? "1.5px solid var(--нить-край)" : "0",
        glow: i === selected ? `0 0 12px ${u.color}` : "none",
      })),
    };
  }

  /** Сплошная часть нити кончается на последнем уровне; режим (Ultracode) — за пунктиром. */
  function solidEndFor(levels, center) {
    const mode = levels.findIndex((u) => u.mode);
    return mode > 0 ? center(mode - 1) : center(levels.length - 1);
  }

  /** Нить, на которой ничего не выбрано: тусклые узлы, поток стоит, кольца нет. */
  function withoutSelection(levels, center, solidEnd) {
    const mode = levels.findIndex((u) => u.mode);
    return {
      label: "По умолчанию",
      color: "",
      tipColor: "",
      baseWidth: solidEnd - 10,
      modeSegment: mode > 0 ? { left: center(mode - 1), width: center(mode) - center(mode - 1), lit: false } : null,
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
      nodes: levels.map((u, i) => ({
        id: u.id,
        name: u.name,
        tip: u.tip,
        mode: u.mode,
        current: false,
        center: center(i),
        left: center(i) - 14,
        size: 8,
        fill: u.mode ? "transparent" : "var(--нить-пусто)",
        border: u.mode ? "1.5px solid var(--нить-край)" : "0",
        glow: "none",
      })),
    };
  }

  const VERDICTS = {
    accepted: "принято",
    remarks: "есть замечания",
    human: "нужно ваше решение",
    missing: "вердикт не вынесен",
  };

  /** «Эстафета»: кто работает, куда бегут частицы, подпись и счёт проверок. */
  function relayView(s) {
    const sub = VERDICTS[s.verdict] ?? "";
    const rounds = Array.from({ length: Math.max(0, s.maxRounds ?? 0) }, (_, i) => i < (s.round ?? 0));
    const kind = (active, label, flow) => ({ active, label, flow, sub, rounds });
    // Открытый запрос разрешения важнее этапа цикла: без ответа никто не двинется.
    if (s.approvals > 0) return kind("human", "Ждёт разрешения", "none");
    switch (s.stage) {
      case "held": return kind("human", "Ждёт вашего решения", "none");
      case "working": return kind("claude", "Claude работает", "to-claude");
      case "reviewing": return kind("codex", "Codex проверяет", "to-codex");
      default:
        // Прямой вопрос после цикла: агент отвечает, а этап ещё «принято».
        if (s.claudeBusy) return kind("claude", "Claude отвечает", "to-claude");
        if (s.codexBusy) return kind("codex", "Codex отвечает", "to-codex");
        if (s.stage === "accepted") return kind("accepted", "Работа принята", "none");
        return kind("idle", s.stage === "stopped" ? "Остановлено" : "Ожидание", "none");
    }
  }

  /**
   * «Дорожка цикла»: пройденные шаги, текущий и пустые шаги оставшихся
   * проверок. trail — след координатора: { who: task|claude|codex|you, mark? }.
   */
  function trackSteps(trail, { stage, maxRounds }) {
    if (!trail || trail.length === 0) return [];
    const inProgress = stage === "working" || stage === "reviewing" || stage === "held";
    const steps = trail.map((sh) => ({ who: sh.who, mark: sh.mark ?? "", state: "done" }));
    if (inProgress) steps[steps.length - 1].state = "current";
    if (stage === "working" || stage === "reviewing") {
      let remaining = Math.max(0, (maxRounds ?? 0) - trail.filter((sh) => sh.who === "codex").length);
      const empty = [];
      if (trail[trail.length - 1].who === "claude" && remaining > 0) {
        empty.push("codex");
        remaining -= 1;
      }
      for (; remaining > 0; remaining -= 1) empty.push("claude", "codex");
      for (const who of empty) steps.push({ who, mark: "", state: "ghost" });
    }
    return steps;
  }

  /** Бусина действия: форма по виду (команда, чтение, правка, прочее), состояние отдельно. */
  function beadFor(tool, status) {
    const kind = globalThis.PanelFormat.toolCategory(tool);
    const shape =
      kind === "command" ? "square" : kind === "read" || kind === "search" ? "ring" : kind === "edit" ? "diamond" : "dot";
    return { shape, status };
  }

  /** Счётчики действий хода: только ненулевые, отказы — отдельно. */
  function actionCounters(names, denied) {
    const counts = { command: 0, read: 0, edit: 0, other: 0 };
    for (const name of names) {
      const kind = globalThis.PanelFormat.toolCategory(name);
      const group = kind === "command" ? "command" : kind === "read" || kind === "search" ? "read" : kind === "edit" ? "edit" : "other";
      counts[group] += 1;
    }
    const result = ["command", "read", "edit", "other"].filter((k) => counts[k] > 0).map((kind) => ({ kind, n: counts[kind] }));
    if (denied > 0) result.push({ kind: "denied", n: denied });
    return result;
  }

  const VERDICT_VALUES = { "ПРИНЯТО": "accepted", "ЕСТЬ ЗАМЕЧАНИЯ": "remarks", "НУЖНО РЕШЕНИЕ ЧЕЛОВЕКА": "human" };
  const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

  /**
   * Открыт ли блок кода после этих строк — по тем же правилам, что
   * src/verdict.ts: ограда запоминается видом и длиной, закрывает её только
   * такая же не короче и без текста после; в информационной строке ограды из
   * обратных кавычек самих кавычек быть не может. Прежний подсчёт чётности
   * оформлял «принято» внутри блока из четырёх кавычек (рецензия Codex 28.09).
   */
  function isBlockOpen(lines) {
    let openFence = null;
    for (const line of lines) {
      const fence = FENCE.exec(line);
      if (openFence) {
        if (fence && fence[1][0] === openFence.char && fence[1].length >= openFence.length && fence[2].trim() === "") {
          openFence = null;
        }
        continue;
      }
      if (fence && !(fence[1][0] === "`" && fence[2].includes("`"))) {
        openFence = { char: fence[1][0], length: fence[1].length };
      }
    }
    return openFence !== null;
  }

  /**
   * Строка вердикта для показа: значок и слова, под ними исходная строка.
   * Только оформление — вердикт для цикла читает src/verdict.ts из исходного
   * текста. Здесь правило уже: строка должна быть последней, точной, вне кода
   * и вне цитаты; сомнительное остаётся обычным текстом, ничего не теряется.
   */
  function verdictLine(text) {
    if (!text) return null;
    // Перевод строки кодом, а не escape-записью: инструменты правки превращают её в настоящий знак.
    const lines = text.split(String.fromCharCode(10)).map((s) => s.trimEnd());
    let end = lines.length - 1;
    while (end >= 0 && lines[end].trim() === "") end -= 1;
    if (end < 0) return null;
    const last = lines[end];
    const m = /^ВЕРДИКТ: (.+?)\s*$/u.exec(last);
    if (!m || !VERDICT_VALUES[m[1]]) return null;
    if (isBlockOpen(lines.slice(0, end))) return null;
    return {
      verdict: VERDICT_VALUES[m[1]],
      line: last.trim(),
      body: lines.slice(0, end).join(String.fromCharCode(10)).replace(/\s+$/u, ""),
    };
  }

  const api = { effortLevels, defaultEffort, threadLayout, relayView, trackSteps, beadFor, actionCounters, verdictLine };
  globalThis.PanelThread = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
