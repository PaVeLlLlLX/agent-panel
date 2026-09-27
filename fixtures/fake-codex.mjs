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
 */
import { existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const ВЕТКА = "fake-thread-1";
const отправить = (о) => process.stdout.write(`${JSON.stringify(о)}\n`);
const уведомить = (method, params) => отправить({ jsonrpc: "2.0", method, params });

process.stderr.write(
  "\x1b[2m2026-09-14T17:07:57Z\x1b[0m \x1b[31mERROR\x1b[0m codex_models_manager::manager: failed to refresh available models\n",
);

const долгие = new Set();
let номерХода = 0;

// --die-once <файл>: первый запуск умирает на initialize, следующие работают.
const iМетки = process.argv.indexOf("--die-once");
if (iМетки > 0 && !existsSync(process.argv[iМетки + 1])) {
  writeFileSync(process.argv[iМетки + 1], "умер");
  createInterface({ input: process.stdin }).once("line", () => process.exit(3));
  await new Promise(() => {});
}

const строки = createInterface({ input: process.stdin });
строки.on("line", (строка) => {
  let з;
  try {
    з = JSON.parse(строка);
  } catch {
    return;
  }

  // Ответ клиента на наш запрос одобрения.
  if (з.id === "srv-1" && !з.method) {
    process.stderr.write(`ответ клиента: ${з.error ? "error" : "result"}\n`);
    return;
  }
  if (!з.method || з.id === undefined) return; // нотификации клиента

  const ответ = (result) => отправить({ jsonrpc: "2.0", id: з.id, result });

  switch (з.method) {
    case "initialize":
      ответ({});
      return;
    case "thread/start":
      ответ({ thread: { id: ВЕТКА, sessionId: "fake-session" } });
      уведомить("thread/started", { thread: { id: ВЕТКА } });
      return;
    case "thread/resume":
      // Параметры возобновления — в stderr: тест читает их из диагностики.
      process.stderr.write(`ПАРАМЕТРЫ-ВЕТКИ ${JSON.stringify({
        resume: true,
        sandbox: з.params.sandbox,
        developerInstructions: String(з.params.developerInstructions ?? "").slice(0, 60),
      })}
`);
      ответ({ thread: { id: з.params.threadId } });
      return;
    case "model/list": {
      // Форма из схемы ModelListResponse (Codex 0.153.0); скрытая модель — чтобы
      // проверить, что панель её не показывает.
      const модель = (id, имя, поУмолчанию, уровень, уровни, скрыта = false) => ({
        id, model: id, displayName: имя, description: `${имя} description`, hidden: скрыта,
        isDefault: поУмолчанию, defaultReasoningEffort: уровень,
        supportedReasoningEfforts: уровни.map((reasoningEffort) => ({ reasoningEffort, description: reasoningEffort })),
      });
      ответ({
        data: [
          модель("gpt-sol", "GPT-Sol", true, "low", ["low", "medium", "high", "ultra"]),
          модель("gpt-luna", "GPT-Luna", false, "medium", ["low", "medium", "high"]),
          модель("gpt-hidden", "GPT-Hidden", false, "medium", ["low"], true),
        ],
        nextCursor: null,
      });
      return;
    }
    case "turn/start": {
      номерХода += 1;
      const turnId = `turn-${номерХода}`;
      const текстХода = (з.params.input ?? []).map((в) => в.text ?? "").join("");
      // ДОЛГИЙ-ХОД: ход идёт, пока его не прервут; ПОЗЖЕ — кончается через 400 мс.
      if (текстХода.includes("ДОЛГИЙ-ХОД") || текстХода.includes("ПОЗЖЕ")) {
        ответ({ turn: { id: turnId, status: "inProgress" } });
        уведомить("turn/started", { threadId: ВЕТКА, turn: { id: turnId, status: "inProgress" } });
        if (текстХода.includes("ДОЛГИЙ-ХОД")) {
          долгие.add(turnId);
          return;
        }
        setTimeout(() => {
          уведомить("item/completed", { item: { type: "agentMessage", id: "i-поздно", text: "поздний ответ" }, threadId: ВЕТКА, turnId });
          уведомить("turn/completed", { threadId: ВЕТКА, turn: { id: turnId, status: "completed" } });
        }, 400);
        return;
      }
      // Модель и уровень хода — в stderr: тест читает их из диагностики.
      process.stderr.write(`ПАРАМЕТРЫ-ХОДА ${JSON.stringify({ model: з.params.model, effort: з.params.effort })}\n`);
      ответ({ turn: { id: turnId, status: "inProgress" } });
      const текст = (з.params.input ?? []).map((в) => в.text ?? "").join("");
      if (!текст.includes("РАСХОД-БЕЗ-ХОДА")) {
        уведомить("turn/started", { threadId: ВЕТКА, turn: { id: turnId, status: "inProgress" } });
      }

      if (текст.includes("ЗАПИСАТЬ")) {
        отправить({
          jsonrpc: "2.0",
          id: "srv-1",
          method: "item/fileChange/requestApproval",
          params: { threadId: ВЕТКА, turnId },
        });
      }
      if (текст.includes("КОМАНДА")) {
        const команда = { type: "commandExecution", id: "cmd-1", command: "git status", status: "inProgress" };
        уведомить("item/started", { item: команда, threadId: ВЕТКА, turnId });
        уведомить("item/completed", {
          item: { ...команда, status: "completed", aggregatedOutput: "чисто", exitCode: 0 },
          threadId: ВЕТКА,
          turnId,
        });
      }
      if (текст.includes("РАСХОД-БЕЗ-ХОДА")) {
        // Повтор расхода прежнего хода, а turn/started для текущего не пришёл.
        уведомить("thread/tokenUsage/updated", {
          threadId: ВЕТКА,
          turnId: "turn-old",
          tokenUsage: { total: { inputTokens: 5000, cachedInputTokens: 0, outputTokens: 400 }, last: { inputTokens: 900, cachedInputTokens: 0, outputTokens: 40 } },
        });
        уведомить("turn/completed", { threadId: ВЕТКА, turn: { id: turnId, status: "completed" } });
        return;
      }
      if (текст.includes("РАСХОД-СЛОЖНЫЙ")) {
        const расход = (ход, вход, выход, последнийВход, последнийВыход) =>
          уведомить("thread/tokenUsage/updated", {
            threadId: ВЕТКА,
            turnId: ход,
            tokenUsage: {
              total: { inputTokens: вход, cachedInputTokens: 0, outputTokens: выход },
              last: { inputTokens: последнийВход, cachedInputTokens: 0, outputTokens: последнийВыход },
            },
          });
        расход("turn-old", 5000, 400, 900, 40); // повтор прежнего хода при возобновлении
        расход(turnId, 1000, 10, 300, 10); // первый запрос хода; ветка возобновлена — базы нет
        расход(turnId, 1500, 25, 500, 15); // второй запрос
        расход(turnId, 400, 5, 400, 5); // сжатие контекста: итог сброшен
        уведомить("turn/completed", { threadId: ВЕТКА, turn: { id: turnId, status: "completed" } });
        return;
      }
      if (текст.includes("ОШИБКА-ХОДА")) {
        уведомить("turn/completed", {
          threadId: ВЕТКА,
          turn: { id: turnId, status: "failed", error: { message: "сбой модели" } },
        });
        return;
      }
      for (const кусок of ["при", "вет"]) {
        уведомить("item/agentMessage/delta", { delta: кусок, itemId: "i1", threadId: ВЕТКА, turnId });
      }
      уведомить("item/completed", {
        item: { type: "agentMessage", id: "i1", text: "привет" },
        threadId: ВЕТКА,
        turnId,
        completedAtMs: Date.now(),
      });
      уведомить("thread/tokenUsage/updated", {
        threadId: ВЕТКА,
        turnId,
        tokenUsage: {
          total: { totalTokens: 99999, inputTokens: 90000, cachedInputTokens: 80000, outputTokens: 9999, reasoningOutputTokens: 0 },
          last: { totalTokens: 17527, inputTokens: 17522, cachedInputTokens: 7936, outputTokens: 5, reasoningOutputTokens: 0 },
          modelContextWindow: 258400,
        },
      });
      уведомить("account/rateLimits/updated", {
        rateLimits: { limitId: "codex", primary: { usedPercent: 8, windowDurationMins: 10080, resetsAt: 1791057755 }, planType: "plus" },
      });
      уведомить("turn/completed", { threadId: ВЕТКА, turn: { id: turnId, status: "completed" } });
      return;
    }
    case "turn/interrupt":
      ответ({});
      // Настоящий Codex присылает конец прерванного хода отдельно и позже ответа.
      if (долгие.delete(з.params.turnId)) {
        setTimeout(() => {
          уведомить("turn/completed", { threadId: ВЕТКА, turn: { id: з.params.turnId, status: "interrupted" } });
        }, 150);
      }
      return;
    default:
      отправить({
        jsonrpc: "2.0",
        id: з.id,
        error: { code: -32601, message: `нет метода ${з.method}` },
      });
  }
});
строки.on("close", () => process.exit(0));
