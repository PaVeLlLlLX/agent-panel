/**
 * Какой claude запускать.
 *
 * Чат владельца живёт в расширении Claude Code для VS Code, у которого свой
 * claude.exe; расширение обновляется само. Claude из npm обновляется только
 * руками и отстаёт: 28.09.2026 CLI 2.1.220 не принял сессию на
 * claude-opus-5-5 («does not support this model; version 2.1.280»), а
 * claude 2.1.280 из расширения — принял. Поэтому по умолчанию — claude
 * расширения, явная настройка важнее, запасной вариант — claude из PATH.
 *
 * Путь ищется при каждом открытии комнаты: при обновлении расширения меняется
 * его папка (в имени — номер версии).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface ClaudeLaunch {
  readonly command: string;
  /** false — запуск без оболочки; undefined — решает адаптер (на Windows — cmd.exe). */
  readonly shell: boolean | undefined;
  readonly source: "setting" | "extension" | "path";
}

/** claude из расширения Claude Code, если он там есть. */
export function findExtensionClaude(папкаРасширения: string | undefined): string | undefined {
  if (!папкаРасширения) return undefined;
  const имя = process.platform === "win32" ? "claude.exe" : "claude";
  const путь = join(папкаРасширения, "resources", "native-binary", имя);
  return existsSync(путь) ? путь : undefined;
}

export function resolveClaudeCommand(
  настройка: string | undefined,
  папкаРасширения: string | undefined,
): ClaudeLaunch {
  const явная = (настройка ?? "").trim();
  if (явная && явная !== "claude") {
    return { command: явная, shell: /\.exe$/i.test(явная) ? false : undefined, source: "setting" };
  }
  const изРасширения = findExtensionClaude(папкаРасширения);
  if (изРасширения) return { command: изРасширения, shell: false, source: "extension" };
  return { command: "claude", shell: undefined, source: "path" };
}

/**
 * Аргумент-путь для выбранного способа запуска. Через cmd.exe путь нужен в
 * кавычках — иначе пробел или «&» в имени папки разбили бы команду; без
 * оболочки Node экранирует сам, а кавычки стали бы частью пути.
 */
export function argumentForLaunch(значение: string, shell: boolean | undefined): string {
  const черезОболочку = shell ?? process.platform === "win32";
  return черезОболочку && process.platform === "win32" ? `"${значение}"` : значение;
}
