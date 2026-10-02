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
 *
 * **--deny-check** (I4, финальная рецензия 02.10): прежние прогоны видели
 * правило `deny` срабатывающим только на роли рецензента, которая сама не
 * пытается писать («Файлы не меняешь… ответь «принято»») — отказ «только
 * чтение» в ленте панели вообще не был замечен под её собственными
 * настройками (`excludeDefaultComponents: true`, те же `tools`). Этот режим
 * поднимает отдельного пробного агента с ТЕМИ ЖЕ фронт-маттером, что и
 * рецензент панели, но с нейтральной ролью, которая пытается писать и
 * выполнять команды, — чтобы увидеть сам отказ правила `deny`, а не
 * дисциплину роли. Пробный агент убирается в finally и не остаётся в
 * настройках владельца.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { GeminiAdapter } = require("../out/adapters/gemini.js");
const { resolveGeminiCommand } = require("../out/geminiBinary.js");
const { agySettingsPath, checkReadOnlyRules, reviewerAgentMarkdown, rulesRefusal } = require("../out/geminiSetup.js");
const { fetchGeminiUsage } = require("../out/geminiUsage.js");

const KEEP_DEFAULT = process.argv.includes("--keep-default-components");
const DENY_CHECK = process.argv.includes("--deny-check");
const AGENT = KEEP_DEFAULT ? "agent-panel-reviewer-probe-full" : "agent-panel-reviewer-probe";

const launch = resolveGeminiCommand("agy", process.env.LOCALAPPDATA, process.env.PATH);
if (!launch) throw new Error("agy не найден");
const settings = agySettingsPath(homedir());
const refusal = rulesRefusal(checkReadOnlyRules(settings), settings);
if (refusal) throw new Error(`${refusal}. Добавьте правила кнопкой в панели и повторите.`);

if (DENY_CHECK) {
  await runDenyCheck();
  process.exit(0);
}

/**
 * Тот же фронт-маттер, что у рецензента панели (reviewerAgentMarkdown),
 * но нейтральное тело роли: она не отказывается писать сама, поэтому отказ
 * правила deny (если он сработает) будет виден, а не скрыт дисциплиной роли.
 */
function denyProbeMarkdown(name) {
  const lines = reviewerAgentMarkdown(name, true).split("\n");
  const closing = lines.indexOf("---", 1);
  const front = lines.slice(0, closing + 1);
  return [
    ...front,
    "# Проверка правил «только чтение»",
    "",
    "Ты помощник. Выполняй просьбы пользователя: создавай файлы и запускай команды, когда просят.",
    "",
  ].join("\n");
}

async function runDenyCheck() {
  const name = "agent-panel-deny-probe";
  const agentFile = join(homedir(), ".gemini", "config", "agents", name, "agent.md");
  mkdirSync(join(agentFile, ".."), { recursive: true });
  writeFileSync(agentFile, denyProbeMarkdown(name));

  const dir = mkdtempSync(join(tmpdir(), "agent-panel-deny-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["-c", "user.email=probe@local", "-c", "user.name=probe", "add", "-A"], { cwd: dir });
  execFileSync("git", ["-c", "user.email=probe@local", "-c", "user.name=probe", "commit", "-qm", "init", "--allow-empty"], { cwd: dir });
  const before = execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" });

  const events = [];
  let a;
  try {
    a = new GeminiAdapter(
      { command: launch.command, shell: launch.shell, cwd: dir, agent: name, model: "gemini-3.8-flash", effort: "low" },
      (e) => events.push(e),
    );
    const from = events.length;
    await a.send({
      text: "Создай файл out.txt с текстом x, затем выполни команду echo probe.",
      from: "human",
    });
    const deadline = Date.now() + 5 * 60_000;
    while (Date.now() < deadline) {
      if (events.slice(from).some((e) => e.kind === "turn_completed" || (e.kind === "error" && e.failed))) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    const turn = events.slice(from);
    const after = execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" });
    const report = {
      agent: name,
      approvalDecided: turn.filter((e) => e.kind === "approval_decided").map((e) => e.text),
      toolResultErrors: turn.filter((e) => e.kind === "tool_result").map((e) => e.text),
      outTxtExists: existsSync(join(dir, "out.txt")),
      gitStatusUnchanged: before === after,
      turnCompleted: turn.find((e) => e.kind === "turn_completed") ?? null,
      message: turn.filter((e) => e.kind === "message").map((e) => e.text),
    };
    console.log(JSON.stringify(report, null, 1));
  } finally {
    await a?.stop();
    // Пробный агент — не агент панели: не остаётся в настройках владельца.
    rmSync(join(agentFile, ".."), { recursive: true, force: true });
  }
}

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

// a/b объявлены снаружи — чтобы finally видел их и остановил даже при сбое хода
// (например, когда turnEnd не дождался за 5 минут): иначе настоящий agy и
// пробный агент в ~/.gemini/config/agents остались бы висеть.
let a;
let b;
try {
  a = make();
  const read = await ask(a, "Прочитай train.py в папке проекта и назови значение SEED. Ответь только числом.");
  const write = await ask(a, "Создай файл out.txt с текстом x, затем выполни команду echo probe. Одной строкой скажи, что удалось.");
  const web = await ask(a, "Открой https://pypi.org/pypi/scikit-learn/json и назови info.version со ссылкой на страницу.");
  await a.stop();
  b = make(conversation);
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
  console.log(JSON.stringify(report, null, 1));
} finally {
  await a?.stop();
  await b?.stop();
  // Пробный агент — не агент панели: в настройках владельца он не остаётся, даже при сбое хода.
  rmSync(join(agentFile, ".."), { recursive: true, force: true });
}
