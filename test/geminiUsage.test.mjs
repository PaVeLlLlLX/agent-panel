/**
 * Квота Gemini: `agy -p /usage --output-format json` отвечает без хода модели
 * (проба 02.10.2026). Панель показывает использованное: 1 − remaining_fraction.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { fetchGeminiUsage, parseGeminiUsage } from "../out/geminiUsage.js";

const FAKE_AGY = fileURLToPath(new URL("../fixtures/fake-agy.mjs", import.meta.url));

test("доля недели и пятичасового окна группы Gemini", () => {
  const reply = JSON.stringify({
    status: "SUCCESS",
    command: { name: "usage", data: { groups: [
      { name: "Claude and GPT models", buckets: [{ window: "weekly", remaining_fraction: 0.2 }] },
      { name: "Gemini Models", buckets: [
        { window: "weekly", remaining_fraction: 0.97, reset_time: "2026-10-09T07:36:04Z" },
        { window: "5h", remaining_fraction: 0.894 },
      ] },
    ] } },
  });
  assert.deepEqual(parseGeminiUsage(reply), { weekPercent: 3, windowPercent: 11, weekResets: "2026-10-09T07:36:04Z" });
});

test("незнакомый ответ — квоты нет, а не ноль", () => {
  assert.equal(parseGeminiUsage("не JSON"), undefined);
  assert.equal(parseGeminiUsage(JSON.stringify({ status: "ERROR" })), undefined);
  assert.equal(parseGeminiUsage(JSON.stringify({ status: "SUCCESS", command: { data: { groups: [] } } })), undefined);
});

test("квота запрашивается у agy и разбирается", async () => {
  const quota = await fetchGeminiUsage({ command: "node", commandArgs: [FAKE_AGY] });
  assert.deepEqual(quota, { weekPercent: 3, windowPercent: 11, weekResets: "2026-10-09T07:36:04Z" });
});
