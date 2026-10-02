/**
 * Сводка действий агента в одну строку: «Claude: 9 команд, 2 чтения».
 *
 * Работает и в webview (глобальный PanelFormat), и в node для тестов
 * (module.exports). Никаких обращений к DOM здесь быть не должно.
 */
(function () {
  function plural(n, forms) {
    const lastTwo = Math.abs(n) % 100;
    const lastDigit = lastTwo % 10;
    if (lastTwo > 10 && lastTwo < 20) return forms[2];
    if (lastDigit === 1) return forms[0];
    if (lastDigit >= 2 && lastDigit <= 4) return forms[1];
    return forms[2];
  }

  const MEMORY_TOOLS = new Set(["mcp__om__remember", "mcp__om__record_work"]);
  const KINDS = {
    Bash: "command",
    commandExecution: "command",
    Read: "read",
    Write: "edit",
    Edit: "edit",
    MultiEdit: "edit",
    NotebookEdit: "edit",
    fileChange: "edit",
    Glob: "search",
    Grep: "search",
    webSearch: "search",
    mcpToolCall: "mcp",
    dynamicToolCall: "mcp",
    // Antigravity CLI (agy) — инструменты Gemini (проба 02.10.2026).
    view_file: "read",
    read_url_content: "read",
    grep_search: "search",
    find_by_name: "search",
    list_dir: "search",
    search_web: "search",
    run_command: "command",
    write_to_file: "edit",
    replace_file_content: "edit",
    multi_replace_file_content: "edit",
  };

  function toolCategory(name) {
    if (MEMORY_TOOLS.has(name)) return "memory";
    if (KINDS[name]) return KINDS[name];
    if (typeof name === "string" && name.startsWith("mcp__")) return "mcp";
    return "other";
  }

  const ORDER = ["command", "read", "edit", "search", "memory", "mcp", "other"];
  const CAPTIONS = {
    command: ["команда", "команды", "команд"],
    read: ["чтение", "чтения", "чтений"],
    edit: ["правка", "правки", "правок"],
    search: ["поиск", "поиска", "поисков"],
    memory: ["запись в память", "записи в память", "записей в память"],
    mcp: ["обращение к MCP", "обращения к MCP", "обращений к MCP"],
    other: ["прочее действие", "прочих действия", "прочих действий"],
  };

  function summarizeTools(names) {
    const counts = {};
    for (const name of names) {
      const kind = toolCategory(name);
      counts[kind] = (counts[kind] || 0) + 1;
    }
    return ORDER.filter((v) => counts[v])
      .map((v) => `${counts[v]} ${plural(counts[v], CAPTIONS[v])}`)
      .join(", ");
  }

  /**
   * Следовать ли прокрутке за новым текстом: только если человек уже внизу.
   * Иначе генерация утягивает его от текста, который он читает выше.
   */
  function stickToBottom(scrollHeight, scrollTop, clientHeight, threshold = 48) {
    return scrollHeight - scrollTop - clientHeight <= threshold;
  }

  const api = { plural, toolCategory, summarizeTools, stickToBottom };
  globalThis.PanelFormat = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
