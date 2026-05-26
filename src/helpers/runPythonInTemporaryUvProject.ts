import {
  type PackageManagerCommandRunResult,
  runCommandInTemporaryPackageManagerProject,
  type RunCommandInTemporaryPackageManagerProjectOptions,
} from './runCommandInTemporaryPackageManagerProject.js';

export interface RunPythonInTemporaryUvProjectOptions extends Omit<
  RunCommandInTemporaryPackageManagerProjectOptions,
  'command' | 'packageManager'
> {
  pythonArgs?: readonly [string, ...string[]];
  uvArgs?: readonly string[];
}

const defaultPythonArgs = ['main.py'] as const;

/**
 * Runs a Python command inside a temporary uv project created from a submission
 * directory and the problem's `pyproject.toml` / `uv.lock`.
 */
export function runPythonInTemporaryUvProject(
  options: RunPythonInTemporaryUvProjectOptions
): Promise<PackageManagerCommandRunResult> {
  const { pythonArgs = defaultPythonArgs, uvArgs = [], ...restOptions } = options;
  return runCommandInTemporaryPackageManagerProject({
    ...restOptions,
    packageManager: 'uv',
    command: ['uv', 'run', '--quiet', '--no-progress', ...uvArgs, 'python', ...pythonArgs] as const,
  });
}
