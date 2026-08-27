import fs from 'node:fs/promises';
import path from 'node:path';

import { checkProblemDirIsolation } from '../helpers/checkProblemDirIsolation.js';
import { judgeByStaticAnalysis } from '../helpers/judgeByStaticAnalysis.js';
import { parseArgs } from '../helpers/parseArgs.js';
import { parseCsv } from '../helpers/parseCsv.js';
import { printDebugBanner } from '../helpers/printDebugBanner.js';
import { printTestCaseResult } from '../helpers/printTestCaseResult.js';
import { readProblemMarkdownFrontMatter } from '../helpers/readProblemMarkdownFrontMatter.js';
import {
  printDebugCwdBanner,
  printDebugExpectationFailureBanner,
  resolveCwds,
  type ResolvedCwd,
} from '../helpers/resolveCwds.js';
import { DecisionCode } from '../types/decisionCode.js';
import type { TestCaseResult } from '../types/testCaseResult.js';

const DEFAULT_SUBMISSION_FILE_PATH = 'submission.csv';
const TEST_CASE_ID = 'evaluation';
const MAX_LISTED_IDS = 10;

export interface EvaluationMetric {
  /** Label shown with the score, e.g. `RMSLE`. */
  label: string;
  isHigherBetter: boolean;
  /**
   * Returns an error message when a predicted value cannot be scored (e.g. it is not a number).
   * The message is shown to the learner together with the row's id.
   */
  validatePrediction?: (prediction: string) => string | undefined;
  /** Computes the score from predictions and answers aligned by id. Both are raw CSV cell strings. */
  compute: (predictions: readonly string[], answers: readonly string[]) => number;
}

export interface EvaluationJudgePresetOptions {
  /** CSV file holding the hidden ground truth, relative to the problem directory. */
  answerFilePath: string;
  /** CSV file the submission must contain. Defaults to `submission.csv`. */
  submissionFilePath?: string;
  /** Column that identifies each row in both CSV files. */
  idColumn: string;
  /** Column holding the answer in the ground truth and the prediction in the submission. */
  targetColumn: string;
  metric: EvaluationMetric;
  /**
   * Score required for acceptance: the submission is accepted when its score is at least this value
   * for a higher-is-better metric and at most this value otherwise. Every valid submission is
   * accepted when omitted.
   */
  acceptableScore?: number;
}

export const evaluationMetrics = {
  rmsle: {
    label: 'RMSLE',
    isHigherBetter: false,
    validatePrediction: (prediction: string) =>
      validateFiniteNumber(prediction) ?? (Number(prediction) <= -1 ? '-1以下のため対数を取れません' : undefined),
    compute: (predictions: readonly string[], answers: readonly string[]) =>
      Math.sqrt(
        mean(
          predictions.map(
            (prediction, index) => (Math.log1p(Number(prediction)) - Math.log1p(Number(answers[index]))) ** 2
          )
        )
      ),
  },
  rmse: {
    label: 'RMSE',
    isHigherBetter: false,
    validatePrediction: validateFiniteNumber,
    compute: (predictions: readonly string[], answers: readonly string[]) =>
      Math.sqrt(mean(predictions.map((prediction, index) => (Number(prediction) - Number(answers[index])) ** 2))),
  },
  mae: {
    label: 'MAE',
    isHigherBetter: false,
    validatePrediction: validateFiniteNumber,
    compute: (predictions: readonly string[], answers: readonly string[]) =>
      mean(predictions.map((prediction, index) => Math.abs(Number(prediction) - Number(answers[index])))),
  },
  accuracy: {
    label: 'Accuracy',
    isHigherBetter: true,
    compute: (predictions: readonly string[], answers: readonly string[]) =>
      mean(predictions.map((prediction, index) => (prediction.trim() === answers[index]?.trim() ? 1 : 0))),
  },
} as const satisfies Record<string, EvaluationMetric>;

