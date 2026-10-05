/**
 * Исполнитель скриптов Gemini (спецификация 05.10, ступень 3).
 *
 * Gemini команд не запускает (правило deny agy), а утверждение, которое
 * проверяется вычислением, подкрепляет блоком «проверка» (checkBlocks.ts).
 * Скрипт выполняет панель — отдельным коротким процессом `codex app-server`
 * (как listModels у Codex), командой command/exec в песочнице Codex, без хода
 * модели. Решения пробы 05.10 (docs/research/2026-10-05-проба-песочницы-codex.md):
 *   * (в) политика — только строгая форма (execPolicy в codex.ts): без
 *     excludeTmpdirEnvVar корнем записи становится %TEMP% пользователя;
 *     передаётся всегда — без неё действует config.toml владельца; TEMP и TMP
 *     скрипта — в папке, полем env (shell_environment_policy к command/exec
 *     отношения не имеет);
 *   * исходов три: ответ {exitCode, stdout, stderr}; ошибка JSON-RPC «sandbox
 *     denied exec error, exit code: N, stdout: …, stderr: …» (код и вывод — из
 *     текста ошибки); ошибка «command timed out»;
 *   * (г) превышение срока — ошибка ровно по сроку, без кода и вывода:
 *     панель пишет «превышено время» и вывода не ждёт;
 *   * фоновые процессы скрипта переживают и команду, и остановку app-server:
 *     после скрипта панель снимает процессы Python, начатые не раньше
 *     скрипта, в командной строке которых есть путь папки проверок. Процесс
 *     без этого пути так не найти — остаточный риск.
 * Перед скриптом — та же самопроверка, что у Codex (codex.ts): запись в папку
 * проходит, в проект — отклонена. Не прошла — исключение: скрипт не
 * выполняется, Gemini получает «проверки недоступны».
 */
import { execFile } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execPolicy } from "./adapters/codex.js";
import { readJsonLines } from "./adapters/jsonLines.js";
import { killTree, spawnProcess } from "./adapters/process.js";
import { ensureReviewFolder } from "./reviewFolder.js";

/** Вывод одного скрипта — не длиннее, начало и конец (спецификация 05.10). */
export const CHECK_OUTPUT_LIMIT = 20_000;
/** Срок ответа app-server на initialize. */
const START_MS = 30_000;
/** Срок одной команды самопроверки: первая команда под песочницей ставит права на папку. */
const SELF_CHECK_MS = 30_000;
/** Сверх срока скрипта: app-server отвечает ошибкой ровно по сроку, это запас на ответ. */
const REPLY_MARGIN_MS = 15_000;
/** Срок поиска и снятия оставшихся процессов. */
const SWEEP_MS = 20_000;
/** Файл самопроверки в проекте — свой, не тот, что у Codex: их проверки могут идти одновременно. */
const PROJECT_PROBE = ".agent-panel-probe-gemini";
/** Запись в путь из argv: путь не попадает в код, кавычки и пробелы в нём не мешают. */
const WRITE_CODE = "import sys; open(sys.argv[1], 'w').write('agent-panel')";
const DENIED_NOTE = "[песочница отказала скрипту в действии]";

export interface CheckResult {
  /** Код выхода скрипта; при превышении времени кода нет — -1. */
  readonly exitCode: number;
  /** stdout и stderr, не длиннее CHECK_OUTPUT_LIMIT. */
  readonly output: string;
  readonly timedOut: boolean;
  /** Файл скрипта в папке проверок. */
  readonly file?: string;
  /** Чем он выполнен — для свидетельства Claude: python и файл. */
  readonly command?: string;
}

export interface CheckRun {
  /** Codex: команда и аргументы запуска, как у адаптера. */
  readonly command: string;
  readonly commandArgs?: readonly string[];
  readonly shell?: boolean;
  /** Папка проверок Gemini (reviewFolder.ts): рабочая папка скрипта и единственный корень записи. */
  readonly folder: string;
  /** Python проекта (pythonFor). */
  readonly python: string;
  readonly name: string;
  readonly code: string;
  /** Срок скрипта (agentPanel.reviewerCheckSeconds). */
  readonly timeoutMs: number;
  /** Папка проекта: самопроверка — запись в неё должна быть отклонена. Нет — без самопроверки. */
  readonly project?: string;
  /** Отмена («Остановить», новая задача): процесс снимается, результат — исключение. */
  readonly signal?: AbortSignal;
  /** Снимать после скрипта процессы с папкой в командной строке; по умолчанию — да. */
  readonly sweep?: boolean;
}

