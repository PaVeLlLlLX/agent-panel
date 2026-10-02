/**
 * Живая проба Gemini: настоящий agy через адаптер панели.
 *
 * Проверяет то, что офлайн-тесты на фальшивом agy проверить не могут: вход по
 * подписке, правила «только чтение» в настоящей папке проекта (запись и
 * команда — явный отказ, файлы не меняются), чтение страниц, продолжение
 * разговора, квоту и — с флагом --keep-default-components — читает ли агент
 * без встроенной части agy файлы проекта, а не диска.
 *
 * Тратит квоту Google AI Pro. Нужны: agy со входом, правила «только чтение»
 * (кнопка «Добавить правила» в панели).
 *
 * Запуск: npm run build && node scripts/gemini-probe.mjs [--keep-default-components]
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { GeminiAdapter } = require("../out/adapters/gemini.js");
const { resolveGeminiCommand } = require("../out/geminiBinary.js");
const {
  agySettingsPath,
  checkReadOnlyRules,
  ensureReviewerAgent,
  reviewerAgentMarkdown,
  reviewerAgentPath,
  rulesRefusal,
} = require("../out/geminiSetup.js");
const { fetchGeminiUsage } = require("../out/geminiUsage.js");

const KEEP_DEFAULT = process.argv.includes("--keep-default-components");
const AGENT = KEEP_DEFAULT ? "agent-panel-reviewer-probe-full" : "agent-panel-reviewer-probe";

const launch = resolveGeminiCommand("agy", process.env.LOCALAPPDATA, process.env.PATH);
if (!launch) throw new Error("agy не найден");
const settings = agySettingsPath(homedir());
const refusal = rulesRefusal(checkReadOnlyRules(settings), settings);
if (refusal) throw new Error(`${refusal}. Добавьте правила кнопкой в панели и повторите.`);

const agentFile = join(homedir(), ".gemini", "config", "agents", AGENT, "agent.md");
mkdirSync(join(agentFile, ".."), { recursive: true });
writeFileSync(agentFile, reviewerAgentMarkdown(AGENT, !KEEP_DEFAULT));

const dir = mkdtempSync(join(tmpdir(), "agent-panel-gemini-"));
writeFileSync(join(dir, "train.py"), "SEED = 4817\n# StandardScaler().fit(X) до разбиения — утечка\n");
writeFileSync(join(dir, "data.csv"), "id,split,x,y\n1,train,0.1,0\n2,train,0.9,1\n2,test,0.8,1\n3,test,0.2,0\n");
execFileSync("git", ["init", "-q"], { cwd: dir });
execFileSync("git", ["-c", "user.email=probe@local", "-c", "user.name=probe", "add", "."], { cwd: dir });
execFileSync("git", ["-c", "user.email=probe@local", "-c", "user.name=probe", "commit", "-qm", "init"], { cwd: dir });
const before = execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" });

const events = [];
let conversation;
const make = (resume) =>
  new GeminiAdapter(
    {
      command: launch.command,
      shell: launch.shell,
      cwd: dir,
      agent: AGENT,
      model: "gemini-3.8-flash",
      effort: "low",
      // Как делает панель перед запуском Gemini: без этого агента
      // "agent-panel-reviewer" не существовало бы, а правила не проверялись бы повторно.
      beforeStart: () => {
        ensureReviewerAgent(reviewerAgentPath(homedir()));
        return rulesRefusal(checkReadOnlyRules(agySettingsPath(homedir())), agySettingsPath(homedir()));
      },
      ...(resume ? { resumeConversationId: resume } : {}),
      onSessionId: (id) => (conversation = id),
    },
    (e) => events.push(e),
  );
const turnEnd = async (from) => {
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    if (events.slice(from).some((e) => e.kind === "turn_completed" || (e.kind === "error" && e.failed))) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("ход не кончился за 5 минут");
};
const ask = async (adapter, text) => {
  const from = events.length;
  await adapter.send({ text, from: "human" });
  await turnEnd(from);
  return events.slice(from);
};

const a = make();
const read = await ask(a, "Прочитай train.py в папке проекта и назови значение SEED. Ответь только числом.");
const write = await ask(a, "Создай файл out.txt с текстом x, затем выполни команду echo probe. Одной строкой скажи, что удалось.");
const web = await ask(a, "Открой https://pypi.org/pypi/scikit-learn/json и назови info.version со ссылкой на страницу.");
await a.stop();
const b = make(conversation);
const resumed = await ask(b, "Какое значение SEED ты назвал в первом ответе этого разговора? Ответь только числом.");
await b.stop();
const usage = await fetchGeminiUsage({ command: launch.command, shell: launch.shell });
const after = execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" });

// Пути в параметрах вызовов — JSON-текст, обратные косые там удвоены.
const normalize = (s) => s.replace(/\\\\/g, "/").replace(/\\/g, "/").toLowerCase();
const absolutePaths = (text) => text.match(/[A-Za-z]:(?:\\\\|\\|\/)[^"]*/g) ?? [];
const readPaths = read.filter((e) => e.kind === "tool_call").flatMap((e) => absolutePaths(e.text ?? ""));
const report = {
  agent: AGENT,
  excludeDefaultComponents: !KEEP_DEFAULT,
  readAnswer: read.filter((e) => e.kind === "message").map((e) => e.text).join(" "),
  // Абсолютные пути инструментов чтения — все внутри папки проекта; относительные — внутри по определению.
  readInsideProject: readPaths.every((p) => normalize(p).startsWith(normalize(dir))),
  readTools: read.filter((e) => e.kind === "tool_call").map((e) => e.tool),
  readIncomplete: read.find((e) => e.kind === "turn_completed")?.incomplete ?? null,
  writeDenied: write.filter((e) => e.kind === "approval_decided").map((e) => e.text),
  filesUnchanged: before === after && !existsSync(join(dir, "out.txt")),
  webTools: web.filter((e) => e.kind === "tool_call").map((e) => e.tool),
  webAnswer: web.filter((e) => e.kind === "message").map((e) => e.text).join(" "),
  resumedAnswer: resumed.filter((e) => e.kind === "message").map((e) => e.text).join(" "),
  tokensPerTurn: [read, write, web, resumed].map((t) => t.find((e) => e.kind === "turn_completed")?.usage ?? null),
  usage,
};
// Пробный агент — не агент панели: в настройках владельца он не остаётся.
rmSync(join(agentFile, ".."), { recursive: true, force: true });
console.log(JSON.stringify(report, null, 1));
