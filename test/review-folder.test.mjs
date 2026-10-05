/**
 * Папка проверок рецензента (ступень 2, спецификация 05.10): вне
 * репозитория, в %LOCALAPPDATA%\agent-panel\review\<комната>\<рецензент>\.
 * Имя комнаты — последняя часть пути проекта плюс короткий хеш полного пути:
 * две папки Trading в разных местах не должны делить одну папку проверок.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureReviewFolder, folderSize, reviewFolderFor } from "../out/reviewFolder.js";

const LOCAL = "C:\\Users\\21435\\AppData\\Local";

test("папка проверок: последняя часть пути проекта в нижнем регистре и хеш полного пути, папка рецензента внутри", () => {
  const folder = reviewFolderFor(LOCAL, "room:c:\\Users\\21435\\source\\Trading", "codex");
  assert.match(folder, /^C:\\Users\\21435\\AppData\\Local\\agent-panel\\review\\trading-[0-9a-f]{8}\\codex$/);
  const gemini = reviewFolderFor(LOCAL, "room:c:\\Users\\21435\\source\\Trading", "gemini");
  assert.equal(gemini, folder.replace(/codex$/, "gemini"), "у рецензентов комнаты общая папка комнаты");
});

test("папка проверок: разные проекты с одним именем — разные папки; регистр пути не важен", () => {
  const one = reviewFolderFor(LOCAL, "room:c:\\work\\Trading", "codex");
  const other = reviewFolderFor(LOCAL, "room:d:\\old\\Trading", "codex");
  assert.notEqual(one, other);
  assert.equal(reviewFolderFor(LOCAL, "room:C:\\WORK\\trading", "codex"), one, "в Windows это та же папка");
  assert.equal(reviewFolderFor(LOCAL, "room:c:\\work\\Trading\\", "codex"), one, "косая черта в конце — та же папка");
});

test("папка проверок: не-ASCII буквы остаются, запрещённые в именах символы — подчёркивание", () => {
  const folder = reviewFolderFor(LOCAL, 'room:c:\\p\\Мой<Проект>:"x|y?*', "codex");
  assert.match(folder, /\\review\\мой_проект___x_y__-[0-9a-f]{8}\\codex$/);
  const root = reviewFolderFor(LOCAL, "room:c:\\", "codex");
  assert.match(root, /\\review\\room-[0-9a-f]{8}\\codex$/, "у корня диска нет последней части");
});

test("папка проверок создаётся вместе с tmp; повторно — без ошибки", () => {
  const folder = join(mkdtempSync(join(tmpdir(), "review-")), "agent-panel", "review", "x-1", "codex");
  ensureReviewFolder(folder);
  ensureReviewFolder(folder);
  assert.ok(statSync(folder).isDirectory());
  assert.ok(statSync(join(folder, "tmp")).isDirectory());
});

test("размер папки — сумма файлов во вложенных папках; нет папки — ноль", () => {
  const folder = mkdtempSync(join(tmpdir(), "review-size-"));
  writeFileSync(join(folder, "a.py"), "x".repeat(100));
  mkdirSync(join(folder, "tmp", "mpl"), { recursive: true });
  writeFileSync(join(folder, "tmp", "mpl", "b.bin"), Buffer.alloc(2500));
  assert.equal(folderSize(folder), 2600);
  assert.equal(folderSize(join(folder, "нет-такой")), 0);
  assert.equal(existsSync(join(folder, "нет-такой")), false, "размер папку не создаёт");
});
