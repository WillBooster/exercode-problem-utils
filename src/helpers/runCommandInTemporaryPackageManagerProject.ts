import childProcess from 'node:child_process';
import nodeFs from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  forceRemove,
  getSandboxUserEnvOverrides,
  killSandboxUserProcesses,
  makeAccessibleToSandboxUser,
  prependInsideSandboxWrapper,
  SANDBOX_WATCHDOG_GRACE_SECONDS,
  sandboxUserName,
  startSandboxTimeoutWatchdog,
  wrapCommandWithSandboxUser,
} from './sandboxUser.js';
import { copyWithoutFollowingSymlinks } from './safeFs.js';

export type PackageManager = 'bun' | 'cargo' | 'go' | 'gradle' | 'maven' | 'npm' | 'pnpm' | 'ruby' | 'uv' | 'yarn';
type PackageManagerInstallCommand = readonly [string, ...string[]];

export interface PackageManagerCommandRunResult {
  stdin: string;
  stdout: string;
  stderr: string;
  status: number | undefined;
  timeSeconds: number;
  memoryBytes: number;
  timedOut: boolean;
  signal: NodeJS.Signals | undefined;
  outputLimitExceeded: boolean;
}

export interface RunCommandInTemporaryPackageManagerProjectOptions {
  cwd: string;
  projectDir: string;
  packageManager: PackageManager;
  command: readonly [string, ...string[]] | ((context: { runDir: string }) => readonly [string, ...string[]]);
  stdin?: string;
  env?: NodeJS.ProcessEnv;
  timeLimitSeconds: number;
  outputLimitBytes?: number;
  tempDirPrefix?: string;
  projectFilePaths?: readonly string[];
}

const packageManagerProjectFilePaths = {
  bun: ['package.json', 'bun.lock', 'bun.lockb'],
  cargo: ['Cargo.toml', 'Cargo.lock'],
  go: ['go.mod', 'go.sum'],
  gradle: [
    'build.gradle',
    'build.gradle.kts',
    'settings.gradle',
    'settings.gradle.kts',
    'gradle.properties',
    'gradle.lockfile',
    'buildscript-gradle.lockfile',
    'gradle',
    'gradlew',
    'gradlew.bat',
  ],
  maven: ['pom.xml', '.mvn', 'mvnw', 'mvnw.cmd'],
  npm: ['package.json', 'package-lock.json'],
  pnpm: ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'],
  ruby: ['Gemfile', 'Gemfile.lock', '.ruby-version'],
  uv: ['pyproject.toml', 'uv.lock'],
  yarn: ['package.json', 'yarn.lock', '.yarnrc', '.yarnrc.yml', '.yarn'],
} as const satisfies Record<PackageManager, readonly string[]>;

const packageManagerInstallCommandResolvers = {
  bun: resolveBunInstallCommand,
  cargo: resolveCargoInstallCommand,
  go: resolveGoInstallCommand,
  gradle: resolveGradleInstallCommand,
  maven: resolveMavenInstallCommand,
  npm: resolveNpmInstallCommand,
  pnpm: resolvePnpmInstallCommand,
  ruby: resolveRubyInstallCommand,
  uv: resolveUvInstallCommand,
  yarn: resolveYarnInstallCommand,
} as const satisfies Record<PackageManager, (runDir: string) => Promise<PackageManagerInstallCommand | undefined>>;

const defaultOutputLimitBytes = 50 * 1024 * 1024;
const killGracePeriodMilliseconds = 1000;
// Added to the watchdog's own deadline so its kill has time to land and `close` to arrive.
const watchdogSettleMarginMilliseconds = 2000;
const timeCommand = resolveTimeCommand();

/**
 * Copies a submission directory to a temporary directory, overlays package
 * manager project files from the problem directory, prepares dependencies,
 * runs a command, and then removes the temporary directory.
 *
 * Under `EXERCODE_SANDBOX_USER` delegation, cleanup kills every process of the sandbox user, so do
 * not run multiple invocations concurrently in that mode — one finishing would kill the others.
 */
