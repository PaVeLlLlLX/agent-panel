/**
 * Выбор модели и уровня рассуждения.
 *
 * Выбор приходит из webview и из сохранённого состояния прошлых запусков.
 * Список моделей у агентов меняется с версиями CLI, поэтому сохранённое
 * «opus · max» может оказаться недопустимым: такое сбрасывается к «по
 * умолчанию», а не передаётся агенту, который упадёт на неизвестном флаге.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { describeChoice, normalizeChoice } from "../out/models.js";

const CATALOG = [
  { id: "", label: "по умолчанию (Sonnet 5)", description: "", efforts: ["low", "high"] },
  { id: "opus", label: "Opus", description: "", efforts: ["low", "high", "max"] },
  { id: "haiku", label: "Haiku", description: "", efforts: [] },
];

test("допустимый выбор сохраняется", () => {
  assert.deepEqual(normalizeChoice(CATALOG, { model: "opus", effort: "max" }), { model: "opus", effort: "max" });
  assert.deepEqual(normalizeChoice(CATALOG, { model: "", effort: "high" }), { model: "", effort: "high" });
});

test("неизвестная модель сбрасывается к умолчанию вместе с уровнем", () => {
  assert.deepEqual(normalizeChoice(CATALOG, { model: "gpt-4", effort: "high" }), { model: "", effort: "" });
});

test("уровень, которого нет у модели, сбрасывается", () => {
  assert.deepEqual(normalizeChoice(CATALOG, { model: "haiku", effort: "high" }), { model: "haiku", effort: "" });
  assert.deepEqual(normalizeChoice(CATALOG, { model: "", effort: "max" }), { model: "", effort: "" });
});

test("мусор вместо выбора — умолчание", () => {
  assert.deepEqual(normalizeChoice(CATALOG, undefined), { model: "", effort: "" });
  assert.deepEqual(normalizeChoice(CATALOG, { model: 5, effort: null }), { model: "", effort: "" });
});

test("без каталога выбор не проверить — строки сохраняются как есть", () => {
  assert.deepEqual(normalizeChoice(undefined, { model: "opus", effort: "max" }), { model: "opus", effort: "max" });
  assert.deepEqual(normalizeChoice(undefined, { model: 1 }), { model: "", effort: "" });
});

test("подпись выбора для людей", () => {
  assert.equal(describeChoice(CATALOG, { model: "opus", effort: "high" }), "Opus · high");
  assert.equal(describeChoice(CATALOG, { model: "", effort: "" }), "по умолчанию (Sonnet 5)");
  assert.equal(describeChoice(undefined, { model: "opus", effort: "" }), "opus");
  assert.equal(describeChoice(undefined, { model: "", effort: "" }), "по умолчанию");
});
