// Identifiers follow the owner's rule of 2026-09-28: Latin letters, digits and underscore only,
// [A-Za-z_][A-Za-z0-9_]* (a private field adds the syntactic '#'). '$' is ASCII but outside the rule.
//
// Usage:
//   node scripts/ascii-identifiers.mjs                    exit 1 if an identifier breaks the rule
//   node scripts/ascii-identifiers.mjs --list             such names with counts
//   node scripts/ascii-identifiers.mjs --inventory OUT    such names with counts, files and first use (JSON)
//   node scripts/ascii-identifiers.mjs --apply MAP        rename identifiers by MAP (JSON, see below)
//   node scripts/ascii-identifiers.mjs --signature OUT    write what every identifier resolves to
//   node scripts/ascii-identifiers.mjs --compare BEFORE   exit 1 if the rename changed anything checkable
//
// Code kept in strings is code too. A template tagged js`…` is a script, one tagged html`…` is a
// page whose <script> bodies are scripts; both are checked and renamed like the rest. What is read
// is the value the tag function receives — escapes decoded, CRLF read as LF — not the source text,
// and every character of it maps back to its place in the file, so a rename lands exactly. The
// decoding is compared with TypeScript's own value of the template. Substitutions ${…} belong to
// the outer file; code put in through ${…} has to be tagged itself. Untagged strings are text.
//
// MAP is {"names": {source: target}, "files": {"relative/path": {source: target}}}; private fields
// are written with their '#'. Only identifiers change, so strings, template text and comments keep
// their exact text.
//
// What --compare checks, and what it does not:
//   * every identifier the TypeScript checker resolves must resolve to the same declaration before
//     and after (no shadowing, no capture of a global such as window.name); tests import the build
//     (../out/*.js), and those imports are resolved to the sources so they are checked too;
//   * an identifier the checker cannot resolve (a property of an untyped value, a webview global)
//     proves nothing by itself. For those the check is weaker: one old name must become one new name
//     everywhere, so a property is never renamed on one side only;
//   * object literals, classes and interfaces must not gain duplicate member names;
//   * NOT checked: property names used as strings (obj["name"], dataset ↔ data-* in selectors,
//     JSON produced elsewhere) and the scripts inside js`…`/html`…` (they run in the browser and are
//     not part of the program). The tests have to cover those.
// media/vendor holds third-party code and is not ours to rename.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKIP = new Set(["node_modules", "out", "dist", ".git", ".vscode-test", "vendor"]);
const EXTENSIONS = /\.(ts|mts|cts|tsx|js|mjs|cjs)$/;
export const VALID = /^#?[A-Za-z_][A-Za-z0-9_]*$/;
export const valid = (name) => VALID.test(name);

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

function parse(file, text) {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
}

/** Identifier and PrivateIdentifier nodes of a parsed tree, in source order. */
function identifierNodes(source) {
  const nodes = [];
  const visit = (node) => {
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) nodes.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return nodes;
}

const SIMPLE_ESCAPES = { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" };

/**
 * The value a template part gets at run time (escapes decoded, CRLF and CR read as LF — what
 * the tag function receives), with the file span every value character came from. The result is
 * compared with TypeScript's own value of the part, so a wrong decoding stops the check.
 */
function cookPart(text, start, end, expected, where) {
  let value = "";
  const from = [];
  const to = [];
  const emit = (chars, a, b) => {
    for (const ch of chars) for (let k = 0; k < ch.length; k++) { value += ch[k]; from.push(a); to.push(b); }
  };
  for (let i = start; i < end;) {
    const c = text[i];
    if (c === "\r") { const b = text[i + 1] === "\n" && i + 1 < end ? i + 2 : i + 1; emit(["\n"], i, b); i = b; continue; }
    if (c !== "\\") { emit([c], i, i + 1); i += 1; continue; }
    const d = text[i + 1];
    let length;
    if (Object.hasOwn(SIMPLE_ESCAPES, d)) { emit([SIMPLE_ESCAPES[d]], i, i + 2); length = 2; }
    else if (d === "0" && !/[0-9]/.test(text[i + 2] ?? "")) { emit(["\0"], i, i + 2); length = 2; }
    else if (d === "x") { emit([String.fromCharCode(parseInt(text.slice(i + 2, i + 4), 16))], i, i + 4); length = 4; }
    else if (d === "u" && text[i + 2] === "{") {
      const close = text.indexOf("}", i);
      emit([String.fromCodePoint(parseInt(text.slice(i + 3, close), 16))], i, close + 1);
      length = close + 1 - i;
    } else if (d === "u") { emit([String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16))], i, i + 6); length = 6; }
    else if (d === "\r") length = text[i + 2] === "\n" ? 3 : 2;           // line continuation: no value
    else if (d === "\n" || d === String.fromCharCode(0x2028) || d === String.fromCharCode(0x2029)) length = 2;
    else if (/[0-9]/.test(d)) throw new Error(`${where}: escape \\${d} gives undefined at run time`);
    else { const ch = String.fromCodePoint(text.codePointAt(i + 1)); emit([ch], i, i + 1 + ch.length); length = 1 + ch.length; }
    i += length;
  }
  if (expected === undefined) throw new Error(`${where}: an escape gives undefined at run time`);
  if (value !== expected) throw new Error(`${where}: decoded value differs from TypeScript's`);
  return { value, from, to };
}

