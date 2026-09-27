/**
 * Память по теме: заметки к сообщению человека от внешней команды поиска.
 *
 * Зачем. Владелец 28.09.2026: агенты должны память проекта не только писать,
 * но и читать. У Claude в панели пользовательских хуков нет намеренно
 * (`--setting-sources project,local`, см. README), у Codex их нет вовсе —
 * значит, найденное по теме сообщения ни один агент панели не видел.
 *
 * Протокол — как у хука UserPromptSubmit Claude Code: на вход JSON
 * `{cwd, prompt, hook_event_name}`, на выход JSON с
 * `hookSpecificOutput.additionalContext`. Так один поиск (например,
 * `~/.claude/hooks/memory_search.py` через qmd) служит и сессиям Claude, и
 * обоим агентам панели. Команда задаётся настройкой; по умолчанию выключено.
 */
import { spawn } from "node:child_process";

export interface Memory {
  /** Текст заметок для агентов — как его вернула команда. */
  readonly text: string;
  /** Заголовки заметок: их панель называет человеку. */
  readonly titles: readonly string[];
}

const НС = String.fromCharCode(10);

/** Заметки из ответа команды; пустой ответ, не JSON и ответ без контекста — undefined. */
export function parseMemoryOutput(stdout: string): Memory | undefined {
  let ответ: unknown;
  try {
    ответ = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  const выход = (ответ as { hookSpecificOutput?: { additionalContext?: unknown } } | null)?.hookSpecificOutput;
  const контекст = выход?.additionalContext;
  if (typeof контекст !== "string" || !контекст.trim()) return undefined;
  const titles = контекст
    .split(НС)
    .filter((строка) => строка.startsWith("## "))
    .map((строка) => строка.slice(3).trim());
  return { text: контекст.trim(), titles };
}

/**
 * Запустить команду поиска. Ошибка команды — отказ промиса, а не пустой
 * результат: «ничего не найдено» и «поиск сломан» человек должен различать.
 */
export function runMemorySearch(
  command: string,
  cwd: string,
  prompt: string,
  таймаут = 20_000,
): Promise<Memory | undefined> {
  return new Promise((resolve, reject) => {
    const процесс = spawn(command, { cwd, shell: true, windowsHide: true });
    let вывод = "";
    let ошибки = "";
    const таймер = setTimeout(() => {
      процесс.kill();
      reject(new Error(`поиск не ответил за ${Math.round(таймаут / 1000)} с`));
    }, таймаут);
    процесс.stdout.setEncoding("utf8");
    процесс.stderr.setEncoding("utf8");
    процесс.stdout.on("data", (кусок: string) => (вывод += кусок));
    процесс.stderr.on("data", (кусок: string) => (ошибки += кусок));
    процесс.on("error", (беда) => {
      clearTimeout(таймер);
      reject(беда);
    });
    процесс.on("close", (код) => {
      clearTimeout(таймер);
      if (код !== 0) {
        const подробности = ошибки.trim().slice(0, 200);
        reject(new Error(`команда завершилась с кодом ${код}${подробности ? `: ${подробности}` : ""}`));
      } else {
        resolve(parseMemoryOutput(вывод));
      }
    });
    процесс.stdin.on("error", () => undefined);
    процесс.stdin.end(JSON.stringify({ cwd, prompt, hook_event_name: "UserPromptSubmit" }));
  });
}
