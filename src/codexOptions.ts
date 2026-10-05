/**
 * Опции Codex комнаты: какую ветку продолжает рецензент и куда пишется
 * номер новой.
 *
 * Решение владельца 05.10: у рецензента своя ветка на комнату
 * (`rooms.codex_review_thread`). Прежняя привязка `codex_thread` — чат
 * владельца, который панель продолжала раньше; теперь она остаётся в журнале
 * историей и не продолжается ни при каком пути: обычный запуск, перезапуск
 * после сбоя и смена модели берут ветку только отсюда (адаптер помнит лишь
 * то, что получил в опциях или завёл сам).
 *
 * Вынесено из extension.ts, чтобы это проверялось тестом без VS Code.
 */
import { CodexOptions, CodexReview } from "./adapters/codex.js";
import { ModelChoice } from "./adapters/types.js";
import { CodexLaunch } from "./codexBinary.js";
import { Journal, RoomBinding } from "./journal.js";

/** Запрет по умолчанию — как у настройки agentPanel.reviewerForbidden. */
export const DEFAULT_FORBIDDEN: readonly string[] = [".env"];

export interface CodexRoomSetup {
  readonly launch: Pick<CodexLaunch, "command" | "shell">;
  readonly cwd: string;
  readonly choice: ModelChoice;
  /** Значение настройки agentPanel.reviewerForbidden как есть. */
  readonly forbidden: unknown;
  readonly journal: Journal;
  readonly room: string;
  /** Комната закрывается: поздний номер ветки в журнал не пишется. */
  readonly closed: () => boolean;
  /** Общая настройка agentPanel.reviewerChecks (ступени 2–3); нет — выключена. */
  readonly checksAllowed?: boolean;
  /** Папка проверок Codex комнаты (reviewFolder.ts). */
  readonly reviewFolder?: string;
}

export function codexRoomOptions(setup: CodexRoomSetup): CodexOptions {
  const binding = setup.journal.binding(setup.room);
  const review = reviewFor(setup.checksAllowed ?? false, binding, setup.reviewFolder);
  return {
    command: setup.launch.command,
    ...(setup.launch.shell !== undefined ? { shell: setup.launch.shell } : {}),
    cwd: setup.cwd,
    model: setup.choice.model,
    effort: setup.choice.effort,
    forbidden: forbiddenFragments(setup.forbidden),
    // Только своя ветка: binding.codexThreadId (чат владельца) сюда не идёт.
    ...(binding?.codexReviewThreadId ? { resumeThreadId: binding.codexReviewThreadId } : {}),
    onSessionId: (id) => {
      if (!setup.closed()) setup.journal.bindCodexReviewThread(setup.room, id);
    },
    ...(review ? { review } : {}),
  };
}

/**
 * Папка проверок Codex — только когда включены и общая настройка
 * agentPanel.reviewerChecks, и переключатель комнаты (журнал): без решения
 * владельца ступени 2–3 не включаются.
 */
export function reviewFor(
  allowed: boolean,
  binding: RoomBinding | undefined,
  folder: string | undefined,
): CodexReview | undefined {
  return allowed && binding?.reviewerChecks === true && folder ? { folder } : undefined;
}

/**
 * Запрещённые фрагменты путей из настройки. Испорченное значение (не
 * массив) — запрет по умолчанию, а не пустой: пустой молча снял бы запрет
 * секретов. Им же читает настройку комната, когда её меняют при открытой
 * панели (extension.ts).
 */
export function forbiddenFragments(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return DEFAULT_FORBIDDEN;
  return value.filter((k): k is string => typeof k === "string").map((k) => k.trim()).filter((k) => k !== "");
}
