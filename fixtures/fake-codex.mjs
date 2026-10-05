/**
 * Фальшивый `codex app-server` для проверки адаптера.
 *
 * Формы сообщений взяты из схемы протокола, выгруженной командой
 * `codex app-server generate-json-schema` (Codex 0.153.0):
 *   ответ thread/start       — { thread: { id } }
 *   turn/started             — { threadId, turn: { id, status } }
 *   item/agentMessage/delta  — { delta, itemId, threadId, turnId }
 *   item/completed           — { item: { type: "agentMessage", id, text }, … }
 *   turn/completed           — { threadId, turn: { id, status, error? } }
 *   TurnStatus               — completed | interrupted | failed | inProgress
 *
 * Именно в этих полях прежняя версия адаптера ошибалась (threadId вместо
 * thread.id, agent_message вместо agentMessage), и тесты на заглушках этого
 * не видели.
 *
 * Управляется словами в тексте реплики:
 *   ОШИБКА-ХОДА — ход завершается со статусом failed;
 *   ЗАПИСАТЬ    — сервер запрашивает у клиента одобрение на изменение файла
 *                 и пишет в stderr, что клиент ответил;
 *   КОМАНДА-ДАННЫЕ — начало команды `python -c "open('data/x.parquet')"`,
 *                 ход висит до turn/interrupt.
 * РАЗРЫВ в id возобновляемой ветки — ответ thread/resume с U+2028/U+2029
 * внутри строки JSON.
 *
 * Параметры ветки (thread/start и thread/resume) пишутся в stderr строкой
 * «ПАРАМЕТРЫ-ВЕТКИ {…}»: resume, id продолжаемой ветки, рабочая папка,
 * песочница, есть ли профиль прав (profile), config и роль целиком — тест
 * читает их из диагностики.
 *
 * Профиль прав в config (default_permissions + permissions) ответ отражает
 * как настоящий app-server 0.159 (проба 05.10): sandbox workspaceWrite с
 * корнями записи профиля, кроме рабочей папки, и activePermissionProfile.
 * Без профиля — readOnly. Флаги argv:
 *   --reject-profile — thread/start|resume с профилем отвечает ошибкой
 *                      (Codex обновился и профиль не принимает);
 *   --weak-profile   — профиль принят, но ответ — readOnly без профиля
 *                      (как продолжение без config на пробе);
 *   --exec-broken    — command/exec пишет куда угодно: «запись в проект
 *                      прошла»;
 *   --reject-interrupt — turn/interrupt отвечает ошибкой, ход идёт дальше.
 *
 * command/exec понимает самопроверку панели — `python -c <код> <путь>`:
 * путь внутри writableRoots политики workspaceWrite — файл пишется на диск
 * и ответ {exitCode: 0}; иначе — ошибка JSON-RPC «sandbox denied», как у
 * настоящего (проба 05.10). Параметры — в stderr строкой «ПАРАМЕТРЫ-КОМАНДЫ {…}».
 * Как у настоящего (живая проверка 05.10, вечер), рабочая папка ПРОЦЕССА
 * app-server — лишний корень записи, хотя cwd и writableRoots запроса
 * называют только папку проверок: процесс, запущенный в проекте, пишет в
 * проект. Рабочая папка процесса — поле processCwd в «ПАРАМЕТРЫ-ВЕТКИ».
 *
 * И скрипт Gemini — `<python> <файл>.py` (ступень 3): ответ «выполнено <имя
 * файла>» с кодом 0. Слова в файле:
 *   ДОЛГО            — через timeoutMs ошибка «command timed out» без вывода,
 *                      как при превышении срока на пробе 05.10;
 *   ЗАПИСЬ-В-ПРОЕКТ  — ошибка «sandbox denied exec error, exit code: 1,
 *                      stdout: …, stderr: …» (отказ песочницы);
 *   ОШИБКА-СКРИПТА   — код 1 и Traceback в stderr;
 *   ДЛИННЫЙ-ВЫВОД    — 30 000 знаков вывода и строка «конец»;
 *   ПОКАЖИ-ПАРАМЕТРЫ — вывод — параметры command/exec в JSON.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve, sep } from "node:path";
import { createInterface } from "node:readline";

const THREAD = "fake-thread-1";
const REJECT_PROFILE = process.argv.includes("--reject-profile");
const WEAK_PROFILE = process.argv.includes("--weak-profile");
const EXEC_BROKEN = process.argv.includes("--exec-broken");
const REJECT_INTERRUPT = process.argv.includes("--reject-interrupt");
const send = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const notify = (method, params) => send({ jsonrpc: "2.0", method, params });
const logThread = (resume, params) =>
  process.stderr.write(`ПАРАМЕТРЫ-ВЕТКИ ${JSON.stringify({
    resume,
    ...(resume ? { threadId: params.threadId } : {}),
    cwd: params.cwd,
    processCwd: process.cwd(),
    approvalPolicy: params.approvalPolicy,
    sandbox: params.sandbox,
    profile: Boolean(params.config?.permissions),
    config: params.config,
    developerInstructions: String(params.developerInstructions ?? ""),
  })}\n`);

/** Путь внутри корня (без учёта регистра, как в Windows). */
const within = (path, root) => {
  const inner = resolve(path).toLowerCase();
  const outer = resolve(root).toLowerCase();
  return inner === outer || inner.startsWith(outer.endsWith(sep) ? outer : outer + sep);
};

