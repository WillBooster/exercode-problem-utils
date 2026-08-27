export interface CsvRecord {
  cells: string[];
  /** 1-based physical line on which the record starts (quoted fields may span several lines). */
  lineNumber: number;
}

/**
 * Parse RFC 4180 style CSV text (double-quoted fields, `""` escapes, LF or CRLF line ends) into rows.
 * A trailing line end does not produce an extra row.
 *
 * @throws when a quoted field is not closed, or a quote appears anywhere but around a whole field.
 */
export function parseCsv(text: string): string[][] {
  return parseCsvRecords(text).map((record) => record.cells);
}

/** Like {@link parseCsv}, but also reports the physical line each record starts on. */
export function parseCsvRecords(text: string): CsvRecord[] {
  const records: CsvRecord[] = [];
  let cells: string[] = [];
  let field = '';
  let fieldState: 'start' | 'unquoted' | 'quoted' | 'closed' = 'start';
  let hasField = false;
  let lineNumber = 1;
  let recordLineNumber = 1;
  let index = 0;
  const content = text.startsWith('\uFEFF') ? text.slice(1) : text;

  const endField = (): void => {
    cells.push(field);
    field = '';
    fieldState = 'start';
  };

  while (index < content.length) {
    const char = content[index] as string;
    if (fieldState === 'quoted') {
      if (char === '"') {
        if (content[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        fieldState = 'closed';
      } else {
        if (char === '\n' || (char === '\r' && content[index + 1] !== '\n')) lineNumber++;
        field += char;
      }
      index++;
      continue;
    }

    hasField = true;
    if (char === ',' || char === '\n' || char === '\r') {
      endField();
      if (char !== ',') {
        records.push({ cells, lineNumber: recordLineNumber });
        cells = [];
        hasField = false;
        if (char === '\r' && content[index + 1] === '\n') index++;
        lineNumber++;
        recordLineNumber = lineNumber;
      }
    } else if (char === '"') {
      if (fieldState !== 'start') throw new Error(`unexpected quote on line ${lineNumber}`);
      fieldState = 'quoted';
    } else if (fieldState === 'closed') {
      throw new Error(`unexpected character after a quoted field on line ${lineNumber}`);
    } else {
      fieldState = 'unquoted';
      field += char;
    }
    index++;
  }

  if (fieldState === 'quoted')
    throw new Error(`unterminated quoted field in the record starting on line ${recordLineNumber}`);
  if (hasField) {
    endField();
    records.push({ cells, lineNumber: recordLineNumber });
  }
  return records;
}
