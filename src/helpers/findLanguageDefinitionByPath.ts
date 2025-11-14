import { languageIdToDefinition } from '../types/language.js';
import type { LanguageDefinition } from '../types/language.js';

export function findLanguageDefinitionByPath(path: string): LanguageDefinition | undefined {
  return Object.values(languageIdToDefinition).find((definition) =>
    definition.fileExtensions.some((ext) => path.endsWith(ext))
  );
}
