/**
 * Блоки «проверка» в ответе Gemini (спецификация 05.10, ступень 3).
 *
 * Утверждение, которое проверяется вычислением, Gemini подкрепляет скриптом:
 *
 *     ```проверка python
 *     # имя: просадка на отрезке [-0.2, 0]
 *     …код…
 *     ```
 *
 * Сам Gemini команд не запускает (правило deny agy), скрипт выполняет панель
 * (checkRunner.ts). Значит, этот разбор решает, какой код будет запущен, и он
 * строгий:
 *   * блок — только с заголовком «проверка python» (регистр не важен);
 *   * только закрытый: оборванный ответ не запускается наполовину;
 *   * не внутри другого блока кода — пример формата в разметке не поручение;
 *   * не больше трёх, лишние отбрасываются и называются числом.
 * Ограда — как в Markdown и verdict.ts: три и более одинаковых знака (` или ~)
 * с отступом до трёх пробелов, закрывает такая же не короче, без текста после.
 */

/** Сколько скриптов из одного ответа выполняется. */
export const MAX_CHECK_BLOCKS = 3;

export interface CheckBlock {
  /** Из первой строки «# имя: …»; без неё — «проверка N» по порядку блоков. */
  readonly name: string;
  /** Весь блок, вместе со строкой имени. */
  readonly code: string;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HEADER = /^\s*проверка\s+python\s*$/iu;
const NAME_LINE = /^\s*#\s*имя\s*:\s*(.*?)\s*$/iu;

/** Строка закрывает ограду open: тот же знак, не короче, после — только пробелы. */
function closes(line: string, open: string): boolean {
  const fence = FENCE.exec(line);
  return fence !== null && fence[1]![0] === open[0] && fence[1]!.length >= open.length && fence[2]!.trim() === "";
}

/** Все блоки «проверка» ответа и сколько из них сверх MAX_CHECK_BLOCKS. */
export function readCheckBlocks(text: string): { blocks: CheckBlock[]; dropped: number } {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const found: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const fence = FENCE.exec(lines[i]!);
    if (!fence) continue;
    const open = fence[1]!;
    // У ``` в строке заголовка обратных кавычек быть не может (как в Markdown).
    const info = fence[2]!;
    let end = i + 1;
    while (end < lines.length && !closes(lines[end]!, open)) end += 1;
    if (end >= lines.length) break; // не закрыт — до конца ответа, ничего не запускается
    if (HEADER.test(info) && !(open[0] === "`" && info.includes("`"))) found.push(lines.slice(i + 1, end).join("\n"));
    i = end;
  }
  const blocks = found.slice(0, MAX_CHECK_BLOCKS).map((code, index) => {
    const first = code.split("\n", 1)[0] ?? "";
    const name = NAME_LINE.exec(first)?.[1] ?? "";
    return { name: name || `проверка ${index + 1}`, code };
  });
  return { blocks, dropped: Math.max(0, found.length - MAX_CHECK_BLOCKS) };
}

/** Блоки «проверка» ответа, не больше MAX_CHECK_BLOCKS. */
export function parseCheckBlocks(text: string): CheckBlock[] {
  return readCheckBlocks(text).blocks;
}