/**
 * A preset for Kaggle-style model evaluation problems: the submission is a CSV of predictions for a
 * hidden test set, and the judge reports the metric value as `score` instead of comparing outputs.
 * The problem directory keeps the ground truth CSV, so it is never shipped to learners.
 *
 * @example
 * Create `judge.ts`:
 * ```ts
 * import { evaluationJudgePreset, evaluationMetrics } from '@exercode/problem-utils/presets/evaluation';
 *
 * await evaluationJudgePreset(import.meta.dirname, {
 *   answerFilePath: 'evaluation/answer.csv',
 *   idColumn: 'Id',
 *   targetColumn: 'TradePrice',
 *   metric: evaluationMetrics.rmsle,
 *   acceptableScore: 0.5,
 * });
 * ```
 *
 * Run `bun judge.ts model_answers/default` to judge one submission, or `bun judge.ts` to judge every
 * `<problemDir>/model_answers/*` and `<problemDir>/model_answers.fails/*` directory for debugging.
 */
export async function evaluationJudgePreset(problemDir: string, options: EvaluationJudgePresetOptions): Promise<void> {
  const args = parseArgs(process.argv);
  const { cwds, isDebugMode } = await resolveCwds(problemDir, args.cwd);

  if (isDebugMode) {
    const acceptedCwd = cwds.find((cwd) => cwd.expectedResult === 'accepted');
    if (acceptedCwd) {
      const isolationCheckResult = await checkProblemDirIsolation(problemDir, acceptedCwd, args.params);
      if (!isolationCheckResult.passed) {
        process.exitCode = 1;
        return;
      }
    } else {
      printDebugBanner([
        '[DEBUG MODE] isolated problem directory check skipped',
        '',
        'No accepted model answer is available for checking that the copied judge still accepts a valid submission.',
      ]);
    }
  }

  const answer = await readAnswer(path.join(problemDir, options.answerFilePath), options);
  for (const resolvedCwd of cwds) {
    if (isDebugMode) printDebugCwdBanner(problemDir, resolvedCwd);
    const result = await judgeSubmission(problemDir, resolvedCwd.cwd, answer, options);
    printTestCaseResult({ testCaseId: TEST_CASE_ID, ...result });
    if (isDebugMode && !matchesExpectedResult(resolvedCwd, result)) {
      process.exitCode = 1;
      printDebugExpectationFailureBanner(problemDir, resolvedCwd);
    }
  }
}

async function judgeSubmission(
  problemDir: string,
  cwd: string,
  answer: ReadonlyMap<string, string>,
  options: EvaluationJudgePresetOptions
): Promise<Omit<TestCaseResult, 'testCaseId'>> {
  const staticAnalysisResult = await judgeByStaticAnalysis(cwd, await readProblemMarkdownFrontMatter(problemDir));
  if (staticAnalysisResult) return staticAnalysisResult;

  const submissionFilePath = options.submissionFilePath ?? DEFAULT_SUBMISSION_FILE_PATH;
  let submissionText: string;
  try {
    submissionText = await fs.readFile(path.join(cwd, submissionFilePath), 'utf8');
  } catch {
    return {
      decisionCode: DecisionCode.MISSING_REQUIRED_SUBMISSION_FILE_ERROR,
      feedbackMarkdown: `\`${submissionFilePath}\`が見つかりません。予測結果のCSVファイルを\`${submissionFilePath}\`という名前で提出してください。`,
    };
  }

  const predictions = readPredictions(submissionText, submissionFilePath, answer, options);
  if (typeof predictions === 'string') {
    return { decisionCode: DecisionCode.WRONG_ANSWER, feedbackMarkdown: predictions };
  }

  const answerValues = [...answer.values()];
  const score = options.metric.compute(
    [...answer.keys()].map((id) => predictions.get(id) as string),
    answerValues
  );
  const isAccepted =
    options.acceptableScore === undefined ||
    (options.metric.isHigherBetter ? score >= options.acceptableScore : score <= options.acceptableScore);
  return {
    decisionCode: isAccepted ? DecisionCode.ACCEPTED : DecisionCode.WRONG_ANSWER,
    score,
    scoreLabel: options.metric.label,
    feedbackMarkdown: buildScoreMarkdown(score, answerValues.length, isAccepted, options),
  };
}

function buildScoreMarkdown(
  score: number,
  rowCount: number,
  isAccepted: boolean,
  options: EvaluationJudgePresetOptions
): string {
  const { label, isHigherBetter } = options.metric;
  const acceptanceLine =
    options.acceptableScore === undefined
      ? ''
      : `\n合格基準: ${label} ${isHigherBetter ? '≧' : '≦'} ${formatScore(options.acceptableScore)}（${isAccepted ? '達成' : '未達成'}）`;
  return `| 指標 | スコア |
| ---- | ------ |
| ${label} | ${formatScore(score)} |

評価件数: ${rowCount.toLocaleString('en-US')}件${acceptanceLine}
`;
}

