/**
 * Фальшивый Antigravity CLI (agy) для проверки панели.
 *
 * Повторяет формат, снятый живой пробой 02.10.2026
 * (docs/research/2026-10-02-проба-agy.md):
 *   agy models                             — строки «slug<TAB>название»;
 *   agy -p /usage --output-format json     — квота без хода модели.
 * Лежит вне test/ по той же причине, что fake-claude.mjs: читает stdin.
 */
const argv = process.argv.slice(2);
const writeLine = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

if (argv[0] === "models") {
  process.stderr.write("Fetching available models...\n");
  process.stdout.write(
    [
      "gemini-3.8-flash-high\tGemini 3.8 Flash (High)",
      "gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)",
      "gemini-3.8-flash-low\tGemini 3.8 Flash (Low)",
      "gemini-3.1-pro-high\tGemini 3.1 Pro (High)",
      "gemini-3.1-pro-low\tGemini 3.1 Pro (Low)",
      "claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)",
      "gpt-oss-120b-medium\tGPT-OSS 120B (Medium)",
    ].join("\n") + "\n",
  );
  process.exit(0);
}

if (argv.includes("/usage")) {
  const bucket = (window, left, reset) => ({ window, remaining_fraction: left, reset_time: reset });
  writeLine({
    conversation_id: "",
    status: "SUCCESS",
    response: "",
    num_turns: 0,
    usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 },
    command: { name: "usage", data: { groups: [
      { name: "Gemini Models", buckets: [bucket("weekly", 0.97, "2026-10-09T07:36:04Z"), bucket("5h", 0.89, "2026-10-02T12:36:04Z")] },
      { name: "Claude and GPT models", buckets: [bucket("weekly", 1, "2026-10-09T07:39:51Z")] },
    ] } },
  });
  process.exit(0);
}
