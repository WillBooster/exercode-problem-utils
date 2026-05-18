import type { LanguageDefinition } from '../types/language.js';

export type SourceCodeGrammar = NonNullable<LanguageDefinition['grammer']>;

/** Removes comments from source code according to the provided language grammar. */
export function removeCommentsInSourceCode(grammar: SourceCodeGrammar, sourceCode: string): string {
  return removeCommentsAndMaybeStringsInSourceCode(grammar, sourceCode, { removeStrings: false });
}

/** Removes comments and string literal contents while preserving executable interpolation expressions. */
export function removeCommentsAndStringsInSourceCode(grammar: SourceCodeGrammar, sourceCode: string): string {
  return removeCommentsAndMaybeStringsInSourceCode(grammar, sourceCode, { removeStrings: true });
}

interface CommentOrStringGrammar {
  closeRegExp: RegExp;
  isComment: boolean;
  openRegExp: RegExp;
}

function removeCommentsAndMaybeStringsInSourceCode(
  grammar: SourceCodeGrammar,
  sourceCode: string,
  options: { removeStrings: boolean }
): string {
  if (!grammar.comments?.length && (!options.removeStrings || !grammar.strings?.length)) return sourceCode;

  const newSourceCodeSlices: string[] = [];
  const commentOrStringGrammars = [
    ...(grammar.comments?.map((v) => ({
      closeRegExp: makeGlobalRegExp(v.close ?? /(?=\n)/g),
      isComment: true,
      openRegExp: makeGlobalRegExp(v.open),
    })) ?? []),
    ...(grammar.strings?.map((v) => ({
      closeRegExp: makeGlobalRegExp(v.close),
      isComment: false,
      openRegExp: makeGlobalRegExp(v.open),
    })) ?? []),
  ] satisfies CommentOrStringGrammar[];

  let lastIndex = 0;

  while (lastIndex < sourceCode.length) {
    let first: { grammar: CommentOrStringGrammar; match: RegExpExecArray } | undefined;

    for (const commentOrStringGrammer of commentOrStringGrammars) {
      const startRegExp = commentOrStringGrammer.openRegExp;
      startRegExp.lastIndex = lastIndex;

      const match = startRegExp.exec(sourceCode);

      if (match && shouldPreferMatch(match, commentOrStringGrammer, first, options)) {
        first = { grammar: commentOrStringGrammer, match };
      }
    }

    if (first) {
      let stringPrefixStartIndex = first.match.index;
      if (!first.grammar.isComment && options.removeStrings) {
        stringPrefixStartIndex = getPythonStringPrefixStartIndex(sourceCode, first.match.index);
      }
      newSourceCodeSlices.push(sourceCode.slice(lastIndex, stringPrefixStartIndex));

      const closeRegExp = first.grammar.closeRegExp;
      closeRegExp.lastIndex = first.match.index + first.match[0].length;

      const match = closeRegExp.exec(sourceCode);

      lastIndex = match ? match.index + match[0].length : sourceCode.length;
      if (!first.grammar.isComment) {
        const stringLiteral = sourceCode.slice(first.match.index, lastIndex);
        if (options.removeStrings) {
          newSourceCodeSlices.push(
            preserveStringInterpolationExpressions(grammar, sourceCode, first.match.index, stringLiteral)
          );
        } else {
          newSourceCodeSlices.push(stringLiteral);
        }
      }
    } else {
      newSourceCodeSlices.push(sourceCode.slice(lastIndex));
      lastIndex = sourceCode.length;
    }
  }

  return newSourceCodeSlices.join('');
}

function shouldPreferMatch(
  match: RegExpExecArray,
  grammar: CommentOrStringGrammar,
  first: { grammar: CommentOrStringGrammar; match: RegExpExecArray } | undefined,
  options: { removeStrings: boolean }
): boolean {
  if (!first) return true;
  if (match.index < first.match.index) return true;
  if (match.index > first.match.index) return false;
  return options.removeStrings && first.grammar.isComment && !grammar.isComment;
}

function makeGlobalRegExp(regExp: RegExp): RegExp {
  return new RegExp(regExp, regExp.flags.includes('g') ? regExp.flags : `${regExp.flags}g`);
}

