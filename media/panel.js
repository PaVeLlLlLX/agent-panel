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
const { effortLevels, defaultEffort, threadLayout, relayView, trackSteps, beadFor, actionCounters, verdictLine } =
  globalThis.PanelThread;

const $ = (id) => document.getElementById(id);
const беседа = $("беседа");
const ввод = $("ввод");

const ИМЕНА = { claude: "Claude", codex: "Codex", human: "Вы", system: "Панель" };
const МАРШРУТЫ = [
  { id: "review", name: "Задача с рецензией", hint: "Claude сделает, Codex проверит — по очереди, до вердикта" },
  { id: "both", name: "Спросить обоих", hint: "Оба ответят независимо, друг другу ничего не передаётся" },
  { id: "claude", name: "Только Claude", hint: "Только Claude, без проверки" },
  { id: "codex", name: "Только Codex", hint: "Только Codex, без пересылки" },
];
const ПРЕДЕЛ_ДИАГНОСТИКИ = 500;
const SVG = "http://www.w3.org/2000/svg";

/** Идущий поток текста по агенту. */
const потоки = new Map();
/** Открытая группа действий по агенту. */
const группы = new Map();

function элемент(тег, класс, текст) {
  const э = document.createElement(тег);
  if (класс) э.className = класс;
  if (текст != null) э.textContent = текст;
  return э;
}

/** Значок из готовой разметки SVG: только постоянные строки из этого файла. */
function значок(разметка, размер = 14) {
  const шаблон = document.createElement("template");
  шаблон.innerHTML = `<svg xmlns="${SVG}" width="${размер}" height="${размер}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${разметка}</svg>`;
  return шаблон.content.firstChild;
}

const ЗНАЧКИ = {
  command: '<path d="M3 4.5 6.5 8 3 11.5M8.5 12h4.5"/>',
  read: '<path d="M4 2h5.5L12 4.5V14H4z"/><path d="M9.5 2v2.5H12"/>',
  edit: '<path d="M3 13l1-3.5 6.5-6.5 2.5 2.5L6.5 12z"/>',
  other: '<circle cx="8" cy="8" r="2.5"/><path d="M8 2v3M8 11v3M2 8h3M11 8h3"/>',
  denied: '<circle cx="8" cy="8" r="5.5"/><path d="M4.2 11.8 11.8 4.2"/>',
  check: '<path d="M3.5 8.5 6.5 11.5 12.5 4.5"/>',
  attention: '<circle cx="8" cy="8" r="6.2"/><path d="M8 4.8v3.6M8 10.8v.3"/>',
  pause: '<circle cx="8" cy="8" r="6.2"/><path d="M6.5 5.8v4.4M9.5 5.8v4.4"/>',
  chevron: '<path d="M6 3.5 10.5 8 6 12.5"/>',
};

/** Значки режимов: огоньки агентов и нити между ними. Цвета — классами из panel.css. */
const ЗНАЧКИ_МАРШРУТОВ = {
  review:
    '<path class="ик-линия" d="M6 7h9"/><path class="ик-линия" d="M13 4.5 15.5 7 13 9.5"/>' +
    '<circle class="ик-claude" cx="4" cy="7" r="3"/><circle class="ик-codex" cx="18.5" cy="7" r="3"/>',
  both:
    '<path class="ик-линия" d="M4 7 15 3M4 7 15 11"/><circle class="ик-человек" cx="4" cy="7" r="2"/>' +
    '<circle class="ик-claude" cx="17" cy="3" r="2.6"/><circle class="ик-codex" cx="17" cy="11" r="2.6"/>',
  claude: '<circle class="ик-кольцо-claude" cx="11" cy="7" r="5.5"/><circle class="ик-claude" cx="11" cy="7" r="3.2"/>',
  codex: '<circle class="ик-кольцо-codex" cx="11" cy="7" r="5.5"/><circle class="ик-codex" cx="11" cy="7" r="3.2"/>',
};

function значокМаршрута(id) {
  const шаблон = document.createElement("template");
  шаблон.innerHTML = `<svg xmlns="${SVG}" width="22" height="14" viewBox="0 0 22 14" aria-hidden="true">${ЗНАЧКИ_МАРШРУТОВ[id]}</svg>`;
  return шаблон.content.firstChild;
}

/** Состояние интерфейса между перезапусками webview: режим, раскрытая дорожка. */
const сохранено = vscode.getState() ?? {};
function запомнить(доп) {
  Object.assign(сохранено, доп);
  vscode.setState(сохранено);
}

// --- Прокрутка -----------------------------------------------------------------

/**
 * Прокрутка следует за новым текстом, только если человек уже внизу. Прежде
 * каждый кусок потока прокручивал беседу к концу, и читать текст выше во время
 * генерации было нельзя (жалоба владельца 27.09). Читает выше — появляется
 * кнопка «К последнему».
 */
let прилип = true;
const кПоследнему = $("к-последнему");
беседа.addEventListener("scroll", () => {
  прилип = stickToBottom(беседа.scrollHeight, беседа.scrollTop, беседа.clientHeight);
  if (прилип) кПоследнему.hidden = true;
});
кПоследнему.addEventListener("click", () => вниз(true));

function вниз(принудительно = false) {
  if (принудительно) прилип = true;
  if (прилип) {
    беседа.scrollTop = беседа.scrollHeight;
    кПоследнему.hidden = true;
  } else {
    кПоследнему.hidden = false;
  }
}