/** Права ветки в ответе thread/start|resume — как их отражает app-server. */
const threadRights = (params) => {
  const name = params.config?.default_permissions;
  const profile = name ? params.config?.permissions?.[name] : undefined;
  if (!profile || WEAK_PROFILE) {
    return { cwd: params.cwd, sandbox: { type: "readOnly", networkAccess: false }, activePermissionProfile: null };
  }
  const writableRoots = Object.entries(profile.filesystem ?? {})
    .filter(([path, access]) => access === "write" && !path.startsWith(":") && !within(path, params.cwd))
    .map(([path]) => path);
  return {
    cwd: params.cwd,
    sandbox: {
      type: "workspaceWrite",
      writableRoots,
      networkAccess: profile.network?.enabled === true,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
    },
    activePermissionProfile: { id: name, extends: null },
  };
};

/** Скрипт Gemini через command/exec: исход — по словам в файле (шапка). */
const runScript = (id, params, file) => {
  const fail = (message) => send({ jsonrpc: "2.0", id, error: { code: -32603, message } });
  const ok = (exitCode, stdout, stderr = "") => send({ jsonrpc: "2.0", id, result: { exitCode, stdout, stderr } });
  let code;
  try {
    code = readFileSync(file, "utf8");
  } catch (err) {
    ok(2, "", `python: can't open file '${file}': ${err.message}`);
    return;
  }
  if (code.includes("ДОЛГО")) {
    setTimeout(() => fail("exec failed: sandbox error: command timed out"), Math.min(Number(params.timeoutMs) || 1000, 60_000));
    return;
  }
  if (code.includes("ЗАПИСЬ-В-ПРОЕКТ")) {
    fail(
      "exec failed: sandbox error: sandbox denied exec error, exit code: 1, stdout: начал запись\r\n, " +
        "stderr: Traceback (most recent call last):\r\nPermissionError: [Errno 13] Permission denied: 'C:/p/x.txt'\r\n",
    );
    return;
  }
  if (code.includes("ОШИБКА-СКРИПТА")) ok(1, "", "Traceback (most recent call last):\r\nKeyError: 'date'\r\n");
  else if (code.includes("ДЛИННЫЙ-ВЫВОД")) ok(0, `${"a".repeat(30_000)}\nконец\n`);
  else if (code.includes("ПОКАЖИ-ПАРАМЕТРЫ")) ok(0, JSON.stringify(params));
  else ok(0, `выполнено ${basename(file)}\n`);
};

