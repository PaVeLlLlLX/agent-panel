/**
 * Гигиена исходников.
 *
 * В verdict.ts попал настоящий нулевой байт вместо экранированной записи, и git стал
 * показывать файл как двоичный: «Bin 2013 -> 2851 bytes», без текстового
 * diff. Для инструмента рецензирования это прямой вред — новый парсер
 * вердикта нельзя было отрецензировать по сравнению версий.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");

test("в отслеживаемых файлах нет нулевых байтов", () => {
  const files = execFileSync("git", ["-c", "core.quotepath=off", "ls-files", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
  assert.ok(files.length > 0, "git ls-files ничего не вернул");
  const withNul = files.filter((file) => readFileSync(join(root, file)).includes(0));
  assert.deepEqual(withNul, [], "git покажет такие файлы двоичными, и diff для рецензии пропадёт");
});
