/**
 * Какой codex запускает панель.
 *
 * Чат Codex владельца живёт в расширении ChatGPT для VS Code, и у расширения
 * свой codex — новее CLI из npm. 25.09.2026 у ветки владельца была сохранена
 * модель gpt-6-sol: CLI 0.153.0 из npm её не знает, и ход падал с «model is
 * not supported when using Codex with a ChatGPT account», а codex
 * 0.155.0-alpha.16 из расширения ту же ветку продолжил. Поэтому по умолчанию
 * берётся codex расширения — тот же, что в чате владельца, с теми же
 * моделями. Явная настройка важнее.
 *
 * Путь к расширению содержит его версию и меняется при обновлении, поэтому
 * он ищется при каждом открытии комнаты, а не запоминается.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface CodexLaunch {
  readonly command: string;
  /** undefined — решает адаптер: на Windows оболочка нужна для .cmd-обёрток. */
  readonly shell: boolean | undefined;
  readonly source: "setting" | "extension" | "path";
}

/** codex внутри расширения ChatGPT: `bin/<платформа>/codex(.exe)`. */
export function findExtensionCodex(папкаРасширения: string | undefined): string | undefined {
  if (!папкаРасширения) return undefined;
  const bin = join(папкаРасширения, "bin");
  let платформы: string[];
  try {
    платформы = readdirSync(bin).sort();
  } catch {
    return undefined;
  }
  const имя = process.platform === "win32" ? "codex.exe" : "codex";
  for (const платформа of платформы) {
    const путь = join(bin, платформа, имя);
    if (existsSync(путь)) return путь;
  }
  return undefined;
}

/** Настройка "codex" — значение по умолчанию, а не выбор человека. */
export function resolveCodexCommand(настройка: string | undefined, папкаРасширения: string | undefined): CodexLaunch {
  const явная = (настройка ?? "").trim();
  if (явная && явная !== "codex") {
    return { command: явная, shell: /\.exe$/i.test(явная) ? false : undefined, source: "setting" };
  }
  const изРасширения = findExtensionCodex(папкаРасширения);
  if (изРасширения) return { command: изРасширения, shell: false, source: "extension" };
  return { command: "codex", shell: undefined, source: "path" };
}
