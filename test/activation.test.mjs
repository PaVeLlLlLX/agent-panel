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
  const зарегистрированы = [];
  const заглушка = {
    window: {
      createWebviewPanel: () => ({
        webview: { html: "", postMessage: () => {}, onDidReceiveMessage: () => {}, asWebviewUri: (u) => u, cspSource: "vscode-resource:" },
        onDidDispose: () => {},
      }),
      showInformationMessage: () => {},
      showErrorMessage: () => {},
    },
    workspace: {
      getConfiguration: () => ({ get: (_к, по) => по }),
      workspaceFolders: undefined,
      fs: { createDirectory: async () => {} },
    },
    commands: {
      registerCommand: (имя) => {
        зарегистрированы.push(имя);
        return { dispose() {} };
      },
    },
    Uri: { joinPath: (...ч) => ч.join("/") },
    ViewColumn: { Beside: 2 },
  };

  // Подмена require для модуля vscode.
  const исходный = Module._load;
  Module._load = function (запрос, ...остальное) {
    if (запрос === "vscode") return заглушка;
    return исходный.call(this, запрос, ...остальное);
  };
  try {
    const расширение = require_("../out/extension.js");
    assert.equal(typeof расширение.activate, "function");
    assert.equal(typeof расширение.deactivate, "function");
    расширение.activate({
      subscriptions: [],
      globalStorageUri: { fsPath: "." },
      extensionUri: ".",
    });
  } finally {
    Module._load = исходный;
  }

  const манифест = JSON.parse(readFileSync("package.json", "utf8"));
  const объявлены = манифест.contributes.commands.map((к) => к.command);
  assert.deepEqual(
    зарегистрированы.sort(),
    objявлены_sorted(объявлены),
    "все объявленные команды должны быть зарегистрированы, иначе в палитре будет «command not found»",
  );
});

function objявлены_sorted(а) {
  return [...а].sort();
}

test("точка входа манифеста указывает на существующий файл", () => {
  const манифест = JSON.parse(readFileSync("package.json", "utf8"));
  assert.doesNotThrow(
    () => require_.resolve(`../${манифест.main.replace(/^\.\//, "")}`),
    `main из манифеста не разрешается: ${манифест.main}`,
  );
});
