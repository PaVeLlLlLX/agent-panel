/**
 * Точка входа расширения: комната в webview.
 *
 * Панель владеет обеими сессиями: подписка на поток уже открытой вкладки по
 * идентификатору не гарантирована, а у истории должен быть один управляющий
 * процесс. Ветку чата Codex владельца панель может продолжить: для этого её
 * идентификатор ставится в привязку комнаты, а чат закрывается в приложении.
 *
 * Агенты запускаются при первом сообщении, а не при открытии: в живом прогоне
 * сессия Claude создавалась просто оттого, что панель открыли в другой папке.
 *
 * История и состояние отдаются в webview после сигнала «ready» от него:
 * сообщения, отправленные до загрузки скрипта, могут потеряться.
 */
import * as vscode from "vscode";
import { join } from "node:path";
import { ClaudeAdapter } from "./adapters/claude.js";
import { CodexAdapter } from "./adapters/codex.js";
import { Adapter, ApprovalChoice, ModelChoice, ModelOption, PanelEvent, stripAnsi } from "./adapters/types.js";
import { Coordinator, RoomState, Route } from "./coordinator.js";
import { Journal } from "./journal.js";
import { describeChoice, normalizeChoice, sameChoice } from "./models.js";
import { resolveCodexCommand } from "./codexBinary.js";

let комната: Комната | undefined;

const МАРШРУТЫ = new Set<Route>(["review", "both", "claude", "codex"]);
const ВЫБОРЫ = new Set<ApprovalChoice>(["allow", "allowSession", "deny"]);

type ВыбираемыйАгент = "claude" | "codex";
const АГЕНТЫ: readonly ВыбираемыйАгент[] = ["claude", "codex"];
const ИМЕНА_АГЕНТОВ: Record<ВыбираемыйАгент, string> = { claude: "Claude", codex: "Codex" };

/** Режимы разрешений, которые принимает Claude Code 2.1.220, плюс default — не передавать флаг. */
const РЕЖИМЫ = new Set(["default", "acceptEdits", "auto", "manual", "dontAsk", "plan", "bypassPermissions"]);
const ПОДПИСИ_РЕЖИМОВ: Record<string, string> = { bypassPermissions: "без вопросов", default: "спрашивать" };

type СообщениеМоделей = {
  type: "models";
  agent: ВыбираемыйАгент;
  choice: ModelChoice;
  options?: readonly ModelOption[];
  error?: string;
};

class Комната {
  readonly #панель: vscode.WebviewPanel;
  readonly #журнал: Journal;
  readonly #координатор: Coordinator;
  readonly #имя: string;
  #закрыта = false;
  /** Выбор моделей хранится для папки: другая папка — другая задача. */
  readonly #память: vscode.Memento;
  readonly #ключМоделей: string;
  readonly #выборы: Record<ВыбираемыйАгент, ModelChoice>;
  readonly #каталоги: Partial<Record<ВыбираемыйАгент, readonly ModelOption[]>> = {};
  readonly #адаптеры: Record<ВыбираемыйАгент, Adapter>;
  #загрузкаМоделей: Promise<void> | undefined;
  /** Режим разрешений Claude для папки; по умолчанию — из настройки. */
  #режим: string;
  readonly #ключРежима: string;

  constructor(контекст: vscode.ExtensionContext, cwd: string) {
    const настройки = vscode.workspace.getConfiguration("agentPanel");
    this.#имя = `room:${cwd}`;
    this.#память = контекст.workspaceState;
    this.#ключМоделей = `agentPanel.models:${cwd}`;
    const сохранённые = this.#память.get<Record<string, unknown>>(this.#ключМоделей) ?? {};
    this.#выборы = {
      claude: normalizeChoice(undefined, сохранённые["claude"]),
      codex: normalizeChoice(undefined, сохранённые["codex"]),
    };
    this.#ключРежима = `agentPanel.claudePermissions:${cwd}`;
    const сохранённыйРежим = this.#память.get<string>(this.#ключРежима);
    this.#режим =
      сохранённыйРежим && РЕЖИМЫ.has(сохранённыйРежим)
        ? сохранённыйРежим
        : настройки.get<string>("claudePermissionMode", "bypassPermissions");
    this.#журнал = new Journal(join(контекст.globalStorageUri.fsPath, "agent-panel.sqlite"));
    this.#журнал.ensureRoom(this.#имя, cwd);
    const привязка = this.#журнал.binding(this.#имя);

    this.#панель = vscode.window.createWebviewPanel(
      "agentPanel",
      "Общая комната",
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this.#панель.webview.html = разметка(this.#панель.webview, контекст);
    this.#панель.onDidDispose(() => void this.dispose());

