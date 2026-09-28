/**
 * Вердикт рецензента: чем заканчивается цикл проверки.
 *
 * Ошибка разбора несимметрична: ложное «принято» останавливает проверку,
 * которая не прошла, а ложное «вердикта нет» только просит решения человека.
 * Поэтому правило строгое — вердикт засчитывается, если это ПОСЛЕДНЯЯ
 * содержательная строка ответа, вне цитаты и вне кода, и значение точно
 * одно из трёх. Всё прочее — «вердикта нет».
 *
 * Первая версия искала подстроку «ПРИНЯТ» в любой строке с «ВЕРДИКТ» и
 * давала «принято» на слитное «НЕПРИНЯТО» и на цитату прежнего вердикта.
 *
 * Вторая переключала признак кода на любой строке с тремя кавычками. Живой
 * прогон 16 сентября дал пять входов с ложным «принято»: блок, открытый
 * четырьмя кавычками и «закрытый» тремя; ограда другого вида; текст после
 * закрывающей ограды; вердикт с отступом в четыре пробела; вердикт в
 * обратных кавычках. Теперь ограда запоминается видом и длиной, закрывает
 * её только такая же не короче и без текста после, отступ кода и строка в
 * обратных кавычках вердиктом не считаются.
 *
 * Строки кода помечаются null, а не строкой-меткой: прежняя метка содержала
 * нулевой байт, и git стал показывать файл двоичным.
 */

export type Verdict = "accepted" | "remarks" | "human" | "missing";

/** Добавляется к каждому запросу на проверку. */
export const VERDICT_REQUEST =
  "Последней строкой ответа, без цитаты и без блока кода, напишите ровно одно: " +
  "«ВЕРДИКТ: ПРИНЯТО», если существенных замечаний нет; " +
  "«ВЕРДИКТ: ЕСТЬ ЗАМЕЧАНИЯ», если разработчику есть что исправить или обосновать; " +
  "«ВЕРДИКТ: НУЖНО РЕШЕНИЕ ЧЕЛОВЕКА», если без решения или данных человека продолжать обмен бессмысленно.";

/** Ограда блока кода: отступ до трёх пробелов, три и более одинаковых знака, остаток строки. */
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
/** Отступ в четыре пробела или табуляцию — блок кода с отступом. */
const CODE_INDENT = /^(?: {4}|\t)/;
/** Обратные кавычки в ведущие знаки не входят: строка в них — пример, а не решение. */
const VERDICT_LINE = /^[\s*_]*ВЕРДИКТ[\s*_]*:\s*(.+)$/iu;

const VERDICT_VALUES: Record<string, Verdict> = {
  "ПРИНЯТО": "accepted",
  "ЕСТЬ ЗАМЕЧАНИЯ": "remarks",
  "НУЖНО РЕШЕНИЕ ЧЕЛОВЕКА": "human",
};

/** Строки кода и ограды — null; остальные как есть. */
function markCode(text: string): (string | null)[] {
  let openFence: { char: string; length: number } | undefined;
  return text.split(/\r?\n/).map((line) => {
    const fence = FENCE.exec(line);
    const label = fence?.[1] ?? "";
    const remainder = fence?.[2] ?? "";

    if (openFence) {
      const closes =
        fence !== null && label[0] === openFence.char && label.length >= openFence.length && remainder.trim() === "";
      if (closes) openFence = undefined;
      return null;
    }
    if (fence) {
      // В информационной строке ограды из кавычек самих кавычек быть не может.
      if (!(label[0] === "`" && remainder.includes("`"))) {
        openFence = { char: label[0] as string, length: label.length };
        return null;
      }
    }
    return CODE_INDENT.test(line) ? null : line;
  });
}

export function parseVerdict(text: string | undefined): Verdict {
  if (!text) return "missing";

  const lines = markCode(text);
  const last = [...lines].reverse().find((s) => s === null || s.trim() !== "");
  if (last === undefined || last === null) return "missing";
  if (/^\s*>/.test(last)) return "missing";

  const m = VERDICT_LINE.exec(last);
  if (!m?.[1]) return "missing";
  const value = m[1]
    .replace(/[*_]/g, "")
    .replace(/[.!\s]+$/u, "")
    .trim()
    .replace(/\s+/g, " ")
    .toUpperCase();

  return VERDICT_VALUES[value] ?? "missing";
}
