import { spawnWithLimits } from './spawnWithLimits.js';

const OUTPUT_LIMIT_BYTES = 8 * 1024 * 1024;

/**
 * Runs a submission-derived command under a time limit. A run that hits the limit is reported with
 * status 0 and `timeSeconds` just above the limit, which callers read as time limit exceeded.
 */
export async function spawnWithTimeout(
  command: string,
  args: readonly string[],
  context: { cwd: string; env: NodeJS.ProcessEnv; stdin?: string },
  timeoutSeconds: number
): Promise<{ stdout: string; stderr: string; status: number | undefined; timeSeconds: number; memoryBytes: number }> {
  const startTimeMilliseconds = Date.now();
  const result = await spawnWithLimits([command, ...args], {
    cwd: context.cwd,
    env: context.env,
    outputLimitBytes: OUTPUT_LIMIT_BYTES,
    stdin: context.stdin ?? '',
    timeLimitSeconds: timeoutSeconds,
  });

  // Keep GNU time's note about an abnormal exit (e.g. a segmentation fault) visible to the learner.
  const stderr = result.timeCommandMessage ? `${result.stderr}${result.timeCommandMessage}\n` : result.stderr;

  if (result.timedOut) {
    return { ...result, stderr, status: 0, timeSeconds: timeoutSeconds + 1e-3 };
  }

  return { ...result, stderr, timeSeconds: result.timeSeconds || (Date.now() - startTimeMilliseconds) / 1000 };
}
