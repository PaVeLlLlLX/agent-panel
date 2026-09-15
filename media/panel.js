/**
 * Интерфейс комнаты.
 *
 * Живой прогон показал, что прежний интерфейс мешал понять суть: колонка
 * действий занимала пол-панели, служебные сообщения подписывались «Вы», логи
 * агентов шли красными репликами. Отсюда устройство:
 *
 *   * беседа на всю ширину; действия агента за ход — одна свёрнутая строка
 *     «Claude · 9 команд, 2 чтения» внутри беседы, подробности по клику;
 *   * служебные сообщения — от «Панели», отдельным стилем;
 *   * логи процессов — в свёрнутой «Диагностике» внизу;
 *   * сверху — чей ход, сколько проверок, вердикт, и что удержано.
 */
const vscode = acquireVsCodeApi();
const { summarizeTools } = globalThis.PanelFormat;

const $ = (id) => document.getElementById(id);
const беседа = $("беседа");
const ввод = $("ввод");
const маршрут = $("маршрут");

const ИМЕНА = { claude: "Claude", codex: "Codex", human: "Вы", system: "Панель" };
const ЭТАПЫ = {
  idle: "ожидание",
  working: "Claude работает",
  reviewing: "Codex проверяет",
  held: "ждёт вашего решения",
  approval: "ждёт разрешения",
  accepted: "работа принята",
  stopped: "остановлено",
};
const ВЕРДИКТЫ = { accepted: "вердикт: принято", remarks: "вердикт: есть замечания", missing: "вердикт не вынесен" };
const ПОДСКАЗКИ = {
  review: "Claude сделает, Codex проверит — по очереди, до вердикта",
  both: "оба ответят независимо, друг другу ничего не передаётся",
  claude: "только Claude, без проверки",
  codex: "только Codex, без пересылки",
};
const ПРЕДЕЛ_ДИАГНОСТИКИ = 500;

/** Идущий поток текста по агенту. */
const потоки = new Map();
/** Открытая группа действий по агенту: { узел, имена, вызовы }. */
const группы = new Map();

function элемент(тег, класс, текст) {
  const э = document.createElement(тег);
  if (класс) э.className = класс;
  if (текст != null) э.textContent = текст;
  return э;
}

function вниз() {
  беседа.scrollTop = беседа.scrollHeight;
}

function пузырь(агент, текст) {
  const п = элемент("article", `пузырь ${агент}`);
  п.append(элемент("div", "автор", ИМЕНА[агент] ?? агент), элемент("div", "текст", текст ?? ""));
  беседа.append(п);
  return п;
}

function уведомление(текст, класс = "") {
  беседа.append(элемент("div", `уведомление ${класс}`.trim(), текст));
}

function группаДействий(агент) {
  let г = группы.get(агент);
  if (г) return г;
  const узел = элемент("details", `действия ${агент}`);
  const сводка = элемент("summary");
  const список = элемент("div", "список");
  узел.append(сводка, список);
  беседа.append(узел);
  г = { узел, сводка, список, имена: [], вызовы: new Map() };
  группы.set(агент, г);
  обновитьСводку(агент, г);
  return г;
}

function обновитьСводку(агент, г) {
  const итог = summarizeTools(г.имена) || "действия";
  г.сводка.textContent = `${ИМЕНА[агент]} · ${итог}`;
}

/** Открытые карточки разрешений по id запроса. */
const запросы = new Map();

function карточкаРазрешения(е, история) {
  const карточка = элемент("article", "разрешение");
  карточка.append(
    элемент("div", "автор", `${ИМЕНА[е.agent] ?? е.agent} просит разрешение · ${е.tool ?? "?"}`),
    элемент("pre", "аргументы", е.text ?? ""),
  );
  const итог = элемент("div", "итог");
  if (история) {
    // Из журнала: процесс, задавший вопрос, уже другой — ответить нельзя.
    итог.textContent = "запрос из прошлого запуска панели";
  } else {
    const кнопки = элемент("div", "кнопки");
    const ответить = (выбор) => {
      for (const к of кнопки.querySelectorAll("button")) к.disabled = true;
      vscode.postMessage({ type: "approval", id: е.callId, choice: выбор });
    };
    const разрешить = элемент("button", "главная", "Разрешить");
    разрешить.title = "Выполнить этот вызов один раз";
    разрешить.addEventListener("click", () => ответить("allow"));
    кнопки.append(разрешить);
    if (е.sessionRules?.length) {
      const сессия = элемент("button", "", "Разрешить в этой сессии");
      сессия.title = `Больше не спрашивать до остановки Claude: ${е.sessionRules.join(", ")}. В файлы настроек ничего не пишется`;
      сессия.addEventListener("click", () => ответить("allowSession"));
      кнопки.append(сессия);
    }
    const отклонить = элемент("button", "опасно", "Отклонить");
    отклонить.title = "Не выполнять; Claude узнает, что отказал человек";
    отклонить.addEventListener("click", () => ответить("deny"));
    кнопки.append(отклонить);
    карточка.append(кнопки);
  }
  карточка.append(итог);
  беседа.append(карточка);
  // И карточку из журнала закроет решение, записанное следом за ней.
  запросы.set(е.callId, карточка);
}

