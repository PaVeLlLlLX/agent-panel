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

const папка = mkdtempSync(join(tmpdir(), "agent-panel-permission-"));
writeFileSync(join(папка, "README.md"), "Временная папка живой пробы разрешений agent-panel.\n");
const итог = { папка, шаги: [] };

const события = [];
let ответНаЗапрос = "allow";
let адаптер;

function приёмник(е) {
  события.push(е);
  if (е.kind === "approval_requested") {
    // Ответ сразу: агент ждёт control_response и без него не продолжит.
    void адаптер.answerApproval(е.callId, ответНаЗапрос);
  }
  события.ждать?.(е);
}

function ход(текст, предел = 180_000) {
  const начало = события.length;
  return new Promise((resolve, reject) => {
    const таймер = setTimeout(() => reject(new Error(`нет turn_completed за ${предел / 1000} с`)), предел);
    события.ждать = (е) => {
      if (е.kind === "turn_completed" || (е.kind === "error" && е.failed)) {
        clearTimeout(таймер);
        resolve(события.slice(начало));
      }
    };
    адаптер.send({ text: текст, from: "human" }).catch(reject);
  });
}

function сводка(имя, отрезок, проверка) {
  const запросы = отрезок.filter((е) => е.kind === "approval_requested");
  const решения = отрезок.filter((е) => е.kind === "approval_decided");
  const действия = отрезок.filter((е) => е.kind === "tool_call" || е.kind === "tool_result");
  const шаг = {
    имя,
    запросов: запросы.length,
    запросы: запросы.map((е) => ({
      tool: е.tool,
      text: е.text,
      sessionRules: е.sessionRules,
      подсказкиCLI: е.raw?.request?.permission_suggestions,
    })),
    решения: решения.map((е) => е.text),
    действия: действия.map((е) => `${е.kind}:${е.tool ?? ""}:${(е.text ?? "").slice(0, 120)}`),
    провал: отрезок.some((е) => е.kind === "error" && е.failed),
    ...проверка,
  };
  итог.шаги.push(шаг);
  return шаг;
}

const опции = { command: "claude", cwd: папка, settingSources: "project,local", permissionMode: "default" };
const каталог = await new ClaudeAdapter(опции, () => {}).listModels();
const дешёвая = каталог.find((м) => /haiku/i.test(`${м.id} ${м.label}`))?.id ?? "haiku";
адаптер = new ClaudeAdapter({ ...опции, model: дешёвая }, приёмник);

try {
  ответНаЗапрос = "allow";
  const ш1 = await ход(
    "Создай инструментом Write файл amber.txt в текущей папке с единственной строкой: янтарь. Больше ничего не делай, ответь одним словом: готово.",
  );
  const путь1 = join(папка, "amber.txt");
  сводка("1. Write → разрешить", ш1, {
    файл: existsSync(путь1) ? readFileSync(путь1, "utf8").trim() : null,
  });

  ответНаЗапрос = "allowSession";
  const команда = "echo one > bash-one.txt";
  const ш2 = await ход(
    `Выполни инструментом Bash ровно эту команду и ничего больше: ${команда}\nОтветь одним словом: готово.`,
  );
  сводка("2. Bash → разрешить в сессии", ш2, { файл: existsSync(join(папка, "bash-one.txt")) });

  ответНаЗапрос = "deny"; // если спросит повторно — правило не сработало, и выполнять не нужно
  const ш3 = await ход(
    `Выполни инструментом Bash ещё раз ровно эту же команду: ${команда}\nОтветь одним словом: готово.`,
  );
  сводка("3. та же команда повторно", ш3, {});

  const безЗаписи = "python -c \"print(2+2)\"";
  ответНаЗапрос = "allowSession";
  const ш4 = await ход(`Выполни инструментом Bash ровно эту команду: ${безЗаписи}
Ответь только её выводом.`);
  сводка("4. Bash без записи → разрешить в сессии", ш4, {});

  ответНаЗапрос = "deny";
  const ш5 = await ход(`Выполни инструментом Bash ещё раз ровно эту же команду: ${безЗаписи}
Ответь только её выводом.`);
  сводка("5. та же команда без записи повторно", ш5, {});

  const папкаКоманда = "mkdir -p probe-dir";
  ответНаЗапрос = "allowSession";
  const ш6 = await ход(`Выполни инструментом Bash ровно эту команду: ${папкаКоманда}
Ответь одним словом: готово.`);
  сводка("6. mkdir → разрешить в сессии", ш6, { папка: existsSync(join(папка, "probe-dir")) });

  ответНаЗапрос = "deny";
  const ш7 = await ход(`Выполни инструментом Bash ещё раз ровно эту же команду: ${папкаКоманда}
Ответь одним словом: готово.`);
  сводка("7. mkdir повторно", ш7, {});
} catch (ошибка) {
  итог.ошибка = String(ошибка);
} finally {
  await адаптер.stop();
}

console.log(JSON.stringify(итог, null, 2));