// --- Реплики -------------------------------------------------------------------

/**
 * Markdown и формулы — только у реплик агентов: вставленные человеком логи
 * не должны превращаться в разметку. Нет сборки — просто текст.
 */
const отрисовкаMarkdown = globalThis.PanelMarkdown?.render;
/** Исходный текст пузыря: поток приходит кусками, отрисовывается целиком. */
const исходники = new WeakMap();

const ВЕРДИКТЫ = {
  accepted: { слова: "Принято", значок: "check" },
  remarks: { слова: "Есть замечания", значок: "attention" },
  human: { слова: "Нужно ваше решение", значок: "pause" },
};

function отрисовать(п) {
  const узел = п.querySelector(".текст");
  let текст = исходники.get(п) ?? "";
  п.querySelector(".вердикт-строка")?.remove();
  // Строка вердикта у законченной реплики рецензента — значком и словами,
  // под ними исходная строка как есть. На цикл это не влияет: вердикт
  // читает расширение из исходного текста.
  const вердикт = п.dataset.вердикт === "да" ? verdictLine(текст) : null;
  if (вердикт) текст = вердикт.body;
  if (отрисовкаMarkdown && п.dataset.разметка === "да") {
    узел.innerHTML = отрисовкаMarkdown(текст);
    узел.classList.add("разметка");
  } else {
    узел.textContent = текст;
  }
  if (вердикт) {
    const вид = ВЕРДИКТЫ[вердикт.verdict];
    const строка = элемент("div", `вердикт-строка ${вердикт.verdict}`);
    строка.append(значок(ЗНАЧКИ[вид.значок], 16), элемент("span", "слово", вид.слова), элемент("span", "исходная", вердикт.line));
    п.append(строка);
  }
}

function пузырь(агент, текст, { какРазметка = агент === "claude" || агент === "codex", снимок } = {}) {
  const п = элемент("article", `пузырь ${агент}`);
  const автор = элемент("div", "автор");
  автор.append(элемент("span", "имя", ИМЕНА[агент] ?? агент));
  if (снимок) {
    const мета = элемент("span", "тихо", String(снимок).slice(0, 7));
    мета.title = `Версия файлов, к которой относится реплика: ${снимок}`;
    автор.append(мета);
  }
  автор.append(элемент("span", "пишет перелив", "пишет"));
  п.append(автор, элемент("div", "текст"));
  if (какРазметка) п.dataset.разметка = "да";
  исходники.set(п, текст ?? "");
  отрисовать(п);
  беседа.append(п);
  return п;
}

/** Реплика закончена: у рецензента отделяется строка вердикта. */
function закончить(п, агент, текст) {
  п.classList.remove("идёт");
  исходники.set(п, текст ?? "");
  if (агент === "codex") п.dataset.вердикт = "да";
  ждутОтрисовки.delete(п);
  отрисовать(п);
}

/** Во время потока разметка пересобирается не чаще раза в 80 мс, а не на каждый кусок. */
const ждутОтрисовки = new Set();
let таймерОтрисовки = 0;
function отрисоватьПозже(п) {
  ждутОтрисовки.add(п);
  if (таймерОтрисовки) return;
  таймерОтрисовки = setTimeout(() => {
    таймерОтрисовки = 0;
    for (const у of ждутОтрисовки) отрисовать(у);
    ждутОтрисовки.clear();
    вниз();
  }, 80);
}

function уведомление(текст, класс = "") {
  беседа.append(элемент("div", `уведомление ${класс}`.trim(), текст));
}

// --- Действия хода: «Чётки» и «Счётчики» ------------------------------------------

const ПОДПИСИ_СЧЁТЧИКОВ = { command: "Команды", read: "Чтения и поиск", edit: "Правки", other: "Прочие действия", denied: "Отказано" };
const МЕТКИ = { formed: "готовится", running: "выполняется", done: "готово", denied: "отказано" };

function группаДействий(агент) {
  let г = группы.get(агент);
  if (г) return г;
  const узел = элемент("details", `действия ${агент}`);
  const сводка = элемент("summary");
  const чётки = элемент("span", "чётки");
  const идёт = элемент("span", "идёт-сейчас перелив");
  идёт.hidden = true;
  const счётчики = элемент("span", "счётчики");
  const шеврон = значок(ЗНАЧКИ.chevron, 12);
  шеврон.classList.add("шеврон");
  сводка.append(чётки, идёт, счётчики, шеврон);
  const список = элемент("div", "список");
  узел.append(сводка, список);
  беседа.append(узел);
  г = { агент, узел, сводка, чётки, идёт, счётчики, список, имена: [], отказы: 0, вызовы: new Map() };
  группы.set(агент, г);
  обновитьСводку(г);
  return г;
}

function кратко(текст) {
  return (текст ?? "").split(String.fromCharCode(10)).find((с) => с.trim() !== "")?.trim() ?? "";
}

