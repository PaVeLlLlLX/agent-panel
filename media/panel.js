/**
 * Интерфейс комнаты — «язык нитей» (docs/specs/2026-09-27-облик-язык-нитей.md).
 *
 * Живой прогон показал, что прежний интерфейс мешал понять суть: колонка
 * действий занимала пол-панели, служебные сообщения подписывались «Вы», логи
 * агентов шли красными репликами. Отсюда устройство:
 *
 *   * беседа на всю ширину; действия агента за ход — одна свёрнутая строка
 *     внутри беседы: бусина на каждый вызов («Чётки») и счётчики по видам;
 *   * служебные сообщения — от «Панели», отдельным стилем;
 *   * логи процессов — в свёрнутой «Диагностике» внизу;
 *   * сверху — «Эстафета»: кто работает, сколько проверок, вердикт; по клику
 *     «Дорожка цикла»; ждущее решения — плашкой над полем ввода.
 *
 * Геометрия и смысл нитей считаются в thread.js; здесь только разметка.
 */
const vscode = acquireVsCodeApi();
const { summarizeTools, stickToBottom, toolCategory } = globalThis.PanelFormat;
const { effortLevels, defaultEffort, threadLayout, relayView, trackSteps, trackGeometry, savedRoute, beadFor, actionCounters, verdictLine } =
  globalThis.PanelThread;

const byId = (id) => document.getElementById(id);
const conversation = byId("беседа");
const inputBox = byId("ввод");

const NAMES = { claude: "Claude", codex: "Codex", gemini: "Gemini", human: "Вы", system: "Панель" };
const ROUTES = [
  {
    id: "review",
    name: "Задача с рецензией",
    hint: "Claude сделает, Codex проверит — по очереди, до вердикта",
    pairHint: "Claude сделает, Codex и Gemini проверят — до вердикта",
  },
  { id: "all", name: "Спросить всех", hint: "Все ответят независимо, друг другу ничего не передаётся" },
  { id: "claude", name: "Только Claude", hint: "Только Claude, без проверки" },
  { id: "codex", name: "Только Codex", hint: "Только Codex, без пересылки" },
  { id: "gemini", name: "Только Gemini", hint: "Только Gemini, без пересылки", needsGemini: true },
];
/** Gemini подключён (agy найден) — сообщает расширение. До ответа — нет. */
let geminiPresent = false;
const availableRoutes = () => ROUTES.filter((m) => !m.needsGemini || geminiPresent);
const routeHint = (m) => (geminiPresent && m.pairHint ? m.pairHint : m.hint);
const DIAGNOSTIC_LIMIT = 500;
const SVG = "http://www.w3.org/2000/svg";

/** Идущий поток текста по агенту. */
const streams = new Map();
/** Открытая группа действий по агенту. */
const groups = new Map();

function makeEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text != null) el.textContent = text;
  return el;
}

/** Значок из готовой разметки SVG: только постоянные строки из этого файла. */
function icon(markup, size = 14) {
  const template = document.createElement("template");
  template.innerHTML = `<svg xmlns="${SVG}" width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${markup}</svg>`;
  return template.content.firstChild;
}

/** Элемент SVG с атрибутами: только числа и постоянные строки из этого файла. */
function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, String(value));
  return el;
}

const ICONS = {
  command: '<path d="M3 4.5 6.5 8 3 11.5M8.5 12h4.5"/>',
  read: '<path d="M4 2h5.5L12 4.5V14H4z"/><path d="M9.5 2v2.5H12"/>',
  edit: '<path d="M3 13l1-3.5 6.5-6.5 2.5 2.5L6.5 12z"/>',
  other: '<circle cx="8" cy="8" r="2.5"/><path d="M8 2v3M8 11v3M2 8h3M11 8h3"/>',
  denied: '<circle cx="8" cy="8" r="5.5"/><path d="M4.2 11.8 11.8 4.2"/>',
  check: '<path d="M3.5 8.5 6.5 11.5 12.5 4.5"/>',
  attention: '<circle cx="8" cy="8" r="6.2"/><path d="M8 4.8v3.6M8 10.8v.3"/>',
  pause: '<circle cx="8" cy="8" r="6.2"/><path d="M6.5 5.8v4.4M9.5 5.8v4.4"/>',
  question: '<circle cx="8" cy="8" r="6.2"/><path d="M6.2 6.3a1.8 1.8 0 1 1 2.6 1.6c-.5.3-.8.7-.8 1.2v.3M8 11.2v.3"/>',
  chevron: '<path d="M6 3.5 10.5 8 6 12.5"/>',
};

/** Значки режимов: огоньки агентов и нити между ними. Цвета — классами из panel.css. */
const ROUTE_ICONS = {
  review:
    '<path class="ик-линия" d="M6 7h9"/><path class="ик-линия" d="M13 4.5 15.5 7 13 9.5"/>' +
    '<circle class="ик-claude" cx="4" cy="7" r="3"/><circle class="ик-codex" cx="18.5" cy="7" r="3"/>',
  reviewPair:
    '<path class="ик-линия" d="M6 7H11C14 7 14 3 16.5 3M11 7C14 7 14 11 16.5 11"/>' +
    '<circle class="ик-claude" cx="4" cy="7" r="3"/><circle class="ик-codex" cx="18.5" cy="3" r="2.4"/><circle class="ик-gemini" cx="18.5" cy="11" r="2.4"/>',
  all:
    '<path class="ик-линия" d="M4 7 15 3M4 7 15 11"/><circle class="ик-человек" cx="4" cy="7" r="2"/>' +
    '<circle class="ик-claude" cx="17" cy="3" r="2.6"/><circle class="ик-codex" cx="17" cy="11" r="2.6"/>',
  allPair:
    '<path class="ик-линия" d="M4 7 15 2M4 7 15 7M4 7 15 12"/><circle class="ик-человек" cx="4" cy="7" r="2"/>' +
    '<circle class="ик-claude" cx="17" cy="2" r="2"/><circle class="ик-codex" cx="17" cy="7" r="2"/><circle class="ик-gemini" cx="17" cy="12" r="2"/>',
  claude: '<circle class="ик-кольцо-claude" cx="11" cy="7" r="5.5"/><circle class="ик-claude" cx="11" cy="7" r="3.2"/>',
  codex: '<circle class="ик-кольцо-codex" cx="11" cy="7" r="5.5"/><circle class="ик-codex" cx="11" cy="7" r="3.2"/>',
  gemini: '<circle class="ик-кольцо-gemini" cx="11" cy="7" r="5.5"/><circle class="ик-gemini" cx="11" cy="7" r="3.2"/>',
};

