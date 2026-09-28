/**
 * Живая проба ответа «разрешить» настоящему Claude вне VS Code.
 *
 * Зачем. Форма запроса разрешения и ответ-отказ сняты с настоящего CLI, а
 * «разрешить» и «разрешить в сессии» проверялись только на фальшивом агенте
 * по контракту Agent SDK (README, «Ограничения»). Здесь — настоящий CLI:
 *   1. Write в режиме default → панель отвечает «разрешить» → файл появился;
 *   2. Bash → «разрешить в сессии» (updatedPermissions из подсказок CLI);
 *   3. та же команда ещё раз → нового запроса быть не должно;
 *   4–5. то же для команды без записи в файл;
 *   6–7. то же для mkdir (запись каталога).
 * Итог 28.09 (CLI 2.1.220): «разрешить» и «в сессии» работают; повторного
 * вопроса нет для python -c и mkdir -p, но команду с перенаправлением «>» в
 * файл CLI спрашивает снова — и с правилом, и с добавленной папкой
 * (addDirectories проверено временной правкой адаптера).
 * Всё во временной папке, модель — самая дешёвая из каталога.
 *
 * Запуск: npm run build && node scripts/permission-probe.mjs
 */
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { ClaudeAdapter } = require("../out/adapters/claude.js");

const dir = mkdtempSync(join(tmpdir(), "agent-panel-permission-"));
writeFileSync(join(dir, "README.md"), "Временная папка живой пробы разрешений agent-panel.\n");
const result = { dir, steps: [] };

const events = [];
let requestAnswer = "allow";
let adapter;

function sink(e) {
  events.push(e);
  if (e.kind === "approval_requested") {
    // Ответ сразу: агент ждёт control_response и без него не продолжит.
    void adapter.answerApproval(e.callId, requestAnswer);
  }
  events.wait?.(e);
}

function turn(text, limit = 180_000) {
  const start = events.length;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`нет turn_completed за ${limit / 1000} с`)), limit);
    events.wait = (e) => {
      if (e.kind === "turn_completed" || (e.kind === "error" && e.failed)) {
        clearTimeout(timer);
        resolve(events.slice(start));
      }
    };
    adapter.send({ text: text, from: "human" }).catch(reject);
  });
}

function summary(name, segment, check) {
  const requests = segment.filter((e) => e.kind === "approval_requested");
  const decisions = segment.filter((e) => e.kind === "approval_decided");
  const actions = segment.filter((e) => e.kind === "tool_call" || e.kind === "tool_result");
  const step = {
    name,
    requestCount: requests.length,
    requests: requests.map((e) => ({
      tool: e.tool,
      text: e.text,
      sessionRules: e.sessionRules,
      cliSuggestions: e.raw?.request?.permission_suggestions,
    })),
    decisions: decisions.map((e) => e.text),
    actions: actions.map((e) => `${e.kind}:${e.tool ?? ""}:${(e.text ?? "").slice(0, 120)}`),
    failed: segment.some((e) => e.kind === "error" && e.failed),
    ...check,
  };
  result.steps.push(step);
  return step;
}

const options = { command: "claude", cwd: dir, settingSources: "project,local", permissionMode: "default" };
const catalog = await new ClaudeAdapter(options, () => {}).listModels();
const cheapModel = catalog.find((m) => /haiku/i.test(`${m.id} ${m.label}`))?.id ?? "haiku";
adapter = new ClaudeAdapter({ ...options, model: cheapModel }, sink);

try {
  requestAnswer = "allow";
  const step1 = await turn(
    "Создай инструментом Write файл amber.txt в текущей папке с единственной строкой: янтарь. Больше ничего не делай, ответь одним словом: готово.",
  );
  const filePath1 = join(dir, "amber.txt");
  summary("1. Write → разрешить", step1, {
    file: existsSync(filePath1) ? readFileSync(filePath1, "utf8").trim() : null,
  });

  requestAnswer = "allowSession";
  const command = "echo one > bash-one.txt";
  const step2 = await turn(
    `Выполни инструментом Bash ровно эту команду и ничего больше: ${command}\nОтветь одним словом: готово.`,
  );
  summary("2. Bash → разрешить в сессии", step2, { file: existsSync(join(dir, "bash-one.txt")) });

  requestAnswer = "deny"; // если спросит повторно — правило не сработало, и выполнять не нужно
  const step3 = await turn(
    `Выполни инструментом Bash ещё раз ровно эту же команду: ${command}\nОтветь одним словом: готово.`,
  );
  summary("3. та же команда повторно", step3, {});

  const noWriteCommand = "python -c \"print(2+2)\"";
  requestAnswer = "allowSession";
  const step4 = await turn(`Выполни инструментом Bash ровно эту команду: ${noWriteCommand}
Ответь только её выводом.`);
  summary("4. Bash без записи → разрешить в сессии", step4, {});

  requestAnswer = "deny";
  const step5 = await turn(`Выполни инструментом Bash ещё раз ровно эту же команду: ${noWriteCommand}
Ответь только её выводом.`);
  summary("5. та же команда без записи повторно", step5, {});

  const mkdirCommand = "mkdir -p probe-dir";
  requestAnswer = "allowSession";
  const step6 = await turn(`Выполни инструментом Bash ровно эту команду: ${mkdirCommand}
Ответь одним словом: готово.`);
  summary("6. mkdir → разрешить в сессии", step6, { dir: existsSync(join(dir, "probe-dir")) });

  requestAnswer = "deny";
  const step7 = await turn(`Выполни инструментом Bash ещё раз ровно эту же команду: ${mkdirCommand}
Ответь одним словом: готово.`);
  summary("7. mkdir повторно", step7, {});
} catch (error) {
  result.error = String(error);
} finally {
  await adapter.stop();
}

console.log(JSON.stringify(result, null, 2));
