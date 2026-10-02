/**
 * Каталог Gemini из `agy models` (проба 02.10.2026): строки «slug<TAB>название»,
 * уровень рассуждения — суффикс slug. В карточку Gemini идут только gemini-*.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { GEMINI_DEFAULT_EFFORT, geminiModelSlug, parseGeminiModels } from "../out/geminiCatalog.js";

const OUTPUT = [
  "gemini-3.8-flash-high\tGemini 3.8 Flash (High)",
  "gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)",
  "gemini-3.8-flash-low\tGemini 3.8 Flash (Low)",
  "gemini-3.1-pro-high\tGemini 3.1 Pro (High)",
  "gemini-3.1-pro-low\tGemini 3.1 Pro (Low)",
  "claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)",
  "gpt-oss-120b-medium\tGPT-OSS 120B (Medium)",
  "",
].join("\r\n");

test("семейство — списком, уровни из суффиксов по возрастанию, только gemini", () => {
  const list = parseGeminiModels(OUTPUT);
  assert.deepEqual(list.map((o) => o.id), ["", "gemini-3.8-flash", "gemini-3.1-pro"]);
  assert.deepEqual(list.map((o) => o.label).slice(1), ["Gemini 3.8 Flash", "Gemini 3.1 Pro"]);
  assert.deepEqual(list[1].efforts, ["low", "medium", "high"]);
  assert.deepEqual(list[2].efforts, ["low", "high"]);
  assert.equal(list[2].defaultEffort, GEMINI_DEFAULT_EFFORT);
  assert.deepEqual(list[0].efforts, [], "«по умолчанию» — модель из настроек agy");
});

test("slug для --model: семейство и уровень; пустой уровень — по умолчанию; пустая модель — без флага", () => {
  const list = parseGeminiModels(OUTPUT);
  assert.equal(geminiModelSlug({ model: "gemini-3.1-pro", effort: "low" }, list), "gemini-3.1-pro-low");
  assert.equal(geminiModelSlug({ model: "gemini-3.1-pro", effort: "" }, list), "gemini-3.1-pro-high");
  assert.equal(geminiModelSlug({ model: "gemini-3.8-flash", effort: "" }), "gemini-3.8-flash-high");
  assert.equal(geminiModelSlug({ model: "", effort: "low" }, list), "");
});
