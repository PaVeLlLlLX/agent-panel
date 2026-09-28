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

const ИМЯ = process.platform === "win32" ? "claude.exe" : "claude";

function расширение() {
  const папка = mkdtempSync(join(tmpdir(), "claude-code-ext-"));
  mkdirSync(join(папка, "resources", "native-binary"), { recursive: true });
  writeFileSync(join(папка, "resources", "native-binary", ИМЯ), "");
  return папка;
}

test("claude находится в resources/native-binary расширения Claude Code", () => {
  const папка = расширение();
  assert.equal(findExtensionClaude(папка), join(папка, "resources", "native-binary", ИМЯ));
});

test("без расширения или без бинарника — не найден", () => {
  assert.equal(findExtensionClaude(undefined), undefined);
  assert.equal(findExtensionClaude(mkdtempSync(join(tmpdir(), "empty-ext-"))), undefined);
});

test("по умолчанию берётся claude расширения и запускается без оболочки", () => {
  const папка = расширение();
  const запуск = resolveClaudeCommand("claude", папка);
  assert.equal(запуск.source, "extension");
  assert.equal(запуск.command, join(папка, "resources", "native-binary", ИМЯ));
  assert.equal(запуск.shell, false, "путь к .exe через оболочку ломается на пробелах");
});

test("пустая настройка тоже означает «по умолчанию»", () => {
  assert.equal(resolveClaudeCommand("  ", расширение()).source, "extension");
  assert.equal(resolveClaudeCommand(undefined, расширение()).source, "extension");
});

test("явная настройка важнее расширения", () => {
  const запуск = resolveClaudeCommand("C:/tools/claude.cmd", расширение());
  assert.equal(запуск.source, "setting");
  assert.equal(запуск.command, "C:/tools/claude.cmd");
  assert.equal(запуск.shell, undefined, "для .cmd нужна оболочка — решает адаптер");
});

test("явный путь к .exe запускается без оболочки", () => {
  assert.equal(resolveClaudeCommand("C:/tools/claude.exe", undefined).shell, false);
});

test("нет ни настройки, ни расширения — claude из PATH", () => {
  const запуск = resolveClaudeCommand("claude", undefined);
  assert.equal(запуск.source, "path");
  assert.equal(запуск.command, "claude");
  assert.equal(запуск.shell, undefined);
});

// Путь к MCP-конфигу для cmd.exe берётся в кавычки, иначе пробел в имени папки
// разбивает команду. Без оболочки кавычки попали бы в сам путь, и claude не
// нашёл бы файл.
test("аргумент в кавычках только при запуске через cmd.exe", () => {
  const путь = "C:/Users/Мой профиль/mcp.json";
  assert.equal(argumentForLaunch(путь, false), путь);
  const черезОболочку = process.platform === "win32" ? `"${путь}"` : путь;
  assert.equal(argumentForLaunch(путь, undefined), черезОболочку, "undefined — оболочка по умолчанию");
  assert.equal(argumentForLaunch(путь, true), черезОболочку);
});
