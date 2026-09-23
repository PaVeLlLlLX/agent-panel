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
import { createInterface } from "node:readline";

const ВЕТКА = "fake-thread-1";
const отправить = (о) => process.stdout.write(`${JSON.stringify(о)}\n`);
const уведомить = (method, params) => отправить({ jsonrpc: "2.0", method, params });

process.stderr.write(
  "\x1b[2m2026-09-14T17:07:57Z\x1b[0m \x1b[31mERROR\x1b[0m codex_models_manager::manager: failed to refresh available models\n",
);

let номерХода = 0;

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
      // Модель и уровень хода — в stderr: тест читает их из диагностики.
      process.stderr.write(`ПАРАМЕТРЫ-ХОДА ${JSON.stringify({ model: з.params.model, effort: з.params.effort })}\n`);
      ответ({ turn: { id: turnId, status: "inProgress" } });
      const текст = (з.params.input ?? []).map((в) => в.text ?? "").join("");
      уведомить("turn/started", { threadId: ВЕТКА, turn: { id: turnId, status: "inProgress" } });

      if (текст.includes("ЗАПИСАТЬ")) {
        отправить({
          jsonrpc: "2.0",
          id: "srv-1",
          method: "item/fileChange/requestApproval",
          params: { threadId: ВЕТКА, turnId },
        });
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
      уведомить("turn/completed", { threadId: ВЕТКА, turn: { id: turnId, status: "completed" } });
      return;
    }
    case "turn/interrupt":
      ответ({});
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
