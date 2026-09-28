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
export function normalizeChoice(catalog: readonly ModelOption[] | undefined, choice: unknown): ModelChoice {
  const record = (choice ?? {}) as Record<string, unknown>;
  const model = typeof record["model"] === "string" ? record["model"] : "";
  const level = typeof record["effort"] === "string" ? record["effort"] : "";
  if (!catalog) return { model: model, effort: level };
  const makeOption = catalog.find((o) => o.id === model);
  if (!makeOption) return DEFAULT_CHOICE;
  return { model: model, effort: makeOption.efforts.includes(level) ? level : "" };
}

export function sameChoice(a: ModelChoice, b: ModelChoice): boolean {
  return a.model === b.model && a.effort === b.effort;
}

/** «Opus · high», «по умолчанию (Sonnet 5)». */
export function describeChoice(catalog: readonly ModelOption[] | undefined, choice: ModelChoice): string {
  const makeOption = catalog?.find((o) => o.id === choice.model);
  const name = makeOption?.label ?? (choice.model || "по умолчанию");
  return choice.effort ? `${name} · ${choice.effort}` : name;
}