function новыйВызов(г, инструмент, аргументы, callId, родитель) {
  г.имена.push(инструмент);
  const { shape } = beadFor(инструмент, "formed");
  const бусина = элемент("span", `бусина ${shape} formed`);
  if (родитель) бусина.classList.add("субагент");
  бусина.title = `${родитель ? "субагент · " : ""}${инструмент} · ${кратко(аргументы)}`;
  г.чётки.append(бусина);

  const строка = элемент("details", "вызов");
  const заголовок = элемент("summary");
  const метка = элемент("span", "метка", МЕТКИ.formed);
  заголовок.append(
    элемент("span", `бусина ${shape} formed`),
    ...(родитель ? [Object.assign(элемент("span", "кто", "субагент"), { title: `запущен вызовом ${родитель}` })] : []),
    элемент("span", "имя", инструмент),
    элемент("span", "кратко", кратко(аргументы)),
    метка,
  );
  строка.append(заголовок);
  if (аргументы) строка.append(элемент("pre", "аргументы", аргументы));
  г.список.append(строка);
  const вызов = { инструмент, аргументы, shape, бусина, строка, метка, состояние: "formed", родитель };
  if (callId) г.вызовы.set(callId, вызов);
  обновитьСводку(г);
  return вызов;
}

function отметитьВызов(г, вызов, состояние) {
  вызов.состояние = состояние;
  вызов.бусина.className = `бусина ${вызов.shape} ${состояние}${вызов.родитель ? " субагент" : ""}`;
  вызов.строка.querySelector("summary .бусина").className = `бусина ${вызов.shape} ${состояние}`;
  вызов.строка.className = `вызов ${состояние === "denied" ? "отказ" : состояние === "running" ? "выполняется" : ""}`.trim();
  вызов.метка.textContent = МЕТКИ[состояние];
  обновитьСводку(г);
}

function обновитьСводку(г) {
  г.счётчики.replaceChildren(
    ...actionCounters(г.имена, г.отказы).map(({ kind, n }) => {
      const с = элемент("span", `счётчик ${kind === "denied" ? "отказы" : ""}`.trim());
      с.title = ПОДПИСИ_СЧЁТЧИКОВ[kind];
      с.append(значок(ЗНАЧКИ[kind]), String(n));
      return с;
    }),
  );
  const выполняется = [...г.вызовы.values()].filter((в) => в.состояние === "running").pop();
  г.идёт.hidden = !выполняется;
  г.идёт.textContent = выполняется ? `выполняется: ${кратко(выполняется.аргументы) || выполняется.инструмент}` : "";
  const итог = summarizeTools(г.имена) || "действия";
  г.сводка.title = `${ИМЕНА[г.агент]}: ${итог}${г.отказы ? `, отказано ${г.отказы}` : ""}. Нажмите — список`;
}

// --- Запрос разрешения ---------------------------------------------------------

/** Открытые карточки разрешений по id запроса. */
const запросы = new Map();

const ДЕЙСТВИЯ_РАЗРЕШЕНИЯ = {
  command: "хочет выполнить команду",
  read: "хочет прочитать",
  search: "хочет найти",
  edit: "хочет изменить файл",
};

function карточкаРазрешения(е, история) {
  const карточка = элемент("section", "разрешение");
  карточка.setAttribute("aria-label", "Запрос разрешения");
  const вид = toolCategory(е.tool);
  const заголовок = элемент("div", "заголовок");
  const кто = элемент("span");
  кто.append(элемент("span", "кто", ИМЕНА[е.agent] ?? е.agent), ` ${ДЕЙСТВИЯ_РАЗРЕШЕНИЯ[вид] ?? "хочет вызвать инструмент"}`);
  заголовок.append(значок(ЗНАЧКИ[вид === "search" ? "read" : вид] ?? ЗНАЧКИ.other), кто, элемент("span", "инструмент", е.tool ?? "?"));
  карточка.append(заголовок, элемент("pre", "аргументы", е.text ?? ""));
  const итог = элемент("div", "итог");
  if (история) {
    // Из журнала: процесс, задавший вопрос, уже другой — ответить нельзя.
    итог.textContent = "запрос из прошлого запуска панели";
  } else {
    const кнопки = элемент("div", "кнопки");
    const закрыть = () => {
      for (const к of кнопки.querySelectorAll("button")) к.disabled = true;
    };
    const ответить = (выбор) => {
      закрыть();
      vscode.postMessage({ type: "approval", id: е.callId, choice: выбор });
    };
    const кнопка = (текст, класс, подсказка, действие) => {
      const к = элемент("button", `пилюля ${класс}`.trim(), текст);
      к.title = подсказка;
      к.addEventListener("click", действие);
      кнопки.append(к);
    };
    кнопка("Разрешить", "главная", "Выполнить этот вызов один раз", () => ответить("allow"));
    if (е.sessionRules?.length) {
      кнопка(
        "В этой сессии",
        "",
        `Больше не спрашивать до остановки Claude: ${е.sessionRules.join(", ")}. В файлы настроек ничего не пишется`,
        () => ответить("allowSession"),
      );
    }
    кнопка(
      "Больше не спрашивать",
      "",
      "Разрешить этот вызов и дальше не спрашивать в этой папке: до конца хода разрешает панель, " +
        "со следующего хода Claude работает в режиме bypassPermissions. Вернуть — кнопка со щитом у поля ввода",
      () => {
        закрыть();
        vscode.postMessage({ type: "setPermissionMode", mode: "bypassPermissions" });
      },
    );
    кнопки.append(элемент("span", "распорка"));
    кнопка("Отклонить", "опасно", "Не выполнять; Claude узнает, что отказал человек", () => ответить("deny"));
    карточка.append(кнопки);
  }
  карточка.append(итог);
  беседа.append(карточка);
  // И карточку из журнала закроет решение, записанное следом за ней.
  запросы.set(е.callId, карточка);
}

// --- События -------------------------------------------------------------------

