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
import { homedir } from "node:os";
import { join } from "node:path";
import { ClaudeAdapter } from "./adapters/claude.js";
import { CodexAdapter } from "./adapters/codex.js";
import { GeminiAdapter } from "./adapters/gemini.js";
import { Adapter, ApprovalChoice, ModelChoice, ModelOption, PanelEvent, forDisplay, questionAnswers, stripAnsi } from "./adapters/types.js";
import { Coordinator, RoomState, Route } from "./coordinator.js";
import { Journal } from "./journal.js";
import { describeChoice, normalizeChoice, sameChoice } from "./models.js";
import { resolveCodexCommand } from "./codexBinary.js";
import { resolveGeminiCommand } from "./geminiBinary.js";
import { addReadOnlyRules, agySettingsPath, checkReadOnlyRules, ensureReviewerAgent, reviewerAgentPath, rulesRefusal } from "./geminiSetup.js";
import { fetchGeminiUsage } from "./geminiUsage.js";
import { argumentForLaunch, resolveClaudeCommand } from "./claudeBinary.js";
import { runMemorySearch } from "./memory.js";
import { fetchClaudeUsage } from "./claudeUsage.js";

let room: Room | undefined;

const ROUTES = new Set<Route>(["review", "all", "claude", "codex", "gemini"]);
const CHOICES = new Set<ApprovalChoice>(["allow", "allowSession", "deny"]);

type SelectableAgent = "claude" | "codex" | "gemini";
const AGENT_NAMES: Record<SelectableAgent, string> = { claude: "Claude", codex: "Codex", gemini: "Gemini" };

/** Режимы разрешений, которые принимает Claude Code (2.1.220 и 2.1.280), плюс default — не передавать флаг. */
const MODES = new Set(["default", "acceptEdits", "auto", "manual", "dontAsk", "plan", "bypassPermissions"]);
const MODE_LABELS: Record<string, string> = { bypassPermissions: "без вопросов", default: "спрашивать" };

type ModelsMessage = {
  type: "models";
  agent: SelectableAgent;
  choice: ModelChoice;
  options?: readonly ModelOption[];
  error?: string;
};

class Room {
  readonly #panel: vscode.WebviewPanel;
  readonly #journal: Journal;
  readonly #coordinator: Coordinator;
  readonly #name: string;
  #closed = false;
  /** Выбор моделей хранится для папки: другая папка — другая задача. */
  readonly #memento: vscode.Memento;
  readonly #modelsKey: string;
  readonly #choices: Record<SelectableAgent, ModelChoice>;
  readonly #catalogs: Partial<Record<SelectableAgent, readonly ModelOption[]>> = {};
  /** Агенты комнаты: Gemini — если agy найден. */
  readonly #agents: readonly SelectableAgent[];
  readonly #adapters: Partial<Record<SelectableAgent, Adapter>>;
  /** settings.json agy: правила «только чтение» проверяются и дописываются здесь. */
  readonly #agySettings: string;
  #modelsLoading: Promise<void> | undefined;
  /** Режим разрешений Claude для папки; по умолчанию — из настройки. */
  #mode: string;
  readonly #modeKey: string;

  constructor(context: vscode.ExtensionContext, cwd: string) {
    const settings = vscode.workspace.getConfiguration("agentPanel");
    this.#name = `room:${cwd}`;
    this.#memento = context.workspaceState;
    this.#modelsKey = `agentPanel.models:${cwd}`;
    const savedChoices = this.#memento.get<Record<string, unknown>>(this.#modelsKey) ?? {};
    this.#choices = {
      claude: normalizeChoice(undefined, savedChoices["claude"]),
      codex: normalizeChoice(undefined, savedChoices["codex"]),
      gemini: normalizeChoice(undefined, savedChoices["gemini"]),
    };
    this.#modeKey = `agentPanel.claudePermissions:${cwd}`;
    const savedMode = this.#memento.get<string>(this.#modeKey);
    this.#mode =
      savedMode && MODES.has(savedMode)
        ? savedMode
        : settings.get<string>("claudePermissionMode", "bypassPermissions");
    this.#journal = new Journal(join(context.globalStorageUri.fsPath, "agent-panel.sqlite"));
    this.#journal.ensureRoom(this.#name, cwd);
    const binding = this.#journal.binding(this.#name);

