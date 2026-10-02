/**
 * Какой agy запускать.
 *
 * Установщик Antigravity CLI кладёт программу в %LOCALAPPDATA%\agy\bin и
 * дописывает эту папку в пользовательский PATH (проба 02.10.2026). Уже
 * запущенные процессы — VS Code и его расширения — нового PATH не видят до
 * перезапуска, поэтому папка установщика проверяется явно и раньше PATH.
 * Явная настройка важнее обоих. Не найден нигде — Gemini в комнате нет:
 * проверяет один Codex, как до подключения Gemini.
 */
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

export interface GeminiLaunch {
  readonly command: string;
  /** false — без оболочки (agy.exe); undefined — решает адаптер (на Windows — cmd.exe). */
  readonly shell: boolean | undefined;
  readonly source: "setting" | "installer" | "path";
}

const EXECUTABLE = process.platform === "win32" ? "agy.exe" : "agy";

export function resolveGeminiCommand(
  setting: string | undefined,
  localAppData: string | undefined,
  pathVariable: string | undefined,
): GeminiLaunch | undefined {
  const explicit = (setting ?? "").trim();
  if (explicit && explicit !== "agy") {
    return { command: explicit, shell: /\.exe$/i.test(explicit) ? false : undefined, source: "setting" };
  }
  if (localAppData) {
    const installed = join(localAppData, "agy", "bin", EXECUTABLE);
    if (existsSync(installed)) return { command: installed, shell: false, source: "installer" };
  }
  for (const dir of (pathVariable ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, EXECUTABLE);
    if (existsSync(candidate)) return { command: candidate, shell: false, source: "path" };
  }
  return undefined;
}
