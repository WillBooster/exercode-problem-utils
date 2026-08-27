import { evaluationJudgePreset, evaluationMetrics } from '@exercode/problem-utils/presets/evaluation';

await evaluationJudgePreset(import.meta.dirname, {
  answerFilePath: 'evaluation/answer.csv',
  idColumn: 'Id',
  targetColumn: 'Price',
  metric: evaluationMetrics.rmsle,
  acceptableScore: 0.5,
});