function показатьСобытие(е, история = false) {
  switch (е.kind) {
    case "text_delta": {
      let п = потоки.get(е.agent);
      if (!п) {
        п = пузырь(е.agent, "", { снимок: е.snapshot });
        п.classList.add("идёт");
        потоки.set(е.agent, п);
      }
      исходники.set(п, (исходники.get(п) ?? "") + (е.text ?? ""));
      отрисоватьПозже(п);
      return;
    }
    case "message": {
      if (е.agent === "system") {
        уведомление(е.text ?? "");
        вниз();
        return;
      }
      // Реплика субагента — не ответ Claude: отдельный приглушённый блок, живой
      // пузырь Claude она не закрывает.
      if (е.parentCallId) {
        const п = пузырь(е.agent, е.text ?? "", { снимок: е.snapshot });
        п.classList.add("субагент");
        const имя = п.querySelector(".автор .имя");
        имя.textContent = "Субагент";
        имя.title = `запущен вызовом ${е.parentCallId}`;
        вниз();
        return;
      }
      const открытый = потоки.get(е.agent);
      if (открытый) {
        закончить(открытый, е.agent, е.text);
        потоки.delete(е.agent);
      } else {
        закончить(пузырь(е.agent, "", { снимок: е.snapshot }), е.agent, е.text);
      }
      вниз();
      return;
    }
    case "tool_call": {
      новыйВызов(группаДействий(е.agent), е.tool ?? "?", е.text ?? "", е.callId, е.parentCallId);
      вниз();
      return;
    }
    case "tool_running": {
      const г = группы.get(е.agent);
      const вызов = г?.вызовы.get(е.callId);
      if (вызов) отметитьВызов(г, вызов, "running");
      return;
    }
    case "tool_result": {
      const г = группаДействий(е.agent);
      const вызов = г.вызовы.get(е.callId) ?? новыйВызов(г, е.tool ?? "?", "", е.callId, е.parentCallId);
      отметитьВызов(г, вызов, вызов.состояние === "denied" ? "denied" : "done");
      вызов.строка.append(элемент("div", "вывод-подпись", "сырой вывод — передаётся рецензенту как есть"));
      вызов.строка.append(элемент("pre", "вывод", е.text ?? ""));
      return;
    }
    case "approval_requested": {
      // Без callId запрос уже решён самим адаптером (запись файлов у Codex).
      if (!е.callId) return;
      карточкаРазрешения(е, история);
      вниз();
      return;
    }
    case "approval_decided": {
      const карточка = запросы.get(е.callId);
      if (карточка) {
        карточка.querySelector(".кнопки")?.remove();
        карточка.querySelector(".итог").textContent = е.text ?? "решено";
        карточка.classList.add(/^отклонено/.test(е.text ?? "") ? "отклонено" : "решено");
        запросы.delete(е.callId);
        // Карточка живёт по id запроса, бусина — по id вызова инструмента.
        if (/^отклонено/.test(е.text ?? "") && е.toolCallId) {
          const г = группы.get(е.agent);
          const вызов = г?.вызовы.get(е.toolCallId);
          if (вызов) {
            г.отказы += 1;
            отметитьВызов(г, вызов, "denied");
          }
        }
        return;
      }
      const г = группаДействий(е.agent);
      г.отказы += 1;
      const вызов = г.вызовы.get(е.toolCallId ?? е.callId);
      if (вызов) отметитьВызов(г, вызов, "denied");
      else обновитьСводку(г);
      г.список.append(элемент("div", "отказ-строка", е.text ?? "отказано"));
      return;
    }
    case "turn_completed":
      группы.delete(е.agent);
      if (е.failed) уведомление(`${ИМЕНА[е.agent]}: ${е.text ?? "ход не удался"}`, "ошибка");
      return;
    case "error": {
      потоки.delete(е.agent);
      группы.delete(е.agent);
      const п = пузырь(е.agent, е.text ?? "ошибка", { какРазметка: false });
      п.classList.add("ошибка");
      вниз();
      return;
    }
    case "diagnostic": {
      const строки = $("диагностика-строки");
      const время = new Date(е.at).toLocaleTimeString("ru-RU", { hour12: false });
      строки.textContent += `${время} ${ИМЕНА[е.agent] ?? е.agent}: ${е.text ?? ""}` + String.fromCharCode(10);
      const все = строки.textContent.split(String.fromCharCode(10));
      if (все.length > ПРЕДЕЛ_ДИАГНОСТИКИ) строки.textContent = все.slice(-ПРЕДЕЛ_ДИАГНОСТИКИ).join(String.fromCharCode(10));
      const счёт = $("диагностика-счёт");
      счёт.textContent = String(Number(счёт.textContent) + 1);
      return;
    }
    default:
      return;
  }
}

// --- Шапка: «Эстафета» и «Дорожка цикла» ------------------------------------------

const ПОДПИСИ_ШАГОВ = { task: "Задача", claude: "Claude", codex: "Codex", you: "Вы" };
let последнееСостояние;

