/**
 * Parse RFC 4180 style CSV text (double-quoted fields, `""` escapes, LF or CRLF line ends) into rows.
 * A trailing line end does not produce an extra row.
 *
 * @throws when a quoted field is not closed before the end of the text.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let hasField = false;
  let isQuoted = false;
  let index = 0;
  const content = text.startsWith('﻿') ? text.slice(1) : text;

  while (index < content.length) {
    const char = content[index] as string;
    if (isQuoted) {
      if (char === '"') {
        if (content[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        isQuoted = false;
      } else {
        field += char;
      }
      index++;
      continue;
    }

    hasField = true;
    if (char === '"') {
      isQuoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      hasField = false;
      if (char === '\r' && content[index + 1] === '\n') index++;
    } else {
      field += char;
    }
    index++;
  }

  if (isQuoted) throw new Error('unterminated quoted field');
  if (hasField) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
