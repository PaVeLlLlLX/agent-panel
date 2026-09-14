/**
 * Интерфейс комнаты.
 *
 * Два правила разметки, оба следуют из постановки.
 *
 * Состояния различимы. «Агент формирует вызов инструмента», «инструмент
 * выполняется», «результат получен» и «результат передан второму агенту» —
 * это четыре разных состояния, и показывать их одинаково значит врать о том,
 * что происходит.
 *
 * Поток отделён от законченного. Дельты дописываются в текущий пузырь и
 * никуда не передаются; законченная реплика становится отдельной записью.
 * Человек видит генерацию, агент получает только результат.
 */
const vscode = acquireVsCodeApi();

const беседа = document.getElementById("беседа");
const действия = document.getElementById("действия");
const ввод = document.getElementById("ввод");
const адресат = document.getElementById("адресат");

const ИМЕНА = { claude: "Claude", codex: "Codex", human: "Вы" };

/** Открытые пузыри потока по агенту: куда дописывать дельты. */
const потоки = new Map();
/** Вызовы инструментов: callId -> элемент строки в списке действий. */
const вызовы = new Map();

function элемент(тег, класс, текст) {
  const э = document.createElement(тег);
  if (класс) э.className = класс;
  if (текст != null) э.textContent = текст;
  return э;
}

function вниз(контейнер) {
  контейнер.scrollTop = контейнер.scrollHeight;
}

function времяТекст(мс) {
  const d = new Date(мс);
  return d.toLocaleTimeString("ru-RU", { hour12: false });
}

function пузырь(агент) {
  const п = элемент("article", `пузырь ${агент}`);
  const шапка = элемент("div", "автор", ИМЕНА[агент] ?? агент);
  п.append(шапка, элемент("div", "текст"));
  беседа.append(п);
  return п;
}

function показатьСобытие(е) {
  switch (е.kind) {
    case "text_delta": {
      let п = потоки.get(е.agent);
      if (!п) {
        п = пузырь(е.agent);
        п.classList.add("идёт");
        потоки.set(е.agent, п);
      }
      п.querySelector(".текст").textContent += е.text ?? "";
      вниз(беседа);
      return;
    }
    case "message": {
      // Законченная реплика закрывает поток: иначе одна и та же мысль
      // осталась бы на экране дважды — как поток и как результат.
      const открытый = потоки.get(е.agent);
      if (открытый) {
        открытый.classList.remove("идёт");
        открытый.querySelector(".текст").textContent = е.text ?? "";
        потоки.delete(е.agent);
      } else {
        const п = пузырь(е.agent);
        п.querySelector(".текст").textContent = е.text ?? "";
      }
      if (е.snapshot) {
        const метка = элемент("div", "версия-метка", `версия ${е.snapshot}`);
        (потоки.get(е.agent) ?? беседа.lastElementChild).append(метка);
      }
      вниз(беседа);
      return;
    }
    case "tool_call": {
      const строка = элемент("div", "действие сформирован");
      строка.append(
        элемент("span", "агент", ИМЕНА[е.agent] ?? е.agent),
        элемент("span", "стрелка", "→"),
        элемент("span", "имя", е.tool ?? "?"),
        элемент("span", "состояние", "вызов сформирован"),
        элемент("time", null, времяТекст(е.at)),
      );
      const подробности = элемент("pre", "аргументы", е.text ?? "");
      строка.append(подробности);
      действия.append(строка);
      if (е.callId) вызовы.set(е.callId, строка);
      вниз(действия);
      return;
    }
    case "tool_running": {
      const строка = е.callId ? вызовы.get(е.callId) : undefined;
      if (строка) {
        строка.className = "действие выполняется";
        строка.querySelector(".состояние").textContent = "выполняется";
      }
      return;
    }
    case "tool_result": {
      const строка = е.callId ? вызовы.get(е.callId) : undefined;
      const цель = строка ?? элемент("div", "действие готов");
      цель.className = "действие готов";
      if (!строка) {
        цель.append(
          элемент("span", "агент", ИМЕНА[е.agent] ?? е.agent),
          элемент("span", "стрелка", "→"),
          элемент("span", "имя", е.tool ?? "?"),
          элемент("span", "состояние", "результат"),
          элемент("time", null, времяТекст(е.at)),
        );
        действия.append(цель);
      } else {
        цель.querySelector(".состояние").textContent = "результат получен";
      }
      const вывод = элемент("pre", "вывод", е.text ?? "");
      вывод.title = "сырой вывод инструмента, передаётся второму агенту как есть";
      цель.append(вывод);
      if (е.callId) вызовы.delete(е.callId);
      вниз(действия);
      return;
    }
    case "approval_requested":
    case "approval_decided": {
      const строка = элемент(
        "div",
        `действие ${е.kind === "approval_decided" ? "отказ" : "запрос"}`,
      );
      строка.append(
        элемент("span", "агент", ИМЕНА[е.agent] ?? е.agent),
        элемент("span", "имя", е.kind === "approval_decided" ? "отказано" : "просит одобрения"),
        элемент("span", "состояние", е.text ?? ""),
      );
      действия.append(строка);
      вниз(действия);
      return;
    }
    case "turn_started":
    case "turn_completed": {
      const строка = элемент(
        "div",
        "действие служебное",
        `${ИМЕНА[е.agent] ?? е.agent}: ${е.kind === "turn_started" ? "ход начат" : "ход завершён"}` +
          (е.text ? ` — ${е.text}` : ""),
      );
      действия.append(строка);
      вниз(действия);
      return;
    }
    case "error": {
      const п = пузырь(е.agent);
      п.classList.add("ошибка");
      п.querySelector(".текст").textContent = е.text ?? "ошибка";
      потоки.delete(е.agent);
      вниз(беседа);
      return;
    }
  }
}

function показатьСостояние(с) {
  if (!с) return;
  document.getElementById("состояние-claude").textContent =
    `Claude: ${с.claudeBusy ? "работает" : "ждёт"}`;
  document.getElementById("состояние-codex").textContent =
    `Codex: ${с.codexBusy ? "проверяет" : "ждёт"}`;
  document.getElementById("раунд").textContent = `раунд ${с.round ?? 0}`;
  document.getElementById("версия").textContent = `версия ${с.snapshot ?? "—"}`;
}

window.addEventListener("message", (событие) => {
  const данные = событие.data;
  if (данные?.type !== "event") return;
  показатьСобытие(данные.событие);
  показатьСостояние(данные.состояние);
});

function отправить() {
  const текст = ввод.value.trim();
  if (!текст) return;
  vscode.postMessage({ type: "send", text: текст, to: адресат.value });
  ввод.value = "";
}

document.getElementById("отправить").addEventListener("click", отправить);
ввод.addEventListener("keydown", (е) => {
  if (е.key === "Enter" && (е.ctrlKey || е.metaKey)) {
    е.preventDefault();
    отправить();
  }
});
document.getElementById("стоп").addEventListener("click", () =>
  vscode.postMessage({ type: "stopAll" }),
);
document.getElementById("прервать").addEventListener("click", () =>
  vscode.postMessage({ type: "interrupt" }),
);
document.getElementById("авто").addEventListener("change", (е) =>
  vscode.postMessage({ type: "setAuto", on: е.target.checked }),
);
