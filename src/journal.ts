/**
 * Журнал комнаты: история переживает перезапуск панели.
 *
 * Требование приёмки — «перезапуск панели сохраняет историю и привязку
 * сессий». Значит хранить надо не только текст, но и идентификаторы сессий
 * обоих агентов: без них после перезапуска мы подключимся к новым сессиям и
 * потеряем контекст, сохранив при этом видимость непрерывности. Это худший
 * из исходов: история выглядит целой, а агенты о ней не знают.
 *
 * Используется встроенный `node:sqlite` (Node 22.5+), поэтому нативная
 * сборка не нужна.
 *
 * Порядок событий задаётся автоинкрементом `seq`, а не временем: события
 * двух агентов приходят почти одновременно, и разрешение времени в
 * миллисекундах не гарантирует различия.
 *
 * **Полный вывод хранится отдельно от показанного.** Текст события
 * обрезается до 64 000 символов для показа, и первая версия журнала
 * хранила только обрезанное — окончание большого вывода терялось
 * безвозвратно. Теперь исходная запись протокола пишется в поле `raw`,
 * и дочитать её можно.
 */
import { DatabaseSync } from "node:sqlite";
import { PanelEvent } from "./adapters/types.js";

export interface RoomBinding {
  readonly room: string;
  readonly cwd: string;
  readonly claudeSessionId: string | undefined;
  readonly codexThreadId: string | undefined;
  readonly geminiConversationId: string | undefined;
  readonly updatedAt: number;
}

export class Journal {
  readonly #db: DatabaseSync;
  #closed = false;

