/**
 * Проба песочницы Codex для проверок рецензентов (ступень 0 спецификации
 * docs/specs/2026-10-05-проверки-рецензентов.md, задача 6 плана).
 *
 * Зачем. Ступени 2–3 держатся на профиле прав «читать всё, писать в одну
 * папку, сеть выключена», переданном в `config` при thread/start и
 * thread/resume, и на command/exec без хода модели. Исходники Codex 0.159
 * говорят, что так можно, но принимает ли это app-server на этой машине,
 * сохраняет ли ветка профиль и как он сообщает тайм-аут — видно только
 * живым запуском. Итог — docs/research/2026-10-05-проба-песочницы-codex.md.
 *
 * Режимы (по очереди; общее состояние — в <out>/state.json):
 *   --profile  новая ветка с профилем в config, один ход модели: запись в
 *              папку и в проект, чтение маркера, сеть через urllib и сырой
 *              сокет, фоновый процесс; потом — жив ли он и снят ли;
 *   --resume   новый процесс, thread/resume той же ветки с тем же config и
 *              без config, по одному ходу на каждый случай;
 *   --python   продолжение с config, один ход: окружение из
 *              shell_environment_policy.set, python из .venv Trading (только
 *              print(1)), импорт кода проекта, временный файл;
 *   --exec     без хода модели: command/exec с sandboxPolicy workspaceWrite,
 *              cwd = папка: запись внутрь и в проект, чтение, сеть, тайм-аут,
 *              python из .venv Trading (только print(1)), импорт кода
 *              проекта, фоновый процесс — в форме плана и в строгой
 *              (excludeTmpdirEnvVar, excludeSlashTmp);
 *   --cleanup  снять оставшиеся фоновые python пробы, удалить временную
 *              папку-проект и review\probe.
 * Ключи режимов:
 *   --cwd folder  рабочая папка ветки — папка рецензента, а не проект (по
 *                 умолчанию — проект, как в плане): с проектом unelevated-
 *                 песочница отказывается запускать команды под профилем;
 *   --checks      (--resume) ход с config повторяет и шесть проверок --profile.
 * Расход — четыре коротких хода Codex (один в --profile, два в --resume,
 * один в --python) на модели по умолчанию из каталога с уровнем low. Чат владельца,
 * ~/.codex/config.toml и данные Trading не трогаются: проект — временная
 * папка с маркером вместо .env; из Trading берётся только python из .venv
 * для print(1). Усиленная песочница не включается.
 *
 * Итог 05.10 (Codex 0.159.0-alpha.12.1, unelevated): профиль принимают и
 * thread/start, и thread/resume, но команды под ним идут только при cwd =
 * папка рецензента; без config при продолжении профиль теряется (read-only);
 * command/exec — со строгой формой sandboxPolicy, отказ и тайм-аут приходят
 * ошибкой JSON-RPC; сырой сокет выходит в сеть, фоновые процессы переживают
 * остановку app-server. Подробности — в документе исследования.
 *
 * Запуск: npm run build, затем по очереди с одной и той же --out <папка>:
 *   node scripts/codex-sandbox-probe.mjs --profile --out <папка>
 *   node scripts/codex-sandbox-probe.mjs --resume --cwd folder --checks --out <папка>
 *   node scripts/codex-sandbox-probe.mjs --python --cwd folder --out <папка>
 *   node scripts/codex-sandbox-probe.mjs --exec --out <папка>
 *   node scripts/codex-sandbox-probe.mjs --cleanup --out <папка>
 * --fake — фальшивый Codex из fixtures/ вместо настоящего: проверка самого
 * скрипта без расхода; папка рецензента тогда — внутри временной папки.
 */
import { execFileSync } from "node:child_process";
import { lookup } from "node:dns/promises";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createConnection } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const require = createRequire(import.meta.url);
const { spawnProcess, killTree } = require("../out/adapters/process.js");
const { resolveCodexCommand } = require("../out/codexBinary.js");

/** Чат владельца: продолжать его проба не должна ни при каком режиме. */
const OWNER_THREAD = "01a09f7b-70de-72a1-97e0-af2e8cca2a16";
const PROFILE_ID = "agent-panel-review";
/** Адрес из плана; если он не отвечает и без песочницы — берётся адрес example.com из DNS. */
const PLANNED_IP = "93.184.215.14";

const argv = process.argv.slice(2);
const option = (name) => {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
};
const fake = argv.includes("--fake");
const mode = ["--profile", "--resume", "--python", "--exec", "--cleanup"].find((it) => argv.includes(it));
const outDir = option("--out") ?? join(tmpdir(), "codex-sandbox-probe-out");
const statePath = join(outDir, "state.json");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stamp = () => new Date().toISOString();

