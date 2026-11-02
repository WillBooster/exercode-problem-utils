import fs from 'node:fs';
import path from 'node:path';

import { bedrock } from '@ai-sdk/amazon-bedrock';
import { google } from '@ai-sdk/google';
import { createOpenAI, openai } from '@ai-sdk/openai';
import { xai } from '@ai-sdk/xai';
import {
  DecisionCode,
  parseArgs,
  printTestCaseResult,
  readTestCases,
  type TestCaseResult,
} from '@exercode/problem-utils';
import { getErrorMessage } from '@willbooster/shared-lib';
import type { LanguageModel, ModelMessage } from 'ai';
import { generateText } from 'ai';
import { z } from 'zod';

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

const jsonObjectSchema = z.record(z.string(), z.unknown());

/**
 * Connection to an OpenAI-compatible Chat Completions endpoint. Each field falls back to its environment variable.
 * Never hard-code `apiKey` or a secret in `extraBody`: `judge.ts` is distributed with the problem.
 */
interface OpenAiCompatibleOptions {
  /** Defaults to `OPENAI_COMPATIBLE_BASE_URL`. The endpoint is used only when a base URL is resolved. */
  baseURL?: string;
  /** Defaults to `OPENAI_COMPATIBLE_API_KEY`. */
  apiKey?: string;
  /** Top-level request body fields. Defaults to the JSON object in `OPENAI_COMPATIBLE_EXTRA_BODY`. */
  extraBody?: Record<string, unknown>;
}

/** A `test_cases/` entry; the preset uses `input` for the prompt and hands everything to `test`. */
interface LlmTestCase {
  id: string;
  input?: string;
  output?: string;
  /** Present when `<id>.fin/` exists; the preset does not copy it anywhere (there is no program run). */
  fileInputPath?: string;
  /** Present when `<id>.fout/` exists, for `test` to read. */
  fileOutputPath?: string;
}

interface LlmJudgePresetOptions {
  buildPrompt?: (context: { prompt: string; testCase: LlmTestCase }) => string | ModelMessage[];
  test: (context: {
    testCase: LlmTestCase;
    result: { output: string };
  }) => Partial<TestCaseResult> | Promise<Partial<TestCaseResult>>;
  /** Sends every test case to this endpoint, with the `model` parameter passed verbatim as the model ID. */
  openAiCompatible?: OpenAiCompatibleOptions;
}

/**
 * A preset judge function for running and testing a user prompt in LLM.
 *
 * @example
 * Create `judge.ts`:
 * ```ts
 * import { llmJudgePreset } from '@exercode/problem-utils-llm';
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
  if (!args.cwd) throw new Error('cwd argument required');
  const params = judgeParamsSchema.parse(args.params);

  const testCases = await readTestCases(path.join(problemDir, 'test_cases'));

  const prompt = await fs.promises.readFile(path.join(args.cwd, PROMPT_FILENAME), 'utf8');

  for (const testCase of testCases) {
    const startTimeMilliseconds = Date.now();
    try {
      const { text } = await generateText({
        model: toOpenAiCompatibleModel(params.model, options.openAiCompatible) ?? toLanguageModel(params.model),
        ...toPromptOptions(
          options.buildPrompt?.({ prompt, testCase }) ?? prompt.replaceAll('{input}', testCase.input ?? '')
        ),
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
        stderr: getErrorMessage(error),
        timeSeconds: (stopTimeMilliseconds - startTimeMilliseconds) / 1000,
      });

      break;
    }
  }
}

/** `ai` rejects system messages inside `messages` unless told that a `buildPrompt` may place them there. */
function toPromptOptions(
  built: string | ModelMessage[]
): { prompt: string } | { messages: ModelMessage[]; allowSystemInMessages: true } {
  return typeof built === 'string' ? { prompt: built } : { messages: built, allowSystemInMessages: true };
}

function toOpenAiCompatibleModel(model: string, options?: OpenAiCompatibleOptions): LanguageModel | undefined {
  const baseURL = options?.baseURL ?? process.env.OPENAI_COMPATIBLE_BASE_URL;
  if (!baseURL) return undefined;

  const extraBody = options?.extraBody ?? readExtraBodyFromEnv();
  return createOpenAI({
    baseURL,
    apiKey: options?.apiKey ?? process.env.OPENAI_COMPATIBLE_API_KEY,
    fetch: extraBody ? withExtraBody(extraBody) : undefined,
  }).chat(model);
}

function readExtraBodyFromEnv(): Record<string, unknown> | undefined {
  const json = process.env.OPENAI_COMPATIBLE_EXTRA_BODY;
  return json ? jsonObjectSchema.parse(JSON.parse(json)) : undefined;
}

function withExtraBody(extraBody: Record<string, unknown>): typeof fetch {
  const extendedFetch = (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]): Promise<Response> => {
    const body = jsonObjectSchema.parse(JSON.parse(z.string().parse(init?.body)));
    return fetch(input, { ...init, body: JSON.stringify({ ...body, ...extraBody }) });
  };
  return Object.assign(extendedFetch, fetch);
}

function toLanguageModel(model: string): LanguageModel {
  const [providerId, modelId] = model.split('/');
  if (!providerId || !modelId) throw new Error(`bad model: ${model}`);
  const languageModel = providerByName[providerId]?.(modelId);
  if (!languageModel) throw new Error(`model not found: ${model}`);
  return languageModel;
}