    const принять = (событие: PanelEvent) => this.#координатор.handle(событие);

    const claude = new ClaudeAdapter(
      {
        command: настройки.get<string>("claudeCommand", "claude"),
        cwd,
        model: this.#выборы.claude.model,
        effort: this.#выборы.claude.effort,
        settingSources: настройки.get<string>("claudeSettingSources", "project,local"),
        ...(привязка?.claudeSessionId ? { resumeSessionId: привязка.claudeSessionId } : {}),
        permissionMode: this.#режим,
        onSessionId: (id) => {
          if (!this.#закрыта) this.#журнал.bindSessions(this.#имя, id, undefined);
        },
      },
      принять,
    );
    // Тот же codex, что в чате владельца: у CLI из npm может не быть модели его ветки.
    const запускCodex = resolveCodexCommand(
      настройки.get<string>("codexCommand", "codex"),
      vscode.extensions.getExtension("openai.chatgpt")?.extensionPath,
    );
    const codex = new CodexAdapter(
      {
        command: запускCodex.command,
        ...(запускCodex.shell !== undefined ? { shell: запускCodex.shell } : {}),
        cwd,
        model: this.#выборы.codex.model,
        effort: this.#выборы.codex.effort,
        ...(привязка?.codexThreadId ? { resumeThreadId: привязка.codexThreadId } : {}),
        onSessionId: (id) => {
          if (!this.#закрыта) this.#журнал.bindSessions(this.#имя, undefined, id);
        },
      },
      принять,
    );

    this.#адаптеры = { claude, codex };
    this.#координатор = new Coordinator(claude, codex, this.#журнал, {
      room: this.#имя,
      cwd,
      maxAutoRounds: настройки.get<number>("maxAutoRounds", 3),
      onEvent: (событие) => this.#отправитьВПанель({ type: "event", событие }),
      onState: (состояние) => this.#отправитьВПанель({ type: "state", состояние }),
    });

