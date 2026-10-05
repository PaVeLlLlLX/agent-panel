/**
 * Папка проверок рецензента (ступень 2, спецификация 05.10):
 * `%LOCALAPPDATA%\agent-panel\review\<комната>\<рецензент>\` и в ней `tmp\`.
 *
 * Вне репозитория: не попадает в `git status`, `git add -A` у Claude, pytest и
 * линтеры проекта. Песочница Codex разрешает в неё запись профилем прав, а
 * корень записи учитывается, только если папка существует, — поэтому панель
 * создаёт её до запуска процесса. Хранится между проверками; очищает её
 * владелец.
 */
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync } from "node:fs";
import { join, win32 } from "node:path";

export type Reviewer = "codex" | "gemini";

/** Символы, запрещённые в именах файлов Windows, и управляющие. */
const UNSAFE = /[<>:"/\\|?*\u0000-\u001f]/g;

/**
 * Папка рецензента комнаты. Имя комнаты — последняя часть пути проекта в
 * нижнем регистре (не-ASCII буквы остаются, запрещённые символы — «_») и
 * короткий хеш полного пути: две папки Trading в разных местах не делят
 * одну папку проверок, а тот же путь в другом регистре — та же папка.
 */
export function reviewFolderFor(localAppData: string, room: string, who: Reviewer): string {
  const project = room.replace(/^room:/, "").replace(/\//g, "\\").replace(/\\+$/, "");
  const name = win32.basename(project).toLowerCase().replace(UNSAFE, "_") || "room";
  const hash = createHash("sha256").update(project.toLowerCase()).digest("hex").slice(0, 8);
  return join(localAppData, "agent-panel", "review", `${name}-${hash}`, who);
}

/** Папка и её tmp\ (TEMP/TMP команд рецензента); есть — ничего не меняется. */
export function ensureReviewFolder(folder: string): void {
  mkdirSync(join(folder, "tmp"), { recursive: true });
}

/**
 * Размер папки в байтах: сумма файлов во вложенных папках. Ссылки не
 * раскрываются; нечитаемое пропускается; нет папки — ноль.
 */
export function folderSize(folder: string): number {
  let total = 0;
  const pending = [folder];
  while (pending.length > 0) {
    const dir = pending.pop() as string;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      try {
        const info = lstatSync(join(dir, name));
        if (info.isDirectory()) pending.push(join(dir, name));
        else if (info.isFile()) total += info.size;
      } catch {
        // Файл удалён между чтением папки и stat — не в счёт.
      }
    }
  }
  return total;
}