function показатьСостояние(с) {
  последнееСостояние = с;
  const вид = relayView(с);
  const нить = $("нить-статус");
  нить.dataset.active = вид.active;
  нить.dataset.flow = вид.flow;
  const этап = $("этап");
  этап.textContent = вид.label;
  этап.dataset.active = вид.active;
  этап.classList.toggle("перелив", вид.active === "claude" || вид.active === "codex");
  $("этап-пояснение").textContent = вид.sub;

  const раунд = $("раунд");
  раунд.replaceChildren(...вид.rounds.map((пройдена) => элемент("span", пройдена ? "пройдена" : "")));
  раунд.setAttribute("aria-label", `проверок ${с.round} из ${с.maxRounds}`);
  раунд.dataset.подпись = `проверок ${с.round} из ${с.maxRounds}`;

  const очередь = $("очередь");
  очередь.hidden = !с.queued;
  очередь.textContent = `в очереди ${с.queued}`;

  const задача = $("задача");
  задача.hidden = !с.task;
  задача.textContent = с.task ?? "";
  // Строка обрезается многоточием, полный текст — при наведении.
  задача.title = с.task ?? "";

  показатьДорожку();

  $("удержано").hidden = !с.held;
  $("удержано-причина").textContent = с.held?.reason ?? "";
  $("отпустить").textContent = !с.held
    ? "Отправить"
    : с.held.action === "retry"
      ? `Повторить ${ИМЕНА[с.held.to]}`
      : `Отправить ${ИМЕНА[с.held.to]}`;

  $("авто").checked = с.auto;
}

/** 1 262 000 → «1,26 млн», 17 527 → «17,5 тыс.». */
function токены(n) {
  const число = (значение, знаков) => String(Number(значение.toFixed(знаков))).replace(".", ",");
  if (n >= 1_000_000) return `${число(n / 1_000_000, 2)} млн`;
  if (n >= 1_000) return `${число(n / 1_000, 1)} тыс.`;
  return String(n);
}

const СТАТУСЫ_ЛИМИТА = { allowed: "в норме", allowed_warning: "близко к пределу", rejected: "исчерпан" };
const ОКНА = { week: "неделя", five_hour: "окно 5 ч" };

/** Строка расхода: токены задачи по агентам и последние сведения о лимитах. */
function показатьРасход(открыта) {
  const строка = $("расход");
  const расход = последнееСостояние?.usage;
  const части = [];
  for (const агент of ["claude", "codex"]) {
    const р = расход?.task?.[агент];
    if (р && р.input + р.output > 0) {
      части.push(`${ИМЕНА[агент]} ${токены(р.input + р.output)}${р.cached ? ` (из кеша ${токены(р.cached)})` : ""}`);
    }
  }
  const лимиты = [];
  for (const агент of ["codex", "claude"]) {
    const л = расход?.limits?.[агент];
    if (!л) continue;
    const окно = ОКНА[л.window] ?? л.window ?? "";
    if (typeof л.percent === "number") лимиты.push(`${ИМЕНА[агент]}: ${окно} ${л.percent}%`);
    else if (л.status) лимиты.push(`${ИМЕНА[агент]}: ${окно} — ${СТАТУСЫ_ЛИМИТА[л.status] ?? л.status}`);
  }
  строка.textContent = [
    части.length ? `Расход задачи: ${части.join(" · ")}` : "",
    лимиты.length ? `Лимиты — ${лимиты.join(", ")}` : "",
  ].filter(Boolean).join(". ");
  строка.hidden = !открыта || !строка.textContent;
}

function показатьДорожку() {
  const дорожка = $("дорожка");
  const открыта = сохранено.дорожка === true;
  дорожка.hidden = !открыта;
  $("эстафета").setAttribute("aria-expanded", String(открыта));
  показатьРасход(открыта);
  if (!открыта) return;
  const с = последнееСостояние ?? { stage: "idle", maxRounds: 0 };
  const шаги = trackSteps(с.trail ?? [], с);
  if (шаги.length === 0) {
    дорожка.replaceChildren(элемент("span", "тихо", "Цикла рецензии ещё не было"));
    return;
  }
  дорожка.replaceChildren(
    ...шаги.map((ш, i) => {
      const обёртка = элемент("span", "шаг");
      if (i > 0) обёртка.append(элемент("span", `шаг-связь ${ш.state === "ghost" ? "пустая" : ""}`.trim()));
      const узел = элемент(
        "span",
        `шаг-узел ${ш.who} ${ш.state === "current" ? "текущий" : ""} ${ш.state === "ghost" ? "пустой" : ""}`.replace(/ +/g, " ").trim(),
      );
      узел.title = ПОДПИСИ_ШАГОВ[ш.who] + (ш.state === "ghost" ? " — ещё впереди, если понадобится" : "");
      if (ш.mark) узел.append(элемент("span", `шаг-отметка ${ш.mark === "✓" ? "принято" : ""}`.trim(), ш.mark));
      обёртка.append(узел);
      return обёртка;
    }),
  );
}

$("эстафета").addEventListener("click", () => {
  запомнить({ дорожка: !(сохранено.дорожка === true) });
  показатьДорожку();
});

// --- Режим отправки: переключатель и меню -----------------------------------------------

let маршрут = МАРШРУТЫ.some((м) => м.id === сохранено.маршрут) ? сохранено.маршрут : "review";

