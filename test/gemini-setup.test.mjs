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

test("роль рецензента: правило вердикта — пробел и дефект не дают «принято», своё условие человека — к человеку (I1)", () => {
  // Живая проба e2e 02.10: Gemini назвал утечку id=3 «пробелом» в обоих
  // раундах и всё равно поставил ПРИНЯТО. Роль должна прямо запрещать это.
  const md = reviewerAgentMarkdown("x", false);
  for (const phrase of [
    "Любой открытый «пробел: …» в чек-листе или найденный методологический дефект",
    "предписан самим поручением человека",
    "«ВЕРДИКТ: НУЖНО РЕШЕНИЕ ЧЕЛОВЕКА», потому что решать за человека",
    "только когда в чек-листе нет",
    "пробелов и не найдено ни одного дефекта",
  ]) {
    assert.ok(md.includes(phrase), `в роли нет «${phrase}»`);
  }
});

/** Тело agent.md без заголовка YAML, пробелы и переносы схлопнуты. */
const roleBody = () => reviewerAgentMarkdown("x", false).split("\n---\n")[1];
const flatRole = () => roleBody().replace(/\s+/g, " ");

test("роль рецензента: правила проекта — GEMINI.md, иначе AGENTS.md, перечитать при изменении; роль важнее (проверка Trading 02.10)", () => {
  // Единственная настоящая проверка Trading: с excludeDefaultComponents agy
  // правил проекта не подаёт, а Gemini сам не открыл ни AGENTS.md, ни
  // документа методологии — чек-лист вышел общим, без правил проекта.
  const flat = flatRole();
  for (const phrase of [
    "В начале разговора прочитай в папке проекта `GEMINI.md` — это правила проекта для тебя.",
    "Нет его — прочитай `AGENTS.md`: его исследовательские правила относятся к тебе полностью",
    "запись, запуск, коммиты и передача работы — дело разработчика",
    "Если материал показывает, что эти файлы изменились, прочитай их снова.",
    "Если файлы проекта расходятся с этой ролью, действует роль.",
    "Запрет проекта (что не открывать, чего не искать) — не расхождение: соблюдай его.",
  ]) {
    assert.ok(flat.includes(phrase), `в роли нет «${phrase}»`);
  }
});

test("роль рецензента: только папка проекта, кроме сохранённых страниц agy; секреты не открывать", () => {
  // Gemini 26 раз читал сохранённые копии страниц из brain agy — буквально
  // роль это запрещала. Чтение файлов agy не закрыто, а в корне Trading .env.
  const flat = flatRole();
  for (const phrase of [
    "Ищи и читай файлы только в папке проекта из шапки сообщения, не по всему диску.",
    "Исключение — сохранённые копии страниц, которые ты открыл, в папке agy `.gemini/antigravity-cli/brain/…`.",
    "Никогда не открывай `.env`, ключи, токены и другие секреты.",
  ]) {
    assert.ok(flat.includes(phrase), `в роли нет «${phrase}»`);
  }
});

test("роль рецензента: свидетельство — только из открытого файла или материала, не выдуманный раздел", () => {
  // Gemini сослался на раздел «Эталоны и бейзлайны» регистрации, которого нет;
  // файл в ходе не открывался.
  const flat = flatRole();
  for (const phrase of [
    "Свидетельство — только из файла, который ты открыл, отвечая на это сообщение, или из материала сообщения.",
    "Раздел, строку или вывод, которых ты не видел, не называй.",
  ]) {
    assert.ok(flat.includes(phrase), `в роли нет «${phrase}»`);
  }
});

test("роль рецензента: чек-лист с регистрацией и «не относится» вместо натянутого свидетельства", () => {
  // «Сиды и разброс» в шаге без случайности Gemini закрыл фразой о
  // детерминированных хэшах, «Метрики» и «Бейзлайн» — «коммит не меняет».
  const flat = flatRole();
  for (const phrase of [
    "Пункты: утечки, разбиения на выборки, регистрация (план до расчёта), метрики и статистика, бейзлайн, сиды и разброс, обоснованность выводов.",
    "«свидетельство: …» (откуда: вызов разработчика, файл, строка вывода), «пробел: …» или «не относится: <почему>»",
    "помечай «не относится», а не подбирай к нему свидетельство",
    "например «выведи пересечение id train и test»",
  ]) {
    assert.ok(flat.includes(phrase), `в роли нет «${phrase}»`);
  }
});