function formatScore(score: number): string {
  return Number(score.toPrecision(6)).toString();
}

function readPredictions(
  submissionText: string,
  submissionFilePath: string,
  answer: ReadonlyMap<string, string>,
  options: EvaluationJudgePresetOptions
): Map<string, string> | string {
  const rows = parseCsv(submissionText);
  const header = rows[0];
  const idIndex = header?.indexOf(options.idColumn) ?? -1;
  const targetIndex = header?.indexOf(options.targetColumn) ?? -1;
  if (!header || idIndex === -1 || targetIndex === -1) {
    return `\`${submissionFilePath}\`の1行目には\`${options.idColumn}\`列と\`${options.targetColumn}\`列のヘッダーが必要です。`;
  }

  const predictions = new Map<string, string>();
  const problems: string[] = [];
  for (const [rowIndex, row] of rows.slice(1).entries()) {
    if (row.length === 1 && row[0] === '') continue;
    const id = row[idIndex]?.trim() ?? '';
    const prediction = row[targetIndex] ?? '';
    const lineNumber = rowIndex + 2;
    if (!answer.has(id)) {
      problems.push(`${lineNumber}行目: \`${options.idColumn}\`が\`${id}\`の行は評価対象ではありません`);
    } else if (predictions.has(id)) {
      problems.push(`${lineNumber}行目: \`${options.idColumn}\`が\`${id}\`の行が重複しています`);
    } else {
      const validationError = options.metric.validatePrediction?.(prediction);
      if (validationError) {
        problems.push(`${lineNumber}行目: \`${options.targetColumn}\`の値\`${prediction}\`は${validationError}`);
      }
      predictions.set(id, prediction);
    }
  }
  const missingIds = [...answer.keys()].filter((id) => !predictions.has(id));
  if (missingIds.length > 0) {
    problems.push(
      `\`${options.idColumn}\`が${listIds(missingIds)}の行がありません（不足 ${missingIds.length.toLocaleString('en-US')}件）`
    );
  }
  if (problems.length > 0) {
    return `\`${submissionFilePath}\`の内容に問題があります。

${problems
  .slice(0, MAX_LISTED_IDS)
  .map((problem) => `- ${problem}`)
  .join(
    '\n'
  )}${problems.length > MAX_LISTED_IDS ? `\n- ほか${(problems.length - MAX_LISTED_IDS).toLocaleString('en-US')}件` : ''}
`;
  }
  return predictions;
}

function listIds(ids: readonly string[]): string {
  const listed = ids.slice(0, MAX_LISTED_IDS).map((id) => `\`${id}\``);
  return ids.length > MAX_LISTED_IDS ? `${listed.join(', ')}, ...` : listed.join(', ');
}

async function readAnswer(answerFilePath: string, options: EvaluationJudgePresetOptions): Promise<Map<string, string>> {
  const rows = parseCsv(await fs.readFile(answerFilePath, 'utf8'));
  const header = rows[0] ?? [];
  const idIndex = header.indexOf(options.idColumn);
  const targetIndex = header.indexOf(options.targetColumn);
  if (idIndex === -1 || targetIndex === -1) {
    throw new Error(`answer file must have ${options.idColumn} and ${options.targetColumn} columns: ${answerFilePath}`);
  }
  const answer = new Map<string, string>();
  for (const row of rows.slice(1)) {
    if (row.length === 1 && row[0] === '') continue;
    const id = row[idIndex]?.trim() ?? '';
    if (answer.has(id)) throw new Error(`duplicate ${options.idColumn} in answer file: ${id}`);
    answer.set(id, row[targetIndex] ?? '');
  }
  if (answer.size === 0) throw new Error(`answer file has no rows: ${answerFilePath}`);
  return answer;
}

function matchesExpectedResult(resolvedCwd: ResolvedCwd, result: Pick<TestCaseResult, 'decisionCode'>): boolean {
  return (result.decisionCode === DecisionCode.ACCEPTED) === (resolvedCwd.expectedResult === 'accepted');
}

function validateFiniteNumber(prediction: string): string | undefined {
  return Number.isFinite(Number(prediction)) && prediction.trim() !== '' ? undefined : '数値ではありません';
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