export async function runCommandInTemporaryPackageManagerProject(
  options: RunCommandInTemporaryPackageManagerProjectOptions
): Promise<PackageManagerCommandRunResult> {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), options.tempDirPrefix ?? 'exercode-'));
  try {
    await fs.cp(options.cwd, runDir, { recursive: true });
    await copyPackageManagerProjectFiles({
      packageManager: options.packageManager,
      projectDir: options.projectDir,
      runDir,
      projectFilePaths: options.projectFilePaths,
    });
    // The sandbox user (if any) runs the install/run commands below and must read the copied
    // sources and create outputs (e.g. `node_modules`, `.venv`) next to them.
    makeAccessibleToSandboxUser(runDir);

    const env = options.env ? { ...process.env, ...options.env } : process.env;
    const installCommand = await resolveInstallCommand(options.packageManager, runDir);
    const command = typeof options.command === 'function' ? options.command({ runDir }) : options.command;
    const startedAt = Date.now();
    const outputLimitBytes = options.outputLimitBytes ?? defaultOutputLimitBytes;
    let installResult: Awaited<ReturnType<typeof spawnWithInput>> | undefined;

    if (installCommand) {
      installResult = await spawnWithInput(installCommand, {
        cwd: runDir,
        env,
        outputLimitBytes,
        stdin: '',
        timeLimitSeconds: options.timeLimitSeconds,
      });
      if (isFailedSpawnResult(installResult)) {
        return toPackageManagerCommandRunResult({
          elapsedTimeSeconds: (Date.now() - startedAt) / 1000,
          options,
          result: installResult,
        });
      }
    }

    const remainingTimeLimitSeconds = options.timeLimitSeconds - (Date.now() - startedAt) / 1000;
    if (remainingTimeLimitSeconds <= 0) {
      return {
        stdin: options.stdin ?? '',
        stdout: installResult?.stdout ?? '',
        stderr: installResult?.stderr ?? '',
        status: 0,
        timeSeconds: options.timeLimitSeconds + 1e-3,
        memoryBytes: installResult?.memoryBytes ?? 0,
        timedOut: true,
        signal: installResult?.signal,
        outputLimitExceeded: false,
      };
    }

    const result = await spawnWithInput(command, {
      cwd: runDir,
      env,
      outputLimitBytes,
      stdin: options.stdin ?? '',
      timeLimitSeconds: remainingTimeLimitSeconds,
    });
    const elapsedTimeSeconds = (Date.now() - startedAt) / 1000;

    if (installResult) {
      return toPackageManagerCommandRunResult({
        elapsedTimeSeconds,
        options,
        result: {
          ...result,
          timeSeconds: installResult.timeSeconds + result.timeSeconds,
          memoryBytes: Math.max(installResult.memoryBytes, result.memoryBytes),
        },
      });
    }

    return toPackageManagerCommandRunResult({ elapsedTimeSeconds, options, result });
  } finally {
    try {
      // Daemonized children of the sandboxed command would otherwise outlive the run.
      if (sandboxUserName) killSandboxUserProcesses();
    } finally {
      // Must run even when the sweep fails closed, or the temporary submission copy leaks.
      await forceRemove(runDir);
    }
  }
}

function toPackageManagerCommandRunResult(context: {
  elapsedTimeSeconds: number;
  options: RunCommandInTemporaryPackageManagerProjectOptions;
  result: Awaited<ReturnType<typeof spawnWithInput>>;
}): PackageManagerCommandRunResult {
  return {
    stdin: context.options.stdin ?? '',
    stdout: context.result.stdout,
    stderr: context.result.stderr,
    status: context.result.timedOut || context.result.outputLimitExceeded ? 0 : context.result.status,
    timeSeconds: context.result.timedOut
      ? context.options.timeLimitSeconds + 1e-3
      : context.result.timeSeconds || context.elapsedTimeSeconds,
    memoryBytes: context.result.memoryBytes,
    timedOut: context.result.timedOut,
    signal: context.result.signal,
    outputLimitExceeded: context.result.outputLimitExceeded,
  };
}

function resolveInstallCommand(
  packageManager: PackageManager,
  runDir: string
): Promise<PackageManagerInstallCommand | undefined> {
  return packageManagerInstallCommandResolvers[packageManager](runDir);
}

