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
      ["ls-files", "--others", "--exclude-standard", "-z"],
      { cwd, maxBuffer: 16 * 1024 * 1024 },
    );
    const списокНовых = новые.split("\0").filter((и) => и.length > 0);
    const грязно = diff.trim().length > 0 || списокНовых.length > 0;
    const хеш = createHash("sha256")
      .update(коммит.trim())
      .update(diff);
    // Содержимое, а не только имена: см. описание модуля.
    for (const имя of списокНовых.sort()) {
      хеш.update(имя);
      хеш.update(await хешСодержимого(join(cwd, имя)));
    }
    const отпечаток = хеш.digest("hex").slice(0, 12);
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

/**
 * Хеш содержимого файла.
 *
 * Недоступный файл даёт не пустую строку, а отметку о недоступности:
 * иначе два разных нечитаемых файла выглядели бы одинаково, и отпечаток
 * перестал бы различать состояния.
 */
async function хешСодержимого(путь: string): Promise<string> {
  try {
    const данные = await readFile(путь);
    return createHash("sha256").update(данные).digest("hex");
  } catch (беда) {
    return `недоступен:${(беда as Error).message}`;
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
        // Содержимое, а не размер со временем: правка той же длины не
        // меняет ни размер, ни (на грубых файловых системах) mtime.
        хеш.update(await хешСодержимого(путь));
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
