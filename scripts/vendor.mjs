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

const root = join(import.meta.dirname, "..");
const nodeModules = join(root, "node_modules");
const target = join(root, "media", "vendor");

rmSync(target, { recursive: true, force: true });
mkdirSync(join(target, "katex", "fonts"), { recursive: true });

await build({
  entryPoints: [join(root, "scripts", "markdown-entry.mjs")],
  bundle: true,
  format: "iife",
  minify: true,
  target: "es2022",
  outfile: join(target, "markdown.js"),
  logLevel: "warning",
});

const katex = join(nodeModules, "katex", "dist");
copyFileSync(join(katex, "katex.min.css"), join(target, "katex", "katex.min.css"));
for (const file of readdirSync(join(katex, "fonts"))) {
  if (file.endsWith(".woff2")) copyFileSync(join(katex, "fonts", file), join(target, "katex", "fonts", file));
}

const PACKAGES = ["markdown-it", "linkify-it", "mdurl", "uc.micro", "entities", "punycode.js", "katex"];
const licenses = PACKAGES.map((pkg) => {
  const dir = join(nodeModules, pkg);
  const file = existsSync(dir) ? readdirSync(dir).find((it) => /^licen[cs]e/i.test(it)) : undefined;
  if (!file) throw new Error(`не найдена лицензия пакета ${pkg}`);
  const version = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version;
  return `=== ${pkg} ${version} ===\n\n${readFileSync(join(dir, file), "utf8").trim()}\n`;
});
writeFileSync(join(target, "LICENSES.txt"), licenses.join("\n"));
