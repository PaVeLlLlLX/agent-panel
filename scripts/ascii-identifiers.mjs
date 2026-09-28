// ASCII-only identifiers (owner's rule of 2026-09-28): check, inventory and a safe rename.
//
// Usage:
//   node scripts/ascii-identifiers.mjs                    exit 1 if a non-ASCII identifier is found
//   node scripts/ascii-identifiers.mjs --list             unique names with counts
//   node scripts/ascii-identifiers.mjs --inventory OUT    names with counts, files and first use (JSON)
//   node scripts/ascii-identifiers.mjs --apply MAP        rename identifiers by MAP (JSON, see below)
//   node scripts/ascii-identifiers.mjs --signature OUT    write what every identifier resolves to
//   node scripts/ascii-identifiers.mjs --compare BEFORE   exit 1 if any identifier resolves elsewhere now
//
// MAP is {"names": {source: target}, "files": {"relative/path": {source: target}}}; private
// fields are written with their '#'. Only Identifier and PrivateIdentifier nodes change, so
// strings, template text and comments keep their exact text. A rename is safe when the
// signature before and after is the same: every identifier, renamed or not, still resolves
// to the same declaration (no shadowing, no capture of a global such as window.name).
// media/vendor holds third-party code and is not ours to rename.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKIP = new Set(["node_modules", "out", "dist", ".git", ".vscode-test", "vendor"]);
const EXTENSIONS = /\.(ts|mts|cts|tsx|js|mjs|cjs)$/;
const ASCII = /^[\x00-\x7F]*$/;

export function sourceFiles(root = ROOT) {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (EXTENSIONS.test(entry.name) && !entry.name.endsWith(".d.ts")) found.push(full);
    }
  };
  walk(root);
  return found.sort();
}

const relative = (file, root) => path.relative(root, file).split(path.sep).join("/");

/** Identifier and PrivateIdentifier nodes of a parsed file, in source order. */
function identifierNodes(source) {
  const nodes = [];
  const visit = (node) => {
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) nodes.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return nodes;
}

function parse(file, text = fs.readFileSync(file, "utf8")) {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
}

export function nonAsciiIdentifiers(file) {
  const source = parse(file);
  return identifierNodes(source)
    .filter((node) => !ASCII.test(node.text))
    .map((node) => ({ name: node.text, line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1 }));
}

export function inventory(root = ROOT) {
  const names = new Map();
  for (const file of sourceFiles(root)) {
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    for (const hit of nonAsciiIdentifiers(file)) {
      const entry = names.get(hit.name) ?? { count: 0, files: [], first: `${relative(file, root)}:${hit.line}: ${lines[hit.line - 1].trim().slice(0, 110)}` };
      entry.count += 1;
      if (!entry.files.includes(relative(file, root))) entry.files.push(relative(file, root));
      names.set(hit.name, entry);
    }
  }
  return names;
}

/** Rename identifiers in place; everything else keeps its exact text, line endings included. */
export function apply(table, root = ROOT) {
  const changed = {};
  for (const file of sourceFiles(root)) {
    const mapping = { ...table.names, ...(table.files?.[relative(file, root)] ?? {}) };
    const text = fs.readFileSync(file, "utf8");
    const edits = identifierNodes(parse(file, text))
      .filter((node) => Object.hasOwn(mapping, node.text))
      .map((node) => [node.getStart(), node.getEnd(), mapping[node.text]]);
    if (!edits.length) continue;
    let result = text;
    for (const [start, end, name] of edits.reverse()) result = result.slice(0, start) + name + result.slice(end);
    fs.writeFileSync(file, result, "utf8");
    changed[relative(file, root)] = edits.length;
  }
  return changed;
}