function показатьМаршрут() {
  const текущий = МАРШРУТЫ.find((м) => м.id === маршрут);
  $("маршрут-название").textContent = текущий.name;
  $("маршрут").title = `${текущий.hint}. Нажмите — выбрать режим`;
  $("режимы").replaceChildren(
    ...МАРШРУТЫ.map((м) => {
      const к = элемент("button");
      к.setAttribute("role", "radio");
      к.setAttribute("aria-checked", String(м.id === маршрут));
      к.setAttribute("aria-label", м.name);
      к.dataset.маршрут = м.id;
      к.title = `${м.name}: ${м.hint}`;
      к.append(значокМаршрута(м.id));
      к.addEventListener("click", () => {
        выбратьМаршрут(м.id);
        // Кнопки пересоздаются: фокус переходит на новую отмеченную.
        $("режимы").querySelector('[aria-checked="true"]')?.focus();
      });
      return к;
    }),
  );
  $("маршрут-меню").replaceChildren(
    ...МАРШРУТЫ.map((м) => {
      const к = элемент("button");
      к.setAttribute("role", "menuitemradio");
      к.setAttribute("aria-checked", String(м.id === маршрут));
      к.dataset.маршрут = м.id;
      к.title = м.hint;
      const галка = значок(ЗНАЧКИ.check);
      галка.classList.add("галка");
      к.append(значокМаршрута(м.id), элемент("span", "", м.name), галка);
      к.addEventListener("click", () => {
        выбратьМаршрут(м.id);
        закрытьМеню(true);
      });
      return к;
    }),
  );
}

function выбратьМаршрут(id) {
  маршрут = id;
  запомнить({ маршрут: id });
  показатьМаршрут();
}

/** Закрыть меню режима; с возвратом — фокус на кнопку названия, откуда меню открыли. */
function закрытьМеню(вернутьФокус = false) {
  const былоОткрыто = !$("маршрут-меню").hidden;
  $("маршрут-меню").hidden = true;
  $("маршрут").setAttribute("aria-expanded", "false");
  if (вернутьФокус && былоОткрыто) $("маршрут").focus();
}

$("маршрут").addEventListener("click", (событие) => {
  событие.stopPropagation();
  const меню = $("маршрут-меню");
  меню.hidden = !меню.hidden;
  $("маршрут").setAttribute("aria-expanded", String(!меню.hidden));
});
document.addEventListener("click", (событие) => {
  if (!$("маршрут-меню").hidden && !событие.target.closest?.("#маршрут-меню")) закрытьМеню();
});
document.addEventListener("keydown", (событие) => {
  if (событие.key === "Escape") закрытьМеню(true);
});
показатьМаршрут();

// --- Модель и уровень рассуждения: шкала «Нить» --------------------------------------
// Список запрашивается по кнопке, а не при открытии: каждый поднимает
// короткий процесс агента, а агенты в панели запускаются по делу.

const МОДЕЛИ = {
  claude: { options: undefined, choice: { model: "", effort: "" }, error: "" },
  codex: { options: undefined, choice: { model: "", effort: "" }, error: "" },
};
let спискиЗапрошены = false;
const ПОДПИСИ_РЕЖИМОВ = { bypassPermissions: "Без вопросов", default: "Спрашивать" };
let режимClaude = "bypassPermissions";

function принятьРежим(режим) {
  if (typeof режим !== "string") return;
  режимClaude = режим;
  показатьРежим();
  показатьМодели();
}

function показатьРежим() {
  const кнопка = $("без-вопросов");
  кнопка.setAttribute("aria-pressed", String(режимClaude === "bypassPermissions"));
  // Режим из настройки, которого нет в переключателе (plan, acceptEdits…), показывается как есть.
  кнопка.querySelector(".подпись").textContent = ПОДПИСИ_РЕЖИМОВ[режимClaude] ?? режимClaude;
  кнопка.title =
    режимClaude === "bypassPermissions"
      ? "Claude выполняет команды без запроса разрешения. Нажмите — спрашивать каждое действие, требующее согласия"
      : "Каждое действие Claude, требующее согласия, приходит карточкой. Нажмите — без вопросов. Действует для этой папки";
}

function вариант(значение, подпись, пояснение = "") {
  const о = элемент("option", "", подпись);
  о.value = значение;
  if (пояснение) о.title = пояснение;
  return о;
}

function подписьМодели(агент) {
  const { options, choice } = МОДЕЛИ[агент];
  const выбранная = options?.find((о) => о.id === choice.model);
  const имя = choice.model ? (выбранная?.label ?? choice.model) : "по умолчанию";
  return choice.effort ? `${имя} · ${choice.effort}` : имя;
}

function показатьМодели() {
  $("модели-кнопка").title =
    `Модель и уровень рассуждения каждого агента; меняются со следующего хода. ` +
    `Сейчас — Claude: ${подписьМодели("claude")}; Codex: ${подписьМодели("codex")}; ` +
    `разрешения Claude: ${(ПОДПИСИ_РЕЖИМОВ[режимClaude] ?? режимClaude).toLowerCase()}`;
  const ошибки = ["claude", "codex"].filter((а) => МОДЕЛИ[а].error).map((а) => `${ИМЕНА[а]}: ${МОДЕЛИ[а].error}`);
  const ждём = спискиЗапрошены && ["claude", "codex"].some((а) => !МОДЕЛИ[а].options && !МОДЕЛИ[а].error);
  $("модели-состояние").textContent = ошибки.length
    ? `Список не получен — ${ошибки.join("; ")}. Откройте ещё раз, чтобы повторить.`
    : ждём
      ? "Загружаю список моделей…"
      : "";

  for (const агент of ["claude", "codex"]) {
    const { options, choice } = МОДЕЛИ[агент];
    const модель = $(`модель-${агент}`);
    if (!options) {
      модель.disabled = true;
      нарисоватьНить(агент, undefined);
      continue;
    }
    модель.replaceChildren(...options.map((о) => вариант(о.id, о.label, о.description)));
    модель.value = choice.model;
    модель.disabled = false;
    нарисоватьНить(агент, options.find((о) => о.id === choice.model));
  }
}

