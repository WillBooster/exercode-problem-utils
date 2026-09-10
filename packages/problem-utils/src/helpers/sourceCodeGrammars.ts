import type { SourceCodeGrammar } from './removeCommentsInSourceCode.js';
import { languageIdToDefinition } from '../types/language.js';

export const languageIdToSourceCodeGrammar = Object.fromEntries(
  Object.entries(languageIdToDefinition).flatMap(([languageId, languageDefinition]) =>
    languageDefinition.grammer ? [[languageId, languageDefinition.grammer] as const] : []
  )
) as Readonly<Record<string, SourceCodeGrammar | undefined>>;
