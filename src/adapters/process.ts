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
import { ChildProcessWithoutNullStreams, execFile, spawn } from "node:child_process";

export const ТАЙМАУТ_ОСТАНОВКИ = 5000;

const WINDOWS = process.platform === "win32";

export function запуститьПроцесс(
  command: string,
  args: readonly string[],
  cwd: string,
  shell: boolean = WINDOWS,
): ChildProcessWithoutNullStreams {
  return spawn(command, [...args], {
    cwd,
    shell,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    detached: !WINDOWS,
  }) as ChildProcessWithoutNullStreams;
}

/** Остановить процесс вместе с потомками и дождаться подтверждения. */
export function остановитьДерево(
  процесс: ChildProcessWithoutNullStreams,
  таймаут: number = ТАЙМАУТ_ОСТАНОВКИ,
): Promise<void> {
  return new Promise((resolve) => {
    const уже = процесс.exitCode !== null || процесс.signalCode !== null;
    const pid = процесс.pid;
    if (pid === undefined) {
      resolve();
      return;
    }

    let вышел = уже;
    let деревоСнято = false;
    let готово = false;
    const таймер = setTimeout(закончить, таймаут);
    function закончить(): void {
      if (готово) return;
      готово = true;
      clearTimeout(таймер);
      resolve();
    }
    const проверить = () => {
      if (вышел && деревоСнято) закончить();
    };
    if (!уже) {
      процесс.once("exit", () => {
        вышел = true;
        проверить();
      });
    }

    if (WINDOWS) {
      execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => {
        // Ошибка допустима: процесс мог уже завершиться сам.
        деревоСнято = true;
        закрытьВвод(процесс);
        проверить();
      });
    } else {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        try {
          процесс.kill("SIGTERM");
        } catch {
          // процесс уже завершён
        }
      }
      деревоСнято = true;
      закрытьВвод(процесс);
      проверить();
    }
  });
}

function закрытьВвод(процесс: ChildProcessWithoutNullStreams): void {
  try {
    процесс.stdin.end();
  } catch {
    // канал уже закрыт
  }
}