  constructor(filePath: string) {
    this.#db = new DatabaseSync(filePath);
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#db.exec("PRAGMA foreign_keys = ON");
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS rooms (
        room       TEXT PRIMARY KEY,
        cwd        TEXT NOT NULL,
        claude_session TEXT,
        codex_thread   TEXT,
        gemini_conversation TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        seq        INTEGER PRIMARY KEY AUTOINCREMENT,
        room       TEXT NOT NULL REFERENCES rooms(room),
        id         TEXT NOT NULL,
        agent      TEXT NOT NULL,
        kind       TEXT NOT NULL,
        visibility TEXT NOT NULL,
        at         INTEGER NOT NULL,
        text       TEXT,
        tool       TEXT,
        call_id    TEXT,
        turn_id    TEXT,
        snapshot   TEXT,
        raw        TEXT
      );
      CREATE INDEX IF NOT EXISTS events_room_seq ON events(room, seq);
    `);
    // Колонки, добавленные позже: журнал прежней версии получает их при открытии.
    // Без них история после перезапуска теряла связь отказа с вызовом
    // (tool_call_id) и действия субагента (parent_call_id) — рецензия Codex 28.09;
    // unsolicited — ход, начатый агентом без сообщения панели; failed — ход не
    // удался (иначе после перезапуска пропадало уведомление об этом).
    const existing = new Set(
      (this.#db.prepare("PRAGMA table_info(events)").all() as Record<string, unknown>[]).map((k) => String(k["name"])),
    );
    for (const column of ["tool_call_id", "parent_call_id", "unsolicited", "failed"]) {
      if (!existing.has(column)) this.#db.exec(`ALTER TABLE events ADD COLUMN ${column} TEXT`);
    }
    // Разговор Gemini (agy --conversation) — колонка комнаты, добавленная позже.
    const roomColumns = new Set(
      (this.#db.prepare("PRAGMA table_info(rooms)").all() as Record<string, unknown>[]).map((k) => String(k["name"])),
    );
    if (!roomColumns.has("gemini_conversation")) this.#db.exec("ALTER TABLE rooms ADD COLUMN gemini_conversation TEXT");
  }

  ensureRoom(room: string, cwd: string): void {
    this.#db
      .prepare(
        `INSERT INTO rooms (room, cwd, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(room) DO UPDATE SET cwd = excluded.cwd,
                                          updated_at = excluded.updated_at`,
      )
      .run(room, cwd, Date.now());
  }

  bindSessions(
    room: string,
    claudeSessionId: string | undefined,
    codexThreadId: string | undefined,
  ): void {
    // Записывается только то, что известно: перетереть известный
    // идентификатор значением undefined значило бы потерять привязку.
    if (claudeSessionId) {
      this.#db
        .prepare(`UPDATE rooms SET claude_session = ?, updated_at = ? WHERE room = ?`)
        .run(claudeSessionId, Date.now(), room);
    }
    if (codexThreadId) {
      this.#db
        .prepare(`UPDATE rooms SET codex_thread = ?, updated_at = ? WHERE room = ?`)
        .run(codexThreadId, Date.now(), room);
    }
  }

  /** Разговор Gemini комнаты: следующий запуск agy продолжит его через --conversation. */
  bindGeminiConversation(room: string, conversationId: string): void {
    this.#db
      .prepare(`UPDATE rooms SET gemini_conversation = ?, updated_at = ? WHERE room = ?`)
      .run(conversationId, Date.now(), room);
  }

  /** Новая сессия агента: привязка комнаты к прежней забывается. */
  forgetSession(room: string, agent: "claude" | "codex" | "gemini"): void {
    if (this.#closed) return;
    const column = agent === "claude" ? "claude_session" : agent === "codex" ? "codex_thread" : "gemini_conversation";
    this.#db.prepare(`UPDATE rooms SET ${column} = NULL, updated_at = ? WHERE room = ?`).run(Date.now(), room);
  }

  binding(room: string): RoomBinding | undefined {
    const line = this.#db
      .prepare(
        `SELECT room, cwd, claude_session, codex_thread, gemini_conversation, updated_at
         FROM rooms WHERE room = ?`,
      )
      .get(room) as Record<string, unknown> | undefined;
    if (!line) return undefined;
    return {
      room: String(line["room"]),
      cwd: String(line["cwd"]),
      claudeSessionId: (line["claude_session"] as string | null) ?? undefined,
      codexThreadId: (line["codex_thread"] as string | null) ?? undefined,
      geminiConversationId: (line["gemini_conversation"] as string | null) ?? undefined,
      updatedAt: Number(line["updated_at"]),
    };
  }

  /**
   * Записывается всё, включая поток.
   *
   * Соблазн не хранить дельты понятен — их много. Но тогда после перезапуска
   * история окажется полнее в одном месте и беднее в другом, и восстановить,
   * что человек видел в момент решения, будет нельзя.
   */
  append(room: string, event: PanelEvent): void {
    // После закрытия журнал молча ничего не делает: позднее событие
    // exit процесса иначе обратилось бы к закрытой базе и уронило
    // закрытие комнаты.
    if (this.#closed) return;
    this.#db
      .prepare(
        `INSERT INTO events
           (room, id, agent, kind, visibility, at, text, tool, call_id,
            turn_id, snapshot, raw, tool_call_id, parent_call_id, unsolicited, failed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        room,
        event.id,
        event.agent,
        event.kind,
        event.visibility,
        event.at,
        event.text ?? null,
        event.tool ?? null,
        event.callId ?? null,
        event.turnId ?? null,
        event.snapshot ?? null,
        event.raw === undefined ? null : JSON.stringify(event.raw),
        event.toolCallId ?? null,
        event.parentCallId ?? null,
        event.unsolicited ? "1" : null,
        event.failed ? "1" : null,
      );
  }

  /** История комнаты для восстановления панели после перезапуска. */
  history(room: string, limit = 2000): PanelEvent[] {
    if (this.#closed) return [];
    const lines = this.#db
      .prepare(
        `SELECT id, agent, kind, visibility, at, text, tool, call_id, turn_id, snapshot,
                tool_call_id, parent_call_id, unsolicited, failed
         FROM events WHERE room = ? ORDER BY seq DESC LIMIT ?`,
      )
      .all(room, limit) as Record<string, unknown>[];
    return lines.reverse().map((s) => ({
      id: String(s["id"]),
      agent: s["agent"] as PanelEvent["agent"],
      kind: s["kind"] as PanelEvent["kind"],
      visibility: s["visibility"] as PanelEvent["visibility"],
      at: Number(s["at"]),
      ...(s["text"] != null ? { text: String(s["text"]) } : {}),
      ...(s["tool"] != null ? { tool: String(s["tool"]) } : {}),
      ...(s["call_id"] != null ? { callId: String(s["call_id"]) } : {}),
      ...(s["turn_id"] != null ? { turnId: String(s["turn_id"]) } : {}),
      ...(s["snapshot"] != null ? { snapshot: String(s["snapshot"]) } : {}),
      ...(s["tool_call_id"] != null ? { toolCallId: String(s["tool_call_id"]) } : {}),
      ...(s["parent_call_id"] != null ? { parentCallId: String(s["parent_call_id"]) } : {}),
      ...(s["unsolicited"] != null ? { unsolicited: true } : {}),
      ...(s["failed"] != null ? { failed: true } : {}),
    })) as PanelEvent[];
  }

  /** Полная запись протокола для события: чтобы дочитать обрезанное. */
  rawOf(room: string, id: string): unknown {
    if (this.#closed) return undefined;
    const line = this.#db
      .prepare(`SELECT raw FROM events WHERE room = ? AND id = ?`)
      .get(room, id) as Record<string, unknown> | undefined;
    const raw = line?.["raw"];
    return typeof raw === "string" ? JSON.parse(raw) : undefined;
  }

  get closed(): boolean {
    return this.#closed;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }
}