function routeIcon(id) {
  const key = geminiPresent && (id === "review" || id === "all") ? `${id}Pair` : id;
  const template = document.createElement("template");
  template.innerHTML = `<svg xmlns="${SVG}" width="22" height="14" viewBox="0 0 22 14" aria-hidden="true">${ROUTE_ICONS[key]}</svg>`;
  return template.content.firstChild;
}

/** Состояние интерфейса между перезапусками webview: режим, раскрытая дорожка. */
const saved = vscode.getState() ?? {};
function remember(extra) {
  Object.assign(saved, extra);
  vscode.setState(saved);
}

// --- Прокрутка -----------------------------------------------------------------

/**
 * Прокрутка следует за новым текстом, только если человек уже внизу. Прежде
 * каждый кусок потока прокручивал беседу к концу, и читать текст выше во время
 * генерации было нельзя (жалоба владельца 27.09). Читает выше — появляется
 * кнопка «К последнему».
 */
let pinned = true;
const toLastButton = byId("к-последнему");
conversation.addEventListener("scroll", () => {
  pinned = stickToBottom(conversation.scrollHeight, conversation.scrollTop, conversation.clientHeight);
  if (pinned) toLastButton.hidden = true;
});
toLastButton.addEventListener("click", () => scrollToBottom(true));

function scrollToBottom(force = false) {
  if (force) pinned = true;
  if (pinned) {
    conversation.scrollTop = conversation.scrollHeight;
    toLastButton.hidden = true;
  } else {
    toLastButton.hidden = false;
  }
}

// --- Реплики -------------------------------------------------------------------

/**
 * Markdown и формулы — только у реплик агентов: вставленные человеком логи
 * не должны превращаться в разметку. Нет сборки — просто текст.
 */
const renderMarkdown = globalThis.PanelMarkdown?.render;
/** Исходный текст пузыря: поток приходит кусками, отрисовывается целиком. */
const sources = new WeakMap();

const VERDICTS = {
  accepted: { words: "Принято", icon: "check" },
  remarks: { words: "Есть замечания", icon: "attention" },
  human: { words: "Нужно ваше решение", icon: "pause" },
};

function render(p) {
  const node = p.querySelector(".текст");
  let text = sources.get(p) ?? "";
  p.querySelector(".вердикт-строка")?.remove();
  // Строка вердикта у законченной реплики рецензента — значком и словами,
  // под ними исходная строка как есть. На цикл это не влияет: вердикт
  // читает расширение из исходного текста.
  const verdict = p.dataset.verdict === "да" ? verdictLine(text) : null;
  if (verdict) text = verdict.body;
  if (renderMarkdown && p.dataset.markup === "да") {
    node.innerHTML = renderMarkdown(text);
    node.classList.add("разметка");
  } else {
    node.textContent = text;
  }
  if (verdict) {
    const kind = VERDICTS[verdict.verdict];
    const line = makeEl("div", `вердикт-строка ${verdict.verdict}`);
    line.append(icon(ICONS[kind.icon], 16), makeEl("span", "слово", kind.words), makeEl("span", "исходная", verdict.line));
    p.append(line);
  }
}

function bubble(agent, text, { asMarkup = agent === "claude" || agent === "codex" || agent === "gemini", snapshot } = {}) {
  const p = makeEl("article", `пузырь ${agent}`);
  const author = makeEl("div", "автор");
  author.append(makeEl("span", "имя", NAMES[agent] ?? agent));
  if (snapshot) {
    const meta = makeEl("span", "тихо", String(snapshot).slice(0, 7));
    meta.title = `Версия файлов, к которой относится реплика: ${snapshot}`;
    author.append(meta);
  }
  author.append(makeEl("span", "пишет перелив", "пишет"));
  p.append(author, makeEl("div", "текст"));
  if (asMarkup) p.dataset.markup = "да";
  sources.set(p, text ?? "");
  render(p);
  conversation.append(p);
  return p;
}

/** Реплика закончена: у рецензента отделяется строка вердикта. */
function finish(p, agent, text) {
  p.classList.remove("идёт");
  sources.set(p, text ?? "");
  if (agent === "codex" || agent === "gemini") p.dataset.verdict = "да";
  pendingRender.delete(p);
  render(p);
}

/** Во время потока разметка пересобирается не чаще раза в 80 мс, а не на каждый кусок. */
const pendingRender = new Set();
let renderTimer = 0;
function renderLater(p) {
  pendingRender.add(p);
  if (renderTimer) return;
  renderTimer = setTimeout(() => {
    renderTimer = 0;
    for (const u of pendingRender) render(u);
    pendingRender.clear();
    scrollToBottom();
  }, 80);
}

function showNotice(text, className = "") {
  conversation.append(makeEl("div", `уведомление ${className}`.trim(), text));
}

// --- Действия хода: «Чётки» и «Счётчики» ------------------------------------------

const COUNTER_LABELS = { command: "Команды", read: "Чтения и поиск", edit: "Правки", other: "Прочие действия", denied: "Отказано" };
const LABELS = { formed: "готовится", running: "выполняется", done: "готово", denied: "отказано" };

function actionGroup(agent) {
  let g = groups.get(agent);
  if (g) return g;
  const node = makeEl("details", `действия ${agent}`);
  const summary = makeEl("summary");
  const beads = makeEl("span", "чётки");
  const inProgress = makeEl("span", "идёт-сейчас перелив");
  inProgress.hidden = true;
  const counters = makeEl("span", "счётчики");
  const chevron = icon(ICONS.chevron, 12);
  chevron.classList.add("шеврон");
  summary.append(beads, inProgress, counters, chevron);
  const list = makeEl("div", "список");
  node.append(summary, list);
  conversation.append(node);
  g = { agent, node, summary, beads, inProgress, counters, list, names: [], denials: 0, calls: new Map() };
  groups.set(agent, g);
  updateSummary(g);
  return g;
}

function brief(text) {
  return (text ?? "").split(String.fromCharCode(10)).find((s) => s.trim() !== "")?.trim() ?? "";
}

function newCall(g, tool, args, callId, parent) {
  g.names.push(tool);
  const { shape } = beadFor(tool, "formed");
  const bead = makeEl("span", `бусина ${shape} formed`);
  if (parent) bead.classList.add("субагент");
  bead.title = `${parent ? "субагент · " : ""}${tool} · ${brief(args)}`;
  g.beads.append(bead);

  const line = makeEl("details", "вызов");
  const header = makeEl("summary");
  const label = makeEl("span", "метка", LABELS.formed);
  header.append(
    makeEl("span", `бусина ${shape} formed`),
    ...(parent ? [Object.assign(makeEl("span", "кто", "субагент"), { title: `запущен вызовом ${parent}` })] : []),
    makeEl("span", "имя", tool),
    makeEl("span", "кратко", brief(args)),
    label,
  );
  line.append(header);
  if (args) line.append(makeEl("pre", "аргументы", args));
  g.list.append(line);
  const call = { tool, args, shape, bead, line, label, state: "formed", parent };
  if (callId) g.calls.set(callId, call);
  updateSummary(g);
  return call;
}

