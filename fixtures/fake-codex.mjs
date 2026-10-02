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
 *                 и пишет в stderr, что клиент ответил.
 * РАЗРЫВ в id возобновляемой ветки — ответ thread/resume с U+2028/U+2029
 * внутри строки JSON.
 */
import { existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const THREAD = "fake-thread-1";
const send = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const notify = (method, params) => send({ jsonrpc: "2.0", method, params });

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
      reply({ thread: { id: THREAD, sessionId: "fake-session" } });
      notify("thread/started", { thread: { id: THREAD } });
      return;
    case "thread/resume":
      // Параметры возобновления — в stderr: тест читает их из диагностики.
      process.stderr.write(`ПАРАМЕТРЫ-ВЕТКИ ${JSON.stringify({
        resume: true,
        sandbox: z.params.sandbox,
        developerInstructions: String(z.params.developerInstructions ?? "").slice(0, 60),
      })}
`);
      // РАЗРЫВ в id ветки: в истории U+2028/U+2029 «как есть» — так их пишет
      // настоящий app-server, и JSON.stringify здесь тоже их не экранирует.
      reply({
        thread: {
          id: z.params.threadId,
          ...(String(z.params.threadId).includes("РАЗРЫВ") ? { preview: "до после конец" } : {}),
        },
      });
      return;
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
      if (turnText.includes("ДОЛГИЙ-ХОД") || turnText.includes("ПОЗЖЕ")) {
        reply({ turn: { id: turnId, status: "inProgress" } });
        notify("turn/started", { threadId: THREAD, turn: { id: turnId, status: "inProgress" } });
        if (turnText.includes("ДОЛГИЙ-ХОД")) {
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
