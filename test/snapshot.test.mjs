/**
 * Отпечаток версии файлов.
 *
 * Главная проверка — правка НОВОГО (ещё не добавленного в git) файла должна
 * менять отпечаток. Первая версия брала такие файлы только по именам, и
 * привязка к версии молча перестала бы работать там, где идёт работа.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { takeSnapshot } from "../out/snapshot.js";

function репозиторий() {
  const к = mkdtempSync(join(tmpdir(), "snap-"));
  const g = (...а) => execFileSync("git", а, { cwd: к, stdio: "ignore" });
  g("init", "-q");
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "t");
  writeFileSync(join(к, "a.txt"), "первая версия");
  g("add", "-A");
  g("commit", "-q", "-m", "первый");
  return { к, g };
}

test("правка нового файла меняет отпечаток", async () => {
  const { к } = репозиторий();
  writeFileSync(join(к, "новый.txt"), "содержимое один");
  const до = await takeSnapshot(к);
  writeFileSync(join(к, "новый.txt"), "содержимое два, той же длины!!");
  const после = await takeSnapshot(к);
  assert.notEqual(
    после.id,
    до.id,
    "отпечаток обязан меняться: иначе замечание привяжется к другому коду",
  );
});

test("правка отслеживаемого файла меняет отпечаток", async () => {
  const { к } = репозиторий();
  const до = await takeSnapshot(к);
  writeFileSync(join(к, "a.txt"), "вторая версия");
  const после = await takeSnapshot(к);
  assert.notEqual(после.id, до.id);
  assert.equal(после.dirty, true);
});

test("без изменений отпечаток тот же", async () => {
  const { к } = репозиторий();
  const первый = await takeSnapshot(к);
  const второй = await takeSnapshot(к);
  assert.equal(первый.id, второй.id);
  assert.equal(первый.dirty, false);
  assert.equal(первый.source, "git");
});

test("новый файл делает состояние грязным", async () => {
  const { к } = репозиторий();
  writeFileSync(join(к, "новый.txt"), "x");
  const с = await takeSnapshot(к);
  assert.equal(с.dirty, true, "новый файл — тоже изменение версии");
});

test("вне git отпечаток всё равно выдаётся и помечен источником", async () => {
  const к = mkdtempSync(join(tmpdir(), "nogit-"));
  writeFileSync(join(к, "f.txt"), "раз");
  const до = await takeSnapshot(к);
  assert.equal(до.source, "filesystem");
  assert.equal(до.dirty, true, "отсутствие git не значит «чисто»");
  writeFileSync(join(к, "f.txt"), "два");
  const после = await takeSnapshot(к);
  assert.notEqual(после.id, до.id);
});
