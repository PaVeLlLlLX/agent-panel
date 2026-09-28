// Identifiers follow the owner's rule of 2026-09-28 — [A-Za-z_][A-Za-z0-9_]* — and the rename tool
// is safe. The last test is the guard: it fails as soon as a name outside the rule appears in the
// sources or in a js`…`/html`…` script. The sample sources below are strings: their names are
// test data, and the rename tables use quoted keys for the same reason.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { apply, compare, inventory, signature, valid } from "../scripts/ascii-identifiers.mjs";

function project(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ascii-identifiers-"));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), text, "utf8");
  }
  return root;
}
const names = (root) => [...inventory(root).keys()].sort();
const read = (root, name) => fs.readFileSync(path.join(root, name), "utf8");

test("the rule is Latin letters, digits and underscore; '$' is ASCII but outside it", () => {
  for (const name of ["name", "_x1", "NAME_2", "#field"]) assert.ok(valid(name), name);
  for (const name of ["$", "$name", "a$b", "имя", "ñame", "1a", "#", "#$x"]) assert.ok(!valid(name), name);
  assert.deepEqual(names(project({ "a.js": "const $name = 1;\nconst ok_1 = $name;\n" })), ["$name"]);
});

test("a Cyrillic name inside a js`…` script breaks the guard", () => {
  const root = project({ "a.mjs": "const js = (s) => s;\nopen(js`const имя = 1; result.x = имя;`);\n" });
  assert.deepEqual(names(root), ["имя"]);
  assert.equal(inventory(root).get("имя").embedded, 2);
});

test("in an html`…` page only <script> bodies are code; untagged strings are text", () => {
  const root = project({
    "a.mjs": "const html = (s) => s;\n" +
      "const page = html`<p>текст страницы</p><script>const имя = 2;</script>`;\n" +
      "const note = `имя = 1`;\nconst label = \"значение\";\n",
  });
  assert.deepEqual(names(root), ["имя"]);
});

test("an escape in js`…` code is checked as the browser gets it: \\n ends a comment", () => {
  const root = project({ "a.mjs": "const js = (s) => s;\nopen(js`// comment\\nconst имя = 1;`);\n" });
  assert.deepEqual(names(root), ["имя"]);
});

test("${…} of a template inside js`…` code is code", () => {
  const root = project({ "a.mjs": "const js = (s) => s;\nopen(js`const t = \\`\\${data.имя}\\`;`);\n" });
  assert.deepEqual(names(root), ["имя"]);
});

test("apply keeps positions across escapes and CRLF inside js`…` code", () => {
  const root = project({ "a.mjs": "const js = (s) => s;\r\nconst code = js`a\\tb\\u0020\\n\r\nconst имя = 1; имя;`;\r\n" });
  apply({ names: { "имя": "name" } }, root);
  assert.equal(read(root, "a.mjs"), "const js = (s) => s;\r\nconst code = js`a\\tb\\u0020\\n\r\nconst name = 1; name;`;\r\n");
});

test("a name written with an escape inside js`…` code is renamed as a whole", () => {
  const root = project({ "a.mjs": "const js = (s) => s;\nconst code = js`const \\u0438мя = 1;`;\n" });
  assert.deepEqual(names(root), ["имя"]);
  apply({ names: { "имя": "name" } }, root);
  assert.equal(read(root, "a.mjs"), "const js = (s) => s;\nconst code = js`const name = 1;`;\n");
});

test("an escape the browser would get as undefined stops the check", () => {
  const root = project({ "a.mjs": "const js = (s) => s;\nopen(js`const a = \"\\1\";`);\n" });
  assert.throws(() => inventory(root), /escape/);
});

test("apply renames inside js`…` scripts; ${…} stays outer code", () => {
  const root = project({ "a.mjs": "const js = (s) => s;\nconst имя = 1;\nconst code = js`let имя = ${имя}; // имя`;\n" });
  apply({ names: { "имя": "name" } }, root);
  assert.equal(read(root, "a.mjs"), "const js = (s) => s;\nconst name = 1;\nconst code = js`let name = ${name}; // имя`;\n");
});