/**
 * Scripts kept in js`…` and html`…` templates, as the tag function receives them: the decoded
 * value, not the source text. ${…} is outer code; its run-time value is not known here, so it
 * stands as " 0 " (code put in through ${…} must be tagged itself to be checked). Returns
 * [{source, from, to}]: a parsed script and, per character, the file span it came from.
 */
export function embeddedScripts(outer, text) {
  const found = [];
  const visit = (node) => {
    if (ts.isTaggedTemplateExpression(node) && ts.isIdentifier(node.tag) && ["js", "html"].includes(node.tag.text)) {
      const template = node.template;
      const { line } = outer.getLineAndCharacterOfPosition(template.getStart());
      const where = `${outer.fileName}:${line + 1}`;
      const parts = ts.isNoSubstitutionTemplateLiteral(template)
        ? [[template, template.getStart() + 1, template.getEnd() - 1]]
        : [[template.head, template.head.getStart() + 1, template.head.getEnd() - 2],
            ...template.templateSpans.map((span) => [span.literal, span.literal.getStart() + 1,
              span.literal.getEnd() - (ts.isTemplateTail(span.literal) ? 1 : 2)])];
      let value = "";
      const from = [];
      const to = [];
      parts.forEach(([part, start, end], k) => {
        if (k > 0) {
          const at = parts[k - 1][2];
          for (const ch of " 0 ") { value += ch; from.push(at); to.push(at); }
        }
        const cooked = cookPart(text, start, end, part.text, where);
        value += cooked.value;
        from.push(...cooked.from);
        to.push(...cooked.to);
      });
      const scripts = node.tag.text === "js" ? [[0, value]]
        : [...value.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => [m.index + m[0].indexOf(">") + 1, m[1]]);
      for (const [offset, code] of scripts) {
        found.push({
          source: ts.createSourceFile("embedded.js", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS),
          from: from.slice(offset, offset + code.length),
          to: to.slice(offset, offset + code.length),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(outer);
  return found;
}

/** Every identifier of a file, those in embedded scripts included, with its span in the file. */
function identifiers(file, text) {
  const outer = parse(file, text);
  const list = identifierNodes(outer).map((node) => ({ name: node.text, start: node.getStart(), end: node.getEnd(), embedded: false }));
  for (const { source, from, to } of embeddedScripts(outer, text)) {
    for (const node of identifierNodes(source)) {
      list.push({ name: node.text, start: from[node.getStart(source)], end: to[node.getEnd() - 1], embedded: true });
    }
  }
  return { outer, list };
}

export function invalidIdentifiers(file) {
  const { outer, list } = identifiers(file, fs.readFileSync(file, "utf8"));
  return list.filter((item) => !valid(item.name))
    .map((item) => ({ ...item, line: outer.getLineAndCharacterOfPosition(item.start).line + 1 }));
}

export function inventory(root = ROOT) {
  const names = new Map();
  for (const file of sourceFiles(root)) {
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    for (const hit of invalidIdentifiers(file)) {
      const entry = names.get(hit.name) ??
        { count: 0, embedded: 0, files: [], first: `${relative(file, root)}:${hit.line}: ${lines[hit.line - 1].trim().slice(0, 110)}` };
      entry.count += 1;
      if (hit.embedded) entry.embedded += 1;
      if (!entry.files.includes(relative(file, root))) entry.files.push(relative(file, root));
      names.set(hit.name, entry);
    }
  }
  return names;
}

/** Rename identifiers in place; everything else keeps its exact text, line endings included. */
export function apply(table, root = ROOT) {
  const pairs = [...Object.entries(table.names ?? {}), ...Object.values(table.files ?? {}).flatMap((m) => Object.entries(m))];
  const bad = pairs.filter(([source, target]) => !valid(target) || source.startsWith("#") !== target.startsWith("#"));
  if (bad.length) throw new Error(`targets outside [A-Za-z_][A-Za-z0-9_]*: ${bad.slice(0, 10).map((p) => p.join(" -> ")).join(", ")}`);
  const changed = {};
  for (const file of sourceFiles(root)) {
    const mapping = { ...table.names, ...(table.files?.[relative(file, root)] ?? {}) };
    const text = fs.readFileSync(file, "utf8");
    const edits = identifiers(file, text).list.filter((item) => Object.hasOwn(mapping, item.name)).sort((a, b) => b.start - a.start);
    if (!edits.length) continue;
    let result = text;
    for (const { start, end, name } of edits) result = result.slice(0, start) + mapping[name] + result.slice(end);
    fs.writeFileSync(file, result, "utf8");
    changed[relative(file, root)] = edits.length;
  }
  return changed;
}

/** Member names defined twice in one object literal, class or interface (accessor pairs and overloads excepted). */
function duplicateMembers(source) {
  const found = [];
  const visit = (node) => {
    const members = ts.isObjectLiteralExpression(node) ? node.properties
      : ts.isClassLike(node) || ts.isInterfaceDeclaration(node) || ts.isTypeLiteralNode(node) ? node.members : undefined;
    if (members) {
      const seen = new Set();
      for (const member of members) {
        const name = member.name;
        if (!name || ts.isComputedPropertyName(name)) continue;
        // Overload signatures repeat a name by design.
        if (ts.isMethodSignature(member) || (ts.isMethodDeclaration(member) && !member.body)) continue;
        const kind = ts.isGetAccessor(member) ? "get" : ts.isSetAccessor(member) ? "set" : "value";
        const isStatic = ts.canHaveModifiers(member) && ts.getModifiers(member)?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword);
        const key = `${isStatic ? "static " : ""}${kind} ${name.text}`;
        if (seen.has(key)) found.push(name.text);
        seen.add(key);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found.sort();
}

/** For every identifier (in source order, per file): its text and the declaration it resolves to. */
export function signature(root = ROOT) {
  const files = sourceFiles(root);
  const options = {
    allowJs: true, checkJs: false, noEmit: true, skipLibCheck: true,
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.Node16, moduleResolution: ts.ModuleResolutionKind.Node16,
    lib: ["lib.es2022.d.ts", "lib.dom.d.ts"], types: ["node", "vscode"],
  };
  const host = ts.createCompilerHost(options);
  const outDir = path.join(root, "out") + path.sep;
  const srcDir = path.join(root, "src") + path.sep;
  host.resolveModuleNameLiterals = (literals, containingFile, redirected, compilerOptions, containingSource) =>
    literals.map((literal) => {
      if (literal.text.startsWith(".")) {
        const target = path.resolve(path.dirname(containingFile), literal.text);
        const source = target.startsWith(outDir) ? path.join(srcDir, path.relative(outDir, target)).replace(/\.js$/, ".ts") : "";
        if (source && fs.existsSync(source)) {
          return { resolvedModule: { resolvedFileName: source, extension: ts.Extension.Ts, isExternalLibraryImport: false } };
        }
      }
      return ts.resolveModuleName(literal.text, containingFile, compilerOptions, host, undefined, redirected,
        ts.getModeForUsageLocation(containingSource, literal, compilerOptions));
    });
  const program = ts.createProgram(files, options, host);
  const checker = program.getTypeChecker();
  const indexOf = new Map();
  const perFile = new Map();
  for (const file of files) {
    const nodes = identifierNodes(program.getSourceFile(file));
    nodes.forEach((node, i) => indexOf.set(node, `${relative(file, root)}#${i}`));
    perFile.set(file, nodes);
  }
  const keyOf = (declaration, symbol) => {
    const name = declaration.name && (ts.isIdentifier(declaration.name) || ts.isPrivateIdentifier(declaration.name))
      ? declaration.name : ts.isIdentifier(declaration) ? declaration : undefined;
    if (name && indexOf.has(name)) return indexOf.get(name);
    const sourceFile = declaration.getSourceFile();
    const own = perFile.get(path.resolve(sourceFile.fileName));
    if (!own) return `lib:${ts.SyntaxKind[declaration.kind]}:${symbol.name}`;
    const first = own.find((node) => node.pos >= declaration.pos);
    return first ? `${indexOf.get(first)}:${ts.SyntaxKind[declaration.kind]}` : `${relative(sourceFile.fileName, root)}:?`;
  };
  const result = {};
  for (const [file, nodes] of perFile) {
    result[relative(file, root)] = {
      names: nodes.map((node) => node.text),
      keys: nodes.map((node) => {
        let symbol;
        try {
          symbol = checker.getSymbolAtLocation(node);
          // An import is an alias: follow it to the declaration it binds to.
          if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
        } catch { symbol = undefined; }
        const declaration = symbol?.declarations?.[0];
        return declaration ? keyOf(declaration, symbol) : "none";
      }),
      duplicates: duplicateMembers(program.getSourceFile(file)),
    };
  }
  return result;
}

export function compare(before, after) {
  const problems = [];
  const counts = { identifiers: 0, renamed: 0, renamedResolved: 0, renamedUnresolved: 0, unresolvedAll: 0 };
  const unresolvedRenames = new Map();         // old name -> Map(new name -> first place)
  for (const [file, was] of Object.entries(before)) {
    const now = after[file];
    if (!now) { problems.push(`${file}: missing now`); continue; }
    if (now.keys.length !== was.keys.length) { problems.push(`${file}: ${was.keys.length} identifiers before, ${now.keys.length} now`); continue; }
    was.keys.forEach((key, i) => {
      counts.identifiers += 1;
      const renamed = was.names[i] !== now.names[i];
      if (key === "none") counts.unresolvedAll += 1;
      if (renamed) {
        counts.renamed += 1;
        if (key === "none") counts.renamedUnresolved += 1; else counts.renamedResolved += 1;
      }
      if (now.keys[i] !== key) problems.push(`${file}#${i} ${was.names[i]} -> ${now.names[i]}: resolved to ${key}, now ${now.keys[i]}`);
      if (key === "none") {
        const targets = unresolvedRenames.get(was.names[i]) ?? new Map();
        if (!targets.has(now.names[i])) targets.set(now.names[i], `${file}#${i}`);
        unresolvedRenames.set(was.names[i], targets);
      }
    });
    const added = [...now.duplicates];
    for (const name of was.duplicates) added.splice(added.indexOf(name), added.includes(name) ? 1 : 0);
    for (const name of added) problems.push(`${file}: duplicate member ${name}`);
  }
  for (const [name, targets] of unresolvedRenames) {
    if (targets.size > 1) problems.push(`unresolved ${name} became ${[...targets].map(([t, at]) => `${t} (${at})`).join(", ")}`);
  }
  return { problems, counts };
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
    const { problems, counts } = compare(JSON.parse(fs.readFileSync(option("--compare"), "utf8")), signature());
    for (const problem of problems.slice(0, 200)) console.log(problem);
    console.log(`identifiers ${counts.identifiers}, renamed ${counts.renamed} ` +
      `(resolved ${counts.renamedResolved}, unresolved ${counts.renamedUnresolved}); unresolved in all ${counts.unresolvedAll}`);
    console.log(problems.length ? `problems: ${problems.length}` : "no problems");
    return problems.length ? 1 : 0;
  }
  const names = inventory();
  if (argv.includes("--list")) {
    for (const [name, entry] of [...names].sort((a, b) => b[1].count - a[1].count)) console.log(`${entry.count}\t${name}`);
  } else {
    const perFile = new Map();
    for (const entry of names.values()) for (const file of entry.files) perFile.set(file, (perFile.get(file) ?? 0) + 1);
    for (const [file, n] of [...perFile].sort((a, b) => b[1] - a[1])) console.log(`${String(n).padStart(6)} ${file}`);
    console.log(`identifiers outside [A-Za-z_][A-Za-z0-9_]*: ${names.size} unique, ` +
      `${[...names.values()].reduce((a, b) => a + b.count, 0)} occurrences ` +
      `(${[...names.values()].reduce((a, b) => a + b.embedded, 0)} in js/html strings) in ${perFile.size} files`);
  }
  return names.size ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exit(main(process.argv.slice(2)));
