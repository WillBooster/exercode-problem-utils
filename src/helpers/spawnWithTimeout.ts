import { isTimeCommandAvailable, spawnWithLimits } from './spawnWithLimits.js';

const OUTPUT_LIMIT_BYTES = 8 * 1024 * 1024;

/**
 * Runs a submission-derived command under a time limit and an output cap. A run that hits a limit is
 * reported like a normal exit (status 0), with `timeSeconds` just above the limit or the output
 * truncated at the cap, so callers judge it by the limit it hit. A command that cannot be started is
 * reported with no status and the error as stderr; a failure on the judge's side throws.
 */
export async function spawnWithTimeout(
  command: string,
  args: readonly string[],
  context: { cwd: string; env: NodeJS.ProcessEnv; stdin?: string },
  timeoutSeconds: number
): Promise<{
  stdout: string;
  stderr: string;
  status: number | undefined;
  timeSeconds: number;
  memoryBytes: number;
  outputLimitExceeded: boolean;
}> {
  // Without measurements, time and memory limits would silently never apply.
  if (!isTimeCommandAvailable) throw new Error('GNU time (gtime on macOS, /usr/bin/time on Linux) is required.');

  const result = await spawnWithLimits([command, ...args], {
    cwd: context.cwd,
    env: context.env,
    outputLimitBytes: OUTPUT_LIMIT_BYTES,
    stdin: context.stdin ?? '',
    timeLimitSeconds: timeoutSeconds,
  });

  // Keep GNU time's note about an abnormal exit (e.g. a segmentation fault) visible to the learner.
  const stderr = result.timeCommandMessage
    ? `${result.stderr}${result.stderr && !result.stderr.endsWith('\n') ? '\n' : ''}${result.timeCommandMessage}\n`
    : result.stderr;

  return {
    stdout: result.stdout,
    stderr,
    status: result.timedOut || result.outputLimitExceeded ? 0 : result.status,
    timeSeconds: result.timedOut ? timeoutSeconds + 1e-3 : result.timeSeconds,
    memoryBytes: result.memoryBytes,
    outputLimitExceeded: result.outputLimitExceeded,
  };
}