    this.#panel = vscode.window.createWebviewPanel(
      "agentPanel",
      "Общая комната",
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this.#panel.webview.html = markup(this.#panel.webview, context);
    this.#panel.onDidDispose(() => void this.dispose());

    const accept = (event: PanelEvent) => this.#coordinator.handle(event);
    // Память по теме для обоих агентов и MCP-серверы для Claude панели: у него
    // нет пользовательских настроек, а значит и ваших MCP-серверов (qmd, om).
    const memoryCommand = settings.get<string>("memorySearchCommand", "").trim();
    const mcpConfig = settings.get<string>("claudeMcpConfig", "").trim();
    // Тот же claude, что в чате владельца: claude из npm может не знать модель
    // его сессии (28.09: 2.1.220 не принял claude-opus-5-5).
    const claudeLaunch = resolveClaudeCommand(
      settings.get<string>("claudeCommand", "claude"),
      vscode.extensions.getExtension("anthropic.claude-code")?.extensionPath,
    );
    // Через cmd.exe путь — в кавычках, иначе пробел или «&» в имени папки разбил
    // бы команду (рецензия Codex 28.09); без оболочки кавычки стали бы частью пути.
    const mcpArg = argumentForLaunch(mcpConfig, claudeLaunch.shell);

    const claude = new ClaudeAdapter(
      {
        command: claudeLaunch.command,
        ...(claudeLaunch.shell !== undefined ? { shell: claudeLaunch.shell } : {}),
        cwd,
        model: this.#choices.claude.model,
        effort: this.#choices.claude.effort,
        settingSources: settings.get<string>("claudeSettingSources", "project,local"),
        ...(mcpConfig ? { extraArgs: ["--mcp-config", mcpArg] } : {}),
        ...(binding?.claudeSessionId ? { resumeSessionId: binding.claudeSessionId } : {}),
        permissionMode: this.#mode,
        onSessionId: (id) => {
          if (!this.#closed) this.#journal.bindSessions(this.#name, id, undefined);
        },
      },
      accept,
    );
    // Тот же codex, что в чате владельца: у CLI из npm может не быть модели его ветки.
    const codexLaunch = resolveCodexCommand(
      settings.get<string>("codexCommand", "codex"),
      vscode.extensions.getExtension("openai.chatgpt")?.extensionPath,
    );
    const codex = new CodexAdapter(
      {
        command: codexLaunch.command,
        ...(codexLaunch.shell !== undefined ? { shell: codexLaunch.shell } : {}),
        cwd,
        model: this.#choices.codex.model,
        effort: this.#choices.codex.effort,
        ...(binding?.codexThreadId ? { resumeThreadId: binding.codexThreadId } : {}),
        onSessionId: (id) => {
          if (!this.#closed) this.#journal.bindSessions(this.#name, undefined, id);
        },
      },
      accept,
    );

    // Gemini — второй рецензент: agy из папки установщика или PATH. Нет — проверяет один Codex.
    this.#agySettings = agySettingsPath(homedir());
    const geminiLaunch = resolveGeminiCommand(
      settings.get<string>("geminiCommand", "agy"),
      process.env["LOCALAPPDATA"],
      process.env["PATH"],
    );
    // Состояние правил на прошлой проверке beforeStart: сменилось — плашка
    // должна появиться или исчезнуть сама, без переоткрытия панели (I2).
    let lastRulesOk: boolean | undefined;
    const gemini = geminiLaunch
      ? new GeminiAdapter(
          {
            command: geminiLaunch.command,
            ...(geminiLaunch.shell !== undefined ? { shell: geminiLaunch.shell } : {}),
            cwd,
            model: this.#choices.gemini.model,
            effort: this.#choices.gemini.effort,
            ...(binding?.geminiConversationId ? { resumeConversationId: binding.geminiConversationId } : {}),
            // Роль пишется перед каждым запуском (файл принадлежит панели); без правил «только чтение» — не запускать.
            // Проверяется на каждом ходу (gemini.ts): правила могли пропасть между ходами возобновляемой сессии.
            beforeStart: () => {
              ensureReviewerAgent(reviewerAgentPath(homedir()));
              const refusal = rulesRefusal(checkReadOnlyRules(this.#agySettings), this.#agySettings);
              const ok = refusal === undefined;
              if (lastRulesOk !== undefined && lastRulesOk !== ok) this.#postGemini();
              lastRulesOk = ok;
              return refusal;
            },
            onSessionId: (id) => {
              if (!this.#closed) this.#journal.bindGeminiConversation(this.#name, id);
            },
          },
          accept,
        )
      : undefined;

    this.#agents = gemini ? ["claude", "codex", "gemini"] : ["claude", "codex"];
    this.#adapters = { claude, codex, ...(gemini ? { gemini } : {}) };
    this.#coordinator = new Coordinator(claude, codex, this.#journal, {
      room: this.#name,
      cwd,
      maxAutoRounds: settings.get<number>("maxAutoRounds", 5),
      evidenceBudget: settings.get<number>("reviewEvidenceChars", 240_000),
      taskTokenLimit: settings.get<number>("taskTokenLimit", 0),
      ...(memoryCommand
        ? { memory: (text: string, catalog: string) => runMemorySearch(memoryCommand, catalog, text) }
        : {}),
      ...(settings.get<boolean>("claudeWeeklyUsage", true)
        ? {
            claudeUsage: () =>
              fetchClaudeUsage({
                command: claudeLaunch.command,
                ...(claudeLaunch.shell !== undefined ? { shell: claudeLaunch.shell } : {}),
              }),
          }
        : {}),
      ...(gemini && geminiLaunch
        ? {
            gemini,
            geminiWaitMs: settings.get<number>("geminiWaitMinutes", 20) * 60_000,
            geminiUsage: () =>
              fetchGeminiUsage({
                command: geminiLaunch.command,
                ...(geminiLaunch.shell !== undefined ? { shell: geminiLaunch.shell } : {}),
              }),
          }
        : {}),
      onEvent: (event) => this.#postToPanel({ type: "event", event: forDisplay(event) }),
      onState: (state) => this.#postToPanel({ type: "state", state }),
    });

    this.#panel.webview.onDidReceiveMessage((message: UiMessage) => void this.#fromPanel(message));
  }

  async #fromPanel(message: UiMessage): Promise<void> {
    switch (message.type) {
      case "ready":
        for (const event of this.#journal.history(this.#name)) {
          const light = forDisplay(event);
          const clean = light.text ? { ...light, text: stripAnsi(light.text) } : light;
          this.#postToPanel({ type: "event", event: clean, history: true });
        }
        this.#postToPanel({ type: "state", state: this.#coordinator.state });
        for (const agent of this.#agents) this.#sendModels(agent);
        this.#postToPanel({ type: "permissions", mode: this.#mode });
        this.#postGemini();
        void this.#coordinator.refreshClaudeUsage();
        void this.#coordinator.refreshGeminiUsage();
        return;
      case "addGeminiRules": {
        try {
          const check = addReadOnlyRules(this.#agySettings);
          const refusal = rulesRefusal(check, this.#agySettings);
          this.#coordinator.notice(
            refusal
              ? `Правила для Gemini не добавлены: ${refusal}.`
              : "Правила «только чтение» для Gemini добавлены в настройки agy (нестандартный режим toolPermission, " +
                  "если он был, снят — иначе Gemini не смог бы читать файлы): со следующей проверки Gemini проверяет вместе с Codex.",
          );
        } catch (err) {
          this.#coordinator.notice(
            `Правила для Gemini не добавлены: ${(err as Error).message}. Настройки agy: ${this.#agySettings}.`,
          );
        }
        this.#postGemini();
        return;
      }
      case "send":
        if (!message.text.trim() || !ROUTES.has(message.route as Route)) return;
        await this.#coordinator.fromHuman(message.text, message.route as Route);
        return;
      case "release":
        await this.#coordinator.releaseHeld();
        return;
      case "stopAll":
        await this.#coordinator.stopAll();
        return;
      case "interrupt":
        await this.#coordinator.interruptAll();
        return;
      case "setAuto":
        this.#coordinator.setAuto(message.on);
        return;
      case "setPermissionMode": {
        if (!MODES.has(message.mode)) return;
        // Адаптеру — всегда: «Больше не спрашивать» на карточке должна
        // разрешить открытый запрос, даже если режим уже был выбран.
        this.#adapters.claude?.setPermissionMode?.(message.mode);
        if (message.mode !== this.#mode) {
          this.#mode = message.mode;
          await this.#memento.update(this.#modeKey, message.mode);
          this.#coordinator.notice(
            message.mode === "bypassPermissions"
              ? "Разрешения Claude: без вопросов. Открытые запросы разрешены сразу, со следующего хода Claude не спрашивает разрешений. " +
                "Свои вопросы к вам он по-прежнему задаёт карточкой."
              : `Разрешения Claude: ${MODE_LABELS[message.mode] ?? message.mode} — со следующего хода.`,
          );
        }
        this.#postToPanel({ type: "permissions", mode: this.#mode });
        return;
      }
      case "listModels":
        await this.#loadModels();
        return;
      case "newSession":
        if (message.agent === "claude" || message.agent === "codex" || message.agent === "gemini") await this.newSession(message.agent);
        else await this.pickNewSession();
        return;
      case "setModel": {
        const agent = message.agent as SelectableAgent;
        if (!this.#agents.includes(agent)) return;
        const choice = normalizeChoice(this.#catalogs[agent], message);
        if (!sameChoice(choice, this.#choices[agent])) {
          await this.#applyChoice(agent, choice);
          this.#coordinator.notice(
            `${AGENT_NAMES[agent]}: ${describeChoice(this.#catalogs[agent], choice)} — со следующего хода.`,
          );
        }
        this.#sendModels(agent);
        return;
      }
      case "openLink": {
        // Webview сам по ссылкам не переходит; открываются только веб-адреса и почта.
        let uri: vscode.Uri;
        try {
          uri = vscode.Uri.parse(message.href, true);
        } catch {
          return;
        }
        if (["http", "https", "mailto"].includes(uri.scheme)) await vscode.env.openExternal(uri);
        return;
      }
      case "approval":
        if (!CHOICES.has(message.choice as ApprovalChoice)) return;
        await this.#coordinator.answerApproval(message.id, message.choice as ApprovalChoice);
        return;
      case "answerQuestion": {
        // Ответ на вопрос Claude (AskUserQuestion): форма проверяется — это ввод webview.
        const answers = questionAnswers(message.answers);
        if (typeof message.id !== "string" || !answers) return;
        await this.#coordinator.answerQuestion(message.id, answers);
        return;
      }
    }
  }

  /**
   * Списки моделей — по запросу человека, один раз за открытие комнаты: каждый
   * поднимает короткий процесс агента. Неудача не запоминается — можно повторить.
   */
  #loadModels(): Promise<void> {
    this.#modelsLoading ??= Promise.all(
      this.#agents.map(async (agent) => {
        try {
          const catalog = (await this.#adapters[agent]?.listModels?.()) ?? [];
          this.#catalogs[agent] = catalog;
          const valid = normalizeChoice(catalog, this.#choices[agent]);
          if (!sameChoice(valid, this.#choices[agent])) {
            await this.#applyChoice(agent, valid);
            this.#coordinator.notice(
              `${AGENT_NAMES[agent]}: сохранённая модель больше недоступна — со следующего хода по умолчанию.`,
            );
          }
          this.#sendModels(agent);
        } catch (err) {
          this.#modelsLoading = undefined;
          this.#sendModels(agent, (err as Error).message);
        }
      }),
    ).then(() => undefined);
    return this.#modelsLoading;
  }

  async #applyChoice(agent: SelectableAgent, choice: ModelChoice): Promise<void> {
    this.#choices[agent] = choice;
    this.#adapters[agent]?.setModel?.(choice);
    await this.#memento.update(this.#modelsKey, this.#choices);
  }

