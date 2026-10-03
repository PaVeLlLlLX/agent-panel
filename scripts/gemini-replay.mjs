/**
 * Следы повтора проверки для scripts/gemini-probe.mjs --timing: что модель
 * открыла и где искала. Вынесено из пробы, потому что проба при импорте сразу
 * ищет agy и проверяет правила, а эти функции проверяются тестом
 * (test/gemini-replay.test.mjs).
 */

/** Строковый параметр вызова по одному из имён без учёта регистра (AbsolutePath, Url, query…). */
function paramOf(parameters, ...names) {
  for (const [key, value] of Object.entries(parameters ?? {})) {
    if (names.includes(key.toLowerCase()) && typeof value === "string") return value;
  }
  return null;
}

const slashes = (p) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

/**
 * Что модель открыла и где искала — для чек-листа повтора проверки (заголовок
 * gemini-probe.mjs): файлы, поиски по файлам, веб, правила проекта, границы папки.
 * Роль велит искать и читать только в папке проекта, поэтому границу папки,
 * сохранённые страницы agy и `.env` проверяют и открытые файлы (view_file), и
 * места поиска (grep_search, find_by_name, list_dir) — в порядке вызовов.
 */
export function replayTrace(trace, cwd) {
  const outcome = (c) => ({ state: c.state, ...(c.error ? { error: c.error } : {}) });
  const searchTools = ["grep_search", "find_by_name", "list_dir"];
  const fileOf = (c) => paramOf(c.parameters, "absolutepath", "path", "file_path");
  const searchOf = (c) => paramOf(c.parameters, "searchpath", "searchdirectory", "directorypath", "path");
  const filesOpened = trace
    .filter((c) => c.tool === "view_file")
    .map((c) => ({ path: fileOf(c), ...outcome(c) }));
  const fileSearches = trace
    .filter((c) => searchTools.includes(c.tool))
    .map((c) => ({ tool: c.tool, path: searchOf(c), parameters: c.parameters, ...outcome(c) }));
  const webCalls = trace
    .filter((c) => c.tool === "search_web" || c.tool === "read_url_content")
    .map((c) => ({ tool: c.tool, target: paramOf(c.parameters, "url", "query"), ...outcome(c) }));
  const root = slashes(cwd);
  const opened = filesOpened.map((f) => f.path).filter((p) => p);
  const touched = trace
    .map((c) => (c.tool === "view_file" ? fileOf(c) : searchTools.includes(c.tool) ? searchOf(c) : null))
    .filter((p) => p);
  const inside = (p) => slashes(p) === root || slashes(p).startsWith(`${root}/`);
  const isBrain = (p) => /\/\.gemini\/antigravity-cli\/brain\//.test(slashes(p));
  return {
    readGeminiMd: opened.some((p) => slashes(p) === `${root}/gemini.md`),
    readAgentsMd: opened.some((p) => slashes(p) === `${root}/agents.md`),
    brainReads: touched.filter(isBrain).length,
    outsideProject: touched.filter((p) => !inside(p) && !isBrain(p)),
    envOpened: touched.filter((p) => /(^|\/)\.env(\.|$)/.test(slashes(p))),
    webCallCount: webCalls.length,
    filesOpened,
    fileSearches,
    webCalls,
    otherTools: trace
      .filter((c) => !["view_file", ...searchTools, "search_web", "read_url_content"].includes(c.tool))
      .map((c) => ({ tool: c.tool, parameters: c.parameters, ...outcome(c) })),
  };
}
