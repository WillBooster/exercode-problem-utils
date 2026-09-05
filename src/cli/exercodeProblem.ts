import { checkAllProblems } from './checkAllProblems.js';
import { runSingleHarness } from './runSingleHarness.js';
import { VALIDATE_SUBCOMMANDS, type ValidateSubcommand, validateLearningMaterial } from './validateLearningMaterial.js';

const usage = `Usage: exercode-problem [rootDir] [--only <substring>]... [--skip <substring>]... [--concurrency <n>]
       exercode-problem judge <answerDir> [paramsJson]
       exercode-problem debug <answerDir> [paramsJson]
       exercode-problem validate-problem <problemDir>...
       exercode-problem validate-course <courseDir> [--problems-dir <dir>]
       exercode-problem validate-contest <contestYamlPath> [--problems-dir <dir>]

Without a subcommand, judge all model answers of all problems under rootDir
(default: the current directory). Use \`judge\` or \`debug\` in a problem
directory to run one answer directory, e.g.:
  exercode-problem debug model_answers/python '{ "stdin": "1 2" }'
The \`validate-*\` subcommands check problem directories, a course directory
(course.yaml and lecture materials), or a contest (*.contest.yaml) file
without running any program.`;

// oxlint-disable-next-line unicorn/prefer-top-level-await -- the CJS build output does not support top-level await
void main();

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === '--help' || args[0] === '-h') {
    // console.log would be stripped from the built CLI, so print the usage with console.info.
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
    } else if (isValidateSubcommand(args[0])) {
      process.exitCode = await validateLearningMaterial(args[0], args.slice(1));
    } else {
      process.exitCode = await checkAllProblems(args);
    }
  } catch (error) {
    // Print the whole error: harness failures need their stack and `cause`, not just the message.
    console.error(error);
    process.exitCode = 1;
  }
}

function isValidateSubcommand(arg: string | undefined): arg is ValidateSubcommand {
  return (VALIDATE_SUBCOMMANDS as readonly string[]).includes(arg ?? '');
}
