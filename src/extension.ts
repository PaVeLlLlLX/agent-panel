/**
 * Точка входа расширения: комната в webview.
 *
 * Панель ВЛАДЕЕТ обеими сессиями. Это решение, а не случайность: подписка на
 * поток уже работающей вкладки по идентификатору сессии документально не
 * гарантирована, а у одной истории должен быть один управляющий процесс.
 * Поэтому панель запускает своих агентов, а штатное расширение Claude
 * остаётся для одиночной работы.
 *
 * Отсюда следствие, о котором надо помнить при чтении кода: сессия Codex,
 * открытая владельцем в терминале, НЕ подхватывается. У неё стоит блокировка
 * писателя, и вмешательство сломало бы её. Панель создаёт свою ветку.
 */
import * as vscode from "vscode";
import { join } from "node:path";
import { ClaudeAdapter } from "./adapters/claude.js";
import { CodexAdapter } from "./adapters/codex.js";
import { PanelEvent } from "./adapters/types.js";
import { Addressee, Coordinator } from "./coordinator.js";
import { Journal } from "./journal.js";

let комната: Комната | undefined;

class Комната {
  readonly #панель: vscode.WebviewPanel;
  readonly #журнал: Journal;
  readonly #координатор: Coordinator;
  readonly #claude: ClaudeAdapter;
  readonly #codex: CodexAdapter;
  readonly #имя: string;
  #закрыта = false;

  constructor(контекст: vscode.ExtensionContext, cwd: string) {
    const настройки = vscode.workspace.getConfiguration("agentPanel");
    const имя = `room:${cwd}`;
    this.#имя = имя;

    this.#журнал = new Journal(
      join(контекст.globalStorageUri.fsPath, "agent-panel.sqlite"),
    );
    this.#журнал.ensureRoom(имя, cwd);
    const привязка = this.#журнал.binding(имя);

    this.#панель = vscode.window.createWebviewPanel(
      "agentPanel",
      "Общая комната",
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this.#панель.webview.html = разметка(this.#панель.webview, контекст);
    this.#панель.onDidDispose(() => void this.dispose());

    const принять = (событие: PanelEvent) => this.#координатор.handle(событие);

