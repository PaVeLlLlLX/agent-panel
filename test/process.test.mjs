/**
 * Поиск команды агента от папки проекта, когда процесс работает в другой
 * папке (рецензия цикла 05.10).
 *
 * Процесс app-server с папкой проверок запускается в ней (265be00), а
 * Windows ищет голое имя команды сначала в рабочей папке процесса: cmd.exe —
 * среди PATHEXT, запуск без оболочки (libuv) — .com и .exe; относительный
 * путь — только от неё. Папка проверок открыта рецензенту на запись, и его
 * codex.bat или codex.exe запустился бы без песочницы. locateCommand находит
 * команду так, как её нашла бы ОС при запуске в проекте.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { locateCommand } from "../out/adapters/process.js";

const WINDOWS = process.platform === "win32";
const folder = () => mkdtempSync(join(tmpdir(), "locate-"));
const touch = (...parts) => writeFileSync(join(...parts), "");

test("относительный путь — от проекта, с пробелами и без; абсолютный — как есть", () => {
  const home = folder();
  mkdirSync(join(home, "папка с пробелом"));
  touch(home, "папка с пробелом", "fake codex.cmd");
  const sep = WINDOWS ? "\\" : "/";
  assert.equal(locateCommand(`tools${sep}codex.cmd`, home, true), join(home, "tools", "codex.cmd"), "файла нет — путь всё равно от проекта");
  assert.equal(locateCommand(`папка с пробелом${sep}fake codex.cmd`, home, true), join(home, "папка с пробелом", "fake codex.cmd"));
  const absolute = join(folder(), "codex.cmd");
  assert.equal(locateCommand(absolute, home, true), absolute);
});

test("голое имя — в проекте, затем по PATH; с оболочкой — среди PATHEXT, без оболочки — .com и .exe", { skip: !WINDOWS }, () => {
  const home = folder();
  const npm = folder();
  const tools = folder();
  touch(npm, "zzcodex.cmd");
  touch(tools, "zzcodex.exe");
  const env = { PATH: `${npm};"${tools}"`, PATHEXT: ".COM;.EXE;.BAT;.CMD" };
  assert.equal(locateCommand("zzcodex", home, true, env), join(npm, "zzcodex.cmd"), "первая папка PATH, где есть любое из PATHEXT");
  assert.equal(locateCommand("zzcodex", home, false, env), join(tools, "zzcodex.exe"), "без оболочки .cmd не запускается — только .com и .exe");
  assert.equal(locateCommand("zzcodex.exe", home, false, env), join(tools, "zzcodex.exe"), "имя с расширением — как есть");
  touch(home, "zzcodex.bat");
  assert.equal(locateCommand("zzcodex", home, true, env), join(home, "zzcodex.bat"), "проект — раньше PATH, как при запуске в проекте");
});

test("голое имя не найдено — путь от проекта: рабочая папка процесса не просматривается", { skip: !WINDOWS }, () => {
  const home = folder();
  const env = { PATH: folder(), PATHEXT: ".COM;.EXE;.BAT;.CMD" };
  assert.equal(locateCommand("zzнет-такого", home, true, env), join(home, "zzнет-такого"));
});

test("команда с аргументом в строке — ищется программа, аргументы как есть; в кавычках — путь внутри кавычек", { skip: !WINDOWS }, () => {
  const home = folder();
  const bin = join(folder(), "с пробелом");
  mkdirSync(bin);
  touch(bin, "zznode.exe");
  const env = { PATH: bin, PATHEXT: ".COM;.EXE;.BAT;.CMD" };
  assert.equal(locateCommand("zznode C:\\x\\codex.js", home, true, env), `"${join(bin, "zznode.exe")}" C:\\x\\codex.js`);
  assert.equal(locateCommand('"tools x\\codex.cmd" --flag', home, true, env), `"${join(home, "tools x", "codex.cmd")}" --flag`);
});
