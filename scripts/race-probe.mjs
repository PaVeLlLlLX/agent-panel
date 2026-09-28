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

const NL = String.fromCharCode(10);
const MARKER = "ПРОКСИ-УВЕДОМЛЕНИЕ";

if (process.argv[2] === "--proxy") {
  // Посредник: stdin → CLI как есть; stdout CLI → наружу, после
  // task_notification — с задержкой 2 с, порядок строк сохраняется.
  const cli = spawn("claude", process.argv.slice(3), { shell: true, windowsHide: true });
  process.stdin.pipe(cli.stdin);
  cli.stderr.pipe(process.stderr);
  // Строки после уведомления ждут до одной общей отметки времени — 2 с разом,
  // а не по 2 с на строку.
  let holdUntil = 0;
  let tail = Promise.resolve();
  createInterface({ input: cli.stdout }).on("line", (line) => {
    const until = holdUntil;
    tail = tail
      .then(() => new Promise((r) => setTimeout(r, Math.max(0, until - Date.now()))))
      .then(() => process.stdout.write(line + NL));
    if (line.includes('"subtype":"task_notification"') && !holdUntil) {
      process.stderr.write(MARKER + NL);
      holdUntil = Date.now() + 2000;
    }
  });
  cli.on("exit", (code) => tail.then(() => process.exit(code ?? 0)));
} else {
  const require = createRequire(import.meta.url);
  const { ClaudeAdapter } = require("../out/adapters/claude.js");
  const dir = mkdtempSync(join(tmpdir(), "agent-panel-race-"));
  writeFileSync(join(dir, "README.md"), "Временная папка пробы гонки agent-panel.\n");
  const t0 = Date.now();
  const time = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
  const events = [];
  let adapter;
  let sent = false;
  const ends = [];
  adapter = new ClaudeAdapter(
    {
      command: "node",
      commandArgs: [fileURLToPath(import.meta.url), "--proxy"],
      cwd: dir,
      model: "haiku",
      permissionMode: "bypassPermissions",
      settingSources: "project,local",
    },
    (e) => {
      events.push(e);
      if (["turn_started", "turn_completed", "message"].includes(e.kind)) {
        console.log(time(), e.kind, e.unsolicited ? "[unsolicited]" : "", (e.text ?? "").slice(0, 90).replace(/\s+/g, " "), `busy=${adapter.busy}`);
      }
      if (e.kind === "turn_completed") ends.push(e);
      if (e.kind === "diagnostic" && (e.text ?? "").includes(MARKER) && !sent) {
        sent = true;
        console.log(time(), "метка посредника — шлём сообщение, init CLI ещё в пути");
        void adapter.send({ text: "Ответь одним словом: второе.", from: "human" });
      }
    },
  );
  const wait = (condition, limit) =>
    new Promise((resolve, reject) => {
      const end = Date.now() + limit;
      const t = setInterval(() => {
        if (condition()) {
          clearInterval(t);
          resolve();
        } else if (Date.now() > end) {
          clearInterval(t);
          reject(new Error("не дождались"));
        }
      }, 200);
    });
  try {
    await adapter.send({
      text: "Запусти инструментом Bash с параметром run_in_background: true команду: sleep 8; echo поздно > late.txt\nНе жди её. Сразу ответь одним словом: запущено.",
      from: "human",
    });
    await wait(() => ends.length >= 1, 120_000);
    await wait(() => ends.length >= 3, 120_000);
    const [, foreign, own] = ends;
    const reply = events.filter((e) => e.kind === "message" && e.agent === "claude").map((e) => e.text).join(" | ");
    console.log(
      JSON.stringify(
        {
          sent,
          secondEndAutonomous: foreign?.unsolicited === true,
          thirdEndAutonomous: own?.unsolicited === true,
          replies: reply,
        },
        null,
        1,
      ),
    );
  } catch (err) {
    console.log("ОШИБКА", String(err), "концов:", ends.length);
  } finally {
    await adapter.stop();
    process.exit(0);
  }
}
