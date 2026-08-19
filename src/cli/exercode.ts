import { checkAllProblems } from './checkAllProblems.js';
import { runSingleHarness } from './runSingleHarness.js';

const usage = `Usage: exercode [rootDir] [--only <substring>]... [--skip <substring>]... [--concurrency <n>]
       exercode judge <answerDir> [paramsJson]
       exercode debug <answerDir> [paramsJson]

Without a subcommand, judge all model answers of all problems under rootDir
(default: the current directory). Use \`judge\` or \`debug\` in a problem
directory to run one answer directory, e.g.:
  exercode debug model_answers/python '{ "stdin": "1 2" }'`;

// oxlint-disable-next-line unicorn/prefer-top-level-await -- the CJS build output does not support top-level await
void main();

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === '--help' || args[0] === '-h') {
    console.info(usage);
    return;
  }
  try {
    if (args[0] === 'judge' || args[0] === 'debug') {
      if (args.length < 2) {
        console.error(usage);
        process.exitCode = 1;
        return;
      }
      // Harness scripts and presets read the answer directory and params from fixed positions in
      // `process.argv`, so drop the subcommand to restore those positions.
      process.argv.splice(2, 1);
      process.exitCode = await runSingleHarness(args[0]);
    } else {
      process.exitCode = await checkAllProblems(args);
    }
  } catch (error) {
    // Print the whole error: harness failures need their stack and `cause`, not just the message.
    console.error(error);
    process.exitCode = 1;
  }
}
