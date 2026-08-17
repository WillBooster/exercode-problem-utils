import { runSingleHarness } from './runSingleHarness.js';

// oxlint-disable-next-line unicorn/prefer-top-level-await -- the CJS build output does not support top-level await
void main();

async function main(): Promise<void> {
  if (process.argv.length <= 2) {
    console.error(`Usage: exercode-debug <answerDir> [paramsJson]

Run in a problem directory to debug one answer directory, e.g.:
  exercode-debug model_answers/python '{ "stdin": "1 2" }'`);
    process.exitCode = 1;
    return;
  }
  try {
    process.exitCode = await runSingleHarness('debug');
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