test("роль рецензента: что искать — ошибки, которые в Trading ловил только Codex", () => {
  const flat = flatRole();
  for (const phrase of [
    // известность на дату решения и будущая информация в отборе
    "сегодняшняя страница или таблица не доказывает, что они были доступны раньше",
    "ни в основной выборке, ни в плацебо и контрольных выборках",
    "«утечек нет» — только в пределах свидетельства",
    // выжившие
    "не исчезают из результата молча",
    // регистрация до расчёта
    "правило или порог в коде без записи — дефект",
    "код, расходящийся с планом, — тоже дефект",
    // статистика гипотезы
    "одно- или двусторонний тест, ранговая или линейная корреляция",
    "номинальный уровень проверен на эмпирическом нуле",
    // неизвестное и отрицательный поиск
    "неизвестное не равно нулю и не равно «событий нет»",
    "отрицательный результат поиска",
    "требует полноты: источник покрывает всё окно, все страницы выдачи пройдены, цитата обосновывает результат",
    // выводы
    "сценарии чувствительности — не границы",
    "совпадение чисел — не причина",
    "косвенная мера — не сам механизм",
    "вывод не шире измеренного",
    "пересказ языковой модели, в том числе ответ ИИ в поисковике, — не документ",
  ]) {
    assert.ok(flat.includes(phrase), `в роли нет «${phrase}»`);
  }
});

test("роль рецензента: факты — первоисточник, только названные разработчиком, дата из шапки", () => {
  // Аккредитацию доменов Gemini подтвердил страницами самих агентств, а не
  // реестром ЦБ; добавил непрошеный факт; дату проверки назвал сам — в
  // сообщении её не было.
  const flat = flatRole();
  for (const phrase of [
    "Дату бери из строки «[дата: …]» шапки сообщения, а не из памяти.",
    "Предпочитай первоисточник: регулятор, биржа, эмитент, автор библиотеки; сайт, который описывает сам себя, слабее реестра.",
    "Проверяй факты, которые назвал разработчик; своих фактов без открытой страницы не добавляй.",
  ]) {
    assert.ok(flat.includes(phrase), `в роли нет «${phrase}»`);
  }
});

test("роль рецензента: код — только строки методологии; чужой шаг — «принято» одной строкой", () => {
  const flat = flatRole();
  for (const phrase of [
    "Код целиком не перепроверяй — это делает Codex.",
    "Читай только строки, от которых зависит методология: окна дат, отбор, статистику.",
    "ответь «принято» и одной строкой поясни почему",
  ]) {
    assert.ok(flat.includes(phrase), `в роли нет «${phrase}»`);
  }
});

test("роль рецензента: записанное ограничение при оговорённом выводе — не пробел, неоговорённое — пробел", () => {
  // Слабые места, записанные в поправках, Gemini пересказал как достоинство и
  // не проверил, что вывод участка оговорён условием полноты реестра.
  const flat = flatRole();
  for (const phrase of [
    "Ограничение, записанное в плане или поправке к нему, — не пробел, если вывод работы явно сделан при этом условии.",
    "Ограничение, которое вывод не оговаривает, — «пробел: …».",
    "Отклонение от плана без записанной поправки — дефект.",
  ]) {
    assert.ok(flat.includes(phrase), `в роли нет «${phrase}»`);
  }
  assert.ok(flat.indexOf("Отклонение от плана") < flat.indexOf("Последней строкой"), "уточнение пробела — до правила последней строки");
});

test("роль рецензента: тело — не больше 9 000 символов (идёт в каждый вызов модели)", () => {
  assert.ok(roleBody().length <= 9000, `тело роли — ${roleBody().length} символов`);
});

test("роль рецензента: веб — только факты, на которых держится вывод, с бюджетом обращений; недоступное — «не проверено» (живой прогон 03.10)", () => {
  // Живой прогон 03.10: ~7 из 8,7 мин проверки — около 40 обращений к вебу с
  // повторами после 403/404 и поиском зеркал. Бюджет считаемый и связан с
  // правилом вердикта: непроверенный ключевой факт — «пробел», второстепенный
  // на вердикт не влияет.
  const flat = reviewerAgentMarkdown("x", false).replace(/\s+/g, " ");
  for (const phrase of [
    "Факты вне репозитория проверяй только те, на которых держится вывод работы",
    "1–2 первоисточника на факт, не больше двух попыток на один сайт",
    "всего не больше ~15 обращений к вебу за проверку",
    "не ищи зеркал, пиши «не проверено: <адрес> — <причина>»",
    "— это «пробел: …» с просьбой к разработчику привести открывающийся источник или цитату",
    "непроверенный второстепенный факт на вердикт не влияет",
  ]) {
    assert.ok(flat.includes(phrase), `в роли нет «${phrase}»`);
  }
});
