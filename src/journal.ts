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
 */
import { DatabaseSync } from "node:sqlite";
import { PanelEvent } from "./adapters/types.js";

export interface RoomBinding {
  readonly room: string;
  readonly cwd: string;
  readonly claudeSessionId: string | undefined;
  readonly codexThreadId: string | undefined;
  readonly updatedAt: number;
}

export class Journal {
  readonly #бд: DatabaseSync;

  constructor(путь: string) {
    this.#бд = new DatabaseSync(путь);
    this.#бд.exec("PRAGMA journal_mode = WAL");
    this.#бд.exec("PRAGMA foreign_keys = ON");
    this.#бд.exec(`
      CREATE TABLE IF NOT EXISTS rooms (
        room       TEXT PRIMARY KEY,
        cwd        TEXT NOT NULL,
        claude_session TEXT,
        codex_thread   TEXT,
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
        snapshot   TEXT
      );
      CREATE INDEX IF NOT EXISTS events_room_seq ON events(room, seq);
    `);
  }

  ensureRoom(room: string, cwd: string): void {
    this.#бд
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
      this.#бд
        .prepare(`UPDATE rooms SET claude_session = ?, updated_at = ? WHERE room = ?`)
        .run(claudeSessionId, Date.now(), room);
    }
    if (codexThreadId) {
      this.#бд
        .prepare(`UPDATE rooms SET codex_thread = ?, updated_at = ? WHERE room = ?`)
        .run(codexThreadId, Date.now(), room);
    }
  }

  binding(room: string): RoomBinding | undefined {
    const строка = this.#бд
      .prepare(
        `SELECT room, cwd, claude_session, codex_thread, updated_at
         FROM rooms WHERE room = ?`,
      )
      .get(room) as Record<string, unknown> | undefined;
    if (!строка) return undefined;
    return {
      room: String(строка["room"]),
      cwd: String(строка["cwd"]),
      claudeSessionId: (строка["claude_session"] as string | null) ?? undefined,
      codexThreadId: (строка["codex_thread"] as string | null) ?? undefined,
      updatedAt: Number(строка["updated_at"]),
    };
  }

  /**
   * Записывается всё, включая поток.
   *
   * Соблазн не хранить дельты понятен — их много. Но тогда после перезапуска
   * история окажется полнее в одном месте и беднее в другом, и восстановить,
   * что человек видел в момент решения, будет нельзя.
   */
  append(room: string, событие: PanelEvent): void {
    this.#бд
      .prepare(
        `INSERT INTO events
           (room, id, agent, kind, visibility, at, text, tool, call_id, turn_id, snapshot)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        room,
        событие.id,
        событие.agent,
        событие.kind,
        событие.visibility,
        событие.at,
        событие.text ?? null,
        событие.tool ?? null,
        событие.callId ?? null,
        событие.turnId ?? null,
        событие.snapshot ?? null,
      );
  }

  /** История комнаты для восстановления панели после перезапуска. */
  history(room: string, limit = 2000): PanelEvent[] {
    const строки = this.#бд
      .prepare(
        `SELECT id, agent, kind, visibility, at, text, tool, call_id, turn_id, snapshot
         FROM events WHERE room = ? ORDER BY seq DESC LIMIT ?`,
      )
      .all(room, limit) as Record<string, unknown>[];
    return строки.reverse().map((с) => ({
      id: String(с["id"]),
      agent: с["agent"] as PanelEvent["agent"],
      kind: с["kind"] as PanelEvent["kind"],
      visibility: с["visibility"] as PanelEvent["visibility"],
      at: Number(с["at"]),
      ...(с["text"] != null ? { text: String(с["text"]) } : {}),
      ...(с["tool"] != null ? { tool: String(с["tool"]) } : {}),
      ...(с["call_id"] != null ? { callId: String(с["call_id"]) } : {}),
      ...(с["turn_id"] != null ? { turnId: String(с["turn_id"]) } : {}),
      ...(с["snapshot"] != null ? { snapshot: String(с["snapshot"]) } : {}),
    })) as PanelEvent[];
  }

  close(): void {
    this.#бд.close();
  }
}
