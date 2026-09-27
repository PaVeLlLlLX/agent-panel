/**
 * Живая проба гонки: сообщение панели уходит, когда CLI уже начал свой
 * запрос (кончилась фоновая команда), а его init до адаптера ещё не дошёл.
 *
 * Зачем. Рецензия Codex 28.09: по занятости адаптера такой запрос не отличить
 * от ответа на сообщение. Адаптер различает их по эху (--replay-user-messages).
 * Окно гонки — доли секунды, поэтому здесь оно растянуто: между адаптером и
 * настоящим CLI стоит посредник (этот же файл с --proxy). Увидев
 * task_notification, он пишет метку в stderr и придерживает следующие
 * строки 2 с; проба по метке сразу шлёт сообщение.
 *
 * Ожидается: первым кончается ход CLI с unsolicited, вторым — ответ на
 * сообщение, без unsolicited и с его текстом.
 *
 * Запуск: npm run build && node scripts/race-probe.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const НС = String.fromCharCode(10);
const МЕТКА = "ПРОКСИ-УВЕДОМЛЕНИЕ";

if (process.argv[2] === "--proxy") {
  // Посредник: stdin → CLI как есть; stdout CLI → наружу, после
  // task_notification — с задержкой 2 с, порядок строк сохраняется.
  const cli = spawn("claude", process.argv.slice(3), { shell: true, windowsHide: true });
  process.stdin.pipe(cli.stdin);
  cli.stderr.pipe(process.stderr);
  // Строки после уведомления ждут до одной общей отметки времени — 2 с разом,
  // а не по 2 с на строку.
  let держатьДо = 0;
  let хвост = Promise.resolve();
  createInterface({ input: cli.stdout }).on("line", (строка) => {
    const до = держатьДо;
    хвост = хвост
      .then(() => new Promise((r) => setTimeout(r, Math.max(0, до - Date.now()))))
      .then(() => process.stdout.write(строка + НС));
    if (строка.includes('"subtype":"task_notification"') && !держатьДо) {
      process.stderr.write(МЕТКА + НС);
      держатьДо = Date.now() + 2000;
    }
  });
  cli.on("exit", (код) => хвост.then(() => process.exit(код ?? 0)));
} else {
  const require = createRequire(import.meta.url);
  const { ClaudeAdapter } = require("../out/adapters/claude.js");
  const папка = mkdtempSync(join(tmpdir(), "agent-panel-race-"));
  writeFileSync(join(папка, "README.md"), "Временная папка пробы гонки agent-panel.\n");
  const t0 = Date.now();
  const время = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
  const события = [];
  let адаптер;
  let послано = false;
  const концы = [];
  адаптер = new ClaudeAdapter(
    {
      command: "node",
      commandArgs: [fileURLToPath(import.meta.url), "--proxy"],
      cwd: папка,
      model: "haiku",
      permissionMode: "bypassPermissions",
      settingSources: "project,local",
    },
    (е) => {
      события.push(е);
      if (["turn_started", "turn_completed", "message"].includes(е.kind)) {
        console.log(время(), е.kind, е.unsolicited ? "[unsolicited]" : "", (е.text ?? "").slice(0, 90).replace(/\s+/g, " "), `busy=${адаптер.busy}`);
      }
      if (е.kind === "turn_completed") концы.push(е);
      if (е.kind === "diagnostic" && (е.text ?? "").includes(МЕТКА) && !послано) {
        послано = true;
        console.log(время(), "метка посредника — шлём сообщение, init CLI ещё в пути");
        void адаптер.send({ text: "Ответь одним словом: второе.", from: "human" });
      }
    },
  );
  const ждать = (условие, предел) =>
    new Promise((resolve, reject) => {
      const конец = Date.now() + предел;
      const т = setInterval(() => {
        if (условие()) {
          clearInterval(т);
          resolve();
        } else if (Date.now() > конец) {
          clearInterval(т);
          reject(new Error("не дождались"));
        }
      }, 200);
    });
  try {
    await адаптер.send({
      text: "Запусти инструментом Bash с параметром run_in_background: true команду: sleep 8; echo поздно > late.txt\nНе жди её. Сразу ответь одним словом: запущено.",
      from: "human",
    });
    await ждать(() => концы.length >= 1, 120_000);
    await ждать(() => концы.length >= 3, 120_000);
    const [, чужой, свой] = концы;
    const ответ = события.filter((е) => е.kind === "message" && е.agent === "claude").map((е) => е.text).join(" | ");
    console.log(
      JSON.stringify(
        {
          послано,
          второйКонецСамостоятельный: чужой?.unsolicited === true,
          третийКонецСамостоятельный: свой?.unsolicited === true,
          реплики: ответ,
        },
        null,
        1,
      ),
    );
  } catch (беда) {
    console.log("ОШИБКА", String(беда), "концов:", концы.length);
  } finally {
    await адаптер.stop();
    process.exit(0);
  }
}