function markCall(g, call, state) {
  call.state = state;
  call.bead.className = `бусина ${call.shape} ${state}${call.parent ? " субагент" : ""}`;
  call.line.querySelector("summary .бусина").className = `бусина ${call.shape} ${state}`;
  call.line.className = `вызов ${state === "denied" ? "отказ" : state === "running" ? "выполняется" : ""}`.trim();
  call.label.textContent = LABELS[state];
  updateSummary(g);
}

function updateSummary(g) {
  g.counters.replaceChildren(
    ...actionCounters(g.names, g.denials).map(({ kind, n }) => {
      const s = makeEl("span", `счётчик ${kind === "denied" ? "отказы" : ""}`.trim());
      s.title = COUNTER_LABELS[kind];
      s.append(icon(ICONS[kind]), String(n));
      return s;
    }),
  );
  const running = [...g.calls.values()].filter((v) => v.state === "running").pop();
  g.inProgress.hidden = !running;
  g.inProgress.textContent = running ? `выполняется: ${brief(running.args) || running.tool}` : "";
  const result = summarizeTools(g.names) || "действия";
  g.summary.title = `${NAMES[g.agent]}: ${result}${g.denials ? `, отказано ${g.denials}` : ""}. Нажмите — список`;
}

// --- Запрос разрешения ---------------------------------------------------------

/** Открытые карточки разрешений по id запроса. */
const requests = new Map();

const PERMISSION_ACTIONS = {
  command: "хочет выполнить команду",
  read: "хочет прочитать",
  search: "хочет найти",
  edit: "хочет изменить файл",
};

function permissionCard(e, history) {
  const card = makeEl("section", "разрешение");
  card.setAttribute("aria-label", "Запрос разрешения");
  const kind = toolCategory(e.tool);
  const header = makeEl("div", "заголовок");
  const who = makeEl("span");
  who.append(makeEl("span", "кто", NAMES[e.agent] ?? e.agent), ` ${PERMISSION_ACTIONS[kind] ?? "хочет вызвать инструмент"}`);
  header.append(icon(ICONS[kind === "search" ? "read" : kind] ?? ICONS.other), who, makeEl("span", "инструмент", e.tool ?? "?"));
  card.append(header, makeEl("pre", "аргументы", e.text ?? ""));
  const result = makeEl("div", "итог");
  if (history) {
    // Из журнала: процесс, задавший вопрос, уже другой — ответить нельзя.
    result.textContent = "запрос из прошлого запуска панели";
  } else {
    const buttons = makeEl("div", "кнопки");
    const close = () => {
      for (const k of buttons.querySelectorAll("button")) k.disabled = true;
    };
    const answer = (choice) => {
      close();
      vscode.postMessage({ type: "approval", id: e.callId, choice: choice });
    };
    const button = (text, className, tooltip, action) => {
      const k = makeEl("button", `пилюля ${className}`.trim(), text);
      k.title = tooltip;
      k.addEventListener("click", action);
      buttons.append(k);
    };
    button("Разрешить", "главная", "Выполнить этот вызов один раз", () => answer("allow"));
    if (e.sessionRules?.length) {
      button(
        "В этой сессии",
        "",
        `Больше не спрашивать до остановки Claude: ${e.sessionRules.join(", ")}. В файлы настроек ничего не пишется`,
        () => answer("allowSession"),
      );
    }
    button(
      "Больше не спрашивать",
      "",
      "Разрешить этот вызов и дальше не спрашивать в этой папке: до конца хода разрешает панель, " +
        "со следующего хода Claude работает в режиме bypassPermissions. Вернуть — кнопка со щитом у поля ввода",
      () => {
        // Свой запрос — своим ответом: запрос, который Claude отдаёт только
        // человеку, режим не разрешает, и карточка застыла бы без решения.
        answer("allow");
        vscode.postMessage({ type: "setPermissionMode", mode: "bypassPermissions" });
      },
    );
    buttons.append(makeEl("span", "распорка"));
    button("Отклонить", "опасно", "Не выполнять; Claude узнает, что отказал человек", () => answer("deny"));
    card.append(buttons);
  }
  card.append(result);
  conversation.append(card);
  // И карточку из журнала закроет решение, записанное следом за ней.
  requests.set(e.callId, card);
}

// --- Вопрос Claude человеку (AskUserQuestion) ------------------------------------

/** Ответ на один вопрос: свой текст важнее вариантов, несколько вариантов — через «, ». */
function chosenAnswer(block) {
  const own = block.querySelector(".свой-ответ").value.trim();
  if (own) return own;
  return [...block.querySelectorAll("input:checked")].map((k) => k.value).join(", ");
}

/**
 * Карточка вопроса: по каждому вопросу варианты (несколько — флажками) и поле
 * «Свой ответ». «Ответить» — когда ответ есть на каждый вопрос; ответы уходят
 * по тексту вопроса, как их ждёт Claude. Закрывает карточку решение адаптера,
 * как у разрешения: она живёт в той же карте requests.
 */