function getPythonStringPrefixStartIndex(sourceCode: string, stringStartIndex: number): number {
  if (sourceCode[stringStartIndex] !== '"' && sourceCode[stringStartIndex] !== "'") return stringStartIndex;

  let index = stringStartIndex - 1;
  while (index >= 0 && /[A-Za-z]/.test(sourceCode[index] ?? '')) index -= 1;

  const prefix = sourceCode.slice(index + 1, stringStartIndex);
  if (!prefix || !/^[bfru]+$/i.test(prefix)) return stringStartIndex;
  if (index >= 0 && /[\dA-Za-z_]/.test(sourceCode[index] ?? '')) return stringStartIndex;

  return index + 1;
}

function preserveStringInterpolationExpressions(
  grammar: SourceCodeGrammar,
  sourceCode: string,
  stringStartIndex: number,
  stringLiteral: string
): string {
  if (stringLiteral.startsWith('`')) return preserveJavaScriptTemplateExpressions(grammar, stringLiteral);
  if (hasPythonFStringPrefix(sourceCode, stringStartIndex))
    return preservePythonFStringExpressions(grammar, stringLiteral);
  return '';
}

function hasPythonFStringPrefix(sourceCode: string, stringStartIndex: number): boolean {
  let index = stringStartIndex - 1;
  while (index >= 0 && /[A-Za-z]/.test(sourceCode[index] ?? '')) index -= 1;
  return sourceCode
    .slice(index + 1, stringStartIndex)
    .toLowerCase()
    .includes('f');
}

function preserveJavaScriptTemplateExpressions(grammar: SourceCodeGrammar, stringLiteral: string): string {
  const expressions: string[] = [];
  let index = 1;

  while (index < stringLiteral.length - 1) {
    if (stringLiteral[index] === '\\') {
      index += 2;
      continue;
    }
    if (stringLiteral[index] === '$' && stringLiteral[index + 1] === '{') {
      const expression = readBalancedExpression(stringLiteral, index + 2, '}');
      expressions.push(removeCommentsAndStringsInSourceCode(grammar, expression.content));
      index = expression.endIndex + 1;
      continue;
    }
    index += 1;
  }

  return expressions.join('\n');
}

function preservePythonFStringExpressions(grammar: SourceCodeGrammar, stringLiteral: string): string {
  const quoteLength = stringLiteral.startsWith("'''") || stringLiteral.startsWith('"""') ? 3 : 1;
  const expressions: string[] = [];
  let index = quoteLength;

  while (index < stringLiteral.length - quoteLength) {
    if (stringLiteral[index] === '{' && stringLiteral[index + 1] === '{') {
      index += 2;
      continue;
    }
    if (stringLiteral[index] === '{') {
      const expression = readBalancedExpression(stringLiteral, index + 1, '}');
      expressions.push(removeCommentsAndStringsInSourceCode(grammar, expression.content));
      index = expression.endIndex + 1;
      continue;
    }
    index += stringLiteral[index] === '\\' ? 2 : 1;
  }

  return expressions.join('\n');
}

function readBalancedExpression(
  sourceCode: string,
  startIndex: number,
  closeChar: string
): { content: string; endIndex: number } {
  let depth = 1;
  let index = startIndex;

  while (index < sourceCode.length) {
    const char = sourceCode[index];
    if (char === '"' || char === "'" || char === '`') {
      index = skipQuotedSpan(sourceCode, index);
      continue;
    }
    if (char === '{') depth += 1;
    if (char === closeChar) {
      depth -= 1;
      if (depth === 0) return { content: sourceCode.slice(startIndex, index), endIndex: index };
    }
    index += 1;
  }

  return { content: sourceCode.slice(startIndex), endIndex: sourceCode.length };
}

function skipQuotedSpan(sourceCode: string, startIndex: number): number {
  const quote = sourceCode[startIndex];
  let index = startIndex + 1;

  while (index < sourceCode.length) {
    if (sourceCode[index] === '\\') {
      index += 2;
      continue;
    }
    if (sourceCode[index] === quote) return index + 1;
    index += 1;
  }

  return index;
}
