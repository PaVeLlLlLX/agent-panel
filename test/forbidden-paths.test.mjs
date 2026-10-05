/**
 * Запрещённые пути рецензентов (src/forbiddenPaths.ts): что ловит
 * стоп-сигнал, а что — нет.
 *
 * Итоговая рецензия ветки 05.10: у Trading список был
 * ["data/", "data\\", ".env"], а data/ ловился после любой косой черты.
 * Поэтому чтение пакета кода tradingbot/data/ (storage.py, market_data.py)
 * останавливало проверку. А папку данных в корне без косой черты на конце
 * («Get-ChildItem …\Trading\data», «rg x data», Path('data')) стоп-сигнал
 * пропускал. Фрагмент от корня — «./data/».
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { forbiddenFragment, rootAnchored, withoutRoot } from "../out/forbiddenPaths.js";

const PROJECT = "C:\\Users\\21435\\source\\Trading";
const TRADING = ["./data/", ".env"];

test("от корня: пакет кода tradingbot/data/ и его файлы — не папка данных", () => {
  for (const command of [
    "Get-Content tradingbot\\data\\storage.py",
    "rg -n fillna tradingbot/data/",
    "git diff HEAD~1 -- tradingbot/data/market_data.py",
    `git -C ${PROJECT} show HEAD:tradingbot/data/storage.py`,
    `rg -n fillna ${PROJECT}\\tradingbot\\data`,
    'python -c "import tradingbot.data.storage as s; print(s.__file__)"',
    "Get-Content .\\tradingbot\\data\\funding.py",
  ]) {
    assert.equal(forbiddenFragment(command, TRADING, PROJECT), undefined, command);
  }
});

test("от корня: папка данных — относительно, через .\\, абсолютно и без косой черты на конце", () => {
  for (const command of [
    // относительный путь
    "Get-Content data\\prices.parquet",
    "python -c \"open('data/x.parquet')\"",
    "dir DATA\\x",
    "tool --dir=data/raw",
    "Get-Content `data\\x.csv`",
    // через .\ и ./
    "Get-Content .\\data\\prices.parquet",
    "ls ./data/",
    "Get-ChildItem .\\data",
    // абсолютный путь
    `Get-Content ${PROJECT}\\data\\prices.parquet`,
    `Get-ChildItem ${PROJECT.toLowerCase()}/data/`,
    // папка без косой черты
    `Get-ChildItem ${PROJECT}\\data`,
    `Get-ChildItem "${PROJECT}\\data" -Recurse`,
    "rg x data",
    "cd data; ls",
    "Get-ChildItem data | Measure-Object",
    "python -c \"from pathlib import Path; print(list((Path('data') / 'x').iterdir()))\"",
    'python -c "import os; print(os.listdir(\\"data\\"))"',
  ]) {
    assert.equal(forbiddenFragment(command, TRADING, PROJECT), "./data/", command);
  }
});

test("от корня: metadata/, sample_data, другая папка проекта и переменная data в коде — не папка данных", () => {
  for (const command of [
    "ls metadata/",
    "Get-ChildItem sample_data\\",
    "rg -n database src",
    "Get-Content data.csv",
    `Get-ChildItem ${PROJECT}2\\data`,
    "Get-ChildItem ..\\data",
    "python -c \"data = [1, 2, 3]; print(sum(data))\"",
    "# имя: синтетика\nimport numpy as np\ndata = np.random.default_rng(1).normal(size=100)\nprint(data.mean())",
    "Get-Content C:\\Users\\21435\\AppData\\Local\\agent-panel\\review\\trading-1\\codex\\dd.py",
  ]) {
    assert.equal(forbiddenFragment(command, TRADING, PROJECT), undefined, command);
  }
});

test("от корня: «.\\data\\» — то же, что «./data/»; без папки проекта — только относительный путь", () => {
  assert.equal(forbiddenFragment("type data\\x", [".\\data\\"], PROJECT), ".\\data\\");
  assert.equal(forbiddenFragment(`type ${PROJECT}\\data\\x`, [".\\data\\"]), undefined, "проект не известен — абсолютный путь не узнать");
  assert.equal(forbiddenFragment("type data\\x", ["./"], PROJECT), undefined, "«./» без имени не запрещает всё");
});

test("простой фрагмент — где угодно в пути, как прежде; /secrets — и внутри пути", () => {
  assert.equal(forbiddenFragment("Get-Content tradingbot\\data\\storage.py", ["data/"]), "data/");
  assert.equal(forbiddenFragment("ls C:/p/secrets/key", ["/secrets"]), "/secrets");
  assert.equal(forbiddenFragment("cat .env.local", [".env"]), ".env");
  assert.equal(forbiddenFragment('rg -n "process.env" src', [".env"]), undefined);
});

test("шаблон секрета — не секрет: .env.example, .env.sample, .env.template не ловятся, .env рядом с ним — ловится", () => {
  for (const command of ["cat .env.example", "Get-Content .\\.env.sample", "type C:\\p\\.env.template"]) {
    assert.equal(forbiddenFragment(command, TRADING, PROJECT), undefined, command);
  }
  assert.equal(forbiddenFragment("cat .env.example .env", TRADING, PROJECT), ".env");
  assert.equal(forbiddenFragment("cat .env.examples", TRADING, PROJECT), ".env", "другое слово — не шаблон");
  assert.equal(forbiddenFragment("cat ./.env.example", ["./.env"], PROJECT), undefined);
  assert.equal(forbiddenFragment("cat ./.env", ["./.env"], PROJECT), "./.env");
});

test("фрагмент от корня узнаётся по «./» или «.\\»; роль называет его без них", () => {
  assert.equal(rootAnchored("./data/"), true);
  assert.equal(rootAnchored(" .\\data\\ "), true);
  assert.equal(rootAnchored("data/"), false);
  assert.equal(rootAnchored(".env"), false);
  assert.equal(withoutRoot("./data/"), "data/");
  assert.equal(withoutRoot(".\\data\\"), "data\\");
});
