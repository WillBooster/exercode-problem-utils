import { browserJudgePreset } from '@exercode/problem-utils-browser';

for (const original of [
  new DOMException('\u001B[2mBrowser operation aborted\u001B[22m', 'AbortError'),
  Object.freeze(new Error('\u001B[2mFrozen failure\u001B[22m')),
]) {
  try {
    await browserJudgePreset({
      initializePage() {
        throw original;
      },
      testCases: [],
    });
    throw new Error('Expected the browser preset to reject');
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ sameError: error === original, name: error instanceof Error ? error.name : '', message: error instanceof Error ? error.message : '', stack: error instanceof Error ? error.stack : undefined })}\n`
    );
  }
}
