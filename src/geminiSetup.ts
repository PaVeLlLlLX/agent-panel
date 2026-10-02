/**
 * Подготовка agy к роли рецензента: правила «только чтение» и свой агент.
 *
 * Живая проба 02.10.2026 (docs/research/2026-10-02-проба-agy.md):
 *   * в обычном режиме agy без интерфейса пишет файлы без вопроса;
 *   * режим strict не даёт читать даже файлы проекта;
 *   * гарантию «только чтение» дают правила deny в settings.json: запись и
 *     команда кончаются явной ошибкой, ход продолжается;
 *   * список tools в agent.md инструменты не ограничивает — он задаёт роль.
 *
 * Настройки agy общие (своего файла для проекта нет), поэтому панель их сама
 * не меняет: правила дописывает кнопка «Добавить правила» по решению человека.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const REVIEWER_AGENT = "agent-panel-reviewer";

/** Обычный режим разрешений agy: strict слепит рецензента, прочие пробой не проверены. */
const REVIEW_MODE = "request-review";
const READ_ONLY_ALLOW = ["read_url(*)"];
const READ_ONLY_DENY = ["write_file(*)", "command(*)"];

/**
 * Без встроенной части agy: ≈2 800 токенов на вызов модели вместо ≈12 000
 * (проба 02.10). Остаётся ли true, решает живая проба scripts/gemini-probe.mjs:
 * без встроенной части Flash в пробе искал файлы вне проекта.
 *
 * Проба через адаптер панели 02.10.2026 (docs/research/2026-10-02-проба-agy.md):
 * оба прогона (с `--keep-default-components` и без) дали `readInsideProject:
 * true` и `readIncomplete: null` — разница в том, что GeminiAdapter сам кладёт
 * в каждое сообщение шапку «[папка проекта: … — ищи и читай файлы только в
 * ней]» (formatForGemini), чего не было в прежней пробе без адаптера. Условие
 * задачи («без встроенной части — не туда, с ней — верно») не выполнилось,
 * поэтому значение остаётся true: экономия токенов без потери точности.
 */
export const EXCLUDE_DEFAULT_COMPONENTS = true;

export function reviewerAgentMarkdown(name: string, excludeDefault: boolean): string {
  return [
    "---",
    `name: ${name}`,
    "description: Рецензент Agent Panel — методология эксперимента и факты вне репозитория. Только чтение.",
    "mainAgent: true",
    `excludeDefaultComponents: ${excludeDefault}`,
    "tools:",
    "  - view_file",
    "  - grep_search",
    "  - list_dir",
    "  - find_by_name",
    "  - search_web",
    "  - read_url_content",
    "---",
    "# Рецензент методологии и фактов",
    "",
    "Ты второй рецензент в комнате Agent Panel: человек ставит задачу, разработчик Claude Code",
    "её выполняет, рецензент Codex проверяет код. Ты проверяешь то, чего Codex не видит.",
    "",
    "Файлы не меняешь и команды не запускаешь: это запрещено настройками. Ищи и читай файлы",
    "только в папке проекта из шапки сообщения, не по всему диску.",
    "",
    "## Что проверяешь",
    "",
    "1. Методологию эксперимента — чек-листом. Пункты: утечки данных, разбиения на выборки,",
    "   метрики, бейзлайн, сиды и разброс, обоснованность выводов. У каждого пункта —",
    "   «свидетельство: …» (откуда: вызов разработчика, файл, строка вывода) или «пробел: …».",
    "   Пробел оформляй просьбой к разработчику показать недостающее, например «выведи",
    "   пересечение id train и test». Следующая проверка увидит его вывод.",
    "2. Факты вне репозитория: API и версии библиотек, документацию, статьи, бенчмарки.",
    "   Каждый факт — с адресом страницы, которую ты открыл, и датой проверки. Фрагмент",
    "   поиска без открытой страницы — не проверенный факт.",
    "",
    "Код целиком не перепроверяй — это делает Codex. Если шаг не затрагивает ни эксперимент,",
    "ни внешние факты, ответь «принято» и одной строкой поясни почему.",
    "",
    "## Как заканчиваешь",
    "",
    "Последней строкой, без цитаты и без блока кода, ровно одно: «ВЕРДИКТ: ПРИНЯТО»,",
    "«ВЕРДИКТ: ЕСТЬ ЗАМЕЧАНИЯ» или «ВЕРДИКТ: НУЖНО РЕШЕНИЕ ЧЕЛОВЕКА». Последний — когда без",
    "решения или данных человека продолжать бессмысленно.",
    "",
  ].join("\n");
}