  /** Gemini для webview: подключён ли и на месте ли правила «только чтение». */
  #postGemini(): void {
    const present = this.#agents.includes("gemini");
    const reason = present ? rulesRefusal(checkReadOnlyRules(this.#agySettings), this.#agySettings) : undefined;
    this.#postToPanel({ type: "gemini", present, rules: reason ? { ok: false, reason } : { ok: true } });
  }

  /** «новая сессия…» из карточки «Модели»: для какого агента — спросить. */
  async pickNewSession(): Promise<void> {
    const picked = await vscode.window.showQuickPick(
      this.#agents.map((a) => AGENT_NAMES[a]),
      { placeHolder: "Новая сессия какого агента?" },
    );
    const agent = this.#agents.find((a) => AGENT_NAMES[a] === picked);
    if (agent) await this.newSession(agent);
  }

  #sendModels(agent: SelectableAgent, error?: string): void {
    const catalog = this.#catalogs[agent];
    this.#postToPanel({
      type: "models",
      agent: agent,
      choice: this.#choices[agent],
      ...(catalog ? { options: catalog } : {}),
      ...(error ? { error: error } : {}),
    });
  }

  /** Новая сессия агента — после подтверждения: прежний разговор агент помнить не будет. */
  async newSession(agent: SelectableAgent): Promise<void> {
    if (!this.#agents.includes(agent)) {
      vscode.window.showInformationMessage("Gemini не подключён: agy не найден (agentPanel.geminiCommand).");
      return;
    }
    const name = AGENT_NAMES[agent];
    const reply = await vscode.window.showWarningMessage(
      `Начать новую сессию ${name} для этой комнаты? Прежний разговор останется в истории ${name}, ` +
        "но агент не будет его помнить. Беседа в панели сохранится.",
      { modal: true },
      "Начать новую",
    );
    if (reply !== "Начать новую") return;
    await this.#coordinator.newSession(agent);
  }

  #postToPanel(
    message:
      | { type: "event"; event: PanelEvent; history?: boolean }
      | { type: "state"; state: RoomState }
      | ModelsMessage
      | { type: "permissions"; mode: string }
      | { type: "gemini"; present: boolean; rules: { ok: boolean; reason?: string } },
  ): void {
    if (this.#closed) return;
    void this.#panel.webview.postMessage(message);
  }

  async dispose(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#coordinator.stopAll();
    this.#journal.close();
    room = undefined;
  }
}