/** For every identifier (in source order, per file): the declaration it resolves to. */
export function signature(root = ROOT) {
  const files = sourceFiles(root);
  const program = ts.createProgram(files, {
    allowJs: true, checkJs: false, noEmit: true, skipLibCheck: true,
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.Node16, moduleResolution: ts.ModuleResolutionKind.Node16,
    lib: ["lib.es2022.d.ts", "lib.dom.d.ts"], types: ["node", "vscode"],
  });
  const checker = program.getTypeChecker();
  const indexOf = new Map();                // node -> "file#index"
  const perFile = new Map();
  for (const file of files) {
    const source = program.getSourceFile(file);
    const nodes = identifierNodes(source);
    nodes.forEach((node, i) => indexOf.set(node, `${relative(file, root)}#${i}`));
    perFile.set(file, nodes);
  }
  const keyOf = (declaration) => {
    const name = declaration.name && (ts.isIdentifier(declaration.name) || ts.isPrivateIdentifier(declaration.name))
      ? declaration.name : ts.isIdentifier(declaration) ? declaration : undefined;
    if (name && indexOf.has(name)) return indexOf.get(name);
    const source = declaration.getSourceFile();
    if (!files.includes(path.resolve(source.fileName))) return `lib:${ts.SyntaxKind[declaration.kind]}`;
    const first = perFile.get(path.resolve(source.fileName))?.find((node) => node.pos >= declaration.pos);
    return first ? `${indexOf.get(first)}:${ts.SyntaxKind[declaration.kind]}` : `${relative(source.fileName, root)}:?`;
  };
  const result = {};
  for (const [file, nodes] of perFile) {
    result[relative(file, root)] = nodes.map((node) => {
      let symbol;
      try { symbol = checker.getSymbolAtLocation(node); } catch { symbol = undefined; }
      const declaration = symbol?.declarations?.[0];
      if (!declaration) return "none";
      const key = keyOf(declaration);
      return key.startsWith("lib:") ? `${key}:${symbol.name}` : key;
    });
  }
  return result;
}

export function compare(before, after) {
  const problems = [];
  for (const [file, keys] of Object.entries(before)) {
    const now = after[file];
    if (!now) { problems.push(`${file}: missing now`); continue; }
    if (now.length !== keys.length) { problems.push(`${file}: ${keys.length} identifiers before, ${now.length} now`); continue; }
    keys.forEach((key, i) => { if (now[i] !== key) problems.push(`${file}#${i}: resolved to ${key}, now ${now[i]}`); });
  }
  return problems;
}

function main(argv) {
  const option = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  if (option("--inventory")) {
    fs.writeFileSync(option("--inventory"), JSON.stringify(Object.fromEntries(inventory()), null, 1), "utf8");
    return 0;
  }
  if (option("--apply")) {
    const changed = apply(JSON.parse(fs.readFileSync(option("--apply"), "utf8")));
    console.log(`files: ${Object.keys(changed).length}, renamed identifiers: ${Object.values(changed).reduce((a, b) => a + b, 0)}`);
    return 0;
  }
  if (option("--signature")) {
    fs.writeFileSync(option("--signature"), JSON.stringify(signature()), "utf8");
    return 0;
  }
  if (option("--compare")) {
    const problems = compare(JSON.parse(fs.readFileSync(option("--compare"), "utf8")), signature());
    for (const problem of problems.slice(0, 200)) console.log(problem);
    console.log(problems.length ? `resolution changed: ${problems.length}` : "every identifier resolves as before");
    return problems.length ? 1 : 0;
  }
  const names = inventory();
  if (argv.includes("--list")) {
    for (const [name, entry] of [...names].sort((a, b) => b[1].count - a[1].count)) console.log(`${entry.count}\t${name}`);
  } else {
    const perFile = new Map();
    for (const entry of names.values()) for (const file of entry.files) perFile.set(file, (perFile.get(file) ?? 0) + 1);
    for (const [file, n] of [...perFile].sort((a, b) => b[1] - a[1])) console.log(`${String(n).padStart(6)} ${file}`);
    console.log(`non-ASCII identifiers: ${names.size} unique, ` +
      `${[...names.values()].reduce((a, b) => a + b.count, 0)} occurrences in ${perFile.size} files`);
  }
  return names.size ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exit(main(process.argv.slice(2)));
