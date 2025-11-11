import fs from 'node:fs';

import { languageIdToDefinition } from '../types/language.js';

// The last is most prioritized.
const PRIOTIZED_MAIN_FILE_NAMES = ['index', 'main'] as const;

export async function findMainFile(cwd: string, language?: string | string[]): Promise<string | undefined> {
  const fileExtensions =
    language && [language].flat().flatMap((language) => languageIdToDefinition[language]?.fileExtension ?? []);

  let mainFileName: string | undefined;
  let mainFilePrioryty = -1;

  for (const dirent of await fs.promises.readdir(cwd, { withFileTypes: true })) {
    if (!dirent.isFile()) continue;
    if (fileExtensions && !fileExtensions.some((ext) => dirent.name.endsWith(ext))) continue;

    const direntPrioryty = PRIOTIZED_MAIN_FILE_NAMES.findLastIndex((name) =>
      dirent.name.toLowerCase().startsWith(`${name}.`)
    );

    if (
      !mainFileName || direntPrioryty !== mainFilePrioryty
        ? direntPrioryty > mainFilePrioryty
        : dirent.name.localeCompare(mainFileName) < 0
    ) {
      mainFileName = dirent.name;
      mainFilePrioryty = direntPrioryty;
    }
  }

  return mainFileName;
}
