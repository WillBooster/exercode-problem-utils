// A judge whose single accepted run takes longer than the isolation check's minimum budget, so the
// debug-mode check must derive its timeout from `timeLimitMs` instead of a fixed value.
import { DecisionCode } from '@exercode/problem-utils';
import { commandJudgePreset } from '@exercode/problem-utils/presets/command';

await commandJudgePreset(import.meta.dirname, {
  test: ({ runResult }) => ({
    decisionCode: runResult.stdout.trim() === 'done' ? DecisionCode.ACCEPTED : DecisionCode.WRONG_ANSWER,
  }),
});
