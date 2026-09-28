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

function repo() {
  const k = mkdtempSync(join(tmpdir(), "snap-"));
  const g = (...a) => execFileSync("git", a, { cwd: k, stdio: "ignore" });
  g("init", "-q");
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "t");
  writeFileSync(join(k, "a.txt"), "первая версия");
  g("add", "-A");
  g("commit", "-q", "-m", "первый");
  return { k, g };
}

test("правка нового файла меняет отпечаток", async () => {
  const { k } = repo();
  writeFileSync(join(k, "новый.txt"), "содержимое один");
  const until = await takeSnapshot(k);
  writeFileSync(join(k, "новый.txt"), "содержимое два, той же длины!!");
  const after = await takeSnapshot(k);
  assert.notEqual(
    after.id,
    until.id,
    "отпечаток обязан меняться: иначе замечание привяжется к другому коду",
  );
});

test("правка отслеживаемого файла меняет отпечаток", async () => {
  const { k } = repo();
  const until = await takeSnapshot(k);
  writeFileSync(join(k, "a.txt"), "вторая версия");
  const after = await takeSnapshot(k);
  assert.notEqual(after.id, until.id);
  assert.equal(after.dirty, true);
});

test("без изменений отпечаток тот же", async () => {
  const { k } = repo();
  const first = await takeSnapshot(k);
  const second = await takeSnapshot(k);
  assert.equal(first.id, second.id);
  assert.equal(first.dirty, false);
  assert.equal(first.source, "git");
});

test("новый файл делает состояние грязным", async () => {
  const { k } = repo();
  writeFileSync(join(k, "новый.txt"), "x");
  const s = await takeSnapshot(k);
  assert.equal(s.dirty, true, "новый файл — тоже изменение версии");
});

test("вне git отпечаток всё равно выдаётся и помечен источником", async () => {
  const k = mkdtempSync(join(tmpdir(), "nogit-"));
  writeFileSync(join(k, "f.txt"), "раз");
  const until = await takeSnapshot(k);
  assert.equal(until.source, "filesystem");
  assert.equal(until.dirty, true, "отсутствие git не значит «чисто»");
  writeFileSync(join(k, "f.txt"), "два");
  const after = await takeSnapshot(k);
  assert.notEqual(after.id, until.id);
});
