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

import { FOLDER_SIZE_LIMIT, ensureReviewFolder, folderSize, oversizeNote, reviewFolderFor } from "../out/reviewFolder.js";

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

test("размер папки с пределом: обход останавливается, как только сумма его превысила", () => {
  // Итоговая рецензия 05.10, M6: обход идёт синхронно в процессе расширения
  // при каждом запуске Codex, а большой папке точный размер не нужен.
  const folder = mkdtempSync(join(tmpdir(), "review-size-"));
  for (const name of ["a.py", "b.py", "c.py"]) writeFileSync(join(folder, name), "x".repeat(600));
  assert.equal(folderSize(folder), 1800);
  const stopped = folderSize(folder, 1000);
  assert.ok(stopped > 1000 && stopped < 1800, `обход остановлен: ${stopped}`);
  assert.equal(folderSize(folder, 5000), 1800, "предел не превышен — сумма вся");
});

test("строка о размере папки проверок: больше предела — с путём и рецензентом, иначе ничего; предел по умолчанию — 500 МБ", () => {
  const folder = mkdtempSync(join(tmpdir(), "review-size-"));
  writeFileSync(join(folder, "old.csv"), "x".repeat(2000));
  assert.equal(oversizeNote(folder, "Gemini", 5000), undefined);
  const note = oversizeNote(folder, "Gemini", 1000);
  assert.match(note, /^Папка проверок Gemini больше \d+ МБ: /);
  assert.ok(note.includes(folder));
  assert.match(note, /Старые скрипты и выводы рецензента можно удалить\.$/);
  assert.equal(FOLDER_SIZE_LIMIT, 500 * 1024 * 1024);
  assert.equal(oversizeNote(folder, "Gemini"), undefined);
});
