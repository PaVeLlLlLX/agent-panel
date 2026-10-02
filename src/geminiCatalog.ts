/**
 * Каталог моделей Gemini из `agy models`.
 *
 * Проба 02.10.2026: вывод — строки «slug<TAB>название», уровень рассуждения
 * зашит в slug суффиксом: gemini-3.8-flash-high — «Gemini 3.8 Flash (High)».
 * В карточке «Модели» семейство выбирается списком, уровень — узлом нити,
 * поэтому slug разбирается на семейство и уровень. Модели Claude и GPT из
 * каталога agy в карточку Gemini не идут (спецификация, «Вне рамок»).
 */
import { ModelChoice, ModelOption } from "./adapters/types.js";

/** Уровень, если в выборе он не задан: есть и у Flash, и у Pro. */
export const GEMINI_DEFAULT_EFFORT = "high";

const LEVEL_ORDER = ["low", "medium", "high"];
const SUFFIX = /^(.+)-(low|medium|high)$/;

export function parseGeminiModels(stdout: string): ModelOption[] {
  const families = new Map<string, { label: string; efforts: string[] }>();
  for (const line of stdout.split(/\r?\n/)) {
    const [rawSlug, rawTitle] = line.split("\t");
    const slug = (rawSlug ?? "").trim();
    if (!slug.startsWith("gemini-")) continue;
    const m = SUFFIX.exec(slug);
    const family = m?.[1] ?? slug;
    const effort = m?.[2];
    const label = (rawTitle ?? "").replace(/\s*\((low|medium|high)\)\s*$/i, "").trim() || family;
    const entry = families.get(family) ?? { label, efforts: [] };
    if (effort && !entry.efforts.includes(effort)) entry.efforts.push(effort);
    families.set(family, entry);
  }
  const options: ModelOption[] = [{ id: "", label: "по умолчанию (модель из настроек agy)", description: "", efforts: [] }];
  for (const [id, { label, efforts }] of families) {
    const sorted = [...efforts].sort((a, b) => LEVEL_ORDER.indexOf(a) - LEVEL_ORDER.indexOf(b));
    const defaultEffort = sorted.includes(GEMINI_DEFAULT_EFFORT) ? GEMINI_DEFAULT_EFFORT : sorted[sorted.length - 1];
    options.push({
      id,
      label,
      description: sorted.length ? `${id}-{${sorted.join(", ")}}` : id,
      efforts: sorted,
      ...(defaultEffort ? { defaultEffort } : {}),
    });
  }
  return options;
}

/** slug для --model; "" — флаг не передаётся, модель из настроек agy. */
export function geminiModelSlug(choice: ModelChoice, catalog?: readonly ModelOption[]): string {
  if (!choice.model) return "";
  const option = catalog?.find((o) => o.id === choice.model);
  if (option && option.efforts.length === 0) return choice.model;
  return `${choice.model}-${choice.effort || option?.defaultEffort || GEMINI_DEFAULT_EFFORT}`;
}