type UiMessage =
  | { type: "ready" }
  | { type: "send"; text: string; route: string }
  | { type: "release" }
  | { type: "stopAll" }
  | { type: "interrupt" }
  | { type: "setAuto"; on: boolean }
  | { type: "approval"; id: string; choice: string }
  | { type: "answerQuestion"; id: unknown; answers: unknown }
  | { type: "openLink"; href: string }
  | { type: "listModels" }
  | { type: "setModel"; agent: string; model: unknown; effort: unknown }
  | { type: "setPermissionMode"; mode: string }
  | { type: "newSession"; agent?: string }
  | { type: "addGeminiRules" };

/**
 * Разметка webview.
 *
 * style-src допускает 'unsafe-inline' ради KaTeX: высоту дробей и индексов
 * он задаёт атрибутами style, без них формулы разваливаются. Сырой HTML из
 * реплик агентов в страницу не попадает (markdown-it с html: false), а
 * скрипты по-прежнему только с nonce.
 */
function markup(webview: vscode.Webview, context: vscode.ExtensionContext): string {
  const resource = (name: string) =>
    webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "media", name));
  const nonce = Math.random().toString(36).slice(2);
  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${resource("vendor/katex/katex.min.css")}">
<link rel="stylesheet" href="${resource("panel.css")}">
<title>Общая комната</title>
</head>
<body>
<header id="состояние" class="шапка">
  <div class="шапка-строка">
    <button id="эстафета" class="эстафета" aria-expanded="false" aria-controls="дорожка" title="Кто сейчас работает. Нажмите — история текущего цикла">
      <span id="нить-статус" class="нить-статус" data-active="idle" data-flow="none" data-pair="no" aria-hidden="true">
        <svg class="ст-нити" width="96" height="28" viewBox="0 0 96 28">
          <path class="ст-ствол" d="M8 14 H54"/>
          <path class="ст-ветвь одна" d="M54 14 H82"/>
          <path class="ст-ветвь codex" d="M54 14 C66 14 70 6 82 6"/>
          <path class="ст-ветвь gemini" d="M54 14 C66 14 70 22 82 22"/>
        </svg>
        <span class="ст-поток"><span class="ст-частица"></span><span class="ст-частица"></span><span class="ст-частица"></span><span class="ст-частица"></span><span class="ст-частица"></span><span class="ст-частица"></span></span>
        <span class="ст-огонёк claude"></span>
        <span class="ст-огонёк codex"></span>
        <span class="ст-огонёк gemini"></span>
        <span class="ст-кольцо"></span>
        <span class="ст-человек"></span>
        <span id="ст-отметка-codex" class="ст-отметка codex" hidden></span>
        <span id="ст-отметка-gemini" class="ст-отметка gemini" hidden></span>
        <span class="ст-галочка"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.5 6.5 11.5 12.5 4.5"/></svg></span>
      </span>
      <span class="статус-текст">
        <span id="этап" data-active="idle">Ожидание</span>
        <span id="этап-пояснение"></span>
      </span>
    </button>
    <span class="распорка"></span>
    <span id="очередь" class="очередь" hidden title="Сообщения, которые ждут, пока агент закончит текущий ход"></span>
    <span id="раунд" class="раунды" role="img" aria-label="проверок 0 из 0" title="Проверка — один раз, когда рецензенты посмотрели работу Claude (Codex и Gemini вместе — одна проверка). Предел — сколько проверок разрешено на одну задачу, чтобы агенты не спорили бесконечно"></span>
    <button id="прервать" class="круглая" aria-label="Прервать ход" title="Прервать текущий ход агентов; сообщения, ждавшие в очереди, не отправляются. Следующее сообщение продолжит те же сессии"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M6 4v8M10 4v8"/></svg></button>
    <button id="стоп" class="круглая опасно" aria-label="Остановить агентов" title="Завершить процессы всех агентов вместе с их командами"><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="3.5" y="3.5" width="9" height="9" rx="1.5"/></svg></button>
  </div>
  <div id="задача" class="задача" hidden></div>
  <div id="дорожка" class="дорожка" hidden aria-label="Дорожка цикла"></div>
  <div id="расход" class="расход" hidden title="Токены агентов с начала текущей задачи и последние сведения о лимитах"></div>
