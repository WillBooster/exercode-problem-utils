import fs from 'node:fs';
import path from 'node:path';

import parseFrontMatter from 'front-matter';

import type { ProblemMarkdownFrontMatter } from '../types/problem.js';
import { problemMarkdownFrontMatterSchema } from '../types/problem.js';

/**
 * Whether a standard stdio problem is judgeable without test cases: static-analysis rules still
 * judge the submitted code, and manual scoring intentionally accepts every submission.
 */
export function judgesWithoutTestCases(frontMatter: ProblemMarkdownFrontMatter): boolean {
  return (
    frontMatter.isManualScoringRequired === true ||
    (frontMatter.requiredRegExpsInCode?.length ?? 0) > 0 ||
    (frontMatter.forbiddenRegExpsInCode?.length ?? 0) > 0 ||
    (frontMatter.forbiddenTextsInCode?.length ?? 0) > 0 ||
    (frontMatter.requiredSubmissionFilePaths?.length ?? 0) > 0
  );
}

/**
 * Whether the front matter judges every test case without an expected output: manual scoring
 * accepts every run, and required output files are checked by their presence after each run.
 * Code rules and required submission files do not count because they check the submission once,
 * in addition to the output comparison.
 */
export function judgesTestCasesWithoutExpectations(frontMatter: ProblemMarkdownFrontMatter): boolean {
  return frontMatter.isManualScoringRequired === true || (frontMatter.requiredOutputFilePaths?.length ?? 0) > 0;
}

export async function readProblemMarkdownFrontMatter(problemDir: string): Promise<ProblemMarkdownFrontMatter> {
  for (const dirent of await fs.promises.readdir(problemDir, { withFileTypes: true })) {
    if (!dirent.isFile()) continue;
    if (!(dirent.name === 'problem.md' || dirent.name.endsWith('.problem.md'))) continue;

    const markdown = await fs.promises.readFile(path.join(dirent.parentPath, dirent.name), 'utf8');

    const { attributes } = (parseFrontMatter as unknown as (markdown: string) => { attributes: unknown })(markdown);

    return problemMarkdownFrontMatterSchema.parse(attributes);
  }

  throw new Error(`problem markdown not found: ${problemDir}`);
}