test("apply renames identifiers only: strings, template text and comments keep their text", () => {
  const root = project({
    "a.js": "const путь = \"путь\"; // путь\r\nconsole.log(`${путь} путь`);\r\n" +
      "class К { #поле = 1; get() { return this.#поле; } }\r\n",
  });
  apply({ names: { "путь": "path", "К": "K", "#поле": "#field" } }, root);
  assert.equal(read(root, "a.js"),
    "const path = \"путь\"; // путь\r\nconsole.log(`${path} путь`);\r\n" +
    "class K { #field = 1; get() { return this.#field; } }\r\n");
});

test("apply takes per-file overrides on top of the global names", () => {
  const root = project({ "a.js": "const т = 1;\n", "b.js": "const т = 2;\n" });
  apply({ names: { "т": "t" }, files: { "b.js": { "т": "ticker" } } }, root);
  assert.equal(read(root, "a.js"), "const t = 1;\n");
  assert.equal(read(root, "b.js"), "const ticker = 2;\n");
});

test("apply refuses a target outside the rule", () => {
  const root = project({ "a.js": "const имя = 1;\n" });
  assert.throws(() => apply({ names: { "имя": "$name" } }, root), /outside/);
  assert.throws(() => apply({ names: { "#поле": "field" } }, root), /outside/);
  assert.equal(read(root, "a.js"), "const имя = 1;\n");
});

test("a rename that shadows an outer name changes the signature", () => {
  const root = project({ "a.mjs": "const path = 1;\nexport function f() {\n  const путь = 2;\n  return path + путь;\n}\n" });
  const before = signature(root);
  apply({ names: { "путь": "path" } }, root);
  assert.notDeepEqual(compare(before, signature(root)).problems, []);
});

test("a rename that captures a browser global changes the signature", () => {
  const root = project({ "a.js": "function f() {\n  const имя = 2;\n  return [name, имя];\n}\n" });
  const before = signature(root);
  apply({ names: { "имя": "name" } }, root);
  assert.notDeepEqual(compare(before, signature(root)).problems, []);
});

test("an unresolved property renamed differently in two files is reported", () => {
  const root = project({ "a.js": "function f(o) { return o.имя; }\n", "b.js": "function g(o) { return o.имя; }\n" });
  const before = signature(root);
  apply({ names: { "имя": "name" }, files: { "b.js": { "имя": "title" } } }, root);
  const { problems } = compare(before, signature(root));
  assert.ok(problems.some((p) => p.startsWith("unresolved имя became")), problems.join("\n"));
});

test("a rename that makes two members one is reported", () => {
  const root = project({ "a.js": "const o = { имя: 1, name: 2 };\nclass C { имя() {} name() {} }\n" });
  const before = signature(root);
  apply({ names: { "имя": "name" } }, root);
  const { problems } = compare(before, signature(root));
  assert.equal(problems.filter((p) => p.includes("duplicate member name")).length, 2, problems.join("\n"));
});

test("a test's import of the build resolves to the source declaration", () => {
  const root = project({
    "src/a.ts": "export const имя = 1;\n",
    "test/t.mjs": "import { имя } from \"../out/a.js\";\nconsole.log(имя);\n",
  });
  const keys = signature(root)["test/t.mjs"].keys;
  assert.ok(keys.includes("src/a.ts#0"), keys.join(" "));
});

test("a rename without collisions keeps the signature", () => {
  const root = project({
    "a.mjs": "export class Счёт {\n  #деньги = 0;\n  внести(сумма) { this.#деньги += сумма; return this.#деньги; }\n}\n" +
      "export const счёт = new Счёт();\nсчёт.внести(5);\n",
  });
  const before = signature(root);
  apply({ names: { "Счёт": "Account", "#деньги": "#cash", "внести": "deposit", "сумма": "amount", "счёт": "account" } }, root);
  const { problems, counts } = compare(before, signature(root));
  assert.deepEqual(problems, []);
  assert.equal(counts.renamed, 11);
});

test("the repository follows the rule, js`…`/html`…` scripts included", () => {
  const left = [...inventory().keys()];
  assert.deepEqual(left.slice(0, 20), [], `identifiers outside the rule: ${left.length}`);
});
