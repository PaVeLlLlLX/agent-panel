/**
 * Квота Gemini — из `agy -p /usage --output-format json`.
 *
 * Проба 02.10.2026: ответ без хода модели и без расхода; command.data.groups —
 * группы моделей («Gemini Models»: Flash и Pro делят квоту; «Claude and GPT
 * models»), у каждой окна weekly и 5h с remaining_fraction. Панель
 * показывает долю использованного: 1 − remaining_fraction. Незнакомый ответ —
 * квоты нет, а не ноль.
 */
import { spawnProcess, killTree } from "./adapters/process.js";
import { USAGE_TIMEOUT_MS, UsageRequest, usageDirectory } from "./claudeUsage.js";

export interface GeminiUsage {
  /** Недельное окно, проценты использованного. */
  readonly weekPercent: number;
  /** Пятичасовое окно, проценты использованного. */
  readonly windowPercent?: number;
  /** Когда сбросится неделя, ISO. */
  readonly weekResets?: string;
}

const records = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? (value as Record<string, unknown>[]) : [];

export function parseGeminiUsage(stdout: string): GeminiUsage | undefined {
  let reply: unknown;
  try {
    reply = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  const record = (reply ?? {}) as Record<string, unknown>;
  if (record["status"] !== "SUCCESS") return undefined;
  const command = (record["command"] ?? {}) as Record<string, unknown>;
  const data = (command["data"] ?? {}) as Record<string, unknown>;
  const gemini = records(data["groups"]).find((g) => /gemini/i.test(String(g["name"] ?? "")));
  const buckets = records(gemini?.["buckets"]);
  const used = (window: string) => {
    const bucket = buckets.find((b) => b["window"] === window);
    const left = bucket?.["remaining_fraction"];
    return typeof left === "number" ? { percent: Math.round((1 - left) * 100), resets: bucket?.["reset_time"] } : undefined;
  };
  const week = used("weekly");
  if (!week) return undefined;
  const fiveHours = used("5h");
  return {
    weekPercent: week.percent,
    ...(fiveHours ? { windowPercent: fiveHours.percent } : {}),
    ...(typeof week.resets === "string" ? { weekResets: week.resets } : {}),
  };
}

/** Спросить `/usage`. Сбой запуска или срок — отказ промиса; незнакомый ответ — undefined. */
export function fetchGeminiUsage(request: UsageRequest): Promise<GeminiUsage | undefined> {
  const timeout = request.timeoutMs ?? USAGE_TIMEOUT_MS;
  const args = [...(request.commandArgs ?? []), "-p", "/usage", "--output-format", "json"];
  return new Promise((resolve, reject) => {
    const proc = spawnProcess(request.command, args, request.cwd ?? usageDirectory(), request.shell);
    proc.stdin.end();
    let output = "";
    const timer = setTimeout(() => {
      void killTree(proc);
      reject(new Error(`/usage agy не ответил за ${Math.max(1, Math.round(timeout / 1000))} с`));
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
      resolve(parseGeminiUsage(output.trim()));
    });
  });
}