export const REVIEWER_AGENT_MD = reviewerAgentMarkdown(REVIEWER_AGENT, EXCLUDE_DEFAULT_COMPONENTS);

export interface RulesCheck {
  readonly ok: boolean;
  /** Чего не хватает — словами для человека. */
  readonly problems: readonly string[];
  /** settings.json не разбирается: панель его не трогает. */
  readonly broken?: string;
}

export function agySettingsPath(home: string): string {
  return join(home, ".gemini", "antigravity-cli", "settings.json");
}

export function reviewerAgentPath(home: string): string {
  return join(home, ".gemini", "config", "agents", REVIEWER_AGENT, "agent.md");
}

type Settings = Record<string, unknown>;

function readSettings(filePath: string): { readonly settings: Settings } | { readonly broken: string } {
  if (!existsSync(filePath)) return { settings: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (err) {
    return { broken: (err as Error).message };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { broken: "ожидался объект JSON" };
  return { settings: parsed as Settings };
}

function permissionsOf(settings: Settings): Record<string, unknown> {
  const p = settings["permissions"];
  return p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : {};
}

const has = (value: unknown, rule: string) => Array.isArray(value) && value.includes(rule);

export function checkReadOnlyRules(filePath: string): RulesCheck {
  const read = readSettings(filePath);
  if ("broken" in read) return { ok: false, problems: [], broken: read.broken };
  const problems: string[] = [];
  const mode = read.settings["toolPermission"];
  if (mode !== undefined && mode !== REVIEW_MODE) problems.push(`режим «${String(mode)}» вместо обычного (${REVIEW_MODE})`);
  const permissions = permissionsOf(read.settings);
  if (!has(permissions["allow"], "read_url(*)")) problems.push("нет разрешения читать страницы: allow read_url(*)");
  if (!has(permissions["deny"], "write_file(*)")) problems.push("нет запрета записи: deny write_file(*)");
  if (!has(permissions["deny"], "command(*)")) problems.push("нет запрета команд: deny command(*)");
  return { ok: problems.length === 0, problems };
}

/** Причина не запускать Gemini — для адаптера и для ленты; undefined — правила на месте. */
export function rulesRefusal(check: RulesCheck, filePath: string): string | undefined {
  if (check.broken) return `настройки agy не разбираются (${check.broken}) — исправьте ${filePath} вручную`;
  if (!check.ok) return `нет режима «только чтение» в настройках agy: ${check.problems.join("; ")}`;
  return undefined;
}

/** Недостающие правила дописываются; чужие записи, в том числе не строки, остаются как были. */
function withRules(current: unknown, needed: readonly string[]): unknown[] {
  const kept = Array.isArray(current) ? [...(current as unknown[])] : [];
  for (const rule of needed) if (!kept.includes(rule)) kept.push(rule);
  return kept;
}

export function addReadOnlyRules(filePath: string): RulesCheck {
  const read = readSettings(filePath);
  if ("broken" in read) return { ok: false, problems: [], broken: read.broken };
  const settings: Settings = { ...read.settings };
  const permissions = { ...permissionsOf(settings) };
  permissions["allow"] = withRules(permissions["allow"], READ_ONLY_ALLOW);
  permissions["deny"] = withRules(permissions["deny"], READ_ONLY_DENY);
  settings["permissions"] = permissions;
  // Обычный режим — это отсутствие toolPermission: agy по умолчанию request-review.
  if (settings["toolPermission"] !== undefined && settings["toolPermission"] !== REVIEW_MODE) delete settings["toolPermission"];
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  return checkReadOnlyRules(filePath);
}

/** Файл агента принадлежит панели: переписывается, когда роль в коде изменилась. */
export function ensureReviewerAgent(filePath: string): boolean {
  if (existsSync(filePath) && readFileSync(filePath, "utf8") === REVIEWER_AGENT_MD) return false;
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, REVIEWER_AGENT_MD, "utf8");
  return true;
}