function показатьСобытие(е, история = false) {
  switch (е.kind) {
    case "text_delta": {
      let п = потоки.get(е.agent);
      if (!п) {
        п = пузырь(е.agent);
        п.classList.add("идёт");
        потоки.set(е.agent, п);
      }
      п.querySelector(".текст").textContent += е.text ?? "";
      вниз();
      return;
    }
    case "message": {
      if (е.agent === "system") {
        уведомление(е.text ?? "");
        вниз();
        return;
      }
      const открытый = потоки.get(е.agent);
      if (открытый) {
        открытый.classList.remove("идёт");
        открытый.querySelector(".текст").textContent = е.text ?? "";
        потоки.delete(е.agent);
      } else {
        пузырь(е.agent, е.text);
      }
      вниз();
      return;
    }
    case "tool_call": {
      const г = группаДействий(е.agent);
      г.имена.push(е.tool ?? "?");
      const вызов = элемент("details", "вызов сформирован");
      const заголовок = элемент("summary");
      заголовок.append(элемент("span", "имя", е.tool ?? "?"), элемент("span", "метка", "вызов сформирован"));
      вызов.append(заголовок, элемент("pre", "аргументы", е.text ?? ""));
      г.список.append(вызов);
      if (е.callId) г.вызовы.set(е.callId, вызов);
      обновитьСводку(е.agent, г);
      вниз();
      return;
    }
    case "tool_running": {
      const вызов = группы.get(е.agent)?.вызовы.get(е.callId);
      if (вызов) {
        вызов.className = "вызов выполняется";
        вызов.querySelector(".метка").textContent = "выполняется";
      }
      return;
    }
    case "tool_result": {
      const г = группаДействий(е.agent);
      let вызов = г.вызовы.get(е.callId);
      if (!вызов) {
        г.имена.push(е.tool ?? "?");
        вызов = элемент("details", "вызов");
        const заголовок = элемент("summary");
        заголовок.append(элемент("span", "имя", е.tool ?? "?"), элемент("span", "метка", ""));
        вызов.append(заголовок);
        г.список.append(вызов);
        обновитьСводку(е.agent, г);
      }
      вызов.className = "вызов готов";
      вызов.querySelector(".метка").textContent = "результат получен";
      const вывод = элемент("pre", "вывод", е.text ?? "");
      вывод.title = "сырой вывод инструмента — передаётся рецензенту как есть";
      вызов.append(вывод);
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
        return;
      }
      const г = группаДействий(е.agent);
      г.список.append(элемент("div", "вызов отказ", е.text ?? "отказано"));
      return;
    }
    case "turn_completed":
      группы.delete(е.agent);
      if (е.failed) уведомление(`${ИМЕНА[е.agent]}: ${е.text ?? "ход не удался"}`, "ошибка");
      return;
    case "error": {
      потоки.delete(е.agent);
      группы.delete(е.agent);
      const п = пузырь(е.agent, е.text ?? "ошибка");
      п.classList.add("ошибка");
      вниз();
      return;
    }
    case "diagnostic": {
      const строки = $("диагностика-строки");
      const время = new Date(е.at).toLocaleTimeString("ru-RU", { hour12: false });
      строки.textContent += `${время} ${ИМЕНА[е.agent] ?? е.agent}: ${е.text ?? ""}\n`;
      const все = строки.textContent.split("\n");
      if (все.length > ПРЕДЕЛ_ДИАГНОСТИКИ) строки.textContent = все.slice(-ПРЕДЕЛ_ДИАГНОСТИКИ).join("\n");
      const счёт = $("диагностика-счёт");
      счёт.textContent = String(Number(счёт.textContent) + 1);
      return;
    }
    default:
      return;
  }
}

function показатьСостояние(с) {
  // Открытый запрос разрешения важнее этапа цикла: без ответа никто не двинется.
  const этап = с.approvals > 0 ? "approval" : с.stage;
  $("этап").textContent = ЭТАПЫ[этап] ?? этап;
  $("этап").dataset.этап = этап;
  $("раунд").textContent = `проверок ${с.round} из ${с.maxRounds}`;

  const вердикт = $("вердикт");
  вердикт.hidden = !с.verdict;
  вердикт.textContent = ВЕРДИКТЫ[с.verdict] ?? "";
  вердикт.dataset.вердикт = с.verdict ?? "";

  const очередь = $("очередь");
  очередь.hidden = !с.queued;
  очередь.textContent = `в очереди ${с.queued}`;

  const задача = $("задача");
  задача.hidden = !с.task;
  задача.textContent = с.task ? `Задача: ${с.task}` : "";
  // Строка обрезается многоточием, полный текст — при наведении.
  задача.title = с.task ?? "";

  const удержано = $("удержано");
  удержано.hidden = !с.held;
  $("удержано-причина").textContent = с.held?.reason ?? "";
  $("отпустить").textContent = !с.held
    ? "Отправить"
    : с.held.action === "retry"
      ? `Повторить ${ИМЕНА[с.held.to]}`
      : `Отправить ${ИМЕНА[с.held.to]}`;

  $("авто").checked = с.auto;
}

window.addEventListener("message", (событие) => {
  const д = событие.data;
  if (д?.type === "event") показатьСобытие(д.событие, д.история === true);
  else if (д?.type === "state") показатьСостояние(д.состояние);
});

function отправить() {
  const текст = ввод.value.trim();
  if (!текст) return;
  vscode.postMessage({ type: "send", text: текст, route: маршрут.value });
  ввод.value = "";
}

function показатьПодсказку() {
  $("подсказка").textContent = ПОДСКАЗКИ[маршрут.value] ?? "";
  vscode.setState({ ...(vscode.getState() ?? {}), маршрут: маршрут.value });
}

const сохранённый = vscode.getState()?.маршрут;
if (сохранённый && ПОДСКАЗКИ[сохранённый]) маршрут.value = сохранённый;
показатьПодсказку();

маршрут.addEventListener("change", показатьПодсказку);
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

// История и состояние приходят только после этого сигнала.
vscode.postMessage({ type: "ready" });
