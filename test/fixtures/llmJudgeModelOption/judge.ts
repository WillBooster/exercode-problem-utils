import { DecisionCode } from '@exercode/problem-utils';
import { llmJudgePreset } from '@exercode/problem-utils-llm';

await llmJudgePreset(import.meta.dirname, {
  model: 'vendor/option-model',
  test: () => ({ decisionCode: DecisionCode.ACCEPTED }),
});