function isFailedSpawnResult(result: Awaited<ReturnType<typeof spawnWithInput>>): boolean {
  return result.status !== 0 || result.timedOut || result.outputLimitExceeded;
}

async function resolveBunInstallCommand(runDir: string): Promise<PackageManagerInstallCommand | undefined> {
  if (!(await pathExists(path.join(runDir, 'package.json')))) return undefined;
  // Bun supports --silent and it keeps successful preparation output out of judge output buffers.
  return (await hasAnyPath(runDir, ['bun.lock', 'bun.lockb']))
    ? ['bun', 'install', '--frozen-lockfile', '--silent']
    : ['bun', 'install', '--silent'];
}

async function resolveCargoInstallCommand(runDir: string): Promise<PackageManagerInstallCommand | undefined> {
  if (!(await pathExists(path.join(runDir, 'Cargo.toml')))) return undefined;
  return (await pathExists(path.join(runDir, 'Cargo.lock'))) ? ['cargo', 'fetch', '--locked'] : ['cargo', 'fetch'];
}

async function resolveGoInstallCommand(runDir: string): Promise<PackageManagerInstallCommand | undefined> {
  if (!(await pathExists(path.join(runDir, 'go.mod')))) return undefined;
  return ['go', 'mod', 'download'];
}

async function resolveGradleInstallCommand(runDir: string): Promise<PackageManagerInstallCommand | undefined> {
  if (
    !(await hasAnyPath(runDir, [
      'build.gradle',
      'build.gradle.kts',
      'settings.gradle',
      'settings.gradle.kts',
      'gradlew',
      'gradlew.bat',
    ]))
  )
    return undefined;
  const args = ['--no-daemon', '--quiet', 'dependencies'] as const;
  if (process.platform === 'win32') {
    return (await pathExists(path.join(runDir, 'gradlew.bat')))
      ? ['cmd.exe', '/c', 'gradlew.bat', ...args]
      : ['gradle', ...args];
  }
  return (await pathExists(path.join(runDir, 'gradlew'))) ? ['sh', './gradlew', ...args] : ['gradle', ...args];
}

async function resolveMavenInstallCommand(runDir: string): Promise<PackageManagerInstallCommand | undefined> {
  if (!(await pathExists(path.join(runDir, 'pom.xml')))) return undefined;
  const args = ['-q', 'dependency:go-offline'] as const;
  if (process.platform === 'win32') {
    return (await pathExists(path.join(runDir, 'mvnw.cmd')))
      ? ['cmd.exe', '/c', 'mvnw.cmd', ...args]
      : ['mvn', ...args];
  }
  return (await pathExists(path.join(runDir, 'mvnw'))) ? ['sh', './mvnw', ...args] : ['mvn', ...args];
}

async function resolveNpmInstallCommand(runDir: string): Promise<PackageManagerInstallCommand | undefined> {
  if (!(await pathExists(path.join(runDir, 'package.json')))) return undefined;
  return (await pathExists(path.join(runDir, 'package-lock.json')))
    ? ['npm', 'ci', '--silent']
    : ['npm', 'install', '--silent'];
}

async function resolvePnpmInstallCommand(runDir: string): Promise<PackageManagerInstallCommand | undefined> {
  if (!(await pathExists(path.join(runDir, 'package.json')))) return undefined;
  return (await pathExists(path.join(runDir, 'pnpm-lock.yaml')))
    ? ['pnpm', 'install', '--frozen-lockfile', '--silent']
    : ['pnpm', 'install', '--silent'];
}

async function resolveRubyInstallCommand(runDir: string): Promise<PackageManagerInstallCommand | undefined> {
  if (!(await pathExists(path.join(runDir, 'Gemfile')))) return undefined;
  return (await pathExists(path.join(runDir, 'Gemfile.lock')))
    ? ['bundle', 'install', '--frozen', '--quiet']
    : ['bundle', 'install', '--quiet'];
}

async function resolveUvInstallCommand(): Promise<undefined> {
  return undefined;
}

