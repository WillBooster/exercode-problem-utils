import { languageIdToDefinition } from '../types/language.js';
import type { SourceCodeGrammar } from './removeCommentsInSourceCode.js';

export const languageIdToSourceCodeGrammar = Object.fromEntries(
  Object.entries(languageIdToDefinition).flatMap(([languageId, languageDefinition]) =>
    languageDefinition.grammer ? [[languageId, languageDefinition.grammer] as const] : []
  )
) as Readonly<Record<string, SourceCodeGrammar | undefined>>;
