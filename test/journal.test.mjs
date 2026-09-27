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

const событие = (доп) => ({ id: "e" + Math.random(), agent: "claude", visibility: "turn", at: 1, ...доп });

test("история восстанавливает связь отказа с вызовом и действие субагента", () => {
  const путь = join(mkdtempSync(join(tmpdir(), "journal-")), "j.sqlite");
  const журнал = new Journal(путь);
  журнал.ensureRoom("r", "C:/x");
  журнал.append("r", событие({ kind: "approval_decided", callId: "perm-1", toolCallId: "toolu_1", text: "отклонено человеком" }));
  журнал.append("r", событие({ kind: "tool_call", tool: "Read", callId: "toolu_sub", parentCallId: "toolu_agent", text: "a.txt" }));
  журнал.append("r", событие({ kind: "tool_result", tool: "Read", callId: "toolu_sub", full: "огромный", text: "показ" }));
  const история = журнал.history("r");
  assert.equal(история[0].toolCallId, "toolu_1");
  assert.equal(история[1].parentCallId, "toolu_agent");
  assert.equal(история[2].full, undefined, "полный текст в журнал не пишется: там raw");
  журнал.close();
});

test("журнал прежней версии получает новые колонки при открытии", () => {
  const путь = join(mkdtempSync(join(tmpdir(), "journal-")), "j.sqlite");
  const старая = new DatabaseSync(путь);
  старая.exec(`
    CREATE TABLE rooms (room TEXT PRIMARY KEY, cwd TEXT NOT NULL, claude_session TEXT, codex_thread TEXT, updated_at INTEGER NOT NULL);
    CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT NOT NULL REFERENCES rooms(room), id TEXT NOT NULL,
      agent TEXT NOT NULL, kind TEXT NOT NULL, visibility TEXT NOT NULL, at INTEGER NOT NULL, text TEXT, tool TEXT,
      call_id TEXT, turn_id TEXT, snapshot TEXT, raw TEXT);
    INSERT INTO rooms VALUES ('r', 'C:/x', NULL, NULL, 1);
    INSERT INTO events (room, id, agent, kind, visibility, at, text) VALUES ('r', 'old', 'human', 'message', 'turn', 1, 'прежнее');
  `);
  старая.close();
  const журнал = new Journal(путь);
  журнал.append("r", событие({ kind: "tool_call", callId: "c", parentCallId: "p", text: "x" }));
  const история = журнал.history("r");
  assert.equal(история[0].text, "прежнее", "прежние записи на месте");
  assert.equal(история[1].parentCallId, "p");
  журнал.close();
});