/** Узел разметки со стилями из раскладки: вся геометрия — числа из thread.js. */
function кусок(класс, стиль) {
  const э = элемент("span", класс);
  Object.assign(э.style, стиль);
  return э;
}

const пикс = (n) => `${n}px`;

function нарисоватьНить(агент, модель) {
  const полоса = $(`нить-${агент}`);
  const подпись = $(`нить-уровень-${агент}`);
  const уровни = effortLevels(агент, модель?.efforts ?? []);
  const поУмолчанию = defaultEffort(модель);
  const выбор = МОДЕЛИ[агент].choice.effort;
  const р = threadLayout(агент, уровни, выбор, поУмолчанию, полоса.clientWidth || 328);
  // Вернуть «по умолчанию» можно, пока выбран явный уровень: у Claude умолчание
  // неизвестно, и никакой узел его не заменяет (рецензия Codex 28.09).
  $(`нить-сброс-${агент}`).hidden = !р || !выбор;
  if (!р) {
    подпись.textContent = МОДЕЛИ[агент].options ? "Без уровней" : "—";
    подпись.style.color = "var(--тихий)";
    подпись.title = МОДЕЛИ[агент].options ? "У этой модели уровень рассуждения не выбирается" : "";
    полоса.replaceChildren();
    return;
  }
  подпись.textContent = р.label;
  подпись.style.color = р.color ? `color-mix(in srgb, ${р.color} var(--нить-доля-подписи), var(--сильный))` : "var(--тихий)";
  подпись.title = выбор ? "" : поУмолчанию ? "Уровень модели по умолчанию" : "Уровень выбирает агент: своего умолчания CLI не сообщает";

  const части = [кусок("нить-основа", { left: "10px", width: пикс(р.baseWidth) })];
  if (р.modeSegment) {
    const цвет = р.modeSegment.lit ? р.color : "var(--нить-край)";
    части.push(
      кусок("нить-режим", {
        left: пикс(р.modeSegment.left),
        top: "21px",
        height: "2px",
        width: пикс(р.modeSegment.width),
        background: `repeating-linear-gradient(90deg, ${цвет} 0 4px, transparent 4px 8px)`,
      }),
    );
  }
  if (р.litWidth > 0) {
    части.push(
      кусок("нить-свет", { left: "10px", top: пикс(р.litTop), height: пикс(р.litHeight), width: пикс(р.litWidth), background: р.litFill }),
    );
  }
  if (р.particles.length) {
    const поток = кусок("нить-поток", { left: "10px", width: пикс(р.flowWidth) });
    for (const ч of р.particles) {
      поток.append(кусок("нить-частица", { animationDuration: ч.dur, animationDelay: ч.delay, boxShadow: `0 0 6px ${р.color}` }));
    }
    части.push(поток);
  }
  if (р.fork) {
    const ветви = кусок("нить-ветвь-обёртка", { left: пикс(р.forkLeft) });
    for (const в of р.branches) {
      const ветвь = кусок("нить-ветвь", {
        transform: `rotate(${в.angle})`,
        background: `linear-gradient(90deg, ${р.color}, color-mix(in srgb, var(--vscode-foreground) 12%, transparent))`,
      });
      ветвь.append(
        кусок("нить-частица", { animationDelay: в.delay, boxShadow: `0 0 6px ${р.color}` }),
        кусок("нить-субагент", { background: р.tipColor, boxShadow: `0 0 8px ${р.tipColor}`, animationDelay: в.delay }),
      );
      ветви.append(ветвь);
    }
    части.push(ветви);
  }
  if (р.defaultLeft != null) {
    const метка = кусок("нить-по-умолчанию", { left: пикс(р.defaultLeft) });
    метка.title = "Уровень по умолчанию";
    части.push(метка);
  }
  for (const у of р.nodes) {
    const узел = элемент("button", "нить-узел");
    узел.style.left = пикс(у.left);
    узел.setAttribute("role", "radio");
    узел.setAttribute("aria-checked", String(у.current));
    узел.setAttribute("aria-label", у.name);
    узел.dataset.уровень = у.id;
    узел.title = `${у.name}. ${у.tip}`;
    узел.tabIndex = у.current || (!р.nodes.some((н) => н.current) && у === р.nodes[0]) ? 0 : -1;
    узел.append(
      кусок("", {
        width: пикс(у.size),
        height: пикс(у.size),
        boxSizing: "border-box",
        background: у.fill,
        border: у.border,
        boxShadow: у.glow,
      }),
    );
    узел.addEventListener("click", () => выбратьУровень(агент, модель, у.id));
    части.push(узел);
  }
  if (р.ringLeft != null) {
    const кольца = кусок("нить-кольцо-обёртка", { left: пикс(р.ringLeft) });
    кольца.append(кусок("нить-кольцо", { borderColor: р.color, animationDuration: р.ringDur }));
    if (р.deep) кольца.append(кусок("нить-кольцо", { borderColor: р.color, animationDuration: р.ringDur, animationDelay: р.ringDelay }));
    части.push(кольца);
  }
  полоса.replaceChildren(...части);
}

/**
 * Узел, совпадающий с умолчанием из каталога, сохраняется как «по умолчанию»:
 * флаг агенту не передаётся, решает сам агент — как было до выбора.
 */
