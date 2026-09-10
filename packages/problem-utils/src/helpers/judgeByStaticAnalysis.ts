import fs from 'node:fs';
import path from 'node:path';

import { DecisionCode } from '../types/decisionCode.js';
import type { ProblemMarkdownFrontMatter } from '../types/problem.js';
import { normalizeCodeRule } from '../types/problem.js';
import type { TestCaseResult } from '../types/testCaseResult.js';

import { findLanguageDefinitionByPath } from './findLanguageDefinitionByPath.js';
import { removeCommentsInSourceCode } from './removeCommentsInSourceCode.js';

interface ForbiddenRuleViolation {
  /** Learner-facing description of the rule; the raw pattern when the problem declares no message. */
  label: string;
  matches: { path: string; match: string }[];
}

export async function judgeByStaticAnalysis(
  cwd: string,
  problemMarkdownFrontMatterLike: Pick<
    ProblemMarkdownFrontMatter,
    'forbiddenRegExpsInCode' | 'forbiddenTextsInCode' | 'requiredRegExpsInCode' | 'requiredSubmissionFilePaths'
  >
): Promise<Pick<TestCaseResult, 'decisionCode' | 'feedbackMarkdown'> | undefined> {
  const needsSourceCode =
    !!problemMarkdownFrontMatterLike.forbiddenRegExpsInCode?.length ||
    !!problemMarkdownFrontMatterLike.forbiddenTextsInCode?.length ||
    !!problemMarkdownFrontMatterLike.requiredRegExpsInCode?.length;
  if (!needsSourceCode && !problemMarkdownFrontMatterLike.requiredSubmissionFilePaths?.length) return;

  const filePathSet = new Set<string>();
  const sourceCodeWithoutCommentFiles: { path: string; data: string }[] = [];

  for (const dirent of await fs.promises.readdir(cwd, { withFileTypes: true, recursive: true })) {
    if (!dirent.isFile()) continue;

    const relativePath = path.relative(cwd, path.join(dirent.parentPath, dirent.name));
    filePathSet.add(relativePath);

    if (!needsSourceCode) continue;
    const languageDefinition = findLanguageDefinitionByPath(dirent.name);
    if (!languageDefinition) continue;

    const text = await fs.promises.readFile(path.join(dirent.parentPath, dirent.name), 'utf8');
    const isBinary = text.includes('\uFFFD');
    if (isBinary) continue;

    sourceCodeWithoutCommentFiles.push({
      path: relativePath,
      data: languageDefinition.grammer ? removeCommentsInSourceCode(languageDefinition.grammer, text) : text,
    });
  }

  if (problemMarkdownFrontMatterLike.requiredSubmissionFilePaths) {
    const missingFilePaths = problemMarkdownFrontMatterLike.requiredSubmissionFilePaths
      .filter((p) => !filePathSet.has(p))
      .toSorted();

    if (missingFilePaths.length > 0) {
      return {
        decisionCode: DecisionCode.MISSING_REQUIRED_SUBMISSION_FILE_ERROR,
        feedbackMarkdown: `ファイルが不足しています。
次のファイルを追加してから再度提出してください。

${missingFilePaths.map((p) => `- \`${p}\``).join('\n')}
`,
      };
    }
  }

  const violations: ForbiddenRuleViolation[] = [];

  for (const rule of problemMarkdownFrontMatterLike.forbiddenRegExpsInCode ?? []) {
    const { pattern, message } = normalizeCodeRule(rule);
    const re = new RegExp(pattern, 'g');
    const matches = sourceCodeWithoutCommentFiles.flatMap((file) =>
      [...file.data.matchAll(re)].map((match) => ({ path: file.path, match: match[0] }))
    );
    if (matches.length > 0) violations.push({ label: message ?? `禁止パターン \`${re.toString()}\``, matches });
  }
  for (const rule of problemMarkdownFrontMatterLike.forbiddenTextsInCode ?? []) {
    const { pattern, message } = normalizeCodeRule(rule);
    const matches = sourceCodeWithoutCommentFiles
      .filter((file) => file.data.includes(pattern))
      .map((file) => ({ path: file.path, match: pattern }));
    if (matches.length > 0) violations.push({ label: message ?? `禁止文字列 \`${pattern}\``, matches });
  }

  if (violations.length > 0) {
    return {
      decisionCode: DecisionCode.FORBIDDEN_PATTERNS_IN_CODE_ERROR,
      feedbackMarkdown: `ソースコード中に禁止された文字列が含まれています。
ソースコードを修正してから再度提出してください。

${violations.map(formatForbiddenRuleViolation).join('\n')}
`,
    };
  }

  const missingRequiredLabels: string[] = [];

  for (const rule of problemMarkdownFrontMatterLike.requiredRegExpsInCode ?? []) {
    const { pattern, message } = normalizeCodeRule(rule);
    const re = new RegExp(pattern);
    const isFound = sourceCodeWithoutCommentFiles.some((f) => re.test(f.data));
    if (!isFound) missingRequiredLabels.push(message ?? `\`${re.toString()}\``);
  }

  if (missingRequiredLabels.length > 0) {
    return {
      decisionCode: DecisionCode.REQUIRED_PATTERNS_IN_CODE_ERROR,
      feedbackMarkdown: `ソースコード中に必要な文字列が含まれていません。
ソースコードを修正してから再度提出してください。

${missingRequiredLabels.map((label) => `- ${label}`).join('\n')}
`,
    };
  }

  return;
}

function formatForbiddenRuleViolation(violation: ForbiddenRuleViolation): string {
  const locations = [...new Set(violation.matches.map(({ path, match }) => `  - \`${path}\`: \`${match}\``))];
  return `- ${violation.label}\n${locations.join('\n')}`;
}