process.stderr.write(
  "\x1b[2m2026-09-14T17:07:57Z\x1b[0m \x1b[31mERROR\x1b[0m codex_models_manager::manager: failed to refresh available models\n",
);

const longRunning = new Set();
let turnNumber = 0;

// --die-once <файл>: первый запуск умирает на initialize, следующие работают.
const markIndex = process.argv.indexOf("--die-once");
if (markIndex > 0 && !existsSync(process.argv[markIndex + 1])) {
  writeFileSync(process.argv[markIndex + 1], "умер");
  createInterface({ input: process.stdin }).once("line", () => process.exit(3));
  await new Promise(() => {});
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  let z;
  try {
    z = JSON.parse(line);
  } catch {
    return;
  }

  // Ответ клиента на наш запрос одобрения.
  if (z.id === "srv-1" && !z.method) {
    process.stderr.write(`ответ клиента: ${z.error ? "error" : "result"}\n`);
    return;
  }
  if (!z.method || z.id === undefined) return; // нотификации клиента

  const reply = (result) => send({ jsonrpc: "2.0", id: z.id, result });

  switch (z.method) {
    case "initialize":
      reply({});
      return;
    case "thread/start":
    case "thread/resume": {
      const resume = z.method === "thread/resume";
      logThread(resume, z.params);
      if (REJECT_PROFILE && z.params.config?.permissions) {
        send({ jsonrpc: "2.0", id: z.id, error: { code: -32600, message: "Invalid request: unknown field `permissions`" } });
        return;
      }
      if (!resume) {
        reply({ thread: { id: THREAD, sessionId: "fake-session" }, ...threadRights(z.params) });
        notify("thread/started", { thread: { id: THREAD } });
        return;
      }
      // РАЗРЫВ в id ветки: в истории U+2028/U+2029 «как есть» — так их пишет
      // настоящий app-server, и JSON.stringify здесь тоже их не экранирует.
      reply({
        thread: {
          id: z.params.threadId,
          ...(String(z.params.threadId).includes("РАЗРЫВ") ? { preview: "до после конец" } : {}),
        },
        ...threadRights(z.params),
      });
      return;
    }
    case "command/exec": {
      const p = z.params ?? {};
      process.stderr.write(`ПАРАМЕТРЫ-КОМАНДЫ ${JSON.stringify(p)}\n`);
      const command = Array.isArray(p.command) ? p.command : [];
      if (command.length === 2 && /\.py$/i.test(String(command[1]))) {
        runScript(z.id, p, String(command[1]));
        return;
      }
      const target = command[1] === "-c" && typeof command[3] === "string" ? command[3] : undefined;
      if (!target) {
        send({ jsonrpc: "2.0", id: z.id, error: { code: -32603, message: "exec failed: фальшивка понимает только самопроверку" } });
        return;
      }
      const policy = p.sandboxPolicy ?? {};
      // Рабочая папка процесса — корень записи наравне с writableRoots (шапка).
      const roots = [...(policy.writableRoots ?? []), process.cwd()];
      const allowed = EXEC_BROKEN || (policy.type === "workspaceWrite" && roots.some((root) => within(target, root)));
      if (allowed) {
        try {
          writeFileSync(target, "x");
          reply({ exitCode: 0, stdout: "", stderr: "" });
        } catch (err) {
          reply({ exitCode: 1, stdout: "", stderr: String(err.message) });
        }
        return;
      }
      send({
        jsonrpc: "2.0",
        id: z.id,
        error: {
          code: -32603,
          message: `exec failed: sandbox error: sandbox denied exec error, exit code: 1, stdout: , stderr: PermissionError: [Errno 13] Permission denied: '${target}'`,
        },
      });
      return;
    }
    case "model/list": {
      // Форма из схемы ModelListResponse (Codex 0.153.0); скрытая модель — чтобы
      // проверить, что панель её не показывает.
      const model = (id, name, isDefault, level, levels, hidden = false) => ({
        id, model: id, displayName: name, description: `${name} description`, hidden: hidden,
        isDefault: isDefault, defaultReasoningEffort: level,
        supportedReasoningEfforts: levels.map((reasoningEffort) => ({ reasoningEffort, description: reasoningEffort })),
      });
      reply({
        data: [
          model("gpt-sol", "GPT-Sol", true, "low", ["low", "medium", "high", "ultra"]),
          model("gpt-luna", "GPT-Luna", false, "medium", ["low", "medium", "high"]),
          model("gpt-hidden", "GPT-Hidden", false, "medium", ["low"], true),
        ],
        nextCursor: null,
      });
      return;
    }
    case "turn/start": {
      turnNumber += 1;
      const turnId = `turn-${turnNumber}`;
      const turnText = (z.params.input ?? []).map((v) => v.text ?? "").join("");
      // УПАСТЬ-ХОД: процесс умирает посреди хода.
      if (turnText.includes("УПАСТЬ-ХОД")) {
        reply({ turn: { id: turnId, status: "inProgress" } });
        setTimeout(() => process.exit(3), 20);
        return;
      }
      // ДОЛГИЙ-ХОД: ход идёт, пока его не прервут; ПОЗЖЕ — кончается через 400 мс.
      // КОМАНДА-ДАННЫЕ: начало команды с путём к данным, затем ход висит до
      // прерывания — для стоп-сигнала панели (обычный КОМАНДА ниже не срабатывает).
      if (turnText.includes("ДОЛГИЙ-ХОД") || turnText.includes("ПОЗЖЕ") || turnText.includes("КОМАНДА-ДАННЫЕ")) {
        reply({ turn: { id: turnId, status: "inProgress" } });
        notify("turn/started", { threadId: THREAD, turn: { id: turnId, status: "inProgress" } });
        if (turnText.includes("КОМАНДА-ДАННЫЕ")) {
          notify("item/started", {
            item: { type: "commandExecution", id: "cmd-data", command: "python -c \"open('data/x.parquet')\"", status: "inProgress" },
            threadId: THREAD,
            turnId,
          });
        }
        if (turnText.includes("ДОЛГИЙ-ХОД") || turnText.includes("КОМАНДА-ДАННЫЕ")) {
          longRunning.add(turnId);
          return;
        }
        setTimeout(() => {
          notify("item/completed", { item: { type: "agentMessage", id: "i-поздно", text: "поздний ответ" }, threadId: THREAD, turnId });
          notify("turn/completed", { threadId: THREAD, turn: { id: turnId, status: "completed" } });
        }, 400);
        return;
      }
      // Модель и уровень хода — в stderr: тест читает их из диагностики.
      process.stderr.write(`ПАРАМЕТРЫ-ХОДА ${JSON.stringify({ model: z.params.model, effort: z.params.effort })}\n`);
      reply({ turn: { id: turnId, status: "inProgress" } });
      const text = (z.params.input ?? []).map((v) => v.text ?? "").join("");
      if (!text.includes("РАСХОД-БЕЗ-ХОДА")) {
        notify("turn/started", { threadId: THREAD, turn: { id: turnId, status: "inProgress" } });
      }

      if (text.includes("ЗАПИСАТЬ")) {
        send({
          jsonrpc: "2.0",
          id: "srv-1",
          method: "item/fileChange/requestApproval",
          params: { threadId: THREAD, turnId },
        });
      }
      if (text.includes("КОМАНДА")) {
        const command = { type: "commandExecution", id: "cmd-1", command: "git status", status: "inProgress" };
        notify("item/started", { item: command, threadId: THREAD, turnId });
        notify("item/completed", {
          item: { ...command, status: "completed", aggregatedOutput: "чисто", exitCode: 0 },
          threadId: THREAD,
          turnId,
        });
      }
      if (text.includes("РАСХОД-БЕЗ-ХОДА")) {
        // Повтор расхода прежнего хода, а turn/started для текущего не пришёл.
        notify("thread/tokenUsage/updated", {
          threadId: THREAD,
          turnId: "turn-old",
          tokenUsage: { total: { inputTokens: 5000, cachedInputTokens: 0, outputTokens: 400 }, last: { inputTokens: 900, cachedInputTokens: 0, outputTokens: 40 } },
        });
        notify("turn/completed", { threadId: THREAD, turn: { id: turnId, status: "completed" } });
        return;
      }
      if (text.includes("РАСХОД-СЛОЖНЫЙ")) {
        const usage = (turn, input, output, lastInput, lastOutput) =>
          notify("thread/tokenUsage/updated", {
            threadId: THREAD,
            turnId: turn,
            tokenUsage: {
              total: { inputTokens: input, cachedInputTokens: 0, outputTokens: output },
              last: { inputTokens: lastInput, cachedInputTokens: 0, outputTokens: lastOutput },
            },
          });
        usage("turn-old", 5000, 400, 900, 40); // повтор прежнего хода при возобновлении
        usage(turnId, 1000, 10, 300, 10); // первый запрос хода; ветка возобновлена — базы нет
        usage(turnId, 1500, 25, 500, 15); // второй запрос
        usage(turnId, 400, 5, 400, 5); // сжатие контекста: итог сброшен
        notify("turn/completed", { threadId: THREAD, turn: { id: turnId, status: "completed" } });
        return;
      }
      if (text.includes("ОШИБКА-ХОДА")) {
        notify("turn/completed", {
          threadId: THREAD,
          turn: { id: turnId, status: "failed", error: { message: "сбой модели" } },
        });
        return;
      }
      for (const chunk of ["при", "вет"]) {
        notify("item/agentMessage/delta", { delta: chunk, itemId: "i1", threadId: THREAD, turnId });
      }
      notify("item/completed", {
        item: { type: "agentMessage", id: "i1", text: "привет" },
        threadId: THREAD,
        turnId,
        completedAtMs: Date.now(),
      });
      notify("thread/tokenUsage/updated", {
        threadId: THREAD,
        turnId,
        tokenUsage: {
          total: { totalTokens: 99999, inputTokens: 90000, cachedInputTokens: 80000, outputTokens: 9999, reasoningOutputTokens: 0 },
          last: { totalTokens: 17527, inputTokens: 17522, cachedInputTokens: 7936, outputTokens: 5, reasoningOutputTokens: 0 },
          modelContextWindow: 258400,
        },
      });
      notify("account/rateLimits/updated", {
        rateLimits: { limitId: "codex", primary: { usedPercent: 8, windowDurationMins: 10080, resetsAt: 1791057755 }, planType: "plus" },
      });
      notify("turn/completed", { threadId: THREAD, turn: { id: turnId, status: "completed" } });
      return;
    }
    case "turn/interrupt":
      if (REJECT_INTERRUPT) {
        send({ jsonrpc: "2.0", id: z.id, error: { code: -32603, message: "ход не найден" } });
        return;
      }
      reply({});
      // Настоящий Codex присылает конец прерванного хода отдельно и позже ответа.
      if (longRunning.delete(z.params.turnId)) {
        // Перед концом — поздний элемент прерванного хода.
        setTimeout(() => {
          notify("item/completed", {
            item: { type: "agentMessage", id: "i-прерванный", text: "поздний кусок" },
            threadId: THREAD,
            turnId: z.params.turnId,
          });
        }, 100);
        setTimeout(() => {
          notify("turn/completed", { threadId: THREAD, turn: { id: z.params.turnId, status: "interrupted" } });
        }, 150);
      }
      return;
    default:
      send({
        jsonrpc: "2.0",
        id: z.id,
        error: { code: -32601, message: `нет метода ${z.method}` },
      });
  }
});
lines.on("close", () => process.exit(0));
