/**
 * Какой agy запускает панель.
 *
 * 02.10.2026: установщик Antigravity CLI кладёт agy в %LOCALAPPDATA%\agy\bin
 * и дописывает папку в PATH пользователя, но уже запущенный VS Code нового
 * PATH не видит. Поэтому папка установщика проверяется раньше PATH; явная
 * настройка важнее обоих; не найден нигде — Gemini в комнате нет.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { resolveGeminiCommand } from "../out/geminiBinary.js";

const NAME = process.platform === "win32" ? "agy.exe" : "agy";

function installer() {
  const dir = mkdtempSync(join(tmpdir(), "localappdata-"));
  mkdirSync(join(dir, "agy", "bin"), { recursive: true });
  writeFileSync(join(dir, "agy", "bin", NAME), "");
  return dir;
}

test("по умолчанию — agy из папки установщика, без оболочки", () => {
  const dir = installer();
  const launch = resolveGeminiCommand("agy", dir, "");
  assert.deepEqual(launch, { command: join(dir, "agy", "bin", NAME), shell: false, source: "installer" });
});

test("явная настройка важнее установщика", () => {
  const launch = resolveGeminiCommand("C:/tools/agy.cmd", installer(), "");
  assert.deepEqual(launch, { command: "C:/tools/agy.cmd", shell: undefined, source: "setting" });
  assert.equal(resolveGeminiCommand("C:/tools/agy.exe", undefined, "").shell, false);
});

test("нет установщика — agy из PATH", () => {
  const dir = mkdtempSync(join(tmpdir(), "path-"));
  writeFileSync(join(dir, NAME), "");
  const launch = resolveGeminiCommand("agy", undefined, ["", join(dir, "нет"), dir].join(delimiter));
  assert.deepEqual(launch, { command: join(dir, NAME), shell: false, source: "path" });
});

test("нигде нет — Gemini не подключается", () => {
  const empty = mkdtempSync(join(tmpdir(), "empty-"));
  assert.equal(resolveGeminiCommand("agy", empty, empty), undefined);
  assert.equal(resolveGeminiCommand(undefined, undefined, undefined), undefined);
});
