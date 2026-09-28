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
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { ChildProcessWithoutNullStreams, execFile, spawn } from "node:child_process";

export const STOP_TIMEOUT = 5000;

const WINDOWS = process.platform === "win32";

export function spawnProcess(
  command: string,
  args: readonly string[],
  cwd: string,
  shell: boolean = WINDOWS,
): ChildProcessWithoutNullStreams {
  // cmd.exe делит строку по пробелам: путь вроде «C:\Program Files\…» без
  // кавычек стал бы несколькими словами (рецензия Codex 28.09).
  // Строка вида «node script.js» — команда с аргументом, её не трогать:
  // кавычки нужны только пути к существующему файлу.
  const quotedCommand =
    shell && WINDOWS && /\s/.test(command) && !command.startsWith('"') && existsSync(resolve(cwd, command))
      ? `"${command}"`
      : command;
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