    const режим = настройки.get<string>(
      "claudePermissionMode",
      "default",
    );
    this.#claude = new ClaudeAdapter(
      {
        command: настройки.get<string>("claudeCommand", "claude"),
        cwd,
        ...(привязка?.claudeSessionId
          ? { resumeSessionId: привязка.claudeSessionId }
          : {}),
        ...(режим && режим !== "default"
          ? { extraArgs: ["--permission-mode", режим] }
          : {}),
        // session_id приходит асинхронно, уже после start(). Без этого
        // обратного вызова привязка сохранялась бы до его появления, и
        // после перезапуска панель показывала бы старую историю,
        // разговаривая с новой сессией, которая о ней не знает.
        onSessionId: (id) => {
          if (this.#закрыта) return;
          this.#журнал.bindSessions(this.#имя, id, undefined);
        },
      },
      принять,
    );
    this.#codex = new CodexAdapter(
      {
        command: настройки.get<string>("codexCommand", "codex"),
        cwd,
        ...(привязка?.codexThreadId
          ? { resumeThreadId: привязка.codexThreadId }
          : {}),
      },
      принять,
    );

    this.#координатор = new Coordinator(
      this.#claude,
      this.#codex,
      this.#журнал,
      {
        room: имя,
        cwd,
        maxAutoRounds: настройки.get<number>("maxAutoRounds", 3),
        onEvent: (событие) => this.#вПанель(событие),
      },
    );

    // История отдаётся до запуска агентов: панель должна быть читаемой сразу,
    // а не после того, как процессы поднялись.
    for (const событие of this.#журнал.history(имя)) {
      void this.#панель.webview.postMessage({ type: "event", событие });
    }

    this.#панель.webview.onDidReceiveMessage((сообщение: ВходящееUI) =>
      void this.#изПанели(сообщение),
    );

    void this.#поднять(имя);
  }

  async #поднять(имя: string): Promise<void> {
    for (const [название, адаптер] of [
      ["Claude", this.#claude],
      ["Codex", this.#codex],
    ] as const) {
      try {
        await адаптер.start();
      } catch (беда) {
        this.#вПанель({
          id: `b${Date.now().toString(36)}`,
          agent: адаптер.id,
          kind: "error",
          visibility: "turn",
          at: Date.now(),
          text: `${название} не запустился: ${(беда as Error).message}`,
        });
      }
    }
    // Привязка сохраняется сразу после запуска: если панель упадёт до первого
    // хода, восстановление всё равно найдёт те же сессии.
    this.#журнал.bindSessions(
      имя,
      this.#claude.sessionId,
      this.#codex.sessionId,
    );
    this.#вПанель({
      id: `r${Date.now().toString(36)}`,
      agent: "human",
      kind: "message",
      visibility: "turn",
      at: Date.now(),
      text:
        `Комната готова. Claude: ${this.#claude.sessionId?.slice(0, 8) ?? "—"}, ` +
        `Codex: ${this.#codex.sessionId?.slice(0, 8) ?? "—"}. ` +
        `Рецензент работает в песочнице read-only; попытки записи ` +
        `отклоняются панелью. Два известных ограничения: запуск команд ` +
        `рецензентом технически не запрещён, и у разработчика нет ` +
        `канала согласования в панели — действия, требующие ` +
        `одобрения, будут отклонены, пока режим разрешений не задан ` +
        `настройкой agentPanel.claudePermissionMode.`,
    });
  }

  async #изПанели(сообщение: ВходящееUI): Promise<void> {
    switch (сообщение.type) {
      case "send":
        await this.#координатор.fromHuman(
          сообщение.text,
          сообщение.to as Addressee,
        );
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

  #вПанель(событие: PanelEvent): void {
    if (this.#закрыта) return;
    void this.#панель.webview.postMessage({
      type: "event",
      событие,
      состояние: {
        claudeBusy: this.#claude.busy,
        codexBusy: this.#codex.busy,
        round: this.#координатор.round,
        snapshot: this.#координатор.snapshot?.id,
      },
    });
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
  | { type: "send"; text: string; to: string }
  | { type: "stopAll" }
  | { type: "interrupt" }
  | { type: "setAuto"; on: boolean };

function разметка(
  webview: vscode.Webview,
  контекст: vscode.ExtensionContext,
): string {
  const ресурс = (имя: string) =>
    webview.asWebviewUri(
      vscode.Uri.joinPath(контекст.extensionUri, "media", имя),
    );
  const nonce = Math.random().toString(36).slice(2);
  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${webview.cspSource};
               script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${ресурс("panel.css")}">
<title>Общая комната</title>
</head>
<body>
<header id="шапка">
  <span class="ярлык">Комната</span>
  <span id="состояние-claude" class="значок">Claude: —</span>
  <span id="состояние-codex" class="значок">Codex: —</span>
  <span id="раунд" class="значок">раунд 0</span>
  <span id="версия" class="значок">версия —</span>
  <label class="переключатель">
    <input type="checkbox" id="авто" checked> автораунды
  </label>
  <button id="прервать">Прервать ход</button>
  <button id="стоп" class="опасно">Остановить обоих</button>
</header>
<main>
  <section id="беседа" aria-label="Общая беседа"></section>
  <aside id="действия" aria-label="Действия агентов"></aside>
</main>
<footer>
  <textarea id="ввод" rows="3"
            placeholder="Сообщение… Ctrl+Enter отправляет"></textarea>
  <div class="строка">
    <label>Адресат:
      <select id="адресат">
        <option value="both">Оба</option>
        <option value="claude">Claude</option>
        <option value="codex">Codex</option>
      </select>
    </label>
    <button id="отправить">Отправить</button>
  </div>
</footer>
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
        vscode.window.showErrorMessage(
          "Нужна открытая папка: агенты запускаются в её каталоге.",
        );
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
