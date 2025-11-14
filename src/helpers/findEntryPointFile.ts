import fs from 'node:fs';

import { languageIdToDefinition } from '../types/language.js';

// The last is most prioritized.
const PRIOTIZED_FILE_NAMES = ['index', 'main'] as const;

const IGNORED_FILE_EXTENSIONS = ['.DS_Store', '.class'] as const;

export async function findEntryPointFile(
  cwd: string,
  language?: string | readonly string[]
): Promise<string | undefined> {
  const fileExtensions =
    language && [language].flat().flatMap((language) => languageIdToDefinition[language]?.fileExtensions ?? []);

  let mainFileName: string | undefined;
  let mainFilePrioryty = -1;

  for (const dirent of await fs.promises.readdir(cwd, { withFileTypes: true })) {
    if (!dirent.isFile()) continue;
    if (IGNORED_FILE_EXTENSIONS.some((ext) => dirent.name.endsWith(ext))) continue;
    if (fileExtensions && !fileExtensions.some((ext) => dirent.name.endsWith(ext))) continue;

    const direntPrioryty = PRIOTIZED_FILE_NAMES.findLastIndex((name) =>
      dirent.name.toLowerCase().startsWith(`${name}.`)
    );

    if (
      !mainFileName ||
      (direntPrioryty === mainFilePrioryty
        ? dirent.name.localeCompare(mainFileName) < 0
        : direntPrioryty > mainFilePrioryty)
    ) {
      mainFileName = dirent.name;
      mainFilePrioryty = direntPrioryty;
    }
  }

  return mainFileName;
}
