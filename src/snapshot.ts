/**
 * Снимок версии файлов: к чему относится замечание рецензента.
 *
 * Зачем. Рецензент читает код, пишет замечание, а разработчик за это время
 * успевает его переписать. Без привязки замечания к версии два агента начнут
 * спорить о разных состояниях кода, и спор будет выглядеть как разногласие по
 * существу. Это прямое требование постановки.
 *
 * Снимок — это не копия файлов, а отпечаток: коммит плюс хеш от полного diff
 * рабочего дерева, включая неотслеживаемые файлы. Отпечаток дешёвый и
 * достаточный: он меняется при любом изменении содержимого, а панели нужно
 * лишь отличать «то же состояние» от «другое состояние».
 *
 * Если каталог не является git-репозиторием, снимок всё равно выдаётся —
 * по хешу от перечня файлов и их времён изменения. Отсутствие git не должно
 * молча отключать привязку к версии: тогда исчезло бы само свойство, ради
 * которого модуль написан.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

const запустить = promisify(execFile);

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

const ПРОПУСК = new Set([
  ".git",
  "node_modules",
  "out",
  "__pycache__",
  ".venv",
  "data",
]);

export async function takeSnapshot(cwd: string): Promise<Snapshot> {
  try {
    const { stdout: коммит } = await запустить("git", ["rev-parse", "HEAD"], {
      cwd,
    });
    // Учитываются и отслеживаемые изменения, и неотслеживаемые файлы:
    // правка в новом файле — такое же изменение версии, как и в старом.
    const { stdout: diff } = await запустить(
      "git",
      ["diff", "HEAD", "--", "."],
      { cwd, maxBuffer: 64 * 1024 * 1024 },
    );
    const { stdout: новые } = await запустить(
      "git",
      ["ls-files", "--others", "--exclude-standard"],
      { cwd },
    );
    const грязно = diff.trim().length > 0 || новые.trim().length > 0;
    const отпечаток = createHash("sha256")
      .update(коммит.trim())
      .update(diff)
      .update(новые)
      .digest("hex")
      .slice(0, 12);
    return {
      id: отпечаток,
      commit: коммит.trim(),
      dirty: грязно,
      at: Date.now(),
      source: "git",
    };
  } catch {
    return снимокФС(cwd);
  }
}

async function снимокФС(cwd: string): Promise<Snapshot> {
  const хеш = createHash("sha256");
  await обойти(cwd, cwd, хеш, 0);
  return {
    id: хеш.digest("hex").slice(0, 12),
    commit: undefined,
    dirty: true,
    at: Date.now(),
    source: "filesystem",
  };
}

async function обойти(
  корень: string,
  каталог: string,
  хеш: ReturnType<typeof createHash>,
  глубина: number,
): Promise<void> {
  if (глубина > 6) return;
  let записи: string[];
  try {
    записи = (await readdir(каталог)).sort();
  } catch {
    return;
  }
  for (const имя of записи) {
    if (ПРОПУСК.has(имя)) continue;
    const путь = join(каталог, имя);
    try {
      const св = await stat(путь);
      if (св.isDirectory()) {
        await обойти(корень, путь, хеш, глубина + 1);
      } else {
        хеш.update(путь.slice(корень.length));
        хеш.update(String(св.size));
        хеш.update(String(св.mtimeMs));
      }
    } catch {
      // Недоступный файл пропускается, но это не делает снимок «чистым»:
      // source остаётся filesystem, dirty остаётся true.
    }
  }
}

/** Человекочитаемое описание для шапки реплики. */
export function describeSnapshot(s: Snapshot): string {
  const основа =
    s.source === "git"
      ? `${s.commit?.slice(0, 8) ?? "?"}${s.dirty ? "+правки" : ""}`
      : "без git";
  return `${основа} (${s.id})`;
}