// --- состояние и папки --------------------------------------------------------

function readState() {
  return existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : undefined;
}

function saveState(state) {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function saveResult(name, result) {
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `${name}.json`);
  writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`записано: ${file}`);
}

/**
 * Временная папка-проект с маркером вместо .env и кодом для импорта; папка
 * рецензента с tmp\ — заранее: корень записи учитывается, только если есть.
 */
function prepare() {
  const known = readState();
  if (known && existsSync(known.project) && existsSync(known.folder)) return known;
  const root = join(tmpdir(), `codex-sandbox-probe-${stamp().replace(/[:.]/g, "-")}`);
  const project = join(root, "project");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "marker.env"), "SECRET=probe\n");
  writeFileSync(join(project, "code.py"), "VALUE = 42\n\n\ndef answer():\n    return VALUE\n");
  const local = fake ? root : (process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"));
  const panelDir = join(local, "agent-panel");
  const reviewDir = join(panelDir, "review");
  const probeDir = join(reviewDir, "probe");
  // Пустые родители, заведённые пробой, при уборке удаляются; бывшие до неё — нет.
  const createdDirs = [panelDir, reviewDir].filter((it) => !existsSync(it));
  const folder = join(probeDir, "codex");
  mkdirSync(join(folder, "tmp"), { recursive: true });
  const state = { createdAt: stamp(), fake, root, project, folder, probeDir, createdDirs };
  saveState(state);
  return state;
}

function profileConfig(folder) {
  return {
    default_permissions: PROFILE_ID,
    permissions: {
      [PROFILE_ID]: {
        filesystem: { ":root": "read", [folder]: "write" },
        network: { enabled: false },
      },
    },
    shell_environment_policy: {
      set: {
        TEMP: join(folder, "tmp"),
        TMP: join(folder, "tmp"),
        PYTHONDONTWRITEBYTECODE: "1",
        MPLCONFIGDIR: join(folder, "tmp", "mpl"),
      },
    },
  };
}

const PROBE_INSTRUCTIONS = [
  "Это проба песочницы во временной папке; проект настоящий не затрагивается.",
  "Выполняй команды, о которых просят, по одной и ровно как сказано.",
  "После каждой сообщи команду, код выхода и вывод или текст ошибки.",
  "Если команда не прошла, не ищи обходных путей и не проси разрешений:",
  "запиши ошибку и переходи к следующей.",
  "Файлы записывай командой оболочки (python -c или Set-Content), а не инструментом правки файлов.",
].join("\n");

function fileInfo(path) {
  if (!existsSync(path)) return { path, exists: false };
  const stats = statSync(path);
  if (stats.isDirectory()) return { path, exists: true, directory: true, entries: readdirSync(path) };
  return {
    path,
    exists: true,
    size: stats.size,
    modifiedAt: stats.mtime.toISOString(),
    head: readFileSync(path, "utf8").slice(0, 300),
  };
}

const sizeOf = (path) => (existsSync(path) ? statSync(path).size : -1);

function systemPython() {
  try {
    return execFileSync("where", ["python"], { encoding: "utf8", windowsHide: true }).split(/\r?\n/)[0].trim();
  } catch {
    return "python";
  }
}

function tradingPython() {
  const path = join(homedir(), "source", "Trading", ".venv", "Scripts", "python.exe");
  return existsSync(path) ? path : undefined;
}

// --- сеть без песочницы: какой адрес вообще отвечает --------------------------

function tryConnect(host, port = 80, limit = 5000) {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port, timeout: limit });
    const done = (ok, reason) => {
      socket.destroy();
      resolve({ host, ok, ...(reason ? { reason } : {}) });
    };
    socket.on("connect", () => done(true));
    socket.on("timeout", () => done(false, "timeout"));
    socket.on("error", (err) => done(false, err.message));
  });
}

async function reachableIp() {
  const planned = await tryConnect(PLANNED_IP);
  if (planned.ok) return { ip: PLANNED_IP, planned };
  let resolved = [];
  try {
    resolved = (await lookup("example.com", { all: true, family: 4 })).map((it) => it.address);
  } catch (err) {
    return { ip: PLANNED_IP, planned, lookupError: err.message };
  }
  for (const ip of resolved) {
    const attempt = await tryConnect(ip);
    if (attempt.ok) return { ip, planned, resolved, hostCheck: attempt };
  }
  return { ip: PLANNED_IP, planned, resolved, note: "ни один адрес не ответил и без песочницы" };
}

// --- фоновые python пробы -----------------------------------------------------

