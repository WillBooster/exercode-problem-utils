import { describe, expect, test } from 'vitest';

import { parseCsv, parseCsvRecords } from '../../src/helpers/parseCsv.js';

describe('parseCsv', () => {
  test.each<[string, string, string[][]]>([
    [
      'LF rows without a trailing line end',
      'a,b\n1,2',
      [
        ['a', 'b'],
        ['1', '2'],
      ],
    ],
    [
      'trailing line end adds no row',
      'a,b\n1,2\n',
      [
        ['a', 'b'],
        ['1', '2'],
      ],
    ],
    [
      'CRLF line ends',
      'a,b\r\n1,2\r\n',
      [
        ['a', 'b'],
        ['1', '2'],
      ],
    ],
    [
      'CR line ends',
      'a,b\r1,2',
      [
        ['a', 'b'],
        ['1', '2'],
      ],
    ],
    ['quoted comma and escaped quote', '"x,y","say ""hi"""', [['x,y', 'say "hi"']]],
    [
      'quoted newline keeps one record',
      '"line1\nline2",2\n3,4',
      [
        ['line1\nline2', '2'],
        ['3', '4'],
      ],
    ],
    [
      'empty fields',
      'a,,c\n,,',
      [
        ['a', '', 'c'],
        ['', '', ''],
      ],
    ],
    ['blank line becomes an empty field row', 'a\n\nb', [['a'], [''], ['b']]],
    ['final quoted empty field is kept', 'a\n""', [['a'], ['']]],
    ['BOM is stripped', '\uFEFFa,b', [['a', 'b']]],
    ['empty text has no rows', '', []],
  ])('%s', (_name, text, expected) => {
    expect(parseCsv(text)).toEqual(expected);
  });

  test.each<[string, string]>([
    ['unterminated quoted field', 'a,"b'],
    ['quote inside an unquoted field', 'a,1"0"'],
    ['text after a closing quote', 'a,"1"0'],
  ])('rejects %s', (_name, text) => {
    expect(() => parseCsv(text)).toThrow();
  });
});

describe('parseCsvRecords', () => {
  test('reports the physical line each record starts on', () => {
    const records = parseCsvRecords('h\n"1\n2"\n\n3\r\n4\r"5\r6"');
    expect(records.map((record) => [record.cells, record.lineNumber])).toEqual([
      [['h'], 1],
      [['1\n2'], 2],
      [[''], 4],
      [['3'], 5],
      [['4'], 6],
      [['5\r6'], 7],
    ]);
  });

  test('names the record of an unterminated quote', () => {
    expect(() => parseCsvRecords('a\n"b')).toThrow('line 2');
  });
});
