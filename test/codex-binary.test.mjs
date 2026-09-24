/**
 * Какой codex запускает панель.
 *
 * 25.09.2026: чат Codex владельца живёт в расширении ChatGPT для VS Code, у
 * которого свой codex новее CLI из npm. У ветки владельца сохранена модель
 * gpt-6-sol; CLI 0.153.0 её не знает, и ход падал с «model is not supported
 * when using Codex with a ChatGPT account». Codex 0.155.0-alpha.16 из
 * расширения ту же ветку продолжил. Поэтому по умолчанию берётся codex
 * расширения, а явная настройка важнее.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findExtensionCodex, resolveCodexCommand } from "../out/codexBinary.js";

const ИМЯ = process.platform === "win32" ? "codex.exe" : "codex";

function расширение() {
  const папка = mkdtempSync(join(tmpdir(), "chatgpt-ext-"));
  mkdirSync(join(папка, "bin", "windows-x86_64"), { recursive: true });
  writeFileSync(join(папка, "bin", "windows-x86_64", ИМЯ), "");
  return папка;
}

test("codex находится в папке bin расширения ChatGPT", () => {
  const папка = расширение();
  assert.equal(findExtensionCodex(папка), join(папка, "bin", "windows-x86_64", ИМЯ));
});

test("без расширения или без бинарника — не найден", () => {
  assert.equal(findExtensionCodex(undefined), undefined);
  assert.equal(findExtensionCodex(mkdtempSync(join(tmpdir(), "empty-ext-"))), undefined);
});

test("по умолчанию берётся codex расширения и запускается без оболочки", () => {
  const папка = расширение();
  const запуск = resolveCodexCommand("codex", папка);
  assert.equal(запуск.source, "extension");
  assert.equal(запуск.command, join(папка, "bin", "windows-x86_64", ИМЯ));
  assert.equal(запуск.shell, false, "путь к .exe через оболочку ломается на пробелах");
});

test("явная настройка важнее расширения", () => {
  const запуск = resolveCodexCommand("C:/tools/my-codex.cmd", расширение());
  assert.equal(запуск.source, "setting");
  assert.equal(запуск.command, "C:/tools/my-codex.cmd");
  assert.equal(запуск.shell, undefined, "для .cmd нужна оболочка — решает адаптер");
});

test("явный путь к .exe запускается без оболочки", () => {
  assert.equal(resolveCodexCommand("C:/tools/codex.exe", undefined).shell, false);
});

test("нет ни настройки, ни расширения — codex из PATH", () => {
  const запуск = resolveCodexCommand("codex", undefined);
  assert.equal(запуск.source, "path");
  assert.equal(запуск.command, "codex");
  assert.equal(запуск.shell, undefined);
});
