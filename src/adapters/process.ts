/**
 * Запуск и остановка процессов агентов.
 *
 * Зачем отдельный модуль. На Windows агенты запускаются через cmd.exe
 * (shell: true) — иначе не запустить npm-обёртки claude.cmd и codex.cmd. Но
 * тогда `kill()` убивает оболочку, а сам агент и его команды продолжают
 * работать. Рецензент нашёл это чтением кода, тест подтвердил: после
 * «Остановить» агент оставался жив, и следующее сообщение поднимало второго
 * Claude на ту же сессию, пока первый ещё работал.
 *
 * Отсюда правила:
 *   * на Windows останавливается всё дерево: `taskkill /PID … /T /F`;
 *   * на остальных системах процесс запускается в своей группе, и сигнал
 *     уходит всей группе;
 *   * stdin НЕ закрывается до уничтожения дерева: получив конец ввода,
 *     агент может выйти сам раньше, и его дочерние команды осиротеют —
 *     taskkill их уже не найдёт по родителю;
 *   * остановка ждёт подтверждения: и завершения процесса, и завершения
 *     самого taskkill.
 *
 * Проверено на Windows. Ветка для остальных систем написана по документации
 * Node и тестами на этой машине не покрыта.
 *
 * **Команда ищется от папки проекта, даже когда процесс работает в другой**
 * (рецензия цикла 05.10). Процесс app-server с папкой проверок запускается в
 * ней, а Windows ищет голое имя сначала в рабочей папке процесса — cmd.exe
 * среди PATHEXT, запуск без оболочки (libuv) среди .com и .exe, — и
 * относительный путь — только от неё. Папка проверок открыта рецензенту на
 * запись: его codex.bat запустился бы без песочницы с правами пользователя.
 * Переменная NoDefaultCurrentDirectoryInExePath помогла бы только cmd.exe:
 * libuv смотрит её в окружении самой панели, то есть хоста расширений VS Code.
 */
import { existsSync, statSync } from "node:fs";
import { extname, isAbsolute, join, resolve } from "node:path";
import { ChildProcessWithoutNullStreams, execFile, spawn } from "node:child_process";

export const STOP_TIMEOUT = 5000;

const WINDOWS = process.platform === "win32";

/** Расширения, которые cmd.exe перебирает, если PATHEXT не задан. */
const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

const isFile = (path: string): boolean => statSync(path, { throwIfNoEntry: false })?.isFile() === true;

const samePath = (a: string, b: string): boolean =>
  WINDOWS ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);

/**
 * Команда так, как её нашла бы ОС при запуске в папке home: относительный
 * путь — от home; голое имя на Windows — в home, затем по PATH (cmd.exe — с
 * расширениями из PATHEXT, без оболочки — .com и .exe), не найдено — путь от
 * home, чтобы рабочая папка процесса не просматривалась. Строка «программа
 * аргументы» — ищется программа, аргументы остаются как есть (относительный
 * путь в аргументах программа разрешит от своей рабочей папки). На других
 * системах голое имя ищется только по PATH и не меняется.
 */
export function locateCommand(
  command: string,
  home: string,
  shell: boolean,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const quoted = /^"([^"]+)"(.*)$/s.exec(command);
  if (quoted) return `"${locateProgram(quoted[1] ?? "", home, shell, env)}"${quoted[2] ?? ""}`;
  if (isAbsolute(command)) return command;
  // Путь с пробелами к существующему файлу — целиком («папка с пробелом\fake codex.cmd»).
  if (/\s/.test(command) && isFile(resolve(home, command))) return resolve(home, command);
  const split = /^(\S+)(\s.*)$/s.exec(command);
  if (split) {
    const program = locateProgram(split[1] ?? "", home, shell, env);
    return `${shell && /\s/.test(program) ? `"${program}"` : program}${split[2] ?? ""}`;
  }
  return locateProgram(command, home, shell, env);
}

function locateProgram(program: string, home: string, shell: boolean, env: NodeJS.ProcessEnv): string {
  if (isAbsolute(program)) return program;
  if (/[\\/]/.test(program)) return resolve(home, program);
  if (!WINDOWS) return program;
  const extensions = extname(program)
    ? [""]
    : shell
      ? (env["PATHEXT"] || DEFAULT_PATHEXT).split(";").filter(Boolean).map((extension) => extension.toLowerCase())
      : [".com", ".exe"];
  const dirs = (env["PATH"] ?? "")
    .split(";")
    .map((dir) => dir.trim().replace(/^"(.*)"$/, "$1"))
    .filter(Boolean)
    .map((dir) => resolve(home, dir));
  for (const dir of [home, ...dirs]) {
    for (const extension of extensions) {
      const candidate = join(dir, program + extension);
      if (isFile(candidate)) return candidate;
    }
  }
  return resolve(home, program);
}

/**
 * Запустить процесс агента в папке cwd. home — папка, от которой ищется
 * команда (по умолчанию cwd): у процесса в папке проверок — проект.
 */
export function spawnProcess(
  command: string,
  args: readonly string[],
  cwd: string,
  shell: boolean = WINDOWS,
  home: string = cwd,
): ChildProcessWithoutNullStreams {
  const program = samePath(home, cwd) ? command : locateCommand(command, home, shell);
  // cmd.exe делит строку по пробелам: путь вроде «C:\Program Files\…» без
  // кавычек стал бы несколькими словами (рецензия Codex 28.09).
  // Строка вида «node script.js» — команда с аргументом, её не трогать:
  // кавычки нужны только пути к существующему файлу.
  const quotedCommand =
    shell && WINDOWS && /\s/.test(program) && !program.startsWith('"') && existsSync(resolve(cwd, program))
      ? `"${program}"`
      : program;
  return spawn(quotedCommand, [...args], {
    cwd,
    shell,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    detached: !WINDOWS,
  }) as ChildProcessWithoutNullStreams;
}

/** Остановить процесс вместе с потомками и дождаться подтверждения. */
export function killTree(
  proc: ChildProcessWithoutNullStreams,
  timeout: number = STOP_TIMEOUT,
): Promise<void> {
  return new Promise((resolve) => {
    const alreadyExited = proc.exitCode !== null || proc.signalCode !== null;
    const pid = proc.pid;
    if (pid === undefined) {
      resolve();
      return;
    }

    let exited = alreadyExited;
    let treeKilled = false;
    let done = false;
    const timer = setTimeout(finish, timeout);
    function finish(): void {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    }
    const checkNow = () => {
      if (exited && treeKilled) finish();
    };
    if (!alreadyExited) {
      proc.once("exit", () => {
        exited = true;
        checkNow();
      });
    }

    if (WINDOWS) {
      execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => {
        // Ошибка допустима: процесс мог уже завершиться сам.
        treeKilled = true;
        closeStdin(proc);
        checkNow();
      });
    } else {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        try {
          proc.kill("SIGTERM");
        } catch {
          // процесс уже завершён
        }
      }
      treeKilled = true;
      closeStdin(proc);
      checkNow();
    }
  });
}

function closeStdin(proc: ChildProcessWithoutNullStreams): void {
  try {
    proc.stdin.end();
  } catch {
    // канал уже закрыт
  }
}
