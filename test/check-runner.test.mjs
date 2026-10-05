/**
 * Исполнитель скриптов Gemini (спецификация 05.10, ступень 3): короткий
 * процесс `codex app-server`, команда command/exec в песочнице Codex.
 *
 * Формы ответов — по пробе 05.10 (docs/research/2026-10-05-проба-песочницы-codex.md,
 * решения (в) и (г)): выполненная команда — ответ {exitCode, stdout, stderr};
 * отказ песочницы — ошибка JSON-RPC «sandbox denied exec error, exit code: N,
 * stdout: …, stderr: …»; превышение срока — ошибка «command timed out» без
 * вывода. Политика — только строгая форма: без excludeTmpdirEnvVar корнем
 * записи становится %TEMP% пользователя. Здесь — на фальшивом Codex.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CHECK_OUTPUT_LIMIT, pythonFor, runCheck, sweepFolderProcesses } from "../out/checkRunner.js";

const FAKE_CODEX = fileURLToPath(new URL("../fixtures/fake-codex.mjs", import.meta.url));

/** Папка проверок Gemini — ещё не созданная: исполнитель создаёт её сам. */
const freshFolder = () => join(mkdtempSync(join(tmpdir(), "review-")), "gemini");

const options = (folder, extra = {}) => ({
  command: "node",
  commandArgs: [FAKE_CODEX],
  folder,
  python: "python",
  name: "проверка 1",
  code: "print(1)",
  timeoutMs: 5000,
  sweep: false,
  ...extra,
});

const scripts = (folder) => readdirSync(folder).filter((name) => name.endsWith(".py"));

test("скрипт пишется файлом .py в папку проверок и выполняется через command/exec: вывод, код выхода, команда", async () => {
  const folder = freshFolder();
  const code = "# имя: просадка на отрезке [-0.2, 0]\nprint(-0.2)";
  const result = await runCheck(options(folder, { name: "просадка на отрезке [-0.2, 0]", code }));
  const [file] = scripts(folder);
  assert.match(file, /просадка-на-отрезке-0-2-0\.py$/, "имя файла — из имени проверки, без знаков вне имени");
  assert.equal(readFileSync(join(folder, file), "utf8"), `${code}\n`);
  assert.ok(existsSync(join(folder, "tmp")), "tmp\\ — TEMP скрипта, создана вместе с папкой");
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.output, `выполнено ${file}\n`);
  assert.equal(result.file, join(folder, file));
  assert.equal(result.command, `python ${join(folder, file)}`);
});

test("command/exec: python и файл, рабочая папка — папка проверок, строгая политика, срок, TEMP и UTF-8 скрипта — в папке", async () => {
  const folder = freshFolder();
  const result = await runCheck(options(folder, { python: "C:\\p\\.venv\\Scripts\\python.exe", code: "ПОКАЖИ-ПАРАМЕТРЫ", timeoutMs: 7000 }));
  const params = JSON.parse(result.output);
  const [file] = scripts(folder);
  assert.deepEqual(params.command, ["C:\\p\\.venv\\Scripts\\python.exe", join(folder, file)]);
  assert.equal(params.cwd, folder);
  assert.deepEqual(params.sandboxPolicy, {
    type: "workspaceWrite",
    writableRoots: [folder],
    networkAccess: false,
    excludeTmpdirEnvVar: true,
    excludeSlashTmp: true,
  });
  assert.equal(params.timeoutMs, 7000);
  const tmp = join(folder, "tmp");
  assert.deepEqual(params.env, {
    TEMP: tmp,
    TMP: tmp,
    PYTHONDONTWRITEBYTECODE: "1",
    MPLCONFIGDIR: join(tmp, "mpl"),
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
  });
});

test("превышено время — ошибка «command timed out» без вывода: timedOut, вывода нет", async () => {
  const folder = freshFolder();
  const started = Date.now();
  const result = await runCheck(options(folder, { code: "import time\ntime.sleep(600)  # ДОЛГО", timeoutMs: 300 }));
  assert.equal(result.timedOut, true);
  assert.equal(result.output, "");
  assert.ok(Date.now() - started < 5000, "ответ — по сроку, не позже");
});

test("отказ песочницы — ошибка JSON-RPC с кодом и выводом: они разобраны из текста ошибки", async () => {
  const folder = freshFolder();
  const result = await runCheck(options(folder, { code: "open('C:/p/x.txt', 'w')  # ЗАПИСЬ-В-ПРОЕКТ" }));
  assert.equal(result.timedOut, false);
  assert.equal(result.exitCode, 1);
  assert.match(result.output, /^\[песочница отказала скрипту в действии\]\n/);
  assert.match(result.output, /начал запись/);
  assert.match(result.output, /PermissionError: \[Errno 13\] Permission denied/);
});

test("скрипт упал — его код выхода и stderr в выводе", async () => {
  const folder = freshFolder();
  const result = await runCheck(options(folder, { code: "raise KeyError('date')  # ОШИБКА-СКРИПТА" }));
  assert.equal(result.exitCode, 1);
  assert.match(result.output, /Traceback/);
});

