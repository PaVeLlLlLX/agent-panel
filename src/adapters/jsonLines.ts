/**
 * Строки JSON-протокола из stdout агента.
 *
 * Не readline: он считает концом строки ещё и U+2028/U+2029, а JSON пишет их
 * внутри строк как есть (serde_json у Codex, JSON.stringify у Claude Code).
 * Живой прогон 02.10: Codex возобновлял ветку с историей на 14 МБ, ответ
 * thread/resume разрезало на три куска, ни один не разобрался, и запуск ждал
 * ответа вечно — пара висела на «Codex и Gemini проверяют».
 *
 * Здесь граница строки — только \n; \r перед ним отрезается, как у readline.
 */
import { StringDecoder } from "node:string_decoder";
import type { Readable } from "node:stream";

export interface LineReader {
  /** Больше не отдавать строки; поток дочитывается вхолостую. */
  close(): void;
}

export function readJsonLines(input: Readable, onLine: (line: string) => void): LineReader {
  const decoder = new StringDecoder("utf8");
  // Куски незаконченной строки склеиваются один раз, на её конце: ответ на
  // десятки мегабайт не пересобирается на каждом пришедшем куске.
  let pending: string[] = [];
  let closed = false;

  const deliver = (): void => {
    const line = pending.join("");
    pending = [];
    if (!closed) onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
  };
  const take = (text: string): void => {
    let from = 0;
    let at = text.indexOf("\n");
    while (at !== -1) {
      pending.push(text.slice(from, at));
      deliver();
      from = at + 1;
      at = text.indexOf("\n", from);
    }
    if (from < text.length) pending.push(text.slice(from));
  };

  input.on("data", (chunk: Buffer | string) => take(typeof chunk === "string" ? chunk : decoder.write(chunk)));
  input.on("end", () => {
    take(decoder.end());
    if (pending.length > 0) deliver();
  });
  return {
    close: () => {
      closed = true;
      pending = [];
    },
  };
}