async function resolveYarnInstallCommand(runDir: string): Promise<PackageManagerInstallCommand | undefined> {
  if (!(await pathExists(path.join(runDir, 'package.json')))) return undefined;
  const isBerry = await isYarnBerryProject(runDir);
  const hasLockfile = await pathExists(path.join(runDir, 'yarn.lock'));
  if (isBerry) return hasLockfile ? ['yarn', 'install', '--immutable'] : ['yarn', 'install'];
  return hasLockfile ? ['yarn', 'install', '--frozen-lockfile', '--silent'] : ['yarn', 'install', '--silent'];
}

async function isYarnBerryProject(runDir: string): Promise<boolean> {
  if (await pathExists(path.join(runDir, '.yarnrc.yml'))) return true;

  const packageJson = await readJson(path.join(runDir, 'package.json'));
  const packageManager = typeof packageJson.packageManager === 'string' ? packageJson.packageManager : undefined;
  const yarnMajorVersion = /^yarn@(\d+)/.exec(packageManager ?? '')?.[1];
  return yarnMajorVersion !== undefined && Number(yarnMajorVersion) >= 2;
}

async function hasAnyPath(directoryPath: string, relativePaths: readonly string[]): Promise<boolean> {
  for (const relativePath of relativePaths) {
    if (await pathExists(path.join(directoryPath, relativePath))) return true;
  }
  return false;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error ? (error as { code: unknown }).code : undefined;
    if (code !== 'ENOENT') throw error;
    return false;
  }
}

async function readJson(filePath: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch (error) {
    if (error instanceof SyntaxError) return {};
    const code =
      typeof error === 'object' && error !== null && 'code' in error ? (error as { code: unknown }).code : undefined;
    if (code === 'ENOENT') return {};
    throw error;
  }
}

export async function copyPackageManagerProjectFiles(options: {
  packageManager: PackageManager;
  projectDir: string;
  runDir: string;
  projectFilePaths?: readonly string[];
}): Promise<void> {
  for (const projectFilePath of options.projectFilePaths ?? packageManagerProjectFilePaths[options.packageManager]) {
    await copyPathIfExists(path.join(options.projectDir, projectFilePath), path.join(options.runDir, projectFilePath));
  }
}

async function copyPathIfExists(sourcePath: string, destinationPath: string): Promise<void> {
  try {
    // No-follow copy: the destination was seeded from the (sandbox-writable) submission tree, so a
    // planted symlink there must not redirect this trusted project-file overlay outside runDir.
    await copyWithoutFollowingSymlinks(sourcePath, destinationPath);
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error ? (error as { code: unknown }).code : undefined;
    if (code !== 'ENOENT') throw error;
  }
}

