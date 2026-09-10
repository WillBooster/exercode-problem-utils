import { checkProblemDirIsolation, type ProblemDirIsolationCheckOptions } from './checkProblemDirIsolation.js';
import { printDebugBanner } from './printDebugBanner.js';
import type { ResolvedCwd } from './resolveCwds.js';

/**
 * Run the isolated problem directory check against the first accepted model answer in debug mode.
 * Returns false when the check fails, so the caller can stop before judging anything else.
 */
export async function passesIsolationCheckInDebugMode(
  problemDir: string,
  cwds: readonly ResolvedCwd[],
  params: unknown,
  options: ProblemDirIsolationCheckOptions = {}
): Promise<boolean> {
  const acceptedCwd = cwds.find((cwd) => cwd.expectedResult === 'accepted');
  if (!acceptedCwd) {
    printDebugBanner([
      '[DEBUG MODE] isolated problem directory check skipped',
      '',
      'No accepted model answer is available for checking that the copied judge still accepts a valid submission.',
    ]);
    return true;
  }
  const result = await checkProblemDirIsolation(problemDir, acceptedCwd, params, options);
  return result.passed;
}
