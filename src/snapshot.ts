/**
 * Снимок версии файлов: к чему относится замечание рецензента.
 *
 * Зачем. Рецензент читает код, пишет замечание, а разработчик за это время
 * успевает его переписать. Без привязки замечания к версии два агента начнут
 * спорить о разных состояниях кода, и спор будет выглядеть как разногласие по
 * существу. Это прямое требование постановки.
 *
 * Снимок — это не копия файлов, а отпечаток: коммит, хеш от diff
 * отслеживаемых файлов и хеши СОДЕРЖИМОГО неотслеживаемых.
 *
 * Последнее пришлось исправлять. Первая версия брала неотслеживаемые
 * файлы только по ИМЕНАМ: разработчик мог целиком переписать новый файл
 * до `git add`, а отпечаток оставался прежним — то есть привязка к версии
 * молча перестала бы работать ровно там, где идёт активная работа.
 *
 * Если каталог не является git-репозиторием, снимок всё равно выдаётся —
 * по хешам содержимого файлов. Отсутствие git не должно молча отключать
 * привязку к версии: тогда исчезло бы само свойство, ради которого модуль
 * написан. Такой снимок всегда помечен dirty и source=filesystem, чтобы
 * «нет git» не выглядело как «чисто».
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

export interface Snapshot {
  /** Короткий отпечаток для показа и для пометки событий. */
  readonly id: string;
  /** Коммит, если это git-репозиторий. */
  readonly commit: string | undefined;
  /** Есть ли незакоммиченные изменения. */
  readonly dirty: boolean;
  readonly at: number;
  /** Как получен: важно, чтобы «нет git» не выглядело как «чисто». */
  readonly source: "git" | "filesystem";
}

const SKIP = new Set([
  ".git",
  "node_modules",
  "out",
  "__pycache__",
  ".venv",
  "data",
]);

export async function takeSnapshot(cwd: string): Promise<Snapshot> {
  try {
    const { stdout: commit } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd,
    });
    // Учитываются и отслеживаемые изменения, и неотслеживаемые файлы:
    // правка в новом файле — такое же изменение версии, как и в старом.
    const { stdout: diff } = await execFileAsync(
      "git",
      ["diff", "HEAD", "--", "."],
      { cwd, maxBuffer: 64 * 1024 * 1024 },
    );
    const { stdout: untracked } = await execFileAsync(
      "git",
      ["ls-files", "--others", "--exclude-standard", "-z"],
      { cwd, maxBuffer: 16 * 1024 * 1024 },
    );
    const newFiles = untracked.split("\0").filter((it) => it.length > 0);
    const dirty = diff.trim().length > 0 || newFiles.length > 0;
    const hash = createHash("sha256")
      .update(commit.trim())
      .update(diff);
    // Содержимое, а не только имена: см. описание модуля.
    for (const name of newFiles.sort()) {
      hash.update(name);
      hash.update(await contentHash(join(cwd, name)));
    }
    const fingerprint = hash.digest("hex").slice(0, 12);
    return {
      id: fingerprint,
      commit: commit.trim(),
      dirty: dirty,
      at: Date.now(),
      source: "git",
    };
  } catch {
    return fsSnapshot(cwd);
  }
}

/**
 * Хеш содержимого файла.
 *
 * Недоступный файл даёт не пустую строку, а отметку о недоступности:
 * иначе два разных нечитаемых файла выглядели бы одинаково, и отпечаток
 * перестал бы различать состояния.
 */
async function contentHash(filePath: string): Promise<string> {
  try {
    const data = await readFile(filePath);
    return createHash("sha256").update(data).digest("hex");
  } catch (err) {
    return `недоступен:${(err as Error).message}`;
  }
}

async function fsSnapshot(cwd: string): Promise<Snapshot> {
  const hash = createHash("sha256");
  await walk(cwd, cwd, hash, 0);
  return {
    id: hash.digest("hex").slice(0, 12),
    commit: undefined,
    dirty: true,
    at: Date.now(),
    source: "filesystem",
  };
}

async function walk(
  root: string,
  catalog: string,
  hash: ReturnType<typeof createHash>,
  isDeep: number,
): Promise<void> {
  if (isDeep > 6) return;
  let entries: string[];
  try {
    entries = (await readdir(catalog)).sort();
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP.has(name)) continue;
    const filePath = join(catalog, name);
    try {
      const stats = await stat(filePath);
      if (stats.isDirectory()) {
        await walk(root, filePath, hash, isDeep + 1);
      } else {
        hash.update(filePath.slice(root.length));
        // Содержимое, а не размер со временем: правка той же длины не
        // меняет ни размер, ни (на грубых файловых системах) mtime.
        hash.update(await contentHash(filePath));
      }
    } catch {
      // Недоступный файл пропускается, но это не делает снимок «чистым»:
      // source остаётся filesystem, dirty остаётся true.
    }
  }
}

/** Человекочитаемое описание для шапки реплики. */
export function describeSnapshot(s: Snapshot): string {
  const base =
    s.source === "git"
      ? `${s.commit?.slice(0, 8) ?? "?"}${s.dirty ? "+правки" : ""}`
      : "без git";
  return `${base} (${s.id})`;
}