function questionCard(e, history) {
  const card = makeEl("section", "разрешение вопрос");
  card.setAttribute("aria-label", "Вопрос Claude");
  const header = makeEl("div", "заголовок");
  const who = makeEl("span");
  who.append(makeEl("span", "кто", NAMES[e.agent] ?? e.agent), " спрашивает");
  header.append(icon(ICONS.question), who);
  card.append(header);
  const questions = Array.isArray(e.questions) ? e.questions : [];
  const result = makeEl("div", "итог");
  // Из журнала вопросы приходят только текстом: процесс уже другой, ответить нельзя.
  if (history || questions.length === 0) card.append(makeEl("pre", "аргументы", e.text ?? ""));
  if (history) {
    result.textContent = "вопрос из прошлого запуска панели";
  } else {
    const form = makeEl("div", "вопросы");
    const blocks = questions.map((q, index) => {
      const block = makeEl("fieldset", "вопрос-блок");
      const legend = makeEl("legend", "вопрос-текст");
      if (q.header) legend.append(makeEl("span", "вопрос-подпись", q.header), " ");
      legend.append(q.question ?? "");
      block.append(legend);
      for (const option of q.options ?? []) {
        const label = makeEl("label", "вариант");
        const input = makeEl("input");
        input.type = q.multiSelect ? "checkbox" : "radio";
        input.name = `${e.callId}-${index}`;
        input.value = option.label ?? "";
        const text = makeEl("span", "вариант-текст");
        text.append(makeEl("span", "вариант-метка", option.label ?? ""));
        if (option.description) text.append(makeEl("span", "вариант-пояснение", option.description));
        label.append(input, text);
        block.append(label);
      }
      const own = makeEl("input", "свой-ответ");
      own.type = "text";
      own.placeholder = "Свой ответ";
      own.maxLength = 4000;
      own.setAttribute("aria-label", "Свой ответ");
      block.append(own);
      form.append(block);
      return { question: q.question ?? "", block };
    });
    if (blocks.length > 0) card.append(form);

    const buttons = makeEl("div", "кнопки");
    const lock = () => {
      for (const k of card.querySelectorAll("button, input")) k.disabled = true;
    };
    const ready = () => blocks.every(({ block }) => chosenAnswer(block) !== "");
    const reply = makeEl("button", "пилюля главная", "Ответить");
    reply.title = "Отправить ответы Claude";
    reply.addEventListener("click", () => {
      if (!ready()) return;
      const answers = {};
      for (const { question, block } of blocks) answers[question] = chosenAnswer(block);
      lock();
      vscode.postMessage({ type: "answerQuestion", id: e.callId, answers: answers });
    });
    const refresh = () => {
      reply.disabled = !ready();
    };
    form.addEventListener("input", refresh);
    form.addEventListener("change", refresh);
    // Enter в поле «Свой ответ» — то же, что «Ответить».
    form.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || !event.target.classList.contains("свой-ответ")) return;
      event.preventDefault();
      if (!reply.disabled) reply.click();
    });
    const decline = makeEl("button", "пилюля опасно", "Не отвечать");
    decline.title = "Claude узнает, что вы не стали отвечать";
    decline.addEventListener("click", () => {
      lock();
      vscode.postMessage({ type: "approval", id: e.callId, choice: "deny" });
    });
    if (blocks.length > 0) buttons.append(reply);
    buttons.append(makeEl("span", "распорка"), decline);
    refresh();
    card.append(buttons);
  }
  card.append(result);
  conversation.append(card);
  requests.set(e.callId, card);
}

// --- События -------------------------------------------------------------------

/**
 * Агенты, идущие ходом, который начали сами (Claude после фоновой команды):
 * их реплики — не работа по задаче, и это должно быть видно в самой реплике.
 */
const autonomous = new Map();

function showEvent(e, history = false) {
  switch (e.kind) {
    case "turn_started":
      if (e.unsolicited) autonomous.set(e.agent, e.text ?? "");
      return;
    case "text_delta": {
      let p = streams.get(e.agent);
      if (!p) {
        p = bubble(e.agent, "", { snapshot: e.snapshot });
        p.classList.add("идёт");
        streams.set(e.agent, p);
      }
      sources.set(p, (sources.get(p) ?? "") + (e.text ?? ""));
      renderLater(p);
      return;
    }
    case "message": {
      if (e.agent === "system") {
        showNotice(e.text ?? "");
        scrollToBottom();
        return;
      }
      // Реплика субагента — не ответ Claude: отдельный приглушённый блок, живой
      // пузырь Claude она не закрывает.
      if (e.parentCallId) {
        const p = bubble(e.agent, e.text ?? "", { snapshot: e.snapshot });
        p.classList.add("субагент");
        const name = p.querySelector(".автор .имя");
        name.textContent = "Субагент";
        name.title = `запущен вызовом ${e.parentCallId}`;
        scrollToBottom();
        return;
      }
      const openStream = streams.get(e.agent);
      const p = openStream ?? bubble(e.agent, "", { snapshot: e.snapshot });
      finish(p, e.agent, e.text);
      if (openStream) streams.delete(e.agent);
      if (autonomous.has(e.agent)) {
        p.classList.add("сам");
        const name = p.querySelector(".автор .имя");
        name.textContent = `${NAMES[e.agent] ?? e.agent} · сам`;
        name.title = autonomous.get(e.agent) || "ход начат без сообщения панели";
      }
      scrollToBottom();
      return;
    }
    case "tool_call": {
      newCall(actionGroup(e.agent), e.tool ?? "?", e.text ?? "", e.callId, e.parentCallId);
      scrollToBottom();
      return;
    }
    case "tool_running": {
      const g = groups.get(e.agent);
      const call = g?.calls.get(e.callId);
      if (call) markCall(g, call, "running");
      return;
    }
    case "tool_result": {
      const g = actionGroup(e.agent);
      const call = g.calls.get(e.callId) ?? newCall(g, e.tool ?? "?", "", e.callId, e.parentCallId);
      markCall(g, call, call.state === "denied" ? "denied" : "done");
      call.line.append(makeEl("div", "вывод-подпись", "сырой вывод — передаётся рецензенту как есть"));
      call.line.append(makeEl("pre", "вывод", e.text ?? ""));
      return;
    }
    case "approval_requested": {
      // Без callId запрос уже решён самим адаптером (запись файлов у Codex).
      if (!e.callId) return;
      if (e.tool === "AskUserQuestion") questionCard(e, history);
      else permissionCard(e, history);
      scrollToBottom();
      return;
    }
    case "approval_decided": {
      const card = requests.get(e.callId);
      if (card) {
        card.querySelector(".кнопки")?.remove();
        for (const k of card.querySelectorAll("input")) k.disabled = true;
        card.querySelector(".итог").textContent = e.text ?? "решено";
        card.classList.add(/^отклонено/.test(e.text ?? "") ? "отклонено" : "решено");
        requests.delete(e.callId);
        // Карточка живёт по id запроса, бусина — по id вызова инструмента.
        if (/^отклонено/.test(e.text ?? "") && e.toolCallId) {
          const g = groups.get(e.agent);
          const call = g?.calls.get(e.toolCallId);
          if (call) {
            g.denials += 1;
            markCall(g, call, "denied");
          }
        }
        return;
      }
      const g = actionGroup(e.agent);
      g.denials += 1;
      const call = g.calls.get(e.toolCallId ?? e.callId);
      if (call) markCall(g, call, "denied");
      else updateSummary(g);
      g.list.append(makeEl("div", "отказ-строка", e.text ?? "отказано"));
      return;
    }
    case "turn_completed":
      groups.delete(e.agent);
      if (e.unsolicited) autonomous.delete(e.agent);
      if (e.failed) showNotice(`${NAMES[e.agent]}: ${e.text ?? "ход не удался"}`, "ошибка");
      // Ход состоялся, но агент после ответа сообщил об ошибке (agy, 04.10):
      // текст конца хода у такого хода иначе не показывается.
      else if (e.lateError) showNotice(`${NAMES[e.agent]}: ${e.lateError}`, "внимание");
      return;
    case "error": {
      streams.delete(e.agent);
      groups.delete(e.agent);
      const p = bubble(e.agent, e.text ?? "ошибка", { asMarkup: false });
      p.classList.add("ошибка");
      scrollToBottom();
      return;
    }
    // Действие человека (отправил удержанное, переключил автопересылку) —
    // служебной строкой: это не реплика агентам. Материал рецензенту (material)
    // лента не рисует — он только в журнале.
    case "action":
      showNotice(`Вы: ${e.text ?? ""}`);
      scrollToBottom();
      return;
    case "diagnostic": {
      const lines = byId("диагностика-строки");
      const time = new Date(e.at).toLocaleTimeString("ru-RU", { hour12: false });
      lines.textContent += `${time} ${NAMES[e.agent] ?? e.agent}: ${e.text ?? ""}` + String.fromCharCode(10);
      const all = lines.textContent.split(String.fromCharCode(10));
      if (all.length > DIAGNOSTIC_LIMIT) lines.textContent = all.slice(-DIAGNOSTIC_LIMIT).join(String.fromCharCode(10));
      const counts = byId("диагностика-счёт");
      counts.textContent = String(Number(counts.textContent) + 1);
      return;
    }
    default:
      return;
  }
}