async function spawnWithInput(
  command: readonly [string, ...string[]],
  context: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    outputLimitBytes: number;
    stdin: string;
    timeLimitSeconds: number;
  }
): Promise<{
  stdout: string;
  stderr: string;
  status: number | undefined;
  timeSeconds: number;
  memoryBytes: number;
  timedOut: boolean;
  signal: NodeJS.Signals | undefined;
  outputLimitExceeded: boolean;
}> {
  const timeOutputPath = timeCommand === undefined ? undefined : path.join(context.cwd, '.exercode-time-result');
  // `wrapCommandWithSandboxUser` is idempotent, so a command the presets already wrapped is not
  // nested; `time` is then spliced INSIDE that wrapper so it runs as the sandbox user, never as the
  // harness user writing `--output` into this sandbox-writable directory.
  const wrappedCommand = wrapCommandWithSandboxUser(command);
  const spawnedCommand =
    timeCommand === undefined
      ? wrappedCommand
      : prependInsideSandboxWrapper(wrappedCommand, [...timeCommand, `--output=${timeOutputPath}`]);
  // Started BEFORE the submission: `killSubprocessGroup` cannot spawn its `sudo` once a submission
  // has exhausted the PID cgroup, and a submission spawned first could exhaust it before this
  // watchdog exists. It is the deadline of last resort on this path.
  const watchdog = startSandboxTimeoutWatchdog(context.timeLimitSeconds);
  const watchdogDeadlineAt = Date.now() + (Math.ceil(context.timeLimitSeconds) + SANDBOX_WATCHDOG_GRACE_SECONDS) * 1000;
  let subprocess: childProcess.ChildProcessWithoutNullStreams;
  try {
    subprocess = childProcess.spawn(spawnedCommand[0], spawnedCommand.slice(1), {
      cwd: context.cwd,
      detached: process.platform !== 'win32',
      env: { ...context.env, ...getSandboxUserEnvOverrides(context.env) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    watchdog.cancel();
    throw error;
  }

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let outputBytes = 0;
  let timedOut = false;
  let outputLimitExceeded = false;
  // Set when terminating the submission failed (the cleanup `sudo` could not be spawned). The run
  // then waits for the watchdog to end the submission rather than throwing out of an EventEmitter
  // callback, which would be an uncaught exception that kills the harness before any cleanup.
  let killError: Error | undefined;
  let onKillFailure: (() => void) | undefined;
  const killOrRecordFailure = (signal: NodeJS.Signals): void => {
    try {
      killSubprocessGroup(subprocess, signal);
    } catch (error) {
      killError ??= error instanceof Error ? error : new Error(String(error));
      onKillFailure?.();
    }
  };

  const appendOutputChunk = (chunks: Buffer[], chunk: Buffer): void => {
    if (outputBytes >= context.outputLimitBytes) {
      if (chunk.byteLength > 0) {
        outputLimitExceeded = true;
        killOrRecordFailure('SIGKILL');
      }
      return;
    }

    const remainingBytes = context.outputLimitBytes - outputBytes;
    const appendedChunk = chunk.byteLength > remainingBytes ? chunk.subarray(0, remainingBytes) : chunk;
    chunks.push(appendedChunk);
    outputBytes += appendedChunk.byteLength;

    if (chunk.byteLength > remainingBytes) {
      outputLimitExceeded = true;
      killOrRecordFailure('SIGKILL');
    }
  };

  subprocess.stdout.on('data', (chunk: Buffer) => appendOutputChunk(stdoutChunks, chunk));
  subprocess.stderr.on('data', (chunk: Buffer) => appendOutputChunk(stderrChunks, chunk));

  const timeout = setTimeout(() => {
    timedOut = true;
    killOrRecordFailure('SIGTERM');
  }, context.timeLimitSeconds * 1000);
  const killTimeout = setTimeout(
    () => {
      if (timedOut) killOrRecordFailure('SIGKILL');
    },
    context.timeLimitSeconds * 1000 + killGracePeriodMilliseconds
  );
  killTimeout.unref();
  // Bounds the wait after a kill failure: the watchdog force-kills the sandbox user at its own
  // deadline, so `close` should arrive; if even that fails, give up rather than hang.
  let killFailureTimeout: ReturnType<typeof setTimeout> | undefined;
  let closeObserved = false;

  const { status, signal } = await new Promise<{ status: number | undefined; signal: NodeJS.Signals | undefined }>(
    (resolve, reject) => {
      let settled = false;
      let pendingError: Error | undefined;
      const failAfterClose = (error: Error): void => {
        if (settled) return;
        pendingError = error;
        killOrRecordFailure('SIGKILL');
        if (subprocess.pid === undefined) {
          settled = true;
          reject(error);
        }
      };
      // Terminating the submission failed. Keep waiting: the watchdog (started before the
      // submission) force-kills the sandbox user at its own deadline, so `close` still arrives and
      // the run reports its real verdict. Give up only once that deadline has passed without the
      // submission ending, so the run can neither hang nor abandon a still-running submission
      // while its watchdog could still fire.
      onKillFailure = () => {
        killFailureTimeout ??= setTimeout(
          () => {
            if (settled) return;
            settled = true;
            reject(killError ?? new Error('failed to terminate the submission'));
          },
          Math.max(0, watchdogDeadlineAt - Date.now()) + watchdogSettleMarginMilliseconds
        );
      };
      subprocess.on('error', failAfterClose);
      subprocess.stdin.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EPIPE') failAfterClose(error);
      });
      subprocess.on('close', (code, closeSignal) => {
        if (settled) return;
        settled = true;
        // The submission ended, so the watchdog has nothing left to kill and must not outlive this
        // run. A kill that failed once but succeeded on retry (or was superseded by the watchdog)
        // is not an error: the timeout/output-limit verdict below is the correct one to report.
        closeObserved = true;
        if (pendingError) {
          reject(pendingError);
          return;
        }
        resolve({ status: code ?? undefined, signal: closeSignal ?? undefined });
      });
      subprocess.stdin.end(context.stdin);
    }
  ).finally(() => {
    clearTimeout(timeout);
    clearTimeout(killTimeout);
    if (killFailureTimeout) clearTimeout(killFailureTimeout);
    // Cancel unless the submission is still running after a failed kill: the watchdog is then the
    // only remaining mechanism able to stop it, and cancelling would leave it running unchecked.
    if (closeObserved || !killError) watchdog.cancel();
  });

  const { timeSeconds, memoryBytes } =
    timeOutputPath === undefined ? { timeSeconds: 0, memoryBytes: 0 } : await readTimeResult(timeOutputPath);

  return {
    stdout: Buffer.concat(stdoutChunks).toString(),
    stderr: Buffer.concat(stderrChunks).toString(),
    status,
    timeSeconds,
    memoryBytes,
    timedOut,
    signal,
    outputLimitExceeded,
  };
}

function resolveTimeCommand(): readonly [string, ...string[]] | undefined {
  const command = os.platform() === 'darwin' ? 'gtime' : '/usr/bin/time';
  const result = childProcess.spawnSync(command, ['--version'], { stdio: 'ignore' });
  if (result.error || result.status !== 0) return undefined;

  return [command, '--format', '%e %M'];
}

function killSubprocessGroup(subprocess: childProcess.ChildProcess, signal: NodeJS.Signals): void {
  if (subprocess.pid === undefined) return;

  // The current user cannot signal the root-owned sudo wrapper nor the sandbox user's processes,
  // so go through sudo with the requested signal only; the callers' existing timers provide the
  // TERM → grace → KILL escalation.
  // Throws when the cleanup `sudo` cannot even be spawned (a submission can exhaust the PID
  // cgroup). Only `killOrRecordFailure` may call this: it records the failure and lets the
  // watchdog (or, past its deadline, a bounded timer) settle the run instead of letting the throw
  // escape an EventEmitter callback.
  if (sandboxUserName) {
    killSandboxUserProcesses([signal === 'SIGKILL' ? 'KILL' : 'TERM']);
    return;
  }

  try {
    if (process.platform === 'win32') {
      subprocess.kill(signal);
      return;
    }
    process.kill(-subprocess.pid, signal);
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error ? (error as { code: unknown }).code : undefined;
    if (code !== 'ESRCH' && code !== 'EPERM') throw error;
  }
}

async function readTimeResult(timeOutputPath: string): Promise<{ timeSeconds: number; memoryBytes: number }> {
  // The submission owns this directory and can put anything at this path, so decide what was
  // opened from the handle itself rather than from a prior `lstat` it could race:
  // - `O_NOFOLLOW` refuses a symlink to a harness-readable file (e.g. the problem's expected
  //   outputs), which would otherwise report that file's trailing numbers as the submission's own
  //   time and memory usage;
  // - `O_NONBLOCK` keeps a planted FIFO from blocking the harness forever waiting for a writer;
  // - the `fstat` then rejects anything that is not a regular file.
  let content: string;
  let fileHandle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    fileHandle = await fs.open(
      timeOutputPath,
      nodeFs.constants.O_RDONLY | nodeFs.constants.O_NOFOLLOW | nodeFs.constants.O_NONBLOCK
    );
    const stats = await fileHandle.stat();
    if (!stats.isFile()) return { timeSeconds: 0, memoryBytes: 0 };
    content = await fileHandle.readFile('utf8');
  } catch {
    // Whatever the submission swapped in, there is no measurement to report.
    return { timeSeconds: 0, memoryBytes: 0 };
  } finally {
    await fileHandle?.close();
  }

  const match = /(\d+(?:[.,]\d+)?) (\d+)\s*$/.exec(content);
  if (!match) return { timeSeconds: 0, memoryBytes: 0 };

  return { timeSeconds: Number(match[1]!.replace(',', '.')), memoryBytes: Number(match[2]) * 1024 };
}