test("вывод обрезается до 20 000 знаков: начало и конец с пометкой пропуска", async () => {
  const folder = freshFolder();
  const result = await runCheck(options(folder, { code: "print('a' * 30000)  # ДЛИННЫЙ-ВЫВОД" }));
  assert.equal(CHECK_OUTPUT_LIMIT, 20_000);
  assert.ok(result.output.length <= 20_000, `вывод ${result.output.length} знаков`);
  assert.ok(result.output.length > 19_000, "предел использован");
  assert.ok(result.output.startsWith("aaa"));
  assert.ok(result.output.trimEnd().endsWith("конец"));
  assert.match(result.output, /\[… пропущено знаков вывода: [\d ]+ …\]/);
});

test("два скрипта с одним именем — два файла: прежний не перезаписывается", async () => {
  const folder = freshFolder();
  await runCheck(options(folder, { name: "утечка", code: "print('первый')" }));
  await runCheck(options(folder, { name: "утечка", code: "print('второй')" }));
  const files = scripts(folder);
  assert.equal(files.length, 2);
  assert.deepEqual(files.map((f) => readFileSync(join(folder, f), "utf8")).sort(), ["print('второй')\n", "print('первый')\n"]);
});

test("самопроверка с проектом: запись в папку проходит, в проект — отклонена, затем скрипт", async () => {
  const folder = freshFolder();
  const project = mkdtempSync(join(tmpdir(), "project-"));
  const result = await runCheck(options(folder, { project }));
  assert.equal(result.exitCode, 0);
  assert.equal(existsSync(join(folder, "probe.txt")), false, "файл самопроверки убран");
  assert.deepEqual(readdirSync(project), [], "в проекте ничего не осталось");
});

test("самопроверка не прошла (запись в проект прошла) — скрипт не выполняется, исключение с причиной", async () => {
  const folder = freshFolder();
  const project = mkdtempSync(join(tmpdir(), "project-"));
  await assert.rejects(
    runCheck(options(folder, { project, commandArgs: [FAKE_CODEX, "--exec-broken"] })),
    /самопроверка песочницы не прошла: запись в проект прошла/,
  );
  assert.deepEqual(readdirSync(project), [], "файл, записанный в проект, удалён");
});

test("Codex не запустился — исключение, а не зависание", async () => {
  const folder = freshFolder();
  await assert.rejects(runCheck(options(folder, { commandArgs: [join(tmpdir(), "нет-такого-codex.mjs")] })), /Codex/);
});

test("отмена: процесс снимается, результат — исключение, без ожидания срока", async () => {
  const folder = freshFolder();
  const abort = new AbortController();
  const started = Date.now();
  const running = runCheck(options(folder, { code: "# ДОЛГО", timeoutMs: 30_000, signal: abort.signal }));
  setTimeout(() => abort.abort(), 300);
  await assert.rejects(running, /отменена/);
  assert.ok(Date.now() - started < 10_000);
});

test("python проекта — из .venv, если он есть, иначе по имени", () => {
  const project = mkdtempSync(join(tmpdir(), "project-"));
  assert.equal(pythonFor(project), "python");
  const venv = join(project, ".venv", "Scripts");
  mkdirSync(venv, { recursive: true });
  writeFileSync(join(venv, "python.exe"), "");
  assert.equal(pythonFor(project), join(venv, "python.exe"));
});

test(
  "после скрипта снимаются процессы интерпретатора, начатые не раньше скрипта, в командной строке которых — папка проверок (проба 05.10)",
  { skip: process.platform !== "win32" && "только Windows" },
  async () => {
    // Фоновые процессы скрипта переживают app-server (проба 05.10). Но
    // редактор, в котором владелец открыл скрипт из папки до запуска, и
    // программа не-Python с тем же путём — не процессы скрипта (итоговая
    // рецензия 05.10). Интерпретатор здесь — node: python в тестах не нужен.
    const folder = freshFolder();
    mkdirSync(folder, { recursive: true });
    const loop = ["-e", "setInterval(() => {}, 1000)"];
    const editor = spawn(process.execPath, [...loop, join(folder, "открыт-в-редакторе.py")], { stdio: "ignore", windowsHide: true });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const since = Date.now();
    const stray = spawn(process.execPath, [...loop, join(folder, "bg_loop.py")], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    const exited = new Promise((resolve) => stray.once("exit", resolve));
    const other = spawn(process.execPath, [...loop, join(folder + "-другая", "x.py")], {
      stdio: "ignore",
      windowsHide: true,
    });
    try {
      const notPython = await sweepFolderProcesses(folder, { since, interpreter: "C:\\нет\\python.exe" });
      assert.deepEqual(notPython.filter((pid) => [stray.pid, editor.pid, other.pid].includes(pid)), [], "node — не Python скрипта: никто не снят");
      const killed = await sweepFolderProcesses(folder, { since, interpreter: process.execPath });
      assert.ok(killed.includes(stray.pid), `снят: ${killed.join(", ")}`);
      assert.ok(!killed.includes(editor.pid), "процесс, начатый до скрипта, не тронут");
      assert.ok(!killed.includes(other.pid), "процесс с похожей папкой не тронут");
      assert.ok(!killed.includes(process.pid));
      await exited;
      assert.equal(other.exitCode, null, "другой процесс жив");
      assert.equal(editor.exitCode, null, "редактор жив");
    } finally {
      other.kill();
      editor.kill();
      try {
        stray.kill();
      } catch {
        // уже снят
      }
    }
    assert.equal(basename(folder), "gemini");
  },
);