function выбратьУровень(агент, модель, id) {
  const effort = модель?.defaultEffort && id === модель.defaultEffort ? "" : id;
  выбрать(агент, { model: МОДЕЛИ[агент].choice.model, effort });
  $(`нить-${агент}`).querySelector(`[data-уровень="${id}"]`)?.focus();
}

function выбрать(агент, выбор) {
  МОДЕЛИ[агент].choice = выбор;
  показатьМодели();
  vscode.postMessage({ type: "setModel", agent: агент, model: выбор.model, effort: выбор.effort });
}

function принятьМодели(д) {
  const м = МОДЕЛИ[д.agent];
  if (!м) return;
  if (д.options) м.options = д.options;
  if (д.choice) м.choice = д.choice;
  м.error = д.error ?? "";
  if (д.error) спискиЗапрошены = false;
  показатьМодели();
}

for (const агент of ["claude", "codex"]) {
  $(`модель-${агент}`).addEventListener("change", (событие) => {
    const м = МОДЕЛИ[агент];
    const модель = событие.target.value;
    const уровни = м.options?.find((о) => о.id === модель)?.efforts ?? [];
    // Уровень, которого у новой модели нет, сбрасывается, а не уходит агенту.
    выбрать(агент, { model: модель, effort: уровни.includes(м.choice.effort) ? м.choice.effort : "" });
  });
  // Стрелки двигают выбор по нити, как в любой группе переключателей.
  $(`нить-${агент}`).addEventListener("keydown", (событие) => {
    if (событие.key !== "ArrowLeft" && событие.key !== "ArrowRight") return;
    const узлы = [...$(`нить-${агент}`).querySelectorAll(".нить-узел")];
    const сейчас = узлы.findIndex((у) => у.getAttribute("aria-checked") === "true");
    const шаг = событие.key === "ArrowRight" ? 1 : -1;
    const следующий = узлы[Math.min(узлы.length - 1, Math.max(0, (сейчас < 0 ? 0 : сейчас) + шаг))];
    if (!следующий) return;
    событие.preventDefault();
    следующий.click();
  });
}

for (const агент of ["claude", "codex"]) {
  $(`нить-сброс-${агент}`).addEventListener("click", () => {
    выбрать(агент, { model: МОДЕЛИ[агент].choice.model, effort: "" });
  });
}

$("без-вопросов").addEventListener("click", () => {
  режимClaude = режимClaude === "bypassPermissions" ? "default" : "bypassPermissions";
  показатьРежим();
  показатьМодели();
  vscode.postMessage({ type: "setPermissionMode", mode: режимClaude });
});

$("модели-кнопка").addEventListener("click", () => {
  const панель = $("модели-панель");
  панель.hidden = !панель.hidden;
  $("модели-кнопка").setAttribute("aria-expanded", String(!панель.hidden));
  if (!панель.hidden && !спискиЗапрошены) {
    спискиЗапрошены = true;
    vscode.postMessage({ type: "listModels" });
  }
  показатьМодели();
});
// Ширина нити зависит от ширины панели.
window.addEventListener("resize", () => {
  if (!$("модели-панель").hidden) показатьМодели();
});
показатьРежим();
показатьМодели();

// --- Прочее ------------------------------------------------------------------------

window.addEventListener("message", (событие) => {
  const д = событие.data;
  if (д?.type === "event") показатьСобытие(д.событие, д.история === true);
  else if (д?.type === "state") показатьСостояние(д.состояние);
  else if (д?.type === "models") принятьМодели(д);
  else if (д?.type === "permissions") принятьРежим(д.mode);
});

function отправить() {
  const текст = ввод.value.trim();
  if (!текст) return;
  // Своё сообщение человек хочет видеть: беседа снова следует за концом.
  вниз(true);
  vscode.postMessage({ type: "send", text: текст, route: маршрут });
  ввод.value = "";
  подогнатьВвод();
}

/** Поле растёт с текстом до 40% высоты панели, дальше — прокрутка внутри. */
function подогнатьВвод() {
  ввод.style.height = "auto";
  ввод.style.height = `${Math.min(ввод.scrollHeight, Math.round(window.innerHeight * 0.4))}px`;
}
ввод.addEventListener("input", подогнатьВвод);

// Webview сам по ссылкам не переходит: адрес открывает расширение.
беседа.addEventListener("click", (событие) => {
  const ссылка = событие.target.closest?.(".разметка a[href]");
  if (!ссылка) return;
  событие.preventDefault();
  vscode.postMessage({ type: "openLink", href: ссылка.getAttribute("href") });
});
$("отправить").addEventListener("click", отправить);
ввод.addEventListener("keydown", (е) => {
  if (е.key === "Enter" && (е.ctrlKey || е.metaKey)) {
    е.preventDefault();
    отправить();
  }
});
$("отпустить").addEventListener("click", () => vscode.postMessage({ type: "release" }));
$("стоп").addEventListener("click", () => vscode.postMessage({ type: "stopAll" }));
$("прервать").addEventListener("click", () => vscode.postMessage({ type: "interrupt" }));
$("авто").addEventListener("change", (е) => vscode.postMessage({ type: "setAuto", on: е.target.checked }));
$("диагностика-кнопка").addEventListener("click", () => {
  const панель = $("диагностика");
  панель.hidden = !панель.hidden;
  $("диагностика-кнопка").setAttribute("aria-expanded", String(!панель.hidden));
});

// История и состояние приходят только после этого сигнала.
vscode.postMessage({ type: "ready" });