// --- Шапка: «Эстафета» и «Дорожка цикла» ------------------------------------------

const STEP_LABELS = { task: "Задача", claude: "Claude", codex: "Codex", gemini: "Gemini", you: "Вы" };
let lastState;

function showState(s) {
  lastState = s;
  const kind = relayView(s);
  const threadEl = byId("нить-статус");
  threadEl.dataset.active = kind.active;
  threadEl.dataset.flow = kind.flow;
  threadEl.dataset.pair = kind.pair ? "yes" : "no";
  for (const who of ["claude", "codex", "gemini"]) {
    threadEl.querySelector(`.ст-огонёк.${who}`).classList.toggle("горит", kind.lit[who]);
  }
  for (const who of ["codex", "gemini"]) {
    const mark = byId(`ст-отметка-${who}`);
    mark.textContent = kind.marks[who];
    mark.classList.toggle("принято", kind.marks[who] === "✓");
    mark.hidden = !kind.marks[who] || kind.active === "accepted";
  }
  const stage = byId("этап");
  stage.textContent = kind.label;
  stage.dataset.active = kind.active;
  stage.classList.toggle("перелив", ["claude", "codex", "gemini", "reviewers"].includes(kind.active));
  byId("этап-пояснение").textContent = kind.sub;

  const round = byId("раунд");
  round.replaceChildren(...kind.rounds.map((passed) => makeEl("span", passed ? "пройдена" : "")));
  round.setAttribute("aria-label", `проверок ${s.round} из ${s.maxRounds}`);
  round.dataset.caption = `проверок ${s.round} из ${s.maxRounds}`;

  const queue = byId("очередь");
  queue.hidden = !s.queued;
  queue.textContent = `в очереди ${s.queued}`;

  const task = byId("задача");
  task.hidden = !s.task;
  task.textContent = s.task ?? "";
  // Строка обрезается многоточием, полный текст — при наведении.
  task.title = s.task ?? "";

  showTrack();

  byId("удержано").hidden = !s.held;
  byId("удержано-причина").textContent = s.held?.reason ?? "";
  byId("отпустить").textContent = !s.held
    ? "Отправить"
    : s.held.action === "review"
      ? "Отправить на проверку"
      : s.held.action === "retry"
        ? `Повторить ${NAMES[s.held.to]}`
        : `Отправить ${NAMES[s.held.to]}`;

  byId("авто").checked = s.auto;
}

/** 1 262 000 → «1,26 млн», 17 527 → «17,5 тыс.». */
function tokens(n) {
  const num = (value, decimals) => String(Number(value.toFixed(decimals))).replace(".", ",");
  if (n >= 1_000_000) return `${num(n / 1_000_000, 2)} млн`;
  if (n >= 1_000) return `${num(n / 1_000, 1)} тыс.`;
  return String(n);
}

const LIMIT_STATUSES = { allowed: "в норме", allowed_warning: "близко к пределу", rejected: "исчерпан" };
const WINDOW_LABELS = { week: "неделя", five_hour: "окно 5 ч" };

/** Время сведения; не сегодняшнее — с датой: «на 05:14», «на 27.09 23:50». */
function infoTime(at) {
  const d = new Date(at);
  const clockText = d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === new Date().toDateString()) return clockText;
  return `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")} ${clockText}`;
}

// Пометка «на …» зависит от возраста сведения, а не только от событий:
// раскрытая строка расхода перерисовывается раз в минуту (рецензия Codex 28.09).
setInterval(() => {
  if (saved.track === true) showUsage(true);
}, 60_000);

/** Строка расхода: токены задачи по агентам и последние сведения о лимитах. */
function showUsage(isOpen) {
  const line = byId("расход");
  const usage = lastState?.usage;
  const parts = [];
  for (const agent of ["claude", "codex", "gemini"]) {
    const r = usage?.task?.[agent];
    if (r && r.input + r.output > 0) {
      parts.push(`${NAMES[agent]} ${tokens(r.input + r.output)}${r.cached ? ` (из кеша ${tokens(r.cached)})` : ""}`);
    }
  }
  const limits = [];
  for (const agent of ["codex", "claude", "gemini"]) {
    const l = usage?.limits?.[agent];
    const week = agent === "claude" ? usage?.limits?.claudeWeek : agent === "gemini" ? usage?.limits?.geminiWeek : undefined;
    if (week) {
      // Доля недели из /usage; статус окна из потока — только когда он не «в норме».
      // Сведение старше 10 минут или последний запрос не удался — со временем.
      const isStale = week.stale || (typeof week.at === "number" && Date.now() - week.at > 10 * 60_000);
      const time = isStale && typeof week.at === "number" ? ` (на ${infoTime(week.at)})` : "";
      const pieces = [`неделя ${week.percent}%${time}`];
      if (typeof week.session === "number") pieces.push(`окно 5 ч ${week.session}%`);
      if (l?.status && l.status !== "allowed") pieces.push(LIMIT_STATUSES[l.status] ?? l.status);
      limits.push(`${NAMES[agent]}: ${pieces.join(", ")}`);
      continue;
    }
    if (!l) continue;
    const windowLabel = WINDOW_LABELS[l.window] ?? l.window ?? "";
    if (typeof l.percent === "number") limits.push(`${NAMES[agent]}: ${windowLabel} ${l.percent}%`);
    else if (l.status) limits.push(`${NAMES[agent]}: ${windowLabel} — ${LIMIT_STATUSES[l.status] ?? l.status}`);
  }
  line.textContent = [
    parts.length ? `Расход задачи: ${parts.join(" · ")}` : "",
    limits.length ? `Лимиты — ${limits.join(", ")}` : "",
  ].filter(Boolean).join(". ");
  line.hidden = !isOpen || !line.textContent;
}

