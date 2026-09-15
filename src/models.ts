/**
 * Выбор модели и уровня рассуждения: проверка и подпись.
 *
 * Выбор приходит из webview и из сохранённого состояния прошлых запусков, а
 * список моделей меняется с версиями CLI. Сохранённое «opus · max» может
 * оказаться недопустимым — тогда оно сбрасывается к «по умолчанию», а не
 * передаётся агенту, который упадёт на неизвестном значении флага.
 */
import { ModelChoice, ModelOption } from "./adapters/types.js";

export const DEFAULT_CHOICE: ModelChoice = { model: "", effort: "" };

/** Допустимый выбор. Без каталога проверить нечем — сохраняются строки как есть. */
export function normalizeChoice(каталог: readonly ModelOption[] | undefined, выбор: unknown): ModelChoice {
  const запись = (выбор ?? {}) as Record<string, unknown>;
  const модель = typeof запись["model"] === "string" ? запись["model"] : "";
  const уровень = typeof запись["effort"] === "string" ? запись["effort"] : "";
  if (!каталог) return { model: модель, effort: уровень };
  const вариант = каталог.find((о) => о.id === модель);
  if (!вариант) return DEFAULT_CHOICE;
  return { model: модель, effort: вариант.efforts.includes(уровень) ? уровень : "" };
}

export function sameChoice(а: ModelChoice, б: ModelChoice): boolean {
  return а.model === б.model && а.effort === б.effort;
}

/** «Opus · high», «по умолчанию (Sonnet 5)». */
export function describeChoice(каталог: readonly ModelOption[] | undefined, выбор: ModelChoice): string {
  const вариант = каталог?.find((о) => о.id === выбор.model);
  const имя = вариант?.label ?? (выбор.model || "по умолчанию");
  return выбор.effort ? `${имя} · ${выбор.effort}` : имя;
}
