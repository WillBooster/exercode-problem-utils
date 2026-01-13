import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from 'vitest';

import { findEntryPointFile } from '../../src/helpers/findEntryPointFile.js';

test.each<[string | readonly string[] | undefined, readonly string[], string | undefined]>([
  [undefined, ['a.c', 'b.c', 'index.c', 'main.c', 'A.java', 'B.java', 'Index.java', 'Main.java'], 'main.c'],
  [undefined, ['a.c', 'b.c', 'index.c', 'A.java', 'B.java', 'Index.java'], 'index.c'],
  [undefined, ['a.c', 'b.c', 'A.java', 'B.java'], 'a.c'],
  [undefined, ['a.c', 'b.c', 'A.java', 'B.java', 'Index.java', 'Main.java'], 'Main.java'],
  [['java', 'python'], ['a.c', 'b.c', 'index.c', 'main.c', 'A.java', 'B.java', 'Index.java', 'Main.java'], 'Main.java'],
  [['java', 'python'], ['a.c', 'b.c', 'index.c', 'main.c'], undefined],
])('%s %s -> %s', async (language, fileNames, expected) => {
  await fs.promises.mkdir('temp', { recursive: true });
  const tempDir = await fs.promises.mkdtemp(path.join('temp', 'findMainFile_'));
  for (const fileName of fileNames) await fs.promises.writeFile(path.join(tempDir, fileName), '');

  const received = await findEntryPointFile(tempDir, language);
  expect(received).toBe(expected);
});
