/**
 * Запрещённые пути рецензентов (agentPanel.reviewerForbidden): по ним
 * стоп-сигнал координатора проверяет команды Codex и скрипты Gemini, их же
 * называет роль Codex.
 *
 * Фрагмент — часть пути, а не любая подстрока (рецензия задачи 8). Сравнение
 * без учёта регистра, «\» и «/» — одно и то же.
 *
 * Простой фрагмент (data/, .env, /secrets) ловится где угодно в пути. Слева —
 * начало строки или знак вне имени (пробел, кавычка, «/», «=», «(»…), но не
 * буква, цифра, «_», «.» или «-». Справа — конец строки или не буква, не цифра
 * и не «_». Косая черта на краю фрагмента сама граница: /secrets ловится и в
 * «C:/p/secrets». Так .env ловит «cat .env», «.env.local», «C:/p/.env», но не
 * process.env и os.environ; data/ — «open('data/x')», но не metadata/ и
 * sample_data/.
 *
 * Фрагмент от корня проекта пишется «./data/» или «.\data\» (итоговая
 * рецензия ветки 05.10). У Trading папка данных data/ лежит в корне, а пакет
 * кода tradingbot/data/ — глубже. Простой фрагмент data/ останавливал чтение
 * кода пакета и пропускал «Get-ChildItem …\Trading\data» без косой черты на
 * конце. Фрагмент от корня ловится в начале относительного пути (начало
 * команды, пробел, кавычка, «=», «(», знаки оболочки; «./» перед ним не
 * мешает) или сразу после «<проект>/». Папка без косой черты на конце
 * ловится, когда это явно путь: после «<проект>/» или «./», в кавычках
 * ('data'), или последним словом команды ('rg x data', 'cd data; …').
 *
 * Шаблон секрета (.env.example, .env.sample, .env.template) — не сам секрет:
 * Trading хранит .env.example в репозитории.
 */

/** Фрагмент от корня проекта: начинается с «./» или «.\». */
export function rootAnchored(fragment: string): boolean {
  return /^\.[\\/]/.test(fragment.trim());
}

/** Фрагмент от корня без «./» — так его называет роль Codex. */
export function withoutRoot(fragment: string): string {
  return fragment.trim().replace(/^(?:\.[\\/])+/, "");
}

const plain = (s: string): string => s.replace(/\\/g, "/").toLowerCase();
const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Справа от имени: не буква, не цифра и не «_». */
const NAME_END = String.raw`(?![\p{L}\p{N}_])`;
/** Не шаблон секрета: .env.example — не .env. */
const NOT_TEMPLATE = String.raw`(?!\.(?:example|sample|template)(?![\p{L}\p{N}_]))`;
/** Начало относительного пути: начало команды, пробел, кавычка, «=», «(», знаки оболочки. */
const PATH_START = String.raw`(?:^|(?<=[\s'"\x60=(,;|&<>]))`;
/** Конец слова пути: конец команды, пробел, кавычка, скобка, знаки оболочки. */
const TOKEN_END = String.raw`(?=$|[\s'"\x60),;|&<>])`;
/** «./» перед путём, сколько угодно раз. */
const DOT_SLASH = String.raw`(?:\./)*`;

/** Простой фрагмент — где угодно в пути. */
function anywherePattern(fragment: string): RegExp {
  const before = fragment.startsWith("/") ? "" : String.raw`(?<![\p{L}\p{N}_.\-])`;
  const after = fragment.endsWith("/") ? "" : NAME_END + NOT_TEMPLATE;
  return new RegExp(before + escape(fragment) + after, "u");
}

/**
 * Фрагмент от корня (без «./»): в начале относительного пути или после
 * «<проект>/». Папка (косая черта на конце) — и без косой черты, когда это
 * явно путь.
 */
function rootPattern(core: string, project: string | undefined): RegExp {
  const folder = core.endsWith("/");
  const name = escape(folder ? core.slice(0, -1) : core);
  const absolute = project ? `${escape(project)}/${DOT_SLASH}` : undefined;
  const starts = [`${PATH_START}${DOT_SLASH}`, ...(absolute ? [absolute] : [])].join("|");
  if (!folder) return new RegExp(`(?:${starts})${name}${NAME_END}${NOT_TEMPLATE}`, "u");
  const bare = [
    // …\Trading\data, ./data
    ...(absolute ? [`${absolute}${name}${TOKEN_END}`] : []),
    String.raw`${PATH_START}(?:\./)+${name}${TOKEN_END}`,
    // Path('data'), "data", `data`
    `(?<=')${name}(?=')`,
    `(?<=")${name}(?=")`,
    String.raw`(?<=\x60)${name}(?=\x60)`,
    // rg x data; cd data; ls data | …: последнее слово команды или перед её
    // разделителем. «data = …», «print(data)» в коде — не путь.
    String.raw`(?:^|(?<=[\s=]))${name}(?=[ \t]*(?:$|;|\||&&))`,
  ];
  return new RegExp(`(?:${starts})${name}/|${bare.join("|")}`, "u");
}

/**
 * Первый запрещённый фрагмент, найденный в команде или коде; нет —
 * undefined. project — папка проекта: фрагмент от корня ловится и после
 * неё. Пустой фрагмент (и «./» без имени) не считается: он совпал бы с любой
 * командой.
 */
export function forbiddenFragment(command: string, forbidden: readonly string[], project?: string): string | undefined {
  const text = plain(command);
  const root = project === undefined ? undefined : plain(project).replace(/\/+$/, "") || undefined;
  return forbidden.find((entry) => {
    const fragment = plain(entry.trim());
    if (fragment === "") return false;
    if (!rootAnchored(fragment)) return anywherePattern(fragment).test(text);
    const core = withoutRoot(fragment);
    return core !== "" && core !== "/" && rootPattern(core, root).test(text);
  });
}
