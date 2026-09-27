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
import { Adapter, ApprovalChoice, ModelChoice, ModelOption, PanelEvent, forDisplay, stripAnsi } from "./adapters/types.js";
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
      evidenceBudget: настройки.get<number>("reviewEvidenceChars", 240_000),
      onEvent: (событие) => this.#отправитьВПанель({ type: "event", событие: forDisplay(событие) }),
      onState: (состояние) => this.#отправитьВПанель({ type: "state", состояние }),
    });

    this.#панель.webview.onDidReceiveMessage((сообщение: ВходящееUI) => void this.#изПанели(сообщение));
  }

  async #изПанели(сообщение: ВходящееUI): Promise<void> {
    switch (сообщение.type) {
      case "ready":
        for (const событие of this.#журнал.history(this.#имя)) {
          const лёгкое = forDisplay(событие);
          const чистое = лёгкое.text ? { ...лёгкое, text: stripAnsi(лёгкое.text) } : лёгкое;
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
<header id="состояние" class="шапка">
  <div class="шапка-строка">
    <button id="эстафета" class="эстафета" aria-expanded="false" aria-controls="дорожка" title="Кто сейчас работает. Нажмите — история текущего цикла">
      <span id="нить-статус" class="нить-статус" data-active="idle" data-flow="none" aria-hidden="true">
        <span class="ст-нить"></span>
        <span class="ст-поток"><span class="ст-частица"></span><span class="ст-частица"></span><span class="ст-частица"></span><span class="ст-частица"></span><span class="ст-частица"></span></span>
        <span class="ст-огонёк claude"></span>
        <span class="ст-огонёк codex"></span>
        <span class="ст-кольцо"></span>
        <span class="ст-человек"></span>
        <span class="ст-галочка"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.5 6.5 11.5 12.5 4.5"/></svg></span>
      </span>
      <span class="статус-текст">
        <span id="этап" data-active="idle">Ожидание</span>
        <span id="этап-пояснение"></span>
      </span>
    </button>
    <span class="распорка"></span>
    <span id="очередь" class="очередь" hidden title="Сообщения, которые ждут, пока агент закончит текущий ход"></span>
    <span id="раунд" class="раунды" role="img" aria-label="проверок 0 из 0" title="Проверка — один раз, когда Codex посмотрел работу Claude. Предел — сколько проверок разрешено на одну задачу, чтобы агенты не спорили бесконечно"></span>
    <button id="прервать" class="круглая" aria-label="Прервать ход" title="Прервать текущий ход агентов. Следующее сообщение продолжит те же сессии"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M6 4v8M10 4v8"/></svg></button>
    <button id="стоп" class="круглая опасно" aria-label="Остановить агентов" title="Завершить процессы обоих агентов вместе с их командами"><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="3.5" y="3.5" width="9" height="9" rx="1.5"/></svg></button>
  </div>
  <div id="задача" class="задача" hidden></div>
  <div id="дорожка" class="дорожка" hidden aria-label="Дорожка цикла"></div>
</header>
<main id="беседа" aria-label="Беседа"></main>
<div class="якорь-низа"><button id="к-последнему" class="пилюля" hidden title="Прокрутить к последнему сообщению">↓ К последнему</button></div>
<footer class="низ">
  <section id="удержано" class="удержано" hidden aria-label="Ждёт вашего решения">
    <span class="значок-паузы" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M6 4v8M10 4v8"/></svg></span>
    <div class="суть"><b>Обмен остановлен</b><span id="удержано-причина"></span></div>
    <button id="отпустить" class="пилюля главная">Отправить</button>
  </section>
  <div id="модели-панель" class="модели" hidden>
    <span id="модели-состояние"></span>
    <div class="нить-карточка" data-agent="claude">
      <div class="нить-заголовок">
        <span id="нить-уровень-claude" class="нить-уровень">По умолчанию</span>
        <button id="нить-сброс-claude" class="ссылка-кнопка нить-сброс" hidden title="Вернуть уровень по умолчанию: решает агент">по умолчанию</button>
        <span class="нить-агент">Claude</span>
        <select id="модель-claude" class="нить-модель" disabled aria-label="Модель Claude"></select>
      </div>
      <div id="нить-claude" class="нить-полоса" role="radiogroup" aria-label="Уровень рассуждения Claude"></div>
    </div>
    <div class="нить-карточка" data-agent="codex">
      <div class="нить-заголовок">
        <span id="нить-уровень-codex" class="нить-уровень">По умолчанию</span>
        <button id="нить-сброс-codex" class="ссылка-кнопка нить-сброс" hidden title="Вернуть уровень по умолчанию модели">по умолчанию</button>
        <span class="нить-агент">Codex</span>
        <select id="модель-codex" class="нить-модель" disabled aria-label="Модель Codex"></select>
      </div>
      <div id="нить-codex" class="нить-полоса" role="radiogroup" aria-label="Уровень рассуждения Codex"></div>
    </div>
  </div>
  <div class="поле">
    <textarea id="ввод" rows="2" aria-label="Сообщение" placeholder="Поручите задачу или задайте вопрос"></textarea>
    <div class="поле-кнопки">
      <div id="режимы" class="режимы" role="radiogroup" aria-label="Режим"></div>
      <button id="маршрут" class="пилюля прозрачная режим-название" aria-haspopup="menu" aria-expanded="false" aria-controls="маршрут-меню"><span id="маршрут-название">Задача с рецензией</span><svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M3.5 6 8 10.5 12.5 6"/></svg></button>
      <div id="маршрут-меню" class="меню" role="menu" hidden></div>
      <button id="без-вопросов" class="пилюля прозрачная" aria-pressed="true"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" aria-hidden="true"><path d="M8 1.8 13 3.6v4.1c0 3-2.1 5.3-5 6.4-2.9-1.1-5-3.4-5-6.4V3.6z"/></svg><span class="подпись">Без вопросов</span></button>
      <span class="распорка"></span>
      <button id="модели-кнопка" class="пилюля" aria-expanded="false" aria-controls="модели-панель"><span class="полоски" aria-hidden="true"><span></span><span></span></span>Модели</button>
      <button id="отправить" class="круглая отправить" aria-label="Отправить" title="Отправить (Ctrl+Enter)"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 12.5V3.5M4 7.5 8 3.5l4 4"/></svg></button>
    </div>
  </div>
  <div class="под-полем">
    <label title="Включено — Claude и Codex передают работу друг другу сами. Выключено — каждую передачу вы подтверждаете кнопкой"><input type="checkbox" id="авто" checked>Автопересылка</label>
    <span class="распорка"></span>
    <button id="диагностика-кнопка" class="ссылка-кнопка" aria-expanded="false" aria-controls="диагностика" title="Служебные логи процессов агентов — не часть разговора">Диагностика <span id="диагностика-счёт">0</span><svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5"/></svg></button>
  </div>
  <div id="диагностика" hidden><pre id="диагностика-строки"></pre></div>
</footer>
<script nonce="${nonce}" src="${ресурс("format.js")}"></script>
<script nonce="${nonce}" src="${ресурс("thread.js")}"></script>
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
