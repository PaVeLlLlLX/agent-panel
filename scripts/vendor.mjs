/**
 * Библиотеки для webview: из интернета панель ничего не грузит.
 *
 * markdown-it 15 не поставляет UMD-сборку, только ES-модуль, поэтому
 * markdown-it, KaTeX и правило формул собираются esbuild в один файл.
 * Стили и шрифты KaTeX копируются рядом (только woff2 — его webview VS Code
 * поддерживает), лицензии всех вошедших пакетов — в LICENSES.txt.
 *
 * Результат — media/vendor/, в git не хранится, собирается в npm run build.
 */
import { build } from "esbuild";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const корень = join(import.meta.dirname, "..");
const модули = join(корень, "node_modules");
const цель = join(корень, "media", "vendor");

rmSync(цель, { recursive: true, force: true });
mkdirSync(join(цель, "katex", "fonts"), { recursive: true });

await build({
  entryPoints: [join(корень, "scripts", "markdown-entry.mjs")],
  bundle: true,
  format: "iife",
  minify: true,
  target: "es2022",
  outfile: join(цель, "markdown.js"),
  logLevel: "warning",
});

const katex = join(модули, "katex", "dist");
copyFileSync(join(katex, "katex.min.css"), join(цель, "katex", "katex.min.css"));
for (const файл of readdirSync(join(katex, "fonts"))) {
  if (файл.endsWith(".woff2")) copyFileSync(join(katex, "fonts", файл), join(цель, "katex", "fonts", файл));
}

const ПАКЕТЫ = ["markdown-it", "linkify-it", "mdurl", "uc.micro", "entities", "punycode.js", "katex"];
const лицензии = ПАКЕТЫ.map((пакет) => {
  const папка = join(модули, пакет);
  const файл = existsSync(папка) ? readdirSync(папка).find((и) => /^licen[cs]e/i.test(и)) : undefined;
  if (!файл) throw new Error(`не найдена лицензия пакета ${пакет}`);
  const версия = JSON.parse(readFileSync(join(папка, "package.json"), "utf8")).version;
  return `=== ${пакет} ${версия} ===\n\n${readFileSync(join(папка, файл), "utf8").trim()}\n`;
});
writeFileSync(join(цель, "LICENSES.txt"), лицензии.join("\n"));
