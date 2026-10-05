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
export function findExtensionClaude(extensionDir: string | undefined): string | undefined {
  if (!extensionDir) return undefined;
  const name = process.platform === "win32" ? "claude.exe" : "claude";
  const filePath = join(extensionDir, "resources", "native-binary", name);
  return existsSync(filePath) ? filePath : undefined;
}

export function resolveClaudeCommand(
  setting: string | undefined,
  extensionDir: string | undefined,
): ClaudeLaunch {
  const explicit = (setting ?? "").trim();
  if (explicit && explicit !== "claude") {
    return { command: explicit, shell: /\.exe$/i.test(explicit) ? false : undefined, source: "setting" };
  }
  const fromExtension = findExtensionClaude(extensionDir);
  if (fromExtension) return { command: fromExtension, shell: false, source: "extension" };
  return { command: "claude", shell: undefined, source: "path" };
}

/**
 * Аргумент-путь (или строка с пробелами) для выбранного способа запуска.
 * Через cmd.exe путь нужен в кавычках — иначе пробел или «&» в имени папки
 * разбили бы команду; без оболочки Node экранирует сам, а кавычки стали бы
 * частью пути.
 */
export function argumentForLaunch(value: string, shell: boolean | undefined): string {
  const viaShell = shell ?? process.platform === "win32";
  return viaShell && process.platform === "win32" ? `"${value}"` : value;
}
