// Identifiers are ASCII only (owner's rule of 2026-09-28), and the rename tool is safe.
// The last test is the guard: it fails as soon as a non-ASCII identifier appears in the sources.
// The sample sources below are strings: their Cyrillic names are test data, not identifiers,
// and the rename tables use quoted keys for the same reason.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { apply, compare, inventory, signature } from "../scripts/ascii-identifiers.mjs";

function project(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ascii-identifiers-"));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(root, name), text, "utf8");
  return root;
}

test("apply renames identifiers only: strings, template text and comments keep their text", () => {
  const root = project({
    "a.js": "const путь = \"путь\"; // путь\r\nconsole.log(`${путь} путь`);\r\n" +
      "class К { #поле = 1; get() { return this.#поле; } }\r\n",
  });
  apply({ names: { "путь": "path", "К": "K", "#поле": "#field" } }, root);
  assert.equal(fs.readFileSync(path.join(root, "a.js"), "utf8"),
    "const path = \"путь\"; // путь\r\nconsole.log(`${path} путь`);\r\n" +
    "class K { #field = 1; get() { return this.#field; } }\r\n");
});

test("apply takes per-file overrides on top of the global names", () => {
  const root = project({ "a.js": "const т = 1;\n", "b.js": "const т = 2;\n" });
  apply({ names: { "т": "t" }, files: { "b.js": { "т": "ticker" } } }, root);
  assert.equal(fs.readFileSync(path.join(root, "a.js"), "utf8"), "const t = 1;\n");
  assert.equal(fs.readFileSync(path.join(root, "b.js"), "utf8"), "const ticker = 2;\n");
});

test("a rename that shadows an outer name changes the signature", () => {
  const root = project({ "a.mjs": "const path = 1;\nexport function f() {\n  const путь = 2;\n  return path + путь;\n}\n" });
  const before = signature(root);
  apply({ names: { "путь": "path" } }, root);
  assert.notDeepEqual(compare(before, signature(root)), []);
});

test("a rename that captures a browser global changes the signature", () => {
  const root = project({ "a.js": "function f() {\n  const имя = 2;\n  return [name, имя];\n}\n" });
  const before = signature(root);
  apply({ names: { "имя": "name" } }, root);
  assert.notDeepEqual(compare(before, signature(root)), []);
});

test("a rename without collisions keeps the signature", () => {
  const root = project({
    "a.mjs": "export class Счёт {\n  #деньги = 0;\n  внести(сумма) { this.#деньги += сумма; return this.#деньги; }\n}\n" +
      "export const счёт = new Счёт();\nсчёт.внести(5);\n",
  });
  const before = signature(root);
  apply({ names: { "Счёт": "Account", "#деньги": "#cash", "внести": "deposit", "сумма": "amount", "счёт": "account" } }, root);
  assert.deepEqual(compare(before, signature(root)), []);
});

test("the repository has no non-ASCII identifiers", () => {
  const left = [...inventory().keys()];
  assert.deepEqual(left.slice(0, 20), [], `non-ASCII identifiers: ${left.length}`);
});
