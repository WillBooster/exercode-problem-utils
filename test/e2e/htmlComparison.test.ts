import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import { DecisionCode, TEST_CASE_RESULT_PREFIX, testCaseResultSchema } from '@exercode/problem-utils';
import { expect, test } from 'vitest';

const sessionPage = `<!doctype html><html><body><span id="count"></span><script>
  sessionStorage.count = String(Number(sessionStorage.count ?? '0') + 1);
  document.querySelector('#count').textContent = sessionStorage.count;
</script></body></html>`;

const cookiePage = `<!doctype html><html><body><span id="count"></span><script>
  const previous = Number(document.cookie.split('=')[1] ?? '0');
  document.cookie = 'visits=' + String(previous + 1) + '; path=/';
  document.querySelector('#count').textContent = document.cookie;
</script></body></html>`;

const encodedPage = String.raw`<!doctype html><html><head><meta charset="utf8"></head><body><script>
  document.body.style.backgroundColor = '日本語' === '\u65e5\u672c\u8a9e' ? 'navy' : 'red';
</script></body></html>`;

test.each([
  {
    name: 'browser recovery of a stray closing tag',
    model: '<!doctype html><html><body><span>A</span><span>B</span></body></html>',
    submission: '<!doctype html><html><body><span>A</span><span>B</span></div></body></html>',
  },
  { name: 'per-page session state', model: sessionPage, submission: sessionPage },
  { name: 'cookie state', model: cookiePage, submission: cookiePage },
  {
    name: 'Shift_JIS document encoding',
    model: encodedPage,
    submission: Buffer.from(
      encodedPage
        .replace('utf8', 'Shift_JIS')
        .replace('日本語', String.fromCodePoint(0x93, 0xFA, 0x96, 0x7B, 0x8C, 0xEA)),
      'latin1'
    ),
  },
])('HTML comparison preserves equivalence with $name', { timeout: 30_000 }, async ({ model, submission }) => {
  await fs.mkdir('.tmp', { recursive: true });
  const root = await fs.mkdtemp(path.resolve('.tmp', 'html-comparison-'));
  try {
    const solution = path.join(root, 'solution');
    const answer = path.join(root, 'answer');
    await fs.mkdir(solution);
    await fs.mkdir(answer);
    await fs.writeFile(path.join(solution, 'index.html'), model);
    await fs.writeFile(path.join(answer, 'index.html'), submission);
    const harness = path.join(root, 'judge.ts');
    await fs.writeFile(
      harness,
      `import { htmlJudgePreset } from '@exercode/problem-utils-browser';
await htmlJudgePreset({ solutionDirectoryPath: ${JSON.stringify(solution)} });
`
    );
    const result = spawnSync('bun', [harness, answer, '{}'], { encoding: 'utf8', timeout: 20_000 });
    expect(result.status, result.stderr).toBe(0);
    const verdicts = result.stdout
      .trim()
      .split('\n')
      .map((line) => {
        expect(line.startsWith(TEST_CASE_RESULT_PREFIX)).toBe(true);
        return testCaseResultSchema.parse(JSON.parse(line.slice(TEST_CASE_RESULT_PREFIX.length)));
      });
    expect(verdicts.map(({ testCaseId, decisionCode }) => ({ testCaseId, decisionCode }))).toEqual([
      { testCaseId: 'snapshot_body', decisionCode: DecisionCode.ACCEPTED },
      { testCaseId: 'screenshot', decisionCode: DecisionCode.ACCEPTED },
    ]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
