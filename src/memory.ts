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
import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { killTree } from "./adapters/process.js";

/**
 * Сколько ждать поиска. Сообщение человека ждёт вместе с ним, поэтому срок
 * короткий: обычный поиск через qmd отвечает за 1–3 с (замер 28.09).
 */
export const MEMORY_TIMEOUT_MS = 10_000;

export interface Memory {
  /** Текст заметок для агентов — как его вернула команда. */
  readonly text: string;
  /** Заголовки заметок: их панель называет человеку. */
  readonly titles: readonly string[];
}

const NL = String.fromCharCode(10);

/** Заметки из ответа команды; пустой ответ, не JSON и ответ без контекста — undefined. */
export function parseMemoryOutput(stdout: string): Memory | undefined {
  let reply: unknown;
  try {
    reply = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  const output = (reply as { hookSpecificOutput?: { additionalContext?: unknown } } | null)?.hookSpecificOutput;
  const context = output?.additionalContext;
  if (typeof context !== "string" || !context.trim()) return undefined;
  const titles = context
    .split(NL)
    .filter((line) => line.startsWith("## "))
    .map((line) => line.slice(3).trim());
  return { text: context.trim(), titles };
}

/**
 * Запустить команду поиска. Ошибка команды — отказ промиса, а не пустой
 * результат: «ничего не найдено» и «поиск сломан» человек должен различать.
 */
export function runMemorySearch(
  command: string,
  cwd: string,
  prompt: string,
  timeout = MEMORY_TIMEOUT_MS,
): Promise<Memory | undefined> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, { cwd, shell: true, windowsHide: true }) as ChildProcessWithoutNullStreams;
    let output = "";
    let errors = "";
    const timer = setTimeout(() => {
      // Через оболочку: kill() снял бы только её, команда поиска осталась бы жить.
      void killTree(proc);
      reject(new Error(`поиск не ответил за ${Math.max(1, Math.round(timeout / 1000))} с`));
    }, timeout);
    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => (output += chunk));
    proc.stderr.on("data", (chunk: string) => (errors += chunk));
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const details = errors.trim().slice(0, 200);
        reject(new Error(`команда завершилась с кодом ${code}${details ? `: ${details}` : ""}`));
      } else {
        resolve(parseMemoryOutput(output));
      }
    });
    proc.stdin.on("error", () => undefined);
    proc.stdin.end(JSON.stringify({ cwd, prompt, hook_event_name: "UserPromptSubmit" }));
  });
}
