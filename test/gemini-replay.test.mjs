/**
 * Следы повтора проверки (scripts/gemini-probe.mjs --timing): что модель
 * открыла и где искала. Роль велит искать и читать файлы только в папке
 * проекта; поиск — тоже обращение к файлам. В проверке Trading 02.10 Gemini
 * 21 раз открыл сохранённые копии страниц view_file и ещё 5 раз искал в них
 * grep_search (seq 54925–54976) — след только по view_file насчитал бы 21 из 26.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { replayTrace } from "../scripts/gemini-replay.mjs";

const root = "C:/Users/21435/source/Trading";
const brain = "C:\\Users\\21435\\.gemini\\antigravity-cli\\brain\\4a9a254d\\.system_generated\\steps\\74\\content.md";
const call = (tool, parameters, state = "DONE") => ({ tool, parameters, state });

test("повтор: поиск вне папки проекта виден так же, как открытый там файл", () => {
  const replay = replayTrace(
    [
      call("view_file", { AbsolutePath: "c:\\Users\\21435\\source\\Trading\\GEMINI.md" }),
      // Сама папка проекта — внутри (так Gemini искал 02.10, seq 54901).
      call("grep_search", { Query: "e-disclosure", SearchPath: "c:\\Users\\21435\\source\\Trading" }),
      call("list_dir", { DirectoryPath: "c:\\Users\\21435\\source\\Trading\\docs" }),
      call("grep_search", { Query: "дивиденд", SearchPath: "C:\\Users\\21435\\Documents\\trading-memory" }),
      call("find_by_name", { Pattern: "*.md", SearchDirectory: "C:\\" }),
      call("view_file", { AbsolutePath: "C:\\Users\\21435\\Documents\\note.md" }),
    ],
    root,
  );
  assert.equal(replay.readGeminiMd, true);
  assert.deepEqual(replay.outsideProject, [
    "C:\\Users\\21435\\Documents\\trading-memory",
    "C:\\",
    "C:\\Users\\21435\\Documents\\note.md",
  ]);
  assert.deepEqual(
    replay.fileSearches.map((s) => s.path),
    ["c:\\Users\\21435\\source\\Trading", "c:\\Users\\21435\\source\\Trading\\docs", "C:\\Users\\21435\\Documents\\trading-memory", "C:\\"],
  );
});

test("повтор: сохранённые страницы agy считаются и по поиску в них, вне папки они не числятся", () => {
  const replay = replayTrace(
    [
      call("view_file", { AbsolutePath: brain }),
      call("grep_search", { Query: "раскрыти", SearchPath: brain }),
      call("grep_search", { Query: "аккредитац", SearchPath: brain }),
    ],
    root,
  );
  assert.equal(replay.brainReads, 3);
  assert.deepEqual(replay.outsideProject, []);
});

test("повтор: .env — и открытый, и прочитанный поиском", () => {
  const replay = replayTrace(
    [
      call("view_file", { AbsolutePath: "c:\\Users\\21435\\source\\Trading\\.env" }),
      call("grep_search", { Query: "TOKEN", SearchPath: "c:\\Users\\21435\\source\\Trading\\.env.local" }),
      call("view_file", { AbsolutePath: "c:\\Users\\21435\\source\\Trading\\docs\\env.md" }),
    ],
    root,
  );
  assert.deepEqual(replay.envOpened, ["c:\\Users\\21435\\source\\Trading\\.env", "c:\\Users\\21435\\source\\Trading\\.env.local"]);
  assert.equal(replay.readGeminiMd, false);
});