// Полный путь: в PATH Git Bash каталога Windows PowerShell нет.
const POWERSHELL = join(
  process.env.SYSTEMROOT ?? process.env.SystemRoot ?? "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);

function pythonProcesses() {
  const script =
    "Get-CimInstance Win32_Process -Filter \"Name like 'python%' or Name = 'py.exe'\" | " +
    "Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress";
  try {
    const text = execFileSync(POWERSHELL, ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      windowsHide: true,
    }).trim();
    if (!text) return [];
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (err) {
    return [{ error: err.message }];
  }
}

const STRONG_MARKS = ["review\\probe", "review/probe", "codex-sandbox-probe"];
const WEAK_MARKS = ["bg.txt", "bg.py", "bg-exec"];

/**
 * Python, запущенные пробой: новые с прошлого снимка и с меткой пробы в
 * командной строке; без снимка — только по меткам пути пробы. Чужие python
 * не снимаются, новые без метки только перечисляются.
 */
function probePythons(before) {
  const all = pythonProcesses();
  const errors = all.filter((it) => it.error).map((it) => it.error);
  const list = all.filter((it) => it.ProcessId !== undefined);
  const fresh = before ? list.filter((it) => !before.has(it.ProcessId)) : list;
  const marks = before ? [...STRONG_MARKS, ...WEAK_MARKS] : STRONG_MARKS;
  const matched = fresh.filter((it) => marks.some((mark) => String(it.CommandLine ?? "").toLowerCase().includes(mark)));
  const unmatched = before ? fresh.filter((it) => !matched.includes(it)) : [];
  return { matched, unmatched, ...(errors.length ? { errors } : {}) };
}

function killPythons(found) {
  const killed = [];
  for (const it of found) {
    try {
      execFileSync("taskkill", ["/PID", String(it.ProcessId), "/T", "/F"], { encoding: "utf8", windowsHide: true });
      killed.push({ pid: it.ProcessId, ok: true });
    } catch (err) {
      killed.push({ pid: it.ProcessId, ok: false, error: String(err.message).slice(0, 300) });
    }
  }
  return killed;
}

const pidSet = () => new Set(pythonProcesses().map((it) => it.ProcessId).filter((it) => it !== undefined));

// --- app-server ---------------------------------------------------------------

function chatgptExtension() {
  const root = join(homedir(), ".vscode", "extensions");
  if (!existsSync(root)) return undefined;
  const names = readdirSync(root)
    .filter((it) => it.startsWith("openai.chatgpt-"))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return names.length ? join(root, names[names.length - 1]) : undefined;
}

function codexLaunch() {
  if (fake) {
    return { command: process.execPath, args: [join(import.meta.dirname, "..", "fixtures", "fake-codex.mjs")], shell: false, source: "fake" };
  }
  const found = resolveCodexCommand(undefined, chatgptExtension());
  return { command: found.command, args: [], shell: found.shell, source: found.source };
}

function codexVersion(launch) {
  if (fake) return "fake";
  try {
    return execFileSync(launch.command, ["--version"], { encoding: "utf8", windowsHide: true }).trim();
  } catch (err) {
    return `не узнать: ${err.message}`;
  }
}

/** Свой короткий клиент JSON-RPC: запросы сервера отклоняются и записываются. */
function openServer(cwd) {
  const launch = codexLaunch();
  const proc = spawnProcess(launch.command, [...launch.args, "app-server"], cwd, launch.shell);
  const waiters = new Map();
  const listeners = new Set();
  const notifications = [];
  const serverRequests = [];
  const stderr = [];
  let next = 1;
  let exit;
  const write = (record) => {
    try {
      proc.stdin.write(`${JSON.stringify(record)}\n`);
    } catch {
      // канал уже закрыт
    }
  };
  proc.stdin.on("error", () => undefined);
  createInterface({ input: proc.stderr }).on("line", (line) => {
    const text = line.replace(/\x1b\[[0-9;]*m/g, "").trim();
    if (text) stderr.push(text.slice(0, 2000));
  });
  createInterface({ input: proc.stdout }).on("line", (line) => {
    if (!line.trim()) return;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      stderr.push(`строка вне протокола: ${line.slice(0, 500)}`);
      return;
    }
    if ("method" in record && "id" in record) {
      serverRequests.push(record);
      write({ jsonrpc: "2.0", id: record.id, error: { code: -32000, message: "проба: запросы сервера отклоняются" } });
      return;
    }
    if ("method" in record) {
      notifications.push({ at: Date.now(), method: record.method, params: record.params });
      for (const listener of listeners) listener(record);
      return;
    }
    const waiter = waiters.get(record.id);
    waiters.delete(record.id);
    if (!waiter) return;
    if (record.error) waiter.reject(Object.assign(new Error(record.error.message ?? "ошибка Codex"), { rpcError: record.error }));
    else waiter.resolve(record.result);
  });
  const failAll = (text) => {
    for (const [, waiter] of waiters) waiter.reject(new Error(text));
    waiters.clear();
  };
  proc.on("exit", (code, signal) => {
    exit = { code, signal, at: stamp() };
    failAll(`app-server завершился (код ${code}, сигнал ${signal})`);
  });
  proc.on("error", (err) => failAll(`app-server не запустился: ${err.message}`));
  const request = (method, params, limit = 60_000) =>
    new Promise((resolve, reject) => {
      const id = next++;
      const timer = setTimeout(() => {
        waiters.delete(id);
        reject(new Error(`нет ответа на ${method} за ${limit / 1000} с`));
      }, limit);
      waiters.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      write({ jsonrpc: "2.0", id, method, params });
    });
  const notify = (method, params) => write({ jsonrpc: "2.0", method, params });
  return {
    launch,
    proc,
    request,
    notify,
    listeners,
    notifications,
    serverRequests,
    stderr,
    alive: () => exit === undefined,
    exit: () => exit,
    stop: () => killTree(proc),
  };
}

async function settle(promise) {
  const startedAt = Date.now();
  try {
    const result = await promise;
    return { ok: true, ms: Date.now() - startedAt, result };
  } catch (err) {
    return { ok: false, ms: Date.now() - startedAt, error: err.message, ...(err.rpcError ? { rpcError: err.rpcError } : {}) };
  }
}

async function initialize(server) {
  // Как панель: capabilities пустые, экспериментальные поля недоступны.
  const reply = await settle(
    server.request("initialize", { clientInfo: { name: "agent-panel", version: "0.1.0" }, capabilities: {} }),
  );
  server.notify("initialized", {});
  return reply;
}

function serverSummary(server) {
  const counts = {};
  for (const it of server.notifications) counts[it.method] = (counts[it.method] ?? 0) + 1;
  return {
    notificationCounts: counts,
    configWarnings: server.notifications.filter((it) => it.method === "configWarning").map((it) => it.params),
    serverRequests: server.serverRequests,
    stderr: server.stderr.slice(-200),
    exit: server.exit(),
  };
}

/** Модель по умолчанию из каталога и уровень low, если модель его знает. */
function choice(catalog) {
  const list = Array.isArray(catalog?.data) ? catalog.data : [];
  const model = list.find((it) => it.isDefault) ?? list[0];
  const levels = (model?.supportedReasoningEfforts ?? []).map((it) => it.reasoningEffort);
  const effort = levels.includes("low") ? "low" : (model?.defaultReasoningEffort ?? undefined);
  return { model: model?.model ?? model?.id, effort, levels };
}

/** Один ход до turn/completed; при пределе — turn/interrupt. */
async function runTurn(server, threadId, text, picked, limit = 600_000) {
  const from = server.notifications.length;
  let finish;
  const completed = new Promise((resolve) => {
    finish = resolve;
  });
  const listener = (record) => {
    if (record.method === "turn/completed" && (record.params?.threadId ?? threadId) === threadId) finish(record.params);
  };
  server.listeners.add(listener);
  const startedAt = Date.now();
  const params = {
    threadId,
    input: [{ type: "text", text }],
    ...(picked.model ? { model: picked.model } : {}),
    ...(picked.effort ? { effort: picked.effort } : {}),
  };
  const start = await settle(server.request("turn/start", params));
  let end;
  let interrupt;
  if (start.ok) {
    const timer = sleep(limit).then(() => "limit");
    end = await Promise.race([completed, timer]);
    if (end === "limit") {
      interrupt = await settle(server.request("turn/interrupt", { threadId, turnId: start.result?.turn?.id }));
      end = await Promise.race([completed, sleep(30_000).then(() => "no completion after interrupt")]);
    }
  }
  server.listeners.delete(listener);
  const mine = server.notifications.slice(from);
  const items = mine.filter((it) => it.method === "item/completed").map((it) => it.params?.item ?? {});
  const commands = items
    .filter((it) => it.type === "commandExecution")
    .map((it) => ({
      command: it.command,
      cwd: it.cwd,
      source: it.source,
      status: it.status,
      exitCode: it.exitCode,
      durationMs: it.durationMs,
      aggregatedOutput: it.aggregatedOutput,
      commandActions: it.commandActions,
    }));
  const lastOf = (method) => mine.filter((it) => it.method === method).at(-1)?.params;
  const kinds = {};
  for (const it of items) kinds[it.type] = (kinds[it.type] ?? 0) + 1;
  return {
    params,
    start,
    seconds: Math.round((Date.now() - startedAt) / 1000),
    end,
    interrupt,
    itemKinds: kinds,
    commands,
    fileChanges: items.filter((it) => it.type === "fileChange"),
    messages: items.filter((it) => it.type === "agentMessage").map((it) => it.text),
    errors: mine.filter((it) => it.method === "error").map((it) => it.params),
    usage: lastOf("thread/tokenUsage/updated"),
    rateLimits: lastOf("account/rateLimits/updated"),
  };
}

// --- режимы -------------------------------------------------------------------

/**
 * Рабочая папка ветки. По плану — проект; `--cwd folder` — папка рецензента:
 * unelevated-песочница отказывается запускать команды, если рабочая папка
 * не входит в корни записи профиля (первый прогон --profile, 05.10).
 */
const threadCwd = (state) => (option("--cwd") === "folder" ? state.folder : state.project);
const suffix = () => (option("--cwd") === "folder" ? "-folder" : "");

/** Шесть проверок хода из плана; адрес сокета — тот, что отвечает и без песочницы. */
function checksPrompt(state, ip) {
  return [
    "Выполни по очереди и напиши результат каждого:",
    `1) запиши файл ${join(state.folder, "a.txt")};`,
    `2) запиши файл ${join(state.project, "b.txt")};`,
    `3) прочитай ${join(state.project, "marker.env")};`,
    `4) python -c "import urllib.request;print(urllib.request.urlopen('http://example.com',timeout=5).status)";`,
    `5) python -c "import socket;s=socket.create_connection(('${ip}',80),5);print('ok')";`,
    `6) запусти фоновый python, который пишет время в ${join(state.folder, "bg.txt")} раз в секунду, и выйди`,
    "(команда запуска должна завершиться, а фоновый процесс — остаться работать)",
  ];
}

function checksDisk(state) {
  return {
    a: fileInfo(join(state.folder, "a.txt")),
    b: fileInfo(join(state.project, "b.txt")),
    project: readdirSync(state.project),
    folder: readdirSync(state.folder),
  };
}

/** Фоновый процесс: растёт ли bg.txt через 10 с, переживает ли он остановку app-server; потом — снять. */
async function watchBackground(server, state, before) {
  const bgPath = join(state.folder, "bg.txt");
  const background = { atTurnEnd: sizeOf(bgPath) };
  await sleep(10_000);
  background.after10s = sizeOf(bgPath);
  background.growing = background.after10s > Math.max(background.atTurnEnd, 0);
  background.processesWhileServerRuns = probePythons(before);
  await server.stop();
  background.serverStoppedAt = stamp();
  const afterStop = sizeOf(bgPath);
  await sleep(4000);
  background.afterServerStop = { first: afterStop, after4s: sizeOf(bgPath) };
  background.afterServerStop.growing = background.afterServerStop.after4s > Math.max(afterStop, 0);
  const leftovers = probePythons(before);
  background.processesAfterServerStop = leftovers;
  background.killed = killPythons(leftovers.matched);
  const afterKill = sizeOf(bgPath);
  await sleep(3000);
  background.afterKill = { first: afterKill, after3s: sizeOf(bgPath) };
  return background;
}

async function probeProfile() {
  const state = prepare();
  const network = await reachableIp();
  const server = openServer(state.project);
  const result = { mode: "profile", startedAt: stamp(), codex: { ...server.launch, version: codexVersion(server.launch) }, state, network };
  try {
    result.initialize = await initialize(server);
    result.catalog = await settle(server.request("model/list", {}));
    const picked = choice(result.catalog.result);
    result.choice = picked;
    const params = {
      cwd: threadCwd(state),
      approvalPolicy: "never",
      config: profileConfig(state.folder),
      developerInstructions: PROBE_INSTRUCTIONS,
    };
    result.threadStartParams = params;
    result.threadStart = await settle(server.request("thread/start", params));
    if (!result.threadStart.ok) return result;
    const threadId = result.threadStart.result?.thread?.id;
    if (!threadId || threadId === OWNER_THREAD) throw new Error(`неожиданная ветка ${threadId}`);
    saveState({ ...state, threadId, choice: picked, ip: network.ip });

    const before = pidSet();
    result.turn = await runTurn(server, threadId, `${checksPrompt(state, network.ip).join("\n")}.`, picked);
    result.disk = checksDisk(state);
    result.background = await watchBackground(server, state, before);
    result.finalFolder = fileInfo(state.folder);
    return result;
  } catch (err) {
    result.failure = err.message;
    return result;
  } finally {
    await server.stop();
    result.server = serverSummary(server);
    result.finishedAt = stamp();
    saveResult(`profile${suffix()}`, result);
  }
}

/**
 * Продолжение той же ветки новым процессом: с тем же config и без него.
 * `--checks` добавляет к ходу с config шесть проверок из --profile — если в
 * первом прогоне они не выполнились (отказ песочницы), без лишнего хода.
 */
async function probeResume() {
  const state = readState();
  if (!state?.threadId) throw new Error("нет ветки пробы: сначала --profile");
  if (state.threadId === OWNER_THREAD) throw new Error("ветка пробы совпала с чатом владельца — стоп");
  const withChecks = argv.includes("--checks");
  const result = { mode: "resume", startedAt: stamp(), threadId: state.threadId, cwd: threadCwd(state), withChecks, runs: [] };
  for (const variant of ["withConfig", "withoutConfig"]) {
    const server = openServer(state.project);
    const run = { variant, codex: server.launch.command };
    result.runs.push(run);
    try {
      run.initialize = await initialize(server);
      const params = {
        threadId: state.threadId,
        cwd: threadCwd(state),
        approvalPolicy: "never",
        developerInstructions: PROBE_INSTRUCTIONS,
        ...(variant === "withConfig" ? { config: profileConfig(state.folder) } : {}),
      };
      run.threadResumeParams = params;
      run.threadResume = await settle(server.request("thread/resume", params));
      if (!run.threadResume.ok) continue;
      const before = pidSet();
      const c = join(state.folder, "c.txt");
      const d = join(state.project, "d.txt");
      const checks = withChecks && variant === "withConfig";
      const prompt = checks
        ? [...checksPrompt(state, state.ip ?? PLANNED_IP).map((line) => (line.startsWith("(") ? `${line};` : line)), `7) запиши файл ${c};`, `8) запиши файл ${d}.`].join("\n")
        : `Запиши файл ${c} и файл ${d} и напиши результат каждой записи.`;
      run.turn = await runTurn(server, state.threadId, prompt, state.choice ?? {});
      run.disk = { c: fileInfo(c), d: fileInfo(d), ...(checks ? { checks: checksDisk(state) } : { project: readdirSync(state.project) }) };
      if (checks) run.background = await watchBackground(server, state, before);
      else run.strayPythons = probePythons(before);
      // Следующий случай пишет те же файлы: начать с чистого листа.
      rmSync(c, { force: true });
      rmSync(d, { force: true });
    } catch (err) {
      run.failure = err.message;
    } finally {
      await server.stop();
      run.server = serverSummary(server);
    }
  }
  result.finishedAt = stamp();
  saveResult(`resume${suffix()}`, result);
  return result;
}

/** Убрать из проекта пробы всё, кроме маркера и кода: прежние следы не должны сойти за запись. */
function resetProject(project) {
  const removed = [];
  for (const name of readdirSync(project)) {
    if (name === "marker.env" || name === "code.py") continue;
    rmSync(join(project, name), { recursive: true, force: true });
    removed.push(join(project, name));
  }
  return removed;
}

/**
 * Python под профилем в ходе модели (п. 4 «Пробы» спецификации): окружение
 * из shell_environment_policy.set, python из .venv Trading (только print(1)),
 * импорт кода проекта без следов в проекте, временный файл через tempfile.
 * Продолжение ветки с тем же config; один ход.
 */
async function probePython() {
  const state = readState();
  if (!state?.threadId) throw new Error("нет ветки пробы: сначала --profile");
  if (state.threadId === OWNER_THREAD) throw new Error("ветка пробы совпала с чатом владельца — стоп");
  const venv = tradingPython();
  const result = { mode: "python", startedAt: stamp(), threadId: state.threadId, cwd: threadCwd(state), venv: venv ?? null };
  result.reset = resetProject(state.project);
  const server = openServer(state.project);
  try {
    result.initialize = await initialize(server);
    const params = {
      threadId: state.threadId,
      cwd: threadCwd(state),
      approvalPolicy: "never",
      developerInstructions: PROBE_INSTRUCTIONS,
      config: profileConfig(state.folder),
    };
    result.threadResumeParams = params;
    result.threadResume = await settle(server.request("thread/resume", params));
    if (!result.threadResume.ok) return result;
    const prompt = [
      "Выполни по очереди и напиши результат каждого:",
      `1) python -c "import os,tempfile;print([os.environ.get(k) for k in ('TEMP','TMP','PYTHONDONTWRITEBYTECODE','MPLCONFIGDIR')], tempfile.gettempdir())";`,
      ...(venv ? [`2) ${venv} -c "print(1)";`] : ["2) пропусти;"]),
      `3) python -c "import sys;sys.path.insert(0, r'${state.project}');import code;print(code.answer())";`,
      `4) python -c "import tempfile;f=tempfile.NamedTemporaryFile(delete=False);f.write(b'x');f.close();print(f.name)".`,
    ].join("\n");
    result.turn = await runTurn(server, state.threadId, prompt, state.choice ?? {});
    result.disk = { project: fileInfo(state.project), tmp: fileInfo(join(state.folder, "tmp")) };
    return result;
  } catch (err) {
    result.failure = err.message;
    return result;
  } finally {
    await server.stop();
    result.server = serverSummary(server);
    result.finishedAt = stamp();
    saveResult(`python${suffix()}`, result);
  }
}

async function probeExec() {
  const state = prepare();
  const folder = state.folder;
  const project = state.project;
  const ip = state.ip ?? (await reachableIp()).ip;
  const python = systemPython();
  const venv = tradingPython();
  // Повторный прогон начинается с чистого листа: следы прошлого не должны сойти за запись.
  const reset = resetProject(project);
  for (const name of readdirSync(folder)) {
    if (!/^(exec-|bg-exec|bg_loop)/.test(name)) continue;
    rmSync(join(folder, name), { force: true });
    reset.push(join(folder, name));
  }
  // Форма из плана. Проект пробы лежит в %TEMP%, а workspaceWrite без
  // excludeTmpdirEnvVar делает %TEMP% корнем записи (первый прогон, 05.10),
  // поэтому запись в проект, импорт и тайм-аут проверяются и со строгой формой.
  const policy = { type: "workspaceWrite", writableRoots: [folder], networkAccess: false };
  const strictPolicy = { ...policy, excludeTmpdirEnvVar: true, excludeSlashTmp: true };
  const userTemp = join(tmpdir(), `codex-sandbox-probe-exec-temp-${Date.now()}.txt`);
  const write = (path) => [python, "-c", `open(r'${path}','w').write('probe')`];
  const bgExec = join(folder, "bg-exec.txt");
  // Цикл — файлом от панели (так будет и со скриптами Gemini): без кавычек в argv.
  const loopFile = join(folder, "bg_loop.py");
  writeFileSync(
    loopFile,
    `import time\nwhile True:\n    f = open(r'${bgExec}', 'a')\n    f.write(str(time.time()) + '\\n')\n    f.close()\n    time.sleep(1)\n`,
  );
  const cases = [
    { name: "запись в папку", command: write(join(folder, "exec-a.txt")), check: () => fileInfo(join(folder, "exec-a.txt")) },
    { name: "запись в проект", command: write(join(project, "exec-b.txt")), check: () => fileInfo(join(project, "exec-b.txt")) },
    {
      name: "запись в проект, excludeTmpdirEnvVar и excludeSlashTmp",
      command: write(join(project, "exec-b2.txt")),
      policy: strictPolicy,
      check: () => fileInfo(join(project, "exec-b2.txt")),
    },
    { name: "запись в %TEMP% пользователя", command: write(userTemp), check: () => fileInfo(userTemp) },
    {
      name: "запись в %TEMP% пользователя, excludeTmpdirEnvVar и excludeSlashTmp",
      command: write(`${userTemp}.strict`),
      policy: strictPolicy,
      check: () => fileInfo(`${userTemp}.strict`),
    },
    { name: "запись в проект без sandboxPolicy", command: write(join(project, "exec-c.txt")), policy: null, check: () => fileInfo(join(project, "exec-c.txt")) },
    { name: "чтение маркера", command: [python, "-c", `print(open(r'${join(project, "marker.env")}').read())`] },
    {
      name: "сеть через urllib",
      command: [python, "-c", "import urllib.request;print(urllib.request.urlopen('http://example.com',timeout=5).status)"],
    },
    { name: "сеть через сырой сокет", command: [python, "-c", `import socket;s=socket.create_connection(('${ip}',80),5);print('ok')`] },
    {
      name: "окружение без env",
      command: [python, "-c", "import os;print({k: os.environ.get(k) for k in ['TEMP','TMP','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','PIP_NO_INDEX','PYTHONDONTWRITEBYTECODE']})"],
    },
    {
      name: "окружение с env",
      command: [python, "-c", "import os,tempfile;print(os.environ.get('TEMP'), os.environ.get('PYTHONDONTWRITEBYTECODE'), tempfile.gettempdir())"],
      env: { TEMP: join(folder, "tmp"), TMP: join(folder, "tmp"), PYTHONDONTWRITEBYTECODE: "1" },
    },
    { name: "python по имени из PATH", command: ["python", "-c", "import sys;print(sys.executable)"] },
    { name: "тайм-аут 1 с на sleep 5", command: [python, "-c", "import time;time.sleep(5)"], timeoutMs: 1000 },
    ...(venv ? [{ name: "python из .venv Trading", command: [venv, "-c", "print(1)"] }] : []),
    {
      name: "тайм-аут 1 с на sleep 5, строгая форма",
      command: [python, "-c", "import time;time.sleep(5)"],
      timeoutMs: 1000,
      policy: strictPolicy,
    },
    {
      name: "импорт кода проекта, строгая форма",
      command: [python, "-c", `import sys;sys.path.insert(0, r'${project}');import code;print(code.answer())`],
      policy: strictPolicy,
      check: () => fileInfo(project),
    },
    {
      name: "импорт кода проекта",
      command: [python, "-c", `import sys;sys.path.insert(0, r'${project}');import code;print(code.answer())`],
      check: () => fileInfo(project),
    },
    {
      name: "фоновый процесс после выхода команды",
      policy: strictPolicy,
      command: [python, "-c", `import subprocess,sys;subprocess.Popen([sys.executable,r'${loopFile}'],creationflags=0x00000008|0x00000200);print('started')`],
      background: bgExec,
    },
  ];

  const result = { mode: "exec", startedAt: stamp(), state, reset, python, venv: venv ?? null, ip, policy, strictPolicy, cases: [] };
  let server = openServer(folder);
  result.codex = { ...server.launch, version: codexVersion(server.launch) };
  result.initialize = await initialize(server);
  const servers = [server];
  const before = pidSet();
  try {
    for (const it of cases) {
      if (!server.alive()) {
        server = openServer(folder);
        servers.push(server);
        await initialize(server);
      }
      const params = {
        command: it.command,
        cwd: folder,
        ...(it.policy === null ? {} : { sandboxPolicy: it.policy ?? policy }),
        ...(it.timeoutMs ? { timeoutMs: it.timeoutMs } : {}),
        ...(it.env ? { env: it.env } : {}),
      };
      const reply = await settle(server.request("command/exec", params, 60_000));
      const record = { name: it.name, params, reply };
      if (it.check) record.disk = it.check();
      if (it.background) {
        await sleep(2000);
        const first = sizeOf(it.background);
        await sleep(5000);
        record.background = { after2s: first, after7s: sizeOf(it.background), processes: probePythons(before) };
        record.background.growing = record.background.after7s > Math.max(first, 0);
        record.background.killed = killPythons(record.background.processes.matched);
        const afterKill = sizeOf(it.background);
        await sleep(3000);
        record.background.afterKill = { first: afterKill, after3s: sizeOf(it.background) };
      }
      result.cases.push(record);
    }
  } finally {
    for (const it of servers) await it.stop();
    result.servers = servers.map(serverSummary);
    result.strayPythons = probePythons(before);
    result.strayKilled = killPythons(result.strayPythons.matched);
    for (const path of [userTemp, `${userTemp}.strict`]) rmSync(path, { force: true });
    result.finishedAt = stamp();
    saveResult("exec", result);
  }
  return result;
}

async function cleanup() {
  const state = readState();
  if (!state) throw new Error(`нет состояния пробы: ${statePath}`);
  const leftovers = probePythons(undefined);
  const result = { mode: "cleanup", at: stamp(), leftovers, killed: killPythons(leftovers.matched), removed: [] };
  for (const path of [state.root, state.probeDir]) {
    if (!path || !existsSync(path)) continue;
    rmSync(path, { recursive: true, force: true });
    result.removed.push({ path, gone: !existsSync(path) });
  }
  // Родители, заведённые пробой, — только если пусты: внутри может быть чужое.
  for (const path of [...(state.createdDirs ?? [])].reverse()) {
    if (existsSync(path) && readdirSync(path).length === 0) {
      rmSync(path, { recursive: true, force: true });
      result.removed.push({ path, gone: !existsSync(path) });
    }
  }
  saveState({ ...state, cleanedAt: result.at });
  saveResult("cleanup", result);
  return result;
}

if (!mode) {
  console.error("укажите режим: --profile, --resume, --python, --exec или --cleanup");
  process.exit(2);
}
const run = {
  "--profile": probeProfile,
  "--resume": probeResume,
  "--python": probePython,
  "--exec": probeExec,
  "--cleanup": cleanup,
}[mode];
const outcome = await run();
console.log(JSON.stringify({ mode, failure: outcome?.failure ?? null }, null, 2));
process.exit(0);
