/**
 * Точка входа расширения: комната в webview.
 *
 * Панель владеет обеими сессиями: подписка на поток уже открытой вкладки по
 * идентификатору не гарантирована, а у истории должен быть один управляющий
 * процесс. Сессия Codex, открытая владельцем в терминале, не подхватывается.
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
import { PanelEvent, stripAnsi } from "./adapters/types.js";
import { Coordinator, RoomState, Route } from "./coordinator.js";
import { Journal } from "./journal.js";

let комната: Комната | undefined;

const МАРШРУТЫ = new Set<Route>(["review", "both", "claude", "codex"]);

class Комната {
  readonly #панель: vscode.WebviewPanel;
  readonly #журнал: Journal;
  readonly #координатор: Coordinator;
  readonly #имя: string;
  #закрыта = false;

  constructor(контекст: vscode.ExtensionContext, cwd: string) {
    const настройки = vscode.workspace.getConfiguration("agentPanel");
    this.#имя = `room:${cwd}`;
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
    const режим = настройки.get<string>("claudePermissionMode", "default");

    const claude = new ClaudeAdapter(
      {
        command: настройки.get<string>("claudeCommand", "claude"),
        cwd,
        settingSources: настройки.get<string>("claudeSettingSources", "project,local"),
        ...(привязка?.claudeSessionId ? { resumeSessionId: привязка.claudeSessionId } : {}),
        ...(режим && режим !== "default" ? { extraArgs: ["--permission-mode", режим] } : {}),
        onSessionId: (id) => {
          if (!this.#закрыта) this.#журнал.bindSessions(this.#имя, id, undefined);
        },
      },
      принять,
    );
    const codex = new CodexAdapter(
      {
        command: настройки.get<string>("codexCommand", "codex"),
        cwd,
        ...(привязка?.codexThreadId ? { resumeThreadId: привязка.codexThreadId } : {}),
        onSessionId: (id) => {
          if (!this.#закрыта) this.#журнал.bindSessions(this.#имя, undefined, id);
        },
      },
      принять,
    );

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
    }
  }

  #отправитьВПанель(сообщение: { type: "event"; событие: PanelEvent; история?: boolean } | { type: "state"; состояние: RoomState }): void {
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
  | { type: "setAuto"; on: boolean };

function разметка(webview: vscode.Webview, контекст: vscode.ExtensionContext): string {
  const ресурс = (имя: string) =>
    webview.asWebviewUri(vscode.Uri.joinPath(контекст.extensionUri, "media", имя));
  const nonce = Math.random().toString(36).slice(2);
  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${ресурс("panel.css")}">
<title>Общая комната</title>
</head>
<body>
<header id="состояние">
  <div class="строка-состояния">
    <span id="этап" class="значок">ожидание</span>
    <span id="раунд" class="значок">проверок 0 из 0</span>
    <span id="вердикт" class="значок" hidden></span>
    <span id="очередь" class="значок" hidden></span>
    <span class="распорка"></span>
    <label class="переключатель" title="Выключено — каждая пересылка ждёт вашей команды">
      <input type="checkbox" id="авто" checked> автораунды
    </label>
    <button id="прервать">Прервать</button>
    <button id="стоп" class="опасно">Остановить</button>
  </div>
  <div id="задача" class="задача" hidden></div>
  <div id="удержано" class="удержано" hidden>
    <span id="удержано-причина"></span>
    <button id="отпустить">Отправить</button>
  </div>
</header>
<main id="беседа" aria-label="Беседа"></main>
<details id="диагностика">
  <summary>Диагностика <span id="диагностика-счёт">0</span></summary>
  <pre id="диагностика-строки"></pre>
</details>
<footer>
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
