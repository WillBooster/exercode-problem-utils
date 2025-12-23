import { llmJudgePreset } from '@exercode/problem-utils/presets/llm';
import { DecisionCode } from '@exercode/problem-utils';

await llmJudgePreset(import.meta.dirname, {
  test(context) {
    return {
      decisionCode:
        context.result.output.length < (context.testCase.input?.length ?? 0) &&
        context.result.output.includes(context.testCase.output ?? '')
          ? DecisionCode.ACCEPTED
          : DecisionCode.WRONG_ANSWER,
    };
  },
});
