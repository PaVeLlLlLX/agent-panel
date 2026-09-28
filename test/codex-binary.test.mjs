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

const NAME = process.platform === "win32" ? "codex.exe" : "codex";

function extensionDir() {
  const dir = mkdtempSync(join(tmpdir(), "chatgpt-ext-"));
  mkdirSync(join(dir, "bin", "windows-x86_64"), { recursive: true });
  writeFileSync(join(dir, "bin", "windows-x86_64", NAME), "");
  return dir;
}

test("codex находится в папке bin расширения ChatGPT", () => {
  const dir = extensionDir();
  assert.equal(findExtensionCodex(dir), join(dir, "bin", "windows-x86_64", NAME));
});

test("без расширения или без бинарника — не найден", () => {
  assert.equal(findExtensionCodex(undefined), undefined);
  assert.equal(findExtensionCodex(mkdtempSync(join(tmpdir(), "empty-ext-"))), undefined);
});

test("по умолчанию берётся codex расширения и запускается без оболочки", () => {
  const dir = extensionDir();
  const launch = resolveCodexCommand("codex", dir);
  assert.equal(launch.source, "extension");
  assert.equal(launch.command, join(dir, "bin", "windows-x86_64", NAME));
  assert.equal(launch.shell, false, "путь к .exe через оболочку ломается на пробелах");
});

test("явная настройка важнее расширения", () => {
  const launch = resolveCodexCommand("C:/tools/my-codex.cmd", extensionDir());
  assert.equal(launch.source, "setting");
  assert.equal(launch.command, "C:/tools/my-codex.cmd");
  assert.equal(launch.shell, undefined, "для .cmd нужна оболочка — решает адаптер");
});

test("явный путь к .exe запускается без оболочки", () => {
  assert.equal(resolveCodexCommand("C:/tools/codex.exe", undefined).shell, false);
});

test("нет ни настройки, ни расширения — codex из PATH", () => {
  const launch = resolveCodexCommand("codex", undefined);
  assert.equal(launch.source, "path");
  assert.equal(launch.command, "codex");
  assert.equal(launch.shell, undefined);
});
