/**
 * Сводка действий агента в одну строку: «Claude: 9 команд, 2 чтения».
 *
 * Работает и в webview (глобальный PanelFormat), и в node для тестов
 * (module.exports). Никаких обращений к DOM здесь быть не должно.
 */
(function () {
  function plural(n, формы) {
    const н = Math.abs(n) % 100;
    const е = н % 10;
    if (н > 10 && н < 20) return формы[2];
    if (е === 1) return формы[0];
    if (е >= 2 && е <= 4) return формы[1];
    return формы[2];
  }

  const ПАМЯТЬ = new Set(["mcp__om__remember", "mcp__om__record_work"]);
  const ВИДЫ = {
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
  };

  function toolCategory(имя) {
    if (ПАМЯТЬ.has(имя)) return "memory";
    if (ВИДЫ[имя]) return ВИДЫ[имя];
    if (typeof имя === "string" && имя.startsWith("mcp__")) return "mcp";
    return "other";
  }

  const ПОРЯДОК = ["command", "read", "edit", "search", "memory", "mcp", "other"];
  const ПОДПИСИ = {
    command: ["команда", "команды", "команд"],
    read: ["чтение", "чтения", "чтений"],
    edit: ["правка", "правки", "правок"],
    search: ["поиск", "поиска", "поисков"],
    memory: ["запись в память", "записи в память", "записей в память"],
    mcp: ["обращение к MCP", "обращения к MCP", "обращений к MCP"],
    other: ["прочее действие", "прочих действия", "прочих действий"],
  };

  function summarizeTools(имена) {
    const счёт = {};
    for (const имя of имена) {
      const вид = toolCategory(имя);
      счёт[вид] = (счёт[вид] || 0) + 1;
    }
    return ПОРЯДОК.filter((в) => счёт[в])
      .map((в) => `${счёт[в]} ${plural(счёт[в], ПОДПИСИ[в])}`)
      .join(", ");
  }

  /**
   * Следовать ли прокрутке за новым текстом: только если человек уже внизу.
   * Иначе генерация утягивает его от текста, который он читает выше.
   */
  function stickToBottom(scrollHeight, scrollTop, clientHeight, порог = 48) {
    return scrollHeight - scrollTop - clientHeight <= порог;
  }

  const api = { plural, toolCategory, summarizeTools, stickToBottom };
  globalThis.PanelFormat = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
