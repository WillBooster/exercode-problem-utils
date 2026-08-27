import fs from 'node:fs/promises';
import path from 'node:path';

import { checkProblemDirIsolation } from '../helpers/checkProblemDirIsolation.js';
import { judgeByStaticAnalysis } from '../helpers/judgeByStaticAnalysis.js';
import { parseArgs } from '../helpers/parseArgs.js';
import { parseCsv, parseCsvRecords } from '../helpers/parseCsv.js';
import { printDebugBanner } from '../helpers/printDebugBanner.js';
import { printTestCaseResult } from '../helpers/printTestCaseResult.js';
import { isSafeSubmissionOutputPath } from '../helpers/readOutputFiles.js';
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
// Learner-controlled cells are echoed into the feedback, so clip them to keep the result line small.
const MAX_ECHOED_CELL_LENGTH = 50;

export interface EvaluationMetric {
  /** Label shown with the score, e.g. `RMSLE`. */
  label: string;
  isHigherBetter: boolean;
  /**
   * Returns an error message when a predicted value cannot be scored (e.g. it is not a number).
   * The message is appended to the row's line number and the offending value, so phrase it as a
   * predicate such as `数値ではありません`. It also validates the ground truth when it is loaded.
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
      validateFiniteNumber(prediction) ?? (Number(prediction) < 0 ? '負の値です' : undefined),
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
    validatePrediction: (prediction: string) => (prediction.trim() === '' ? '空です' : undefined),
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
    const resolvedPath = path.join(cwd, submissionFilePath);
    // The harness reads the file as the trusted user, so refuse symlinks escaping the submission.
    if (!(await isSafeSubmissionOutputPath(cwd, resolvedPath))) throw new Error('unsafe path');
    submissionText = await fs.readFile(resolvedPath, 'utf8');
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
  if (!Number.isFinite(score)) {
    return {
      decisionCode: DecisionCode.WRONG_ANSWER,
      feedbackMarkdown: `予測値が極端なため、${options.metric.label}を計算できませんでした。予測値を見直してください。`,
    };
  }
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
  const precision = findDistinguishingPrecision(score, options.acceptableScore);
  const acceptanceLine =
    options.acceptableScore === undefined
      ? ''
      : `\n合格基準: ${label} ${isHigherBetter ? '≧' : '≦'} ${formatScore(options.acceptableScore, precision)}（${isAccepted ? '達成' : '未達成'}）`;
  return `| 指標 | スコア |
| ---- | ------ |
| ${label} | ${formatScore(score, precision)} |

評価件数: ${rowCount.toLocaleString('en-US')}件${acceptanceLine}
`;
}

function formatScore(score: number, precision: number): string {
  return Number(score.toPrecision(precision)).toString();
}

/**
 * Finds the number of significant digits at which the score and the threshold render differently
 * (or stop changing), so the feedback never shows a pair that contradicts the decision.
 */
function findDistinguishingPrecision(score: number, threshold: number | undefined): number {
  const minimumPrecision = 6;
  if (threshold === undefined || score === threshold) return minimumPrecision;
  for (let precision = minimumPrecision; precision < 17; precision++) {
    if (formatScore(score, precision) !== formatScore(threshold, precision)) return precision;
  }
  return 17;
}

function readPredictions(
  submissionText: string,
  submissionFilePath: string,
  answer: ReadonlyMap<string, string>,
  options: EvaluationJudgePresetOptions
): Map<string, string> | string {
  let records: ReturnType<typeof parseCsvRecords>;
  try {
    records = parseCsvRecords(submissionText);
  } catch {
    return `\`${submissionFilePath}\`をCSVとして読み込めませんでした。引用符（\`"\`）の使い方を確認してください。`;
  }
  const columns = findColumns(records[0]?.cells ?? [], options);
  if (!columns) {
    return `\`${submissionFilePath}\`の1行目には\`${options.idColumn}\`列と\`${options.targetColumn}\`列のヘッダーが必要です。`;
  }

  const predictions = new Map<string, string>();
  const problems: string[] = [];
  let problemCount = 0;
  const reportProblem = (problem: string): void => {
    problemCount++;
    if (problems.length < MAX_LISTED_IDS) problems.push(problem);
  };
  for (const { cells: row, lineNumber } of records.slice(1)) {
    if (isBlankRow(row)) continue;
    const id = row[columns.idIndex]?.trim() ?? '';
    const prediction = row[columns.targetIndex] ?? '';
    if (!answer.has(id)) {
      reportProblem(`${lineNumber}行目: \`${options.idColumn}\`が\`${clip(id)}\`の行は評価対象ではありません`);
    } else if (predictions.has(id)) {
      reportProblem(`${lineNumber}行目: \`${options.idColumn}\`が\`${clip(id)}\`の行が重複しています`);
    } else {
      const validationError = options.metric.validatePrediction?.(prediction);
      if (validationError) {
        reportProblem(`${lineNumber}行目: \`${options.targetColumn}\`の値\`${clip(prediction)}\`は${validationError}`);
      }
      predictions.set(id, prediction);
    }
  }
  const missingIds = [...answer.keys()].filter((id) => !predictions.has(id));
  if (missingIds.length > 0) {
    // Missing rows are the most actionable problem, so they must survive the listing cap.
    problemCount++;
    problems.unshift(
      `\`${options.idColumn}\`が${listIds(missingIds)}の行がありません（不足 ${missingIds.length.toLocaleString('en-US')}件）`
    );
  }
  if (problemCount > 0) {
    return `\`${submissionFilePath}\`の内容に問題があります。

${problems.map((problem) => `- ${problem}`).join('\n')}${problemCount > problems.length ? `\n- ほか${(problemCount - problems.length).toLocaleString('en-US')}件` : ''}
`;
  }
  return predictions;
}

function findColumns(
  header: readonly string[],
  options: EvaluationJudgePresetOptions
): { idIndex: number; targetIndex: number } | undefined {
  const names = header.map((name) => name.trim());
  const idIndex = names.indexOf(options.idColumn);
  const targetIndex = names.indexOf(options.targetColumn);
  return idIndex === -1 || targetIndex === -1 ? undefined : { idIndex, targetIndex };
}

function isBlankRow(row: readonly string[]): boolean {
  return row.every((cell) => cell.trim() === '');
}

function clip(value: string): string {
  // Control characters and backticks would break the markdown list item and inline code the value is echoed in.
  const printable = value.replaceAll(/[\p{Cc}]/gu, ' ').replaceAll('`', "'");
  return printable.length > MAX_ECHOED_CELL_LENGTH ? `${printable.slice(0, MAX_ECHOED_CELL_LENGTH)}…` : printable;
}

function listIds(ids: readonly string[]): string {
  const listed = ids.slice(0, MAX_LISTED_IDS).map((id) => `\`${clip(id)}\``);
  return ids.length > MAX_LISTED_IDS ? `${listed.join(', ')}, ...` : listed.join(', ');
}

async function readAnswer(answerFilePath: string, options: EvaluationJudgePresetOptions): Promise<Map<string, string>> {
  const rows = parseCsv(await fs.readFile(answerFilePath, 'utf8'));
  const columns = findColumns(rows[0] ?? [], options);
  if (!columns) {
    throw new Error(`answer file must have ${options.idColumn} and ${options.targetColumn} columns: ${answerFilePath}`);
  }
  const answer = new Map<string, string>();
  for (const row of rows.slice(1)) {
    if (isBlankRow(row)) continue;
    const id = row[columns.idIndex]?.trim() ?? '';
    const value = row[columns.targetIndex] ?? '';
    if (answer.has(id)) throw new Error(`duplicate ${options.idColumn} in answer file: ${id}`);
    const validationError = options.metric.validatePrediction?.(value);
    if (validationError)
      throw new Error(`invalid ${options.targetColumn} in answer file for ${id}: ${validationError}`);
    answer.set(id, value);
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
