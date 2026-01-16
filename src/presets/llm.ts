import fs from 'node:fs';
import path from 'node:path';

import { bedrock } from '@ai-sdk/amazon-bedrock';
import { google } from '@ai-sdk/google';
import { openai } from '@ai-sdk/openai';
import { xai } from '@ai-sdk/xai';
import type { LanguageModel, ModelMessage } from 'ai';
import { generateText } from 'ai';
import { z } from 'zod';

import { parseArgs } from '../helpers/parseArgs.js';
import { printTestCaseResult } from '../helpers/printTestCaseResult.js';
import { readTestCases } from '../helpers/readTestCases.js';
import { DecisionCode } from '../types/decisionCode.js';
import type { TestCaseResult } from '../types/testCaseResult.js';

const PROMPT_FILENAME = 'prompt.txt';

const providerByName: Record<string, typeof bedrock | typeof google | typeof openai | typeof xai> = {
  // requires `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`
  bedrock,
  // requires `GOOGLE_GENERATIVE_AI_API_KEY`
  google,
  // requires `OPENAI_API_KEY`
  openai,
  // requires `XAI_API_KEY`
  xai,
} as const;

const judgeParamsSchema = z.object({
  model: z.string().min(1),
});

interface LlmJudgePresetOptions {
  buildPrompt?: (context: {
    prompt: string;
    testCase: { id: string; input?: string; output?: string };
  }) => string | ModelMessage[];
  test: (context: {
    testCase: { id: string; input?: string; output?: string };
    result: { output: string };
  }) => Partial<TestCaseResult> | Promise<Partial<TestCaseResult>>;
}

/**
 * A preset judge function for running and testing a user prompt in LLM.
 *
 * @example
 * Create `judge.ts`:
 * ```ts
 * import { llmJudgePreset } from '@exercode/problem-utils/presets/llm';
 * import { DecisionCode } from '@exercode/problem-utils';
 *
 * await llmJudgePreset(import.meta.dirname, {
 *   test: (context) {
 *     return { decisionCode: context.result.output ? DecisionCode.ACCEPTED : DecisionCode.WRONG_ANSWER };
 *   }
 * });
 * ```
 *
 * Run with the required parameters:
 * ```bash
 * bun judge.ts model_answers/java '{ "model": "gemini-2.5-flash-lite" }'
 * ```
 */
export async function llmJudgePreset(problemDir: string, options: LlmJudgePresetOptions): Promise<void> {
  const args = parseArgs(process.argv);
  const params = judgeParamsSchema.parse(args.params);

  const testCases = await readTestCases(path.join(problemDir, 'test_cases'));

  const prompt = await fs.promises.readFile(path.join(args.cwd, PROMPT_FILENAME), 'utf8');

  for (const testCase of testCases) {
    const startTimeMilliseconds = Date.now();
    try {
      const { text } = await generateText({
        model: toLanguageModel(params.model),
        prompt: options.buildPrompt?.({ prompt, testCase }) ?? prompt.replaceAll('{input}', testCase.input ?? ''),
      });

      const stopTimeMilliseconds = Date.now();

      const testCaseResult = {
        testCaseId: testCase.id,
        decisionCode: DecisionCode.ACCEPTED,
        stdin: testCase.input,
        stdout: text,
        timeSeconds: (stopTimeMilliseconds - startTimeMilliseconds) / 1000,
        ...(await options.test({ testCase, result: { output: text } })),
      };

      printTestCaseResult(testCaseResult);

      if (testCaseResult.decisionCode !== DecisionCode.ACCEPTED) break;
    } catch (error) {
      const stopTimeMilliseconds = Date.now();

      printTestCaseResult({
        testCaseId: testCase.id,
        decisionCode: DecisionCode.RUNTIME_ERROR,
        stdin: testCase.input,
        stderr: error instanceof Error ? error.message : String(error),
        timeSeconds: (stopTimeMilliseconds - startTimeMilliseconds) / 1000,
      });

      break;
    }
  }
}

function toLanguageModel(model: string): LanguageModel {
  const [providerId, modelId] = model.split('/');
  if (!providerId || !modelId) throw new Error(`bad model: ${model}`);
  const languageModel = providerByName[providerId]?.(modelId);
  if (!languageModel) throw new Error(`model not found: ${model}`);
  return languageModel;
}