    this.#панель.webview.onDidReceiveMessage((сообщение: ВходящееUI) => void this.#изПанели(сообщение));
  }

  async #изПанели(сообщение: ВходящееUI): Promise<void> {
    switch (сообщение.type) {
      case "ready":
        for (const событие of this.#журнал.history(this.#имя)) {
          const чистое = событие.text ? { ...событие, text: stripAnsi(событие.text) } : событие;
          this.#отправитьВПанель({ type: "event", событие: чистое, история: true });
        }
        this.#отправитьВПанель({ type: "state", состояние: this.#координатор.state });
        for (const агент of АГЕНТЫ) this.#отправитьМодели(агент);
        this.#отправитьВПанель({ type: "permissions", mode: this.#режим });
        return;
      case "send":
        if (!сообщение.text.trim() || !МАРШРУТЫ.has(сообщение.route as Route)) return;
        await this.#координатор.fromHuman(сообщение.text, сообщение.route as Route);
        return;
      case "release":
        await this.#координатор.releaseHeld();
        return;
      case "stopAll":
        await this.#координатор.stopAll();
        return;
      case "interrupt":
        await this.#координатор.interruptAll();
        return;
      case "setAuto":
        this.#координатор.setAuto(сообщение.on);
        return;
      case "setPermissionMode": {
        if (!РЕЖИМЫ.has(сообщение.mode)) return;
        // Адаптеру — всегда: «Больше не спрашивать» на карточке должна
        // разрешить открытый запрос, даже если режим уже был выбран.
        this.#адаптеры.claude.setPermissionMode?.(сообщение.mode);
        if (сообщение.mode !== this.#режим) {
          this.#режим = сообщение.mode;
          await this.#память.update(this.#ключРежима, сообщение.mode);
          this.#координатор.notice(
            сообщение.mode === "bypassPermissions"
              ? "Разрешения Claude: без вопросов. Открытые запросы разрешены сразу, со следующего хода Claude не спрашивает."
              : `Разрешения Claude: ${ПОДПИСИ_РЕЖИМОВ[сообщение.mode] ?? сообщение.mode} — со следующего хода.`,
          );
        }
        this.#отправитьВПанель({ type: "permissions", mode: this.#режим });
        return;
      }
      case "listModels":
        await this.#загрузитьМодели();
        return;
      case "setModel": {
        const агент = сообщение.agent as ВыбираемыйАгент;
        if (!АГЕНТЫ.includes(агент)) return;
        const выбор = normalizeChoice(this.#каталоги[агент], сообщение);
        if (!sameChoice(выбор, this.#выборы[агент])) {
          await this.#применитьВыбор(агент, выбор);
          this.#координатор.notice(
            `${ИМЕНА_АГЕНТОВ[агент]}: ${describeChoice(this.#каталоги[агент], выбор)} — со следующего хода.`,
          );
        }
        this.#отправитьМодели(агент);
        return;
      }
      case "openLink": {
        // Webview сам по ссылкам не переходит; открываются только веб-адреса и почта.
        let адрес: vscode.Uri;
        try {
          адрес = vscode.Uri.parse(сообщение.href, true);
        } catch {
          return;
        }
        if (["http", "https", "mailto"].includes(адрес.scheme)) await vscode.env.openExternal(адрес);
        return;
      }
      case "approval":
        if (!ВЫБОРЫ.has(сообщение.choice as ApprovalChoice)) return;
        await this.#координатор.answerApproval(сообщение.id, сообщение.choice as ApprovalChoice);
        return;
    }
  }

  /**
   * Списки моделей — по запросу человека, один раз за открытие комнаты: каждый
   * поднимает короткий процесс агента. Неудача не запоминается — можно повторить.
   */
  #загрузитьМодели(): Promise<void> {
    this.#загрузкаМоделей ??= Promise.all(
      АГЕНТЫ.map(async (агент) => {
        try {
          const каталог = (await this.#адаптеры[агент].listModels?.()) ?? [];
          this.#каталоги[агент] = каталог;
          const допустимый = normalizeChoice(каталог, this.#выборы[агент]);
          if (!sameChoice(допустимый, this.#выборы[агент])) {
            await this.#применитьВыбор(агент, допустимый);
            this.#координатор.notice(
              `${ИМЕНА_АГЕНТОВ[агент]}: сохранённая модель больше недоступна — со следующего хода по умолчанию.`,
            );
          }
          this.#отправитьМодели(агент);
        } catch (беда) {
          this.#загрузкаМоделей = undefined;
          this.#отправитьМодели(агент, (беда as Error).message);
        }
      }),
    ).then(() => undefined);
    return this.#загрузкаМоделей;
  }

  async #применитьВыбор(агент: ВыбираемыйАгент, выбор: ModelChoice): Promise<void> {
    this.#выборы[агент] = выбор;
    this.#адаптеры[агент].setModel?.(выбор);
    await this.#память.update(this.#ключМоделей, this.#выборы);
  }

  #отправитьМодели(агент: ВыбираемыйАгент, ошибка?: string): void {
    const каталог = this.#каталоги[агент];
    this.#отправитьВПанель({
      type: "models",
      agent: агент,
      choice: this.#выборы[агент],
      ...(каталог ? { options: каталог } : {}),
      ...(ошибка ? { error: ошибка } : {}),
    });
  }

  #отправитьВПанель(
    сообщение:
      | { type: "event"; событие: PanelEvent; история?: boolean }
      | { type: "state"; состояние: RoomState }
      | СообщениеМоделей
      | { type: "permissions"; mode: string },
  ): void {
    if (this.#закрыта) return;
    void this.#панель.webview.postMessage(сообщение);
  }

  async dispose(): Promise<void> {
    if (this.#закрыта) return;
    this.#закрыта = true;
    await this.#координатор.stopAll();
    this.#журнал.close();
    комната = undefined;
  }
}

type ВходящееUI =
  | { type: "ready" }
  | { type: "send"; text: string; route: string }
  | { type: "release" }
  | { type: "stopAll" }
  | { type: "interrupt" }
  | { type: "setAuto"; on: boolean }
  | { type: "approval"; id: string; choice: string }
  | { type: "openLink"; href: string }
  | { type: "listModels" }
  | { type: "setModel"; agent: string; model: unknown; effort: unknown }
  | { type: "setPermissionMode"; mode: string };

/**
 * Разметка webview.
 *
 * style-src допускает 'unsafe-inline' ради KaTeX: высоту дробей и индексов
 * он задаёт атрибутами style, без них формулы разваливаются. Сырой HTML из
 * реплик агентов в страницу не попадает (markdown-it с html: false), а
 * скрипты по-прежнему только с nonce.
 */
function разметка(webview: vscode.Webview, контекст: vscode.ExtensionContext): string {
  const ресурс = (имя: string) =>
    webview.asWebviewUri(vscode.Uri.joinPath(контекст.extensionUri, "media", имя));
  const nonce = Math.random().toString(36).slice(2);
  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${ресурс("vendor/katex/katex.min.css")}">
<link rel="stylesheet" href="${ресурс("panel.css")}">
<title>Общая комната</title>
</head>
<body>
<header id="состояние">
  <div class="строка-состояния">
    <span id="этап" class="значок" title="Что сейчас происходит: кто работает, или панель ждёт вашего решения">ожидание</span>
    <span id="раунд" class="значок" title="Проверка — один раз, когда Codex посмотрел работу Claude. Предел — сколько проверок разрешено на одну задачу, чтобы агенты не спорили бесконечно за ваши деньги">проверок 0 из 0</span>
    <span id="вердикт" class="значок" hidden title="Итог последней проверки. «Принято» — задача закрыта. «Есть замечания» — работа вернулась Claude. «Нужно ваше решение» — рецензент остановил обмен. «Не вынесен» — решаете вы"></span>
    <span id="очередь" class="значок" hidden title="Сообщения, которые ждут, пока агент закончит текущий ход"></span>
    <span class="распорка"></span>
    <label class="переключатель" title="Включено — Claude и Codex передают работу друг другу сами. Выключено — каждую передачу вы подтверждаете кнопкой">
      <input type="checkbox" id="авто" checked> автопересылка
    </label>
    <button id="прервать" title="Прервать текущий ход агентов. Следующее сообщение продолжит те же сессии">Прервать</button>
    <button id="стоп" class="опасно" title="Завершить процессы обоих агентов вместе с их командами">Остановить</button>
  </div>
  <div id="задача" class="задача" hidden title="Задача, над которой идёт текущий цикл рецензии"></div>
  <div id="удержано" class="удержано" hidden title="Панель остановила передачу и ждёт вашего решения">
    <span id="удержано-причина"></span>
    <button id="отпустить">Отправить</button>
  </div>
</header>
<main id="беседа" aria-label="Беседа"></main>
<details id="диагностика">
  <summary title="Служебные логи процессов агентов — не часть разговора">Диагностика <span id="диагностика-счёт">0</span></summary>
  <pre id="диагностика-строки"></pre>
</details>
<footer>
  <div class="строка">
    <button id="модели-кнопка" aria-expanded="false" aria-controls="модели-панель" title="Модель и уровень рассуждения каждого агента. Меняются со следующего хода">Модели</button>
    <span id="модели-сводка" class="подсказка"></span>
  </div>
  <div id="модели-панель" class="модели" hidden>
    <span id="модели-состояние" class="подсказка"></span>
    <div class="модель">
      <span>Claude</span>
      <select id="модель-claude" disabled aria-label="Модель Claude"></select>
      <select id="уровень-claude" disabled aria-label="Уровень рассуждения Claude" title="Уровень рассуждения: чем выше, тем дольше и дороже ход"></select>
    </div>
    <div class="модель">
      <span>Codex</span>
      <select id="модель-codex" disabled aria-label="Модель Codex"></select>
      <select id="уровень-codex" disabled aria-label="Уровень рассуждения Codex" title="Уровень рассуждения: чем выше, тем дольше и дороже ход"></select>
    </div>
    <div class="модель">
      <span>Разрешения Claude</span>
      <select id="режим-claude" aria-label="Режим разрешений Claude" title="Без вопросов — Claude выполняет команды сам (bypassPermissions). Спрашивать — каждое действие, требующее согласия, приходит карточкой. Действует для этой папки">
        <option value="bypassPermissions">без вопросов</option>
        <option value="default">спрашивать</option>
      </select>
    </div>
  </div>
  <textarea id="ввод" rows="3" placeholder="Сообщение… Ctrl+Enter отправляет"></textarea>
  <div class="строка">
    <select id="маршрут" title="Как отправить">
      <option value="review">Задача с рецензией</option>
      <option value="both">Спросить обоих</option>
      <option value="claude">Только Claude</option>
      <option value="codex">Только Codex</option>
    </select>
    <span id="подсказка" class="подсказка"></span>
    <button id="отправить" class="главная">Отправить</button>
  </div>
</footer>
<script nonce="${nonce}" src="${ресурс("format.js")}"></script>
<script nonce="${nonce}" src="${ресурс("vendor/markdown.js")}"></script>
<script nonce="${nonce}" src="${ресурс("panel.js")}"></script>
</body>
</html>`;
}

export function activate(контекст: vscode.ExtensionContext): void {
  контекст.subscriptions.push(
    vscode.commands.registerCommand("agentPanel.open", async () => {
      if (комната) {
        vscode.window.showInformationMessage("Комната уже открыта.");
        return;
      }
      const папка = vscode.workspace.workspaceFolders?.[0];
      if (!папка) {
        vscode.window.showErrorMessage("Нужна открытая папка: агенты запускаются в её каталоге.");
        return;
      }
      await vscode.workspace.fs.createDirectory(контекст.globalStorageUri);
      комната = new Комната(контекст, папка.uri.fsPath);
    }),
    vscode.commands.registerCommand("agentPanel.stopAll", async () => {
      await комната?.dispose();
    }),
  );
}

export function deactivate(): void {
  void комната?.dispose();
}
