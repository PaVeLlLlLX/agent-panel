/**
 * Проверка, что расширение загружается и активируется.
 *
 * Модуль `vscode` существует только внутри редактора, поэтому подменяется
 * заглушкой. Проверка дешёвая, но ловит настоящие поломки: ошибку импорта,
 * падение на верхнем уровне модуля и несовпадение имён команд с манифестом.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import Module from "node:module";

const require_ = createRequire(import.meta.url);

test("расширение активируется и регистрирует команды из манифеста", () => {
  const registered = [];
  const stub = {
    window: {
      createWebviewPanel: () => ({
        webview: { html: "", postMessage: () => {}, onDidReceiveMessage: () => {}, asWebviewUri: (u) => u, cspSource: "vscode-resource:" },
        onDidDispose: () => {},
      }),
      showInformationMessage: () => {},
      showErrorMessage: () => {},
    },
    workspace: {
      getConfiguration: () => ({ get: (_key, fallback) => fallback }),
      workspaceFolders: undefined,
      fs: { createDirectory: async () => {} },
    },
    commands: {
      registerCommand: (name) => {
        registered.push(name);
        return { dispose() {} };
      },
    },
    Uri: { joinPath: (...ch) => ch.join("/") },
    ViewColumn: { Beside: 2 },
  };

  // Подмена require для модуля vscode.
  const original = Module._load;
  Module._load = function (request, ...rest) {
    if (request === "vscode") return stub;
    return original.call(this, request, ...rest);
  };
  try {
    const extensionDir = require_("../out/extension.js");
    assert.equal(typeof extensionDir.activate, "function");
    assert.equal(typeof extensionDir.deactivate, "function");
    extensionDir.activate({
      subscriptions: [],
      globalStorageUri: { fsPath: "." },
      extensionUri: ".",
    });
  } finally {
    Module._load = original;
  }

  const manifest = JSON.parse(readFileSync("package.json", "utf8"));
  const declared = manifest.contributes.commands.map((k) => k.command);
  assert.deepEqual(
    registered.sort(),
    sortedDeclared(declared),
    "все объявленные команды должны быть зарегистрированы, иначе в палитре будет «command not found»",
  );
});

function sortedDeclared(a) {
  return [...a].sort();
}

test("точка входа манифеста указывает на существующий файл", () => {
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));
  assert.doesNotThrow(
    () => require_.resolve(`../${manifest.main.replace(/^\.\//, "")}`),
    `main из манифеста не разрешается: ${manifest.main}`,
  );
});
