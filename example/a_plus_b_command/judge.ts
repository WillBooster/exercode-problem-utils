// The command preset judges `test_cases/` (`.in` / `.out`) like the default stdio harness when no
// `test` option is given, while adding the preset's debug mode (`bun judge.ts` without arguments).
import { commandJudgePreset } from '@exercode/problem-utils/presets/command';

await commandJudgePreset(import.meta.dirname);
