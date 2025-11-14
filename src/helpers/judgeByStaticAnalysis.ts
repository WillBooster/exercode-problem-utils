import fs from 'node:fs';
import path from 'node:path';

import { DecisionCode } from '../types/decisionCode.js';
import type { ProblemMarkdownFrontMatter } from '../types/problem.js';
import type { TestCaseResult } from '../types/testCaseResult.js';

import { findLanguageDefinitionByPath } from './findLanguageDefinitionByPath.js';
import { removeCommentsInSourceCode } from './removeCommentsInSourceCode.js';

export async function judgeByStaticAnalysis(
  cwd: string,
  problemMarkdownFrontMatterLike: Pick<
    ProblemMarkdownFrontMatter,
    'forbiddenRegExpsInCode' | 'forbiddenTextsInCode' | 'requiredRegExpsInCode'
  >
): Promise<Pick<TestCaseResult, 'decisionCode' | 'feedbackMarkdown'> | undefined> {
  const sourceCodeWithoutCommentFiles: { path: string; data: string }[] = [];

  for (const dirent of await fs.promises.readdir(cwd, { withFileTypes: true, recursive: true })) {
    if (!dirent.isFile()) continue;

    const text = await fs.promises.readFile(path.join(dirent.parentPath, dirent.name), 'utf8');
    const isBinary = text.includes('\uFFFD');
    if (isBinary) continue;

    const languageDefinition = findLanguageDefinitionByPath(dirent.name);
    if (!languageDefinition) continue;

    sourceCodeWithoutCommentFiles.push({
      path: dirent.name,
      data: languageDefinition.grammer ? removeCommentsInSourceCode(languageDefinition.grammer, text) : text,
    });
  }

  const forbiddenFounds: { pattern: string; path: string; match: string }[] = [];

  for (const file of sourceCodeWithoutCommentFiles) {
    for (const pattern of problemMarkdownFrontMatterLike.forbiddenRegExpsInCode ?? []) {
      const re = new RegExp(pattern, 'g');
      const mathces = file.data.matchAll(re);
      for (const match of mathces) forbiddenFounds.push({ pattern: re.toString(), path: file.path, match: match[0] });
    }
    for (const pattern of problemMarkdownFrontMatterLike.forbiddenTextsInCode ?? []) {
      let p = 0;
      while (p < file.data.length) {
        const index = file.data.indexOf(pattern, p);
        if (index === -1) break;
        forbiddenFounds.push({ pattern, path: file.path, match: pattern });
        p = index + pattern.length;
      }
    }
  }

  if (forbiddenFounds.length > 0) {
    return {
      decisionCode: DecisionCode.FORBIDDEN_PATTERNS_IN_CODE_ERROR,
      feedbackMarkdown: `ソースコード中に禁止された文字列が含まれています。
ソースコードを修正してから再度提出してください。

| ファイル | 禁止パターン | 文字列 |
| -------- | ------------ | ------ |
${forbiddenFounds.map((f) => `| \`${f.path}\` | \`${f.pattern}\` | \`${f.match}\` |`).join('\n')}
`,
    };
  }

  const missingRequiredPatterns: string[] = [];

  for (const pattern of problemMarkdownFrontMatterLike.requiredRegExpsInCode ?? []) {
    const re = new RegExp(pattern);
    const isFound = sourceCodeWithoutCommentFiles.some((f) => re.test(f.data));
    if (!isFound) missingRequiredPatterns.push(re.toString());
  }

  if (missingRequiredPatterns.length > 0) {
    return {
      decisionCode: DecisionCode.REQUIRED_PATTERNS_IN_CODE_ERROR,
      feedbackMarkdown: `ソースコード中に必要な文字列が含まれていません。
ソースコードを修正してから再度提出してください。

${missingRequiredPatterns.map((p) => `- \`${p}\``).join('\n')}
`,
    };
  }

  return;
}
