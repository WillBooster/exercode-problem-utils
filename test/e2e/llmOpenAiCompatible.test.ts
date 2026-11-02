import child_process from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

import { DecisionCode, TEST_CASE_RESULT_PREFIX, testCaseResultSchema } from '@exercode/problem-utils';
import { afterAll, beforeAll, expect, test } from 'vitest';

interface ReceivedRequest {
  url?: string;
  authorization?: string;
  body: Record<string, unknown>;
}

const requests: ReceivedRequest[] = [];
const server = http.createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => chunks.push(chunk));
  request.on('end', () => {
    requests.push({
      url: request.url,
      authorization: request.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>,
    });
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({
        id: 'chatcmpl-test',
        created: 0,
        model: 'test',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '富士山' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })
    );
  });
});

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
});

afterAll(() => {
  server.close();
});

test(
  'llmJudgePreset sends test cases to the OpenAI-compatible endpoint from the environment',
  { timeout: 30_000 },
  async () => {
    const { port } = server.address() as AddressInfo;
    const stdout = await runJudge({
      OPENAI_COMPATIBLE_BASE_URL: `http://127.0.0.1:${port}/v1`,
      OPENAI_COMPATIBLE_API_KEY: 'test-key',
      OPENAI_COMPATIBLE_EXTRA_BODY: JSON.stringify({ reasoning_effort: 'low', vendor: { fallback_models: ['b/c'] } }),
    });

    const results = stdout
      .split('\n')
      .filter((line) => line.startsWith(TEST_CASE_RESULT_PREFIX))
      .map((line) => testCaseResultSchema.parse(JSON.parse(line.slice(TEST_CASE_RESULT_PREFIX.length))));
    expect(results.map((result) => result.decisionCode)).toEqual([DecisionCode.ACCEPTED, DecisionCode.ACCEPTED]);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      url: '/v1/chat/completions',
      authorization: 'Bearer test-key',
      body: { model: 'vendor/model-name', reasoning_effort: 'low', vendor: { fallback_models: ['b/c'] } },
    });
  }
);

async function runJudge(env: Record<string, string>): Promise<string> {
  // Asynchronous because the endpoint runs in this process.
  const child = child_process.spawn(
    'bun',
    ['run', 'judge.ts', 'model_answers/default', JSON.stringify({ model: 'vendor/model-name' })],
    {
      cwd: path.resolve('example/prompt_summary'),
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'inherit'],
      timeout: 25_000,
    }
  );
  let stdout = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  await new Promise((resolve, reject) => {
    child.on('close', resolve);
    child.on('error', reject);
  });
  return stdout;
}
