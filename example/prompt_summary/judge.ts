import { DecisionCode } from '@exercode/problem-utils';
import { llmJudgePreset } from '@exercode/problem-utils-llm';

await llmJudgePreset(import.meta.dirname, {
  test(context) {
    return {
      decisionCode:
        context.result.output.trim().length < (context.testCase.input?.trim().length ?? 0) &&
        context.result.output.includes(context.testCase.output?.trim() ?? '')
          ? DecisionCode.ACCEPTED
          : DecisionCode.WRONG_ANSWER,
    };
  },
});
