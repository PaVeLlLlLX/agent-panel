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

test("история помнит ошибку, о которой агент сообщил после ответа", () => {
  // Рецензия 04.10, F1: ход Gemini с ответом и status ERROR не провален, и
  // лента показывает ошибку по отдельной отметке. Без колонки после
  // повторного открытия уведомление пропадало бы.
  const filePath = join(mkdtempSync(join(tmpdir(), "journal-")), "j.sqlite");
  const journal = new Journal(filePath);
  journal.ensureRoom("r", "C:/x");
  journal.append("r", event({ kind: "turn_completed", text: "ход завершён; agy сообщил…", lateError: "agy сообщил об ошибке после ответа: ERROR — EOF" }));
  journal.append("r", event({ kind: "turn_completed", text: "ход завершён" }));
  const history = journal.history("r");
  assert.equal(history[0].lateError, "agy сообщил об ошибке после ответа: ERROR — EOF");
  assert.equal(history[0].failed, undefined);
  assert.equal("lateError" in history[1], false);
  journal.close();
});

test("журнал хранит действия человека и материал рецензенту целиком", () => {
  // Материал проверки бывает длиннее предела показа: журнал хранит его весь.
  const filePath = join(mkdtempSync(join(tmpdir(), "journal-")), "j.sqlite");
  const journal = new Journal(filePath);
  journal.ensureRoom("r", "C:/x");
  const long = "м".repeat(70_000);
  journal.append("r", event({ agent: "human", kind: "action", text: "Автопересылка выключена" }));
  journal.append("r", event({ agent: "codex", kind: "material", visibility: "stream", text: long }));
  const [action, material] = journal.history("r");
  assert.equal(action.kind, "action");
  assert.equal(action.agent, "human");
  assert.equal(action.text, "Автопересылка выключена");
  assert.equal(material.kind, "material");
  assert.equal(material.visibility, "stream");
  assert.equal(material.text, long);
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
  journal.append("r", event({ kind: "turn_completed", lateError: "agy сообщил об ошибке после ответа: ERROR" }));
  const history = journal.history("r");
  assert.equal(history[0].text, "прежнее", "прежние записи на месте");
  assert.equal(history[1].parentCallId, "p");
  assert.equal(history[2].lateError, "agy сообщил об ошибке после ответа: ERROR");
  journal.close();
});

test("журнал хранит расход хода и отдаёт его в истории", () => {
  // Журнал 04–05.10: расход каждого хода в журнал не попадал, и сколько
  // стоила проверка, после перезапуска узнать было нельзя.
  const filePath = join(mkdtempSync(join(tmpdir(), "journal-")), "j.sqlite");
  const journal = new Journal(filePath);
  journal.ensureRoom("r", "C:/x");
  journal.append("r", event({ kind: "turn_completed", usage: { input: 10, cached: 2, output: 3 } }));
  journal.append("r", event({ kind: "turn_completed" }));
  const history = journal.history("r");
  assert.deepEqual(history[0].usage, { input: 10, cached: 2, output: 3 });
  assert.equal("usage" in history[1], false, "хода без расхода расход не выдумывается");
  journal.close();
});

test("журнал прежней версии получает колонку расхода при открытии", () => {
  const filePath = join(mkdtempSync(join(tmpdir(), "journal-")), "j.sqlite");
  const oldDb = new DatabaseSync(filePath);
  oldDb.exec(`
    CREATE TABLE rooms (room TEXT PRIMARY KEY, cwd TEXT NOT NULL, claude_session TEXT, codex_thread TEXT,
      gemini_conversation TEXT, updated_at INTEGER NOT NULL);
    CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT NOT NULL REFERENCES rooms(room), id TEXT NOT NULL,
      agent TEXT NOT NULL, kind TEXT NOT NULL, visibility TEXT NOT NULL, at INTEGER NOT NULL, text TEXT, tool TEXT,
      call_id TEXT, turn_id TEXT, snapshot TEXT, raw TEXT, tool_call_id TEXT, parent_call_id TEXT, unsolicited TEXT,
      failed TEXT, late_error TEXT);
    INSERT INTO rooms VALUES ('r', 'C:/x', NULL, NULL, NULL, 1);
    INSERT INTO events (room, id, agent, kind, visibility, at, text) VALUES ('r', 'old', 'codex', 'turn_completed', 'turn', 1, 'ход завершён');
  `);
  oldDb.close();
  const journal = new Journal(filePath);
  journal.append("r", event({ kind: "turn_completed", usage: { input: 7, cached: 0, output: 1 } }));
  const history = journal.history("r");
  assert.equal(history[0].text, "ход завершён", "прежние записи на месте");
  assert.equal("usage" in history[0], false);
  assert.deepEqual(history[1].usage, { input: 7, cached: 0, output: 1 });
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

test("разговор Gemini привязан к комнате и забывается новой сессией", () => {
  const filePath = join(mkdtempSync(join(tmpdir(), "journal-")), "j.sqlite");
  const journal = new Journal(filePath);
  journal.ensureRoom("r", "C:/x");
  journal.bindSessions("r", "claude-1", "codex-1");
  journal.bindGeminiConversation("r", "gemini-1");
  assert.equal(journal.binding("r").geminiConversationId, "gemini-1");
  journal.forgetSession("r", "gemini");
  const p = journal.binding("r");
  assert.equal(p.geminiConversationId, undefined);
  assert.equal(p.claudeSessionId, "claude-1", "другие привязки на месте");
  assert.equal(p.codexThreadId, "codex-1");
  journal.close();
});

test("журнал прежней версии получает колонку разговора Gemini", () => {
  const filePath = join(mkdtempSync(join(tmpdir(), "journal-")), "j.sqlite");
  const oldDb = new DatabaseSync(filePath);
  oldDb.exec(`
    CREATE TABLE rooms (room TEXT PRIMARY KEY, cwd TEXT NOT NULL, claude_session TEXT, codex_thread TEXT, updated_at INTEGER NOT NULL);
    INSERT INTO rooms VALUES ('r', 'C:/x', 'claude-old', NULL, 1);
  `);
  oldDb.close();
  const journal = new Journal(filePath);
  journal.bindGeminiConversation("r", "gemini-1");
  const p = journal.binding("r");
  assert.equal(p.geminiConversationId, "gemini-1");
  assert.equal(p.claudeSessionId, "claude-old", "прежняя привязка на месте");
  journal.close();
});
