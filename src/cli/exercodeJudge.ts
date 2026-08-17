import { checkAllProblems } from './checkAllProblems.js';
import { runSingleHarness } from './runSingleHarness.js';

// oxlint-disable-next-line unicorn/prefer-top-level-await -- the CJS build output does not support top-level await
void main();

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error(`Usage: exercode-judge <answerDir> [paramsJson]
       exercode-judge check [rootDir] [--only <substring>]... [--skip <substring>]... [--concurrency <n>]

Run in a problem directory to judge one answer directory, or use \`check\` to judge
all model answers of all problems under rootDir (default: the current directory).`);
    process.exitCode = 1;
    return;
  }
  try {
    process.exitCode = await (args[0] === 'check' ? checkAllProblems(args.slice(1)) : runSingleHarness('judge'));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