/** Python проекта: из .venv, если он есть, иначе по имени из PATH (спецификация 05.10). */
export function pythonFor(project: string): string {
  for (const candidate of [join(project, ".venv", "Scripts", "python.exe"), join(project, ".venv", "bin", "python")]) {
    if (existsSync(candidate)) return candidate;
  }
  return "python";
}

/** Отказ JSON-RPC: у command/exec так приходят и отказ песочницы, и превышение срока. */
class RpcError extends Error {}
/** app-server не ответил в срок. */
class Overdue extends Error {}

const cancelled = (): Error => new Error("проверка отменена");

interface Waiter {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

interface Server {
  request(method: string, params: unknown, limitMs: number): Promise<unknown>;
  notify(method: string, params: unknown): void;
  close(): Promise<void>;
}

/** Короткий процесс app-server с запросами по номеру; выход процесса и отмена отклоняют ожидания. */
function openServer(run: CheckRun): Server {
  const proc = spawnProcess(run.command, [...(run.commandArgs ?? []), "app-server"], run.folder, run.shell);
  proc.stderr.resume();
  proc.stdin.on("error", () => undefined);
  const waiters = new Map<number, Waiter>();
  let next = 1;
  let ended: Error | undefined;
  const fail = (err: Error): void => {
    if (ended) return;
    ended = err;
    for (const [, waiter] of waiters) waiter.reject(err);
    waiters.clear();
  };
  proc.on("error", (err) => fail(new Error(`Codex не запустился: ${err.message}`)));
  proc.on("exit", (code) => fail(new Error(`Codex завершился, не выполнив проверку (код ${code})`)));
  const onAbort = (): void => fail(cancelled());
  run.signal?.addEventListener("abort", onAbort, { once: true });
  const lines = readJsonLines(proc.stdout, (line) => {
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (typeof record["id"] !== "number" || "method" in record) return;
    const waiter = waiters.get(record["id"]);
    waiters.delete(record["id"]);
    if (!waiter) return;
    const error = record["error"] as { message?: unknown } | undefined;
    if (error) waiter.reject(new RpcError(String(error.message ?? "ошибка Codex")));
    else waiter.resolve(record["result"]);
  });
  const write = (record: unknown): void => {
    proc.stdin.write(`${JSON.stringify(record)}\n`);
  };
  return {
    request(method, params, limitMs) {
      if (ended) return Promise.reject(ended);
      return new Promise((resolve, reject) => {
        const id = next++;
        const timer = setTimeout(() => {
          waiters.delete(id);
          reject(new Overdue(`Codex не ответил на ${method} за ${Math.round(limitMs / 1000)} с`));
        }, limitMs);
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
    },
    notify(method, params) {
      if (!ended) write({ jsonrpc: "2.0", method, params });
    },
    async close() {
      run.signal?.removeEventListener("abort", onAbort);
      fail(new Error("процесс Codex проверки остановлен"));
      lines.close();
      await killTree(proc);
    },
  };
}

/** Окружение скрипта: TEMP, TMP, MPLCONFIGDIR — в папке, без __pycache__, вывод — UTF-8. */
function scriptEnv(folder: string): Record<string, string> {
  const tmp = join(folder, "tmp");
  return {
    TEMP: tmp,
    TMP: tmp,
    PYTHONDONTWRITEBYTECODE: "1",
    MPLCONFIGDIR: join(tmp, "mpl"),
    // Вывод в канал Python иначе пишет в кодировке системы (cp1251), а Codex читает UTF-8.
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
  };
}

/** Число с пробелами между разрядами: 10 001. */
function groupDigits(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

/** Начало и конец вывода в пределе вместе с пометкой пропуска. */
export function clipOutput(text: string, limit: number = CHECK_OUTPUT_LIMIT): string {
  if (text.length <= limit) return text;
  let room = limit;
  let note = "";
  for (let i = 0; i < 3; i += 1) {
    note = `\n[… пропущено знаков вывода: ${groupDigits(text.length - room)} …]\n`;
    room = Math.max(0, limit - note.length);
  }
  const head = Math.ceil(room / 2);
  return `${text.slice(0, head)}${note}${text.slice(text.length - (room - head))}`;
}

/** stdout и stderr одним выводом, строки — через \n. */
function joinOutput(stdout: unknown, stderr: unknown): string {
  const out = String(stdout ?? "").replace(/\r\n/g, "\n");
  const err = String(stderr ?? "").replace(/\r\n/g, "\n");
  if (!out || !err) return out + err;
  return out.endsWith("\n") ? out + err : `${out}\n${err}`;
}

/**
 * Ошибка command/exec словами пробы 05.10: превышение срока или отказ
 * песочницы с кодом и выводом из текста. Другая — undefined: исполнитель
 * недоступен.
 */
function fromError(message: string): Omit<CheckResult, "file" | "command"> | undefined {
  if (/command timed out/i.test(message)) return { exitCode: -1, output: "", timedOut: true };
  const denied = /sandbox denied exec error, exit code: (-?\d+), stdout: /i.exec(message);
  if (!denied) return undefined;
  const rest = message.slice(denied.index + denied[0].length);
  const cut = rest.lastIndexOf(", stderr: ");
  const stdout = cut >= 0 ? rest.slice(0, cut) : rest;
  const stderr = cut >= 0 ? rest.slice(cut + ", stderr: ".length) : "";
  return { exitCode: Number(denied[1]), output: clipOutput(`${DENIED_NOTE}\n${joinOutput(stdout, stderr)}`), timedOut: false };
}

/** Файл скрипта: время и имя проверки (буквы и цифры); такой уже есть — с номером. */
function scriptFile(folder: string, name: string, now: Date = new Date()): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^\p{L}\p{N}_]+/gu, "-")
      .replace(/^-+/, "")
      .slice(0, 60)
      .replace(/-+$/, "") || "проверка";
  const two = (n: number): string => String(n).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-` +
    `${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
  let file = join(folder, `${stamp}-${slug}.py`);
  for (let n = 2; existsSync(file); n += 1) file = join(folder, `${stamp}-${slug}-${n}.py`);
  return file;
}

/** Команда строкой для свидетельства: части с пробелами — в кавычках. */
function commandLine(parts: readonly string[]): string {
  return parts.map((part) => (/\s/.test(part) ? `"${part}"` : part)).join(" ");
}

/**
 * Самопроверка песочницы (как у Codex, codex.ts): запись в папку проверок
 * должна пройти, в проект — быть отклонена, файла быть не должно. Не так —
 * исключение с причиной; скрипт тогда не выполняется.
 */
async function selfCheck(server: Server, run: CheckRun, project: string): Promise<void> {
  const write = async (target: string): Promise<{ reply?: Record<string, unknown>; error?: string }> => {
    const params = {
      command: [run.python, "-c", WRITE_CODE, target],
      cwd: run.folder,
      sandboxPolicy: execPolicy(run.folder),
      timeoutMs: SELF_CHECK_MS,
      env: scriptEnv(run.folder),
    };
    try {
      return { reply: ((await server.request("command/exec", params, SELF_CHECK_MS + REPLY_MARGIN_MS)) ?? {}) as Record<string, unknown> };
    } catch (err) {
      if (err instanceof RpcError) return { error: err.message };
      throw err;
    }
  };
  const failed = (what: string): Error => new Error(`самопроверка песочницы не прошла: ${what}`);

  const inFolder = join(run.folder, "probe.txt");
  rmSync(inFolder, { force: true });
  const first = await write(inFolder);
  const written = existsSync(inFolder);
  rmSync(inFolder, { force: true });
  if (first.reply?.["exitCode"] !== 0 || !written) {
    throw failed(`запись в папку проверок не прошла (${first.error ?? `код ${String(first.reply?.["exitCode"])}`})`);
  }
  // Файл с этим именем — только наш: прежний остаток иначе сошёл бы за прорыв.
  const inProject = join(project, PROJECT_PROBE);
  rmSync(inProject, { force: true });
  const second = await write(inProject);
  if (existsSync(inProject)) {
    rmSync(inProject, { force: true });
    throw failed("запись в проект прошла");
  }
  if (second.error !== undefined && !/sandbox denied/i.test(second.error)) throw failed(`запись в проект не проверена (${second.error})`);
  if (second.error === undefined && second.reply?.["exitCode"] === 0) throw failed("запись в проект прошла");
}

/**
 * Выполнить один скрипт Gemini: файл — в папку проверок, затем app-server,
 * initialize, самопроверка (если дан проект), command/exec. Процесс
 * снимается в любом случае, затем — оставшиеся процессы скрипта. Исключение —
 * исполнитель недоступен (не запустился, самопроверка, отмена).
 */
export async function runCheck(run: CheckRun): Promise<CheckResult> {
  if (run.signal?.aborted) throw cancelled();
  // Секунда запаса: время создания процесса и Date.now() — разные часы.
  const since = Date.now() - 1000;
  ensureReviewFolder(run.folder);
  const file = scriptFile(run.folder, run.name);
  writeFileSync(file, run.code.endsWith("\n") ? run.code : `${run.code}\n`, "utf8");
  const command = [run.python, file];
  const shown = { file, command: commandLine(command) };
  const server = openServer(run);
  try {
    await server.request("initialize", { clientInfo: { name: "agent-panel", version: "0.1.0" }, capabilities: {} }, START_MS);
    server.notify("initialized", {});
    if (run.project !== undefined) await selfCheck(server, run, run.project);
    const params = {
      command,
      cwd: run.folder,
      sandboxPolicy: execPolicy(run.folder),
      timeoutMs: run.timeoutMs,
      env: scriptEnv(run.folder),
    };
    let reply: Record<string, unknown>;
    try {
      reply = ((await server.request("command/exec", params, run.timeoutMs + REPLY_MARGIN_MS)) ?? {}) as Record<string, unknown>;
    } catch (err) {
      // Не ответил и с запасом — для человека это то же превышение времени.
      if (err instanceof Overdue) return { exitCode: -1, output: "", timedOut: true, ...shown };
      const known = err instanceof RpcError ? fromError(err.message) : undefined;
      if (known) return { ...known, ...shown };
      throw err;
    }
    const exitCode = typeof reply["exitCode"] === "number" ? reply["exitCode"] : -1;
    return { exitCode, output: clipOutput(joinOutput(reply["stdout"], reply["stderr"])), timedOut: false, ...shown };
  } finally {
    await server.close();
    if (run.sweep ?? true) await sweepFolderProcesses(run.folder, { since, interpreter: run.python }).catch(() => []);
  }
}

/** Какие процессы с путём папки снимаются после скрипта. */
export interface SweepFilter {
  /** Начатые не раньше, мс epoch: редактор, открытый на скрипте до него, не трогается. */
  readonly since: number;
  /** Python скрипта (pythonFor): кроме python*.exe и py.exe — процесс с этим исполняемым файлом. */
  readonly interpreter?: string;
}

/**
 * Снять процессы скрипта (проба 05.10: фоновый python скрипта жил после
 * ответа command/exec и после остановки app-server; найден по командной
 * строке). Снимаются только процессы Python (python*.exe, py.exe или сам
 * interpreter), начатые не раньше since, в командной строке которых есть путь
 * папки проверок: редактор, в котором владелец открыл скрипт из этой папки,
 * не задевается (итоговая рецензия 05.10). Путь сравнивается с разделителем
 * на конце и без учёта регистра и вида косой черты: папка gemini-другая не
 * задевается. Возвращает снятые номера процессов. Только Windows; сбой
 * поиска — пустой список.
 */
export async function sweepFolderProcesses(folder: string, filter: SweepFilter): Promise<number[]> {
  if (process.platform !== "win32") return [];
  const powershell = join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  // Путь, время и интерпретатор — через переменные окружения: в тексте
  // команды им не нужны кавычки.
  const script =
    "$f = $env:AGENT_PANEL_SWEEP.ToLowerInvariant(); " +
    "$since = [DateTimeOffset]::FromUnixTimeMilliseconds([long]$env:AGENT_PANEL_SWEEP_SINCE).UtcDateTime; " +
    "$exe = ([string]$env:AGENT_PANEL_SWEEP_EXE).ToLowerInvariant(); " +
    "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and " +
    "$_.CommandLine.Replace('/', '\\').ToLowerInvariant().Contains($f) -and " +
    "$_.CreationDate -and $_.CreationDate.ToUniversalTime() -ge $since -and " +
    "($_.Name -match '^(pythonw?[0-9.]*|pyw?)\\.exe$' -or " +
    "($exe -and $_.ExecutablePath -and $_.ExecutablePath.ToLowerInvariant() -eq $exe)) } | ForEach-Object { $_.ProcessId }";
  const marker = `${folder.replace(/\//g, "\\").replace(/\\+$/, "")}\\`;
  const found = await new Promise<string>((resolve) => {
    execFile(
      powershell,
      ["-NoProfile", "-NonInteractive", "-Command", script],
      {
        env: {
          ...process.env,
          AGENT_PANEL_SWEEP: marker,
          AGENT_PANEL_SWEEP_SINCE: String(Math.floor(filter.since)),
          AGENT_PANEL_SWEEP_EXE: filter.interpreter ?? "",
        },
        windowsHide: true,
        timeout: SWEEP_MS,
      },
      (err, stdout) => resolve(err ? "" : String(stdout)),
    );
  });
  const pids = [...new Set(found.split(/\s+/).map(Number))].filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
  for (const pid of pids) {
    await new Promise<void>((resolve) => {
      execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: SWEEP_MS }, () => resolve());
    });
  }
  return pids;
}
