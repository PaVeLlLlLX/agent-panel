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
import { запуститьПроцесс, остановитьДерево } from "./adapters/process.js";

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
export function parseClaudeUsage(текст: string): ClaudeUsage | undefined {
  const неделя = /Current week \(all models\):\s*(\d+(?:\.\d+)?)%\s*used(?:\s*·\s*resets\s+([^\r\n]+))?/.exec(текст);
  if (!неделя) return undefined;
  const сессия = /Current session:\s*(\d+(?:\.\d+)?)%\s*used/.exec(текст);
  return {
    weekPercent: Number(неделя[1]),
    ...(сессия ? { sessionPercent: Number(сессия[1]) } : {}),
    ...(неделя[2] ? { weekResets: неделя[2].trim() } : {}),
  };
}

/** Ответ `claude -p --output-format json`: текст — в поле result. */
export function parseUsageOutput(stdout: string): ClaudeUsage | undefined {
  let ответ: unknown;
  try {
    ответ = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  const запись = (ответ ?? {}) as { is_error?: unknown; result?: unknown };
  if (запись.is_error === true || typeof запись.result !== "string") return undefined;
  return parseClaudeUsage(запись.result);
}

export interface UsageRequest {
  readonly command: string;
  readonly cwd: string;
  /** Аргументы перед флагами — для фальшивого CLI в тестах. */
  readonly commandArgs?: readonly string[];
  readonly shell?: boolean;
  readonly timeoutMs?: number;
}

/**
 * Спросить `/usage`. Сбой запуска или срок — отказ промиса: «доля неизвестна»
 * и «запрос сломан» различаются в диагностике.
 */
export function fetchClaudeUsage(запрос: UsageRequest): Promise<ClaudeUsage | undefined> {
  const таймаут = запрос.timeoutMs ?? USAGE_TIMEOUT_MS;
  const аргументы = [
    ...(запрос.commandArgs ?? []),
    "-p",
    "/usage",
    "--no-session-persistence",
    // Ни хуков, ни MCP владельца: для /usage они не нужны.
    "--setting-sources",
    "project,local",
    "--output-format",
    "json",
  ];
  return new Promise((resolve, reject) => {
    const процесс = запуститьПроцесс(запрос.command, аргументы, запрос.cwd, запрос.shell);
    процесс.stdin.end();
    let вывод = "";
    const таймер = setTimeout(() => {
      void остановитьДерево(процесс);
      reject(new Error(`/usage не ответил за ${Math.max(1, Math.round(таймаут / 1000))} с`));
    }, таймаут);
    процесс.stdout.setEncoding("utf8");
    процесс.stdout.on("data", (кусок: string) => (вывод += кусок));
    процесс.stderr.resume();
    процесс.on("error", (беда) => {
      clearTimeout(таймер);
      reject(беда);
    });
    процесс.on("close", () => {
      clearTimeout(таймер);
      resolve(parseUsageOutput(вывод.trim()));
    });
  });
}