</header>
<main id="беседа" aria-label="Беседа"></main>
<div class="якорь-низа"><button id="к-последнему" class="пилюля" hidden title="Прокрутить к последнему сообщению">↓ К последнему</button></div>
<footer class="низ">
  <section id="удержано" class="удержано" hidden aria-label="Ждёт вашего решения">
    <span class="значок-паузы" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M6 4v8M10 4v8"/></svg></span>
    <div class="суть"><b>Обмен остановлен</b><span id="удержано-причина"></span></div>
    <button id="отпустить" class="пилюля главная">Отправить</button>
  </section>
  <section id="правила-gemini" class="удержано" hidden aria-label="Gemini нужен режим только чтения">
    <span class="значок-паузы" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="8" cy="8" r="6.2"/><path d="M8 4.8v3.6M8 10.8v.3"/></svg></span>
    <div class="суть"><b>Gemini нужен режим только чтения</b><span id="правила-gemini-причина"></span></div>
    <button id="добавить-правила" class="пилюля главная" title="Дописать в настройки agy: разрешить чтение страниц, запретить запись файлов и команды; нестандартный режим (например strict) будет снят, чтобы Gemini мог читать файлы. Остальное содержимое сохраняется">Добавить правила</button>
  </section>
  <div id="модели-панель" class="модели" hidden>
    <span id="модели-состояние"></span>
    <div class="модели-карточка">
      <div id="строка-claude" class="модели-строка" data-agent="claude">
        <span class="модели-имя">Claude</span>
        <select id="модель-claude" class="нить-модель" disabled aria-label="Модель Claude"></select>
        <div id="нить-claude" class="нить-полоса" role="radiogroup" aria-label="Уровень рассуждения Claude"></div>
        <button id="нить-сброс-claude" class="ссылка-кнопка нить-сброс" hidden aria-label="Вернуть уровень Claude по умолчанию" title="Вернуть уровень по умолчанию: решает агент">↺</button>
      </div>
      <div id="строка-codex" class="модели-строка" data-agent="codex">
        <span class="модели-имя">Codex</span>
        <select id="модель-codex" class="нить-модель" disabled aria-label="Модель Codex"></select>
        <div id="нить-codex" class="нить-полоса" role="radiogroup" aria-label="Уровень рассуждения Codex"></div>
        <button id="нить-сброс-codex" class="ссылка-кнопка нить-сброс" hidden aria-label="Вернуть уровень Codex по умолчанию" title="Вернуть уровень по умолчанию модели">↺</button>
      </div>
      <div id="строка-gemini" class="модели-строка" data-agent="gemini" hidden>
        <span class="модели-имя">Gemini</span>
        <select id="модель-gemini" class="нить-модель" disabled aria-label="Модель Gemini"></select>
        <div id="нить-gemini" class="нить-полоса" role="radiogroup" aria-label="Уровень рассуждения Gemini"></div>
        <button id="нить-сброс-gemini" class="ссылка-кнопка нить-сброс" hidden aria-label="Вернуть уровень Gemini по умолчанию" title="Вернуть уровень по умолчанию семейства">↺</button>
      </div>
      <div class="модели-низ">
        <button id="новая-сессия" class="ссылка-кнопка новая-сессия" title="Начать новую сессию агента: прежний разговор останется в истории, но агент его помнить не будет. Нужна, когда длинная сессия дорого обходится каждому ходу">новая сессия…</button>
      </div>
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
      <button id="модели-кнопка" class="пилюля" aria-expanded="false" aria-controls="модели-панель"><span class="полоски" aria-hidden="true"><span></span><span></span><span></span></span>Модели</button>
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
<script nonce="${nonce}" src="${resource("format.js")}"></script>
<script nonce="${nonce}" src="${resource("thread.js")}"></script>
<script nonce="${nonce}" src="${resource("vendor/markdown.js")}"></script>
<script nonce="${nonce}" src="${resource("panel.js")}"></script>
</body>
</html>`;
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("agentPanel.open", async () => {
      if (room) {
        vscode.window.showInformationMessage("Комната уже открыта.");
        return;
      }
      const dir = vscode.workspace.workspaceFolders?.[0];
      if (!dir) {
        vscode.window.showErrorMessage("Нужна открытая папка: агенты запускаются в её каталоге.");
        return;
      }
      await vscode.workspace.fs.createDirectory(context.globalStorageUri);
      room = new Room(context, dir.uri.fsPath);
    }),
    vscode.commands.registerCommand("agentPanel.stopAll", async () => {
      await room?.dispose();
    }),
    vscode.commands.registerCommand("agentPanel.newClaudeSession", async () => {
      await room?.newSession("claude");
    }),
    vscode.commands.registerCommand("agentPanel.newCodexSession", async () => {
      await room?.newSession("codex");
    }),
    vscode.commands.registerCommand("agentPanel.newGeminiSession", async () => {
      await room?.newSession("gemini");
    }),
  );
}

export function deactivate(): void {
  void room?.dispose();
}
