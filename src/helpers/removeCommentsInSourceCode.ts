import type { LanguageDefinition } from '../types/language.js';

export function removeCommentsInSourceCode(
  grammer: NonNullable<LanguageDefinition['grammer']>,
  sourceCode: string
): string {
  if (!grammer.comments?.length) return sourceCode;

  const newSourceCodeSlices: string[] = [];

  let lastIndex = 0;

  while (lastIndex < sourceCode.length) {
    let first: { match: RegExpExecArray; closeRegExp: RegExp | undefined; isComment: boolean } | undefined;

    for (const commentOrStringGrammer of [
      ...grammer.comments.map((v) => ({ isComment: true, ...v })),
      ...(grammer.strings?.map((v) => ({ isComment: false, ...v })) ?? []),
    ]) {
      const startRegExp = new RegExp(commentOrStringGrammer.open, 'g');
      startRegExp.lastIndex = lastIndex;

      const match = startRegExp.exec(sourceCode);

      if (match && (!first || match.index < first.match.index)) {
        first = { match, closeRegExp: commentOrStringGrammer.close, isComment: commentOrStringGrammer.isComment };
      }
    }

    if (first) {
      newSourceCodeSlices.push(sourceCode.slice(lastIndex, first.match.index));

      const closeRegExp = new RegExp(first.closeRegExp ?? /(?=\n)/g, 'g');
      closeRegExp.lastIndex = first.match.index + first.match[0].length;

      const match = closeRegExp.exec(sourceCode);

      lastIndex = match ? match.index + match[0].length : sourceCode.length;
      if (!first.isComment) newSourceCodeSlices.push(sourceCode.slice(first.match.index, lastIndex));
    } else {
      newSourceCodeSlices.push(sourceCode.slice(lastIndex));
      lastIndex = sourceCode.length;
    }
  }

  return newSourceCodeSlices.join('');
}
