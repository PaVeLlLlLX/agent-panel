/**
 * Журнал комнаты: что переживает перезапуск панели.
 *
 * Рецензия Codex 28.09: toolCallId (связь отказа с бусиной) и parentCallId
 * (действие субагента) журнал не сохранял, и после повторного открытия
 * панели история теряла обе связи.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Journal } from "../out/journal.js";

const event = (extra) => ({ id: "e" + Math.random(), agent: "claude", visibility: "turn", at: 1, ...extra });

test("история восстанавливает связь отказа с вызовом и действие субагента", () => {
  const filePath = join(mkdtempSync(join(tmpdir(), "journal-")), "j.sqlite");
  const journal = new Journal(filePath);
  journal.ensureRoom("r", "C:/x");
  journal.append("r", event({ kind: "approval_decided", callId: "perm-1", toolCallId: "toolu_1", text: "отклонено человеком" }));
  journal.append("r", event({ kind: "tool_call", tool: "Read", callId: "toolu_sub", parentCallId: "toolu_agent", text: "a.txt" }));
  journal.append("r", event({ kind: "tool_result", tool: "Read", callId: "toolu_sub", full: "огромный", text: "показ" }));
  const history = journal.history("r");
  assert.equal(history[0].toolCallId, "toolu_1");
  assert.equal(history[1].parentCallId, "toolu_agent");
  assert.equal(history[2].full, undefined, "полный текст в журнал не пишется: там raw");
  journal.close();
});

test("история помнит ход, начатый агентом без сообщения панели", () => {
  // Без отметки после повторного открытия реплика самостоятельного хода
  // выглядела бы работой по задаче.
  const filePath = join(mkdtempSync(join(tmpdir(), "journal-")), "j.sqlite");
  const journal = new Journal(filePath);
  journal.ensureRoom("r", "C:/x");
  journal.append("r", event({ kind: "turn_started", unsolicited: true, text: "фоновая задача закончилась" }));
  journal.append("r", event({ kind: "turn_completed", unsolicited: true }));
  journal.append("r", event({ kind: "turn_completed" }));
  const history = journal.history("r");
  assert.equal(history[0].unsolicited, true);
  assert.equal(history[1].unsolicited, true);
  assert.equal(history[2].unsolicited, undefined);
  journal.close();
});

test("история помнит ход, кончившийся ошибкой", () => {
  // Без отметки после повторного открытия пропадало уведомление «ход не удался».
  const filePath = join(mkdtempSync(join(tmpdir(), "journal-")), "j.sqlite");
  const journal = new Journal(filePath);
  journal.ensureRoom("r", "C:/x");
  journal.append("r", event({ kind: "turn_completed", failed: true, text: "ход завершён с ошибкой: сбой модели" }));
  journal.append("r", event({ kind: "turn_completed", text: "ход завершён" }));
  const history = journal.history("r");
  assert.equal(history[0].failed, true);
  assert.equal(history[1].failed, undefined);
  journal.close();
});

test("журнал прежней версии получает новые колонки при открытии", () => {
  const filePath = join(mkdtempSync(join(tmpdir(), "journal-")), "j.sqlite");
  const oldDb = new DatabaseSync(filePath);
  oldDb.exec(`
    CREATE TABLE rooms (room TEXT PRIMARY KEY, cwd TEXT NOT NULL, claude_session TEXT, codex_thread TEXT, updated_at INTEGER NOT NULL);
    CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT NOT NULL REFERENCES rooms(room), id TEXT NOT NULL,
      agent TEXT NOT NULL, kind TEXT NOT NULL, visibility TEXT NOT NULL, at INTEGER NOT NULL, text TEXT, tool TEXT,
      call_id TEXT, turn_id TEXT, snapshot TEXT, raw TEXT);
    INSERT INTO rooms VALUES ('r', 'C:/x', NULL, NULL, 1);
    INSERT INTO events (room, id, agent, kind, visibility, at, text) VALUES ('r', 'old', 'human', 'message', 'turn', 1, 'прежнее');
  `);
  oldDb.close();
  const journal = new Journal(filePath);
  journal.append("r", event({ kind: "tool_call", callId: "c", parentCallId: "p", text: "x" }));
  const history = journal.history("r");
  assert.equal(history[0].text, "прежнее", "прежние записи на месте");
  assert.equal(history[1].parentCallId, "p");
  journal.close();
});

test("новая сессия: привязка агента комнаты очищается, другого — остаётся", () => {
  const filePath = join(mkdtempSync(join(tmpdir(), "journal-")), "j.sqlite");
  const journal = new Journal(filePath);
  journal.ensureRoom("r", "C:/x");
  journal.bindSessions("r", "claude-1", "codex-1");
  journal.forgetSession("r", "claude");
  const p = journal.binding("r");
  assert.equal(p.claudeSessionId, undefined);
  assert.equal(p.codexThreadId, "codex-1");
  journal.close();
});