function showTrack() {
  const track = byId("дорожка");
  const isOpen = saved.track === true;
  track.hidden = !isOpen;
  byId("эстафета").setAttribute("aria-expanded", String(isOpen));
  showUsage(isOpen);
  if (!isOpen) return;
  const s = lastState ?? { stage: "idle", maxRounds: 0 };
  const columns = trackSteps(s.trail ?? [], s);
  if (columns.length === 0) {
    track.replaceChildren(makeEl("span", "тихо", "Цикла рецензии ещё не было"));
    return;
  }
  const g = trackGeometry(columns);
  const svg = svgEl("svg", { width: g.width, height: g.height, viewBox: `0 0 ${g.width} ${g.height}`, class: "дорожка-граф" });
  for (const l of g.links) svg.append(svgEl("path", { d: l.d, class: l.ghost ? "шаг-связь пустая" : "шаг-связь" }));
  for (const u of g.nodes) {
    const classes = ["шаг-узел", u.who, u.state === "current" ? "текущий" : "", u.state === "ghost" ? "пустой" : "", u.unchecked ? "не-проверял" : ""];
    const circle = svgEl("circle", { cx: u.x, cy: u.y, r: u.r, class: classes.filter(Boolean).join(" ") });
    const tip = svgEl("title", {});
    tip.textContent =
      u.state === "ghost"
        ? `${STEP_LABELS[u.who]} — ещё впереди, если понадобится`
        : u.unchecked
          ? `${STEP_LABELS[u.who]} не проверял: ${u.unchecked}`
          : STEP_LABELS[u.who];
    circle.append(tip);
    svg.append(circle);
    if (u.mark) {
      svg.append(svgEl("rect", { x: u.x + 3, y: u.y - 15, width: 12, height: 12, rx: 6, class: "шаг-отметка-фон" }));
      const mark = svgEl("text", { x: u.x + 9, y: u.y - 6, "text-anchor": "middle", class: u.mark === "✓" ? "шаг-отметка принято" : "шаг-отметка" });
      mark.textContent = u.mark;
      svg.append(mark);
    }
  }
  track.replaceChildren(svg);
}

byId("эстафета").addEventListener("click", () => {
  remember({ track: !(saved.track === true) });
  showTrack();
});

// --- Режим отправки: переключатель и меню -----------------------------------------------

let route = savedRoute(saved.route, ROUTES.map((m) => m.id));
/** Сохранённое намерение (route) переживает перезапуск как есть; показывается и уходит — только доступный режим. */
const shownRoute = () => (availableRoutes().some((m) => m.id === route) ? route : "review");

function showRoute() {
  const current = availableRoutes().find((m) => m.id === shownRoute()) ?? ROUTES[0];
  byId("маршрут-название").textContent = current.name;
  byId("маршрут").title = `${routeHint(current)}. Нажмите — выбрать режим`;
  byId("режимы").replaceChildren(
    ...availableRoutes().map((m) => {
      const k = makeEl("button");
      k.setAttribute("role", "radio");
      k.setAttribute("aria-checked", String(m.id === shownRoute()));
      k.setAttribute("aria-label", m.name);
      k.dataset.route = m.id;
      k.title = `${m.name}: ${routeHint(m)}`;
      k.append(routeIcon(m.id));
      k.addEventListener("click", () => {
        selectRoute(m.id);
        // Кнопки пересоздаются: фокус переходит на новую отмеченную.
        byId("режимы").querySelector('[aria-checked="true"]')?.focus();
      });
      return k;
    }),
  );
  byId("маршрут-меню").replaceChildren(
    ...availableRoutes().map((m) => {
      const k = makeEl("button");
      k.setAttribute("role", "menuitemradio");
      k.setAttribute("aria-checked", String(m.id === shownRoute()));
      k.dataset.route = m.id;
      k.title = routeHint(m);
      const checkmark = icon(ICONS.check);
      checkmark.classList.add("галка");
      k.append(routeIcon(m.id), makeEl("span", "", m.name), checkmark);
      k.addEventListener("click", () => {
        selectRoute(m.id);
        closeMenu(true);
      });
      return k;
    }),
  );
}

function selectRoute(id) {
  route = id;
  remember({ route: id });
  showRoute();
}

/** Закрыть меню режима; с возвратом — фокус на кнопку названия, откуда меню открыли. */
function closeMenu(restoreFocus = false) {
  const wasOpen = !byId("маршрут-меню").hidden;
  byId("маршрут-меню").hidden = true;
  byId("маршрут").setAttribute("aria-expanded", "false");
  if (restoreFocus && wasOpen) byId("маршрут").focus();
}

byId("маршрут").addEventListener("click", (event) => {
  event.stopPropagation();
  const menu = byId("маршрут-меню");
  menu.hidden = !menu.hidden;
  byId("маршрут").setAttribute("aria-expanded", String(!menu.hidden));
});
document.addEventListener("click", (event) => {
  if (!byId("маршрут-меню").hidden && !event.target.closest?.("#маршрут-меню")) closeMenu();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeMenu(true);
});
showRoute();

/** Gemini: подключён ли и на месте ли правила «только чтение» (Task 12 шлёт при открытии и после «Добавить правила»). */
function receiveGemini(d) {
  geminiPresent = d.present === true;
  if (!geminiPresent && route === "gemini") route = "review";
  const rulesMissing = geminiPresent && d.rules?.ok === false;
  byId("правила-gemini").hidden = !rulesMissing;
  byId("правила-gemini-причина").textContent = rulesMissing
    ? `${d.rules.reason ?? "правил нет"}. Пока правил нет, работу проверяет один Codex.`
    : "";
  showRoute();
  showModels();
}
byId("добавить-правила").addEventListener("click", () => vscode.postMessage({ type: "addGeminiRules" }));

// --- Модель и уровень рассуждения: шкала «Нить» --------------------------------------
// Список запрашивается по кнопке, а не при открытии: каждый поднимает
// короткий процесс агента, а агенты в панели запускаются по делу.

