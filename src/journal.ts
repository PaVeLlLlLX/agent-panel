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
  readonly updatedAt: number;
}

export class Journal {
  readonly #бд: DatabaseSync;
  #закрыт = false;

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
        snapshot   TEXT,
        raw        TEXT
      );
      CREATE INDEX IF NOT EXISTS events_room_seq ON events(room, seq);
    `);
    // Колонки, добавленные позже: журнал прежней версии получает их при открытии.
    // Без них история после перезапуска теряла связь отказа с вызовом
    // (tool_call_id) и действия субагента (parent_call_id) — рецензия Codex 28.09.
    const есть = new Set(
      (this.#бд.prepare("PRAGMA table_info(events)").all() as Record<string, unknown>[]).map((к) => String(к["name"])),
    );
    for (const колонка of ["tool_call_id", "parent_call_id"]) {
      if (!есть.has(колонка)) this.#бд.exec(`ALTER TABLE events ADD COLUMN ${колонка} TEXT`);
    }
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
    // После закрытия журнал молча ничего не делает: позднее событие
    // exit процесса иначе обратилось бы к закрытой базе и уронило
    // закрытие комнаты.
    if (this.#закрыт) return;
    this.#бд
      .prepare(
        `INSERT INTO events
           (room, id, agent, kind, visibility, at, text, tool, call_id,
            turn_id, snapshot, raw, tool_call_id, parent_call_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        событие.raw === undefined ? null : JSON.stringify(событие.raw),
        событие.toolCallId ?? null,
        событие.parentCallId ?? null,
      );
  }

  /** История комнаты для восстановления панели после перезапуска. */
  history(room: string, limit = 2000): PanelEvent[] {
    if (this.#закрыт) return [];
    const строки = this.#бд
      .prepare(
        `SELECT id, agent, kind, visibility, at, text, tool, call_id, turn_id, snapshot,
                tool_call_id, parent_call_id
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
      ...(с["tool_call_id"] != null ? { toolCallId: String(с["tool_call_id"]) } : {}),
      ...(с["parent_call_id"] != null ? { parentCallId: String(с["parent_call_id"]) } : {}),
    })) as PanelEvent[];
  }

  /** Полная запись протокола для события: чтобы дочитать обрезанное. */
  rawOf(room: string, id: string): unknown {
    if (this.#закрыт) return undefined;
    const строка = this.#бд
      .prepare(`SELECT raw FROM events WHERE room = ? AND id = ?`)
      .get(room, id) as Record<string, unknown> | undefined;
    const сырое = строка?.["raw"];
    return typeof сырое === "string" ? JSON.parse(сырое) : undefined;
  }

  get closed(): boolean {
    return this.#закрыт;
  }

  close(): void {
    if (this.#закрыт) return;
    this.#закрыт = true;
    this.#бд.close();
  }
}
