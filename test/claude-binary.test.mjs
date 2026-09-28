/**
 * Какой claude запускает панель.
 *
 * 28.09.2026: сессия владельца идёт на claude-opus-5-5, а панель запускала
 * claude из npm (2.1.220). Ход упал: «API Error: 400 Claude Code 2.1.220 does
 * not support this model; version 2.1.280». В расширении Claude Code для
 * VS Code лежит свой claude.exe той версии, что у чата владельца, и
 * расширение обновляется само. Поэтому по умолчанию берётся claude
 * расширения, а явная настройка важнее — так же, как для Codex.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { argumentForLaunch, findExtensionClaude, resolveClaudeCommand } from "../out/claudeBinary.js";

const NAME = process.platform === "win32" ? "claude.exe" : "claude";

function extensionDir() {
  const dir = mkdtempSync(join(tmpdir(), "claude-code-ext-"));
  mkdirSync(join(dir, "resources", "native-binary"), { recursive: true });
  writeFileSync(join(dir, "resources", "native-binary", NAME), "");
  return dir;
}

test("claude находится в resources/native-binary расширения Claude Code", () => {
  const dir = extensionDir();
  assert.equal(findExtensionClaude(dir), join(dir, "resources", "native-binary", NAME));
});

test("без расширения или без бинарника — не найден", () => {
  assert.equal(findExtensionClaude(undefined), undefined);
  assert.equal(findExtensionClaude(mkdtempSync(join(tmpdir(), "empty-ext-"))), undefined);
});

test("по умолчанию берётся claude расширения и запускается без оболочки", () => {
  const dir = extensionDir();
  const launch = resolveClaudeCommand("claude", dir);
  assert.equal(launch.source, "extension");
  assert.equal(launch.command, join(dir, "resources", "native-binary", NAME));
  assert.equal(launch.shell, false, "путь к .exe через оболочку ломается на пробелах");
});

test("пустая настройка тоже означает «по умолчанию»", () => {
  assert.equal(resolveClaudeCommand("  ", extensionDir()).source, "extension");
  assert.equal(resolveClaudeCommand(undefined, extensionDir()).source, "extension");
});

test("явная настройка важнее расширения", () => {
  const launch = resolveClaudeCommand("C:/tools/claude.cmd", extensionDir());
  assert.equal(launch.source, "setting");
  assert.equal(launch.command, "C:/tools/claude.cmd");
  assert.equal(launch.shell, undefined, "для .cmd нужна оболочка — решает адаптер");
});

test("явный путь к .exe запускается без оболочки", () => {
  assert.equal(resolveClaudeCommand("C:/tools/claude.exe", undefined).shell, false);
});

test("нет ни настройки, ни расширения — claude из PATH", () => {
  const launch = resolveClaudeCommand("claude", undefined);
  assert.equal(launch.source, "path");
  assert.equal(launch.command, "claude");
  assert.equal(launch.shell, undefined);
});

// Путь к MCP-конфигу для cmd.exe берётся в кавычки, иначе пробел в имени папки
// разбивает команду. Без оболочки кавычки попали бы в сам путь, и claude не
// нашёл бы файл.
test("аргумент в кавычках только при запуске через cmd.exe", () => {
  const filePath = "C:/Users/Мой профиль/mcp.json";
  assert.equal(argumentForLaunch(filePath, false), filePath);
  const viaShell = process.platform === "win32" ? `"${filePath}"` : filePath;
  assert.equal(argumentForLaunch(filePath, undefined), viaShell, "undefined — оболочка по умолчанию");
  assert.equal(argumentForLaunch(filePath, true), viaShell);
});
