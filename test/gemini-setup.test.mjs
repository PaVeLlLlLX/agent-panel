/**
 * Подготовка agy к роли рецензента.
 *
 * Живая проба 02.10.2026: без правил agy без интерфейса пишет файлы без
 * вопроса, а strict не даёт читать даже файлы проекта. Гарантия «только
 * чтение» — правила deny в общем settings.json agy. Панель дописывает их
 * только по кнопке, сохраняя остальное, и не трогает сломанный файл.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  REVIEWER_AGENT,
  REVIEWER_AGENT_MD,
  addReadOnlyRules,
  agySettingsPath,
  checkReadOnlyRules,
  ensureReviewerAgent,
  reviewerAgentPath,
  reviewerAgentMarkdown,
  rulesRefusal,
} from "../out/geminiSetup.js";

const home = () => mkdtempSync(join(tmpdir(), "home-"));

test("пути настроек и агента — в ~/.gemini", () => {
  assert.equal(agySettingsPath("H"), join("H", ".gemini", "antigravity-cli", "settings.json"));
  assert.equal(reviewerAgentPath("H"), join("H", ".gemini", "config", "agents", REVIEWER_AGENT, "agent.md"));
});

test("нет файла настроек — не хватает всех трёх правил", () => {
  const check = checkReadOnlyRules(agySettingsPath(home()));
  assert.equal(check.ok, false);
  assert.equal(check.problems.length, 3);
  assert.match(rulesRefusal(check, "S"), /нет режима «только чтение» в настройках agy: .*read_url\(\*\).*write_file\(\*\).*command\(\*\)/);
});

test("«Добавить правила» дописывает недостающее, сохраняя остальное и без повторов", () => {
  const file = agySettingsPath(home());
  addReadOnlyRules(file);
  writeFileSync(file, JSON.stringify({
    model: "Gemini 3.8 Flash (High)",
    trustedWorkspaces: ["C:/proj"],
    permissions: { allow: ["command(git status)", { custom: true }], deny: ["write_file(*)"] },
  }));
  const check = addReadOnlyRules(file);
  assert.equal(check.ok, true);
  const saved = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(saved.model, "Gemini 3.8 Flash (High)");
  assert.deepEqual(saved.trustedWorkspaces, ["C:/proj"]);
  assert.deepEqual(saved.permissions.allow, ["command(git status)", { custom: true }, "read_url(*)"]);
  assert.deepEqual(saved.permissions.deny, ["write_file(*)", "command(*)"]);
  assert.equal(rulesRefusal(check, file), undefined);
});

test("сломанный settings.json не перезаписывается, причина названа", () => {
  const file = agySettingsPath(home());
  addReadOnlyRules(file);
  writeFileSync(file, "{ это не JSON");
  const check = addReadOnlyRules(file);
  assert.equal(check.ok, false);
  assert.ok(check.broken);
  assert.equal(readFileSync(file, "utf8"), "{ это не JSON", "файл владельца не тронут");
  assert.match(rulesRefusal(check, file), /не разбираются .* исправьте .* вручную/);
});

test("режим strict ослепляет рецензента: проблема названа, «Добавить правила» возвращает обычный", () => {
  const file = agySettingsPath(home());
  addReadOnlyRules(file);
  writeFileSync(file, JSON.stringify({ toolPermission: "strict", permissions: { allow: ["read_url(*)"], deny: ["write_file(*)", "command(*)"] } }));
  const before = checkReadOnlyRules(file);
  assert.equal(before.ok, false);
  assert.match(before.problems[0], /режим «strict»/);
  assert.equal(addReadOnlyRules(file).ok, true);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).toolPermission, undefined);
});

test("агент agy пишется, только если текст отличается", () => {
  const file = reviewerAgentPath(home());
  assert.equal(ensureReviewerAgent(file), true);
  assert.equal(readFileSync(file, "utf8"), REVIEWER_AGENT_MD);
  assert.equal(ensureReviewerAgent(file), false, "повторно не переписывается");
  writeFileSync(file, "старая роль");
  assert.equal(ensureReviewerAgent(file), true);
  assert.ok(existsSync(file));
});

test("роль рецензента: полосы, чек-лист, факты с адресом и датой, вердикт", () => {
  const md = reviewerAgentMarkdown("x", false);
  assert.match(md, /^---\nname: x\n/);
  assert.match(md, /excludeDefaultComponents: false/);
  for (const word of ["утечки", "свидетельство", "пробел", "адресом страницы", "датой проверки", "ВЕРДИКТ: ПРИНЯТО", "Codex"]) {
    assert.ok(md.includes(word), `в роли нет «${word}»`);
  }
});