const MODELS = {
  claude: { options: undefined, choice: { model: "", effort: "" }, error: "" },
  codex: { options: undefined, choice: { model: "", effort: "" }, error: "" },
  gemini: { options: undefined, choice: { model: "", effort: "" }, error: "" },
};
const MODEL_AGENTS = ["claude", "codex", "gemini"];
const shownAgents = () => MODEL_AGENTS.filter((a) => a !== "gemini" || geminiPresent);
let listsRequested = false;
const MODE_LABELS = { bypassPermissions: "Без вопросов", default: "Спрашивать" };
let claudeMode = "bypassPermissions";

function receiveMode(mode) {
  if (typeof mode !== "string") return;
  claudeMode = mode;
  showMode();
  showModels();
}

function showMode() {
  const button = byId("без-вопросов");
  button.setAttribute("aria-pressed", String(claudeMode === "bypassPermissions"));
  // Режим из настройки, которого нет в переключателе (plan, acceptEdits…), показывается как есть.
  button.querySelector(".подпись").textContent = MODE_LABELS[claudeMode] ?? claudeMode;
  button.title =
    claudeMode === "bypassPermissions"
      ? "Claude выполняет команды без запроса разрешения; свои вопросы к вам задаёт карточкой. Нажмите — спрашивать каждое действие, требующее согласия"
      : "Каждое действие Claude, требующее согласия, приходит карточкой. Нажмите — без вопросов. Действует для этой папки";
}

function makeOption(value, caption, hint = "") {
  const o = makeEl("option", "", caption);
  o.value = value;
  if (hint) o.title = hint;
  return o;
}

function modelCaption(agent) {
  const { options, choice } = MODELS[agent];
  const selectedModel = options?.find((o) => o.id === choice.model);
  const name = choice.model ? (selectedModel?.label ?? choice.model) : "по умолчанию";
  return choice.effort ? `${name} · ${choice.effort}` : name;
}

function showModels() {
  byId("модели-кнопка").title =
    `Модель и уровень рассуждения каждого агента; меняются со следующего хода. Сейчас — ` +
    shownAgents().map((a) => `${NAMES[a]}: ${modelCaption(a)}`).join("; ") +
    `; разрешения Claude: ${(MODE_LABELS[claudeMode] ?? claudeMode).toLowerCase()}`;
  const errors = shownAgents().filter((a) => MODELS[a].error).map((a) => `${NAMES[a]}: ${MODELS[a].error}`);
  const waiting = listsRequested && shownAgents().some((a) => !MODELS[a].options && !MODELS[a].error);
  byId("модели-состояние").textContent = errors.length
    ? `Список не получен — ${errors.join("; ")}. Откройте ещё раз, чтобы повторить.`
    : waiting
      ? "Загружаю список моделей…"
      : "";
  byId("строка-gemini").hidden = !geminiPresent;
  for (const agent of shownAgents()) {
    const { options, choice } = MODELS[agent];
    const model = byId(`модель-${agent}`);
    if (!options) {
      model.disabled = true;
      drawThread(agent, undefined);
      continue;
    }
    model.replaceChildren(...options.map((o) => makeOption(o.id, o.label, o.description)));
    model.value = choice.model;
    model.disabled = false;
    drawThread(agent, options.find((o) => o.id === choice.model));
  }
}

/** Узел разметки со стилями из раскладки: вся геометрия — числа из thread.js. */
function chunk(className, style) {
  const el = makeEl("span", className);
  Object.assign(el.style, style);
  return el;
}

const px = (n) => `${n}px`;

function drawThread(agent, model) {
  const strip = byId(`нить-${agent}`);
  const row = byId(`строка-${agent}`);
  const levels = effortLevels(agent, model?.efforts ?? []);
  const isDefault = defaultEffort(model);
  const choice = MODELS[agent].choice.effort;
  const r = threadLayout(agent, levels, choice, isDefault, strip.clientWidth || 128);
  // Вернуть «по умолчанию» можно, пока выбран явный уровень: у Claude умолчание
  // неизвестно, и никакой узел его не заменяет (рецензия Codex 28.09).
  byId(`нить-сброс-${agent}`).hidden = !r || !choice;
  const name = modelCaption(agent).replace(/ · .*$/, "");
  if (!r) {
    row.title = `${NAMES[agent]}: ${name}`;
    strip.replaceChildren(...(MODELS[agent].options ? [makeEl("span", "нить-пусто-текст", "без уровней")] : []));
    return;
  }
  // Название уровня — подсказкой строки и узла: пояснений в карточке нет (владелец, 02.10).
  row.title = `${NAMES[agent]}: ${choice || isDefault ? `${name} · ${r.label}` : name}`;

  const parts = [chunk("нить-основа", { left: "10px", width: px(r.baseWidth) })];
  if (r.modeSegment) {
    const color = r.modeSegment.lit ? r.color : "var(--нить-край)";
    parts.push(
      chunk("нить-режим", {
        left: px(r.modeSegment.left),
        top: "14px",
        height: "2px",
        width: px(r.modeSegment.width),
        background: `repeating-linear-gradient(90deg, ${color} 0 4px, transparent 4px 8px)`,
      }),
    );
  }
  if (r.litWidth > 0) {
    parts.push(
      chunk("нить-свет", { left: "10px", top: px(r.litTop), height: px(r.litHeight), width: px(r.litWidth), background: r.litFill }),
    );
  }
  if (r.particles.length) {
    const flow = chunk("нить-поток", { left: "10px", width: px(r.flowWidth) });
    for (const ch of r.particles) {
      flow.append(chunk("нить-частица", { animationDuration: ch.dur, animationDelay: ch.delay, boxShadow: `0 0 6px ${r.color}` }));
    }
    parts.push(flow);
  }
  if (r.fork) {
    const forks = chunk("нить-ветвь-обёртка", { left: px(r.forkLeft) });
    for (const v of r.branches) {
      const fork = chunk("нить-ветвь", {
        transform: `rotate(${v.angle})`,
        background: `linear-gradient(90deg, ${r.color}, color-mix(in srgb, var(--vscode-foreground) 12%, transparent))`,
      });
      fork.append(
        chunk("нить-частица", { animationDelay: v.delay, boxShadow: `0 0 6px ${r.color}` }),
        chunk("нить-субагент", { background: r.tipColor, boxShadow: `0 0 8px ${r.tipColor}`, animationDelay: v.delay }),
      );
      forks.append(fork);
    }
    parts.push(forks);
  }
  if (r.defaultLeft != null) {
    const label = chunk("нить-по-умолчанию", { left: px(r.defaultLeft) });
    label.title = "Уровень по умолчанию";
    parts.push(label);
  }
  for (const u of r.nodes) {
    const node = makeEl("button", "нить-узел");
    node.style.left = px(u.left);
    node.setAttribute("role", "radio");
    node.setAttribute("aria-checked", String(u.current));
    node.setAttribute("aria-label", u.name);
    node.dataset.level = u.id;
    node.title = `${u.name}. ${u.tip}`;
    node.tabIndex = u.current || (!r.nodes.some((n) => n.current) && u === r.nodes[0]) ? 0 : -1;
    node.append(
      chunk("", {
        width: px(u.size),
        height: px(u.size),
        boxSizing: "border-box",
        background: u.fill,
        border: u.border,
        boxShadow: u.glow,
      }),
    );
    node.addEventListener("click", () => selectLevel(agent, model, u.id));
    parts.push(node);
  }
  if (r.ringLeft != null) {
    const rings = chunk("нить-кольцо-обёртка", { left: px(r.ringLeft) });
    rings.append(chunk("нить-кольцо", { borderColor: r.color, animationDuration: r.ringDur }));
    if (r.deep) rings.append(chunk("нить-кольцо", { borderColor: r.color, animationDuration: r.ringDur, animationDelay: r.ringDelay }));
    parts.push(rings);
  }
  strip.replaceChildren(...parts);
}

