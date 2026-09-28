/**
 * Недельная доля лимита Claude — из команды `/usage` его CLI.
 *
 * Зачем. Граница владельца (27.09.2026): не больше 90% недельного лимита
 * Claude. В потоке `claude -p` есть только статус пятичасового окна
 * (`rate_limit_event`), процента недели нет; у Codex он приходит сам.
 *
 * `claude -p "/usage"` отвечает без запроса модели: 0 токенов, около 4 с
 * (замер 28.09, CLI 2.1.220). С `--no-session-persistence` не оставляет файла
 * сессии — иначе каждый запрос засорял бы историю сессий владельца. Ответ —
 * английский текст для человека; форма не гарантирована, поэтому незнакомая
 * форма даёт «неизвестно», а не ноль.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnProcess, killTree } from "./adapters/process.js";

/** Срок ответа: обычный — 4 с, запас на холодный старт CLI. */
export const USAGE_TIMEOUT_MS = 30_000;

export interface ClaudeUsage {
  /** «Current week (all models)», проценты. */
  readonly weekPercent: number;
  /** «Current session» — пятичасовое окно, проценты. */
  readonly sessionPercent?: number;
  /** Когда сбросится неделя — как написал CLI. */
  readonly weekResets?: string;
}

/** Доля из текста `/usage`; без строки общей недели — undefined. */
export function parseClaudeUsage(text: string): ClaudeUsage | undefined {
  const week = /Current week \(all models\):\s*(\d+(?:\.\d+)?)%\s*used(?:\s*·\s*resets\s+([^\r\n]+))?/.exec(text);
  if (!week) return undefined;
  const session = /Current session:\s*(\d+(?:\.\d+)?)%\s*used/.exec(text);
  return {
    weekPercent: Number(week[1]),
    ...(session ? { sessionPercent: Number(session[1]) } : {}),
    ...(week[2] ? { weekResets: week[2].trim() } : {}),
  };
}

/** Ответ `claude -p --output-format json`: текст — в поле result. */
export function parseUsageOutput(stdout: string): ClaudeUsage | undefined {
  let reply: unknown;
  try {
    reply = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  const record = (reply ?? {}) as { is_error?: unknown; result?: unknown };
  if (record.is_error === true || typeof record.result !== "string") return undefined;
  return parseClaudeUsage(record.result);
}

let emptyDir: string | undefined;

/**
 * Пустой каталог для `/usage`, один на процесс. Из каталога проекта CLI
 * запустил бы хук SessionStart его настроек (замер 28.09: хук сработал на
 * `/usage` с `--setting-sources project,local`); доля от каталога не зависит.
 */
export function usageDirectory(): string {
  emptyDir ??= mkdtempSync(join(tmpdir(), "agent-panel-usage-"));
  return emptyDir;
}

export interface UsageRequest {
  readonly command: string;
  /** По умолчанию — usageDirectory(). */
  readonly cwd?: string;
  /** Аргументы перед флагами — для фальшивого CLI в тестах. */
  readonly commandArgs?: readonly string[];
  readonly shell?: boolean;
  readonly timeoutMs?: number;
}

/**
 * Спросить `/usage`. Сбой запуска или срок — отказ промиса: «доля неизвестна»
 * и «запрос сломан» различаются в диагностике.
 */
export function fetchClaudeUsage(request: UsageRequest): Promise<ClaudeUsage | undefined> {
  const timeout = request.timeoutMs ?? USAGE_TIMEOUT_MS;
  const args = [
    ...(request.commandArgs ?? []),
    "-p",
    "/usage",
    "--no-session-persistence",
    // Без пользовательских настроек (хуков и MCP владельца); настроек проекта
    // нет — каталог пустой.
    "--setting-sources",
    "project,local",
    "--output-format",
    "json",
  ];
  return new Promise((resolve, reject) => {
    const proc = spawnProcess(request.command, args, request.cwd ?? usageDirectory(), request.shell);
    proc.stdin.end();
    let output = "";
    const timer = setTimeout(() => {
      void killTree(proc);
      reject(new Error(`/usage не ответил за ${Math.max(1, Math.round(timeout / 1000))} с`));
    }, timeout);
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => (output += chunk));
    proc.stderr.resume();
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on("close", () => {
      clearTimeout(timer);
      resolve(parseUsageOutput(output.trim()));
    });
  });
}