/**
 * Узел, совпадающий с умолчанием из каталога, сохраняется как «по умолчанию»:
 * флаг агенту не передаётся, решает сам агент — как было до выбора.
 */
function selectLevel(agent, model, id) {
  const effort = model?.defaultEffort && id === model.defaultEffort ? "" : id;
  select(agent, { model: MODELS[agent].choice.model, effort });
  byId(`нить-${agent}`).querySelector(`[data-level="${id}"]`)?.focus();
}

function select(agent, choice) {
  MODELS[agent].choice = choice;
  showModels();
  vscode.postMessage({ type: "setModel", agent: agent, model: choice.model, effort: choice.effort });
}

function receiveModels(d) {
  const m = MODELS[d.agent];
  if (!m) return;
  if (d.options) m.options = d.options;
  if (d.choice) m.choice = d.choice;
  m.error = d.error ?? "";
  if (d.error) listsRequested = false;
  showModels();
}

for (const agent of MODEL_AGENTS) {
  byId(`модель-${agent}`).addEventListener("change", (event) => {
    const m = MODELS[agent];
    const model = event.target.value;
    const levels = m.options?.find((o) => o.id === model)?.efforts ?? [];
    // Уровень, которого у новой модели нет, сбрасывается, а не уходит агенту.
    select(agent, { model: model, effort: levels.includes(m.choice.effort) ? m.choice.effort : "" });
  });
  // Стрелки двигают выбор по нити, как в любой группе переключателей.
  byId(`нить-${agent}`).addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const nodes = [...byId(`нить-${agent}`).querySelectorAll(".нить-узел")];
    const currentIndex = nodes.findIndex((u) => u.getAttribute("aria-checked") === "true");
    const step = event.key === "ArrowRight" ? 1 : -1;
    const next = nodes[Math.min(nodes.length - 1, Math.max(0, (currentIndex < 0 ? 0 : currentIndex) + step))];
    if (!next) return;
    event.preventDefault();
    next.click();
  });
}

for (const agent of MODEL_AGENTS) {
  byId(`нить-сброс-${agent}`).addEventListener("click", () => {
    select(agent, { model: MODELS[agent].choice.model, effort: "" });
  });
}
// Для какого агента — спросит расширение; подтверждение — там же: новая сессия — необратимое забывание.
byId("новая-сессия").addEventListener("click", () => vscode.postMessage({ type: "newSession" }));

byId("без-вопросов").addEventListener("click", () => {
  claudeMode = claudeMode === "bypassPermissions" ? "default" : "bypassPermissions";
  showMode();
  showModels();
  vscode.postMessage({ type: "setPermissionMode", mode: claudeMode });
});

byId("модели-кнопка").addEventListener("click", () => {
  const panel = byId("модели-панель");
  panel.hidden = !panel.hidden;
  byId("модели-кнопка").setAttribute("aria-expanded", String(!panel.hidden));
  if (!panel.hidden && !listsRequested) {
    listsRequested = true;
    vscode.postMessage({ type: "listModels" });
  }
  showModels();
});
// Ширина нити зависит от ширины панели.
window.addEventListener("resize", () => {
  if (!byId("модели-панель").hidden) showModels();
});
showMode();
showModels();

// --- Прочее ------------------------------------------------------------------------

window.addEventListener("message", (event) => {
  const d = event.data;
  if (d?.type === "event") showEvent(d.event, d.history === true);
  else if (d?.type === "state") showState(d.state);
  else if (d?.type === "models") receiveModels(d);
  else if (d?.type === "permissions") receiveMode(d.mode);
  else if (d?.type === "gemini") receiveGemini(d);
});

function send() {
  const text = inputBox.value.trim();
  if (!text) return;
  // Своё сообщение человек хочет видеть: беседа снова следует за концом.
  scrollToBottom(true);
  vscode.postMessage({ type: "send", text: text, route: shownRoute() });
  inputBox.value = "";
  fitInput();
}

/** Поле растёт с текстом до 40% высоты панели, дальше — прокрутка внутри. */
function fitInput() {
  inputBox.style.height = "auto";
  inputBox.style.height = `${Math.min(inputBox.scrollHeight, Math.round(window.innerHeight * 0.4))}px`;
}
inputBox.addEventListener("input", fitInput);

// Webview сам по ссылкам не переходит: адрес открывает расширение.
conversation.addEventListener("click", (event) => {
  const link = event.target.closest?.(".разметка a[href]");
  if (!link) return;
  event.preventDefault();
  vscode.postMessage({ type: "openLink", href: link.getAttribute("href") });
});
byId("отправить").addEventListener("click", send);
inputBox.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    send();
  }
});
byId("отпустить").addEventListener("click", () => vscode.postMessage({ type: "release" }));
byId("стоп").addEventListener("click", () => vscode.postMessage({ type: "stopAll" }));
byId("прервать").addEventListener("click", () => vscode.postMessage({ type: "interrupt" }));
byId("авто").addEventListener("change", (e) => vscode.postMessage({ type: "setAuto", on: e.target.checked }));
byId("диагностика-кнопка").addEventListener("click", () => {
  const panel = byId("диагностика");
  panel.hidden = !panel.hidden;
  byId("диагностика-кнопка").setAttribute("aria-expanded", String(!panel.hidden));
});

// История и состояние приходят только после этого сигнала.
vscode.postMessage({ type: "ready" });
