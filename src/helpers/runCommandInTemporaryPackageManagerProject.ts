import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

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
    'gradle',
    'gradlew',
    'gradlew.bat',
  ],
  maven: ['pom.xml', '.mvn', 'mvnw', 'mvnw.cmd'],
  npm: ['package.json', 'package-lock.json'],
  pnpm: ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'],
  ruby: ['Gemfile', 'Gemfile.lock', '.ruby-version'],
  uv: ['pyproject.toml', 'uv.lock'],
  yarn: ['package.json', 'yarn.lock', '.yarnrc.yml', '.yarn'],
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
const timeCommand = resolveTimeCommand();

/**
 * Copies a submission directory to a temporary directory, overlays package
 * manager project files from the problem directory, prepares dependencies,
 * runs a command, and then removes the temporary directory.
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
    await fs.rm(runDir, { force: true, recursive: true });
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
    ]))
  )
    return undefined;
  return (await pathExists(path.join(runDir, 'gradlew')))
    ? ['sh', './gradlew', '--no-daemon', '--quiet', 'dependencies']
    : ['gradle', '--no-daemon', '--quiet', 'dependencies'];
}

async function resolveMavenInstallCommand(runDir: string): Promise<PackageManagerInstallCommand | undefined> {
  if (!(await pathExists(path.join(runDir, 'pom.xml')))) return undefined;
  return (await pathExists(path.join(runDir, 'mvnw')))
    ? ['sh', './mvnw', '-q', 'dependency:go-offline']
    : ['mvn', '-q', 'dependency:go-offline'];
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
    ? ['pnpm', 'install', '--frozen-lockfile']
    : ['pnpm', 'install'];
}

async function resolveRubyInstallCommand(runDir: string): Promise<PackageManagerInstallCommand | undefined> {
  if (!(await pathExists(path.join(runDir, 'Gemfile')))) return undefined;
  return ['bundle', 'install', '--quiet'];
}

async function resolveUvInstallCommand(): Promise<undefined> {
  return undefined;
}

async function resolveYarnInstallCommand(runDir: string): Promise<PackageManagerInstallCommand | undefined> {
  if (!(await pathExists(path.join(runDir, 'package.json')))) return undefined;
  if ((await pathExists(path.join(runDir, 'yarn.lock'))) && (await hasAnyPath(runDir, ['.yarnrc.yml', '.yarn'])))
    return ['yarn', 'install', '--immutable'];
  return ['yarn', 'install', '--silent'];
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
    await fs.cp(sourcePath, destinationPath, { recursive: true });
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
  const spawnedCommand =
    timeCommand === undefined ? command : ([...timeCommand, `--output=${timeOutputPath}`, ...command] as const);
  const subprocess = childProcess.spawn(spawnedCommand[0], spawnedCommand.slice(1), {
    cwd: context.cwd,
    detached: process.platform !== 'win32',
    env: context.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let outputBytes = 0;
  let timedOut = false;
  let outputLimitExceeded = false;

  const appendOutputChunk = (chunks: Buffer[], chunk: Buffer): void => {
    if (outputBytes >= context.outputLimitBytes) {
      if (chunk.byteLength > 0) {
        outputLimitExceeded = true;
        killSubprocessGroup(subprocess, 'SIGKILL');
      }
      return;
    }

    const remainingBytes = context.outputLimitBytes - outputBytes;
    const appendedChunk = chunk.byteLength > remainingBytes ? chunk.subarray(0, remainingBytes) : chunk;
    chunks.push(appendedChunk);
    outputBytes += appendedChunk.byteLength;

    if (chunk.byteLength > remainingBytes) {
      outputLimitExceeded = true;
      killSubprocessGroup(subprocess, 'SIGKILL');
    }
  };

  subprocess.stdout.on('data', (chunk: Buffer) => appendOutputChunk(stdoutChunks, chunk));
  subprocess.stderr.on('data', (chunk: Buffer) => appendOutputChunk(stderrChunks, chunk));

  const timeout = setTimeout(() => {
    timedOut = true;
    killSubprocessGroup(subprocess, 'SIGTERM');
  }, context.timeLimitSeconds * 1000);
  const killTimeout = setTimeout(
    () => {
      if (timedOut) killSubprocessGroup(subprocess, 'SIGKILL');
    },
    context.timeLimitSeconds * 1000 + killGracePeriodMilliseconds
  );
  killTimeout.unref();

  const { status, signal } = await new Promise<{ status: number | undefined; signal: NodeJS.Signals | undefined }>(
    (resolve, reject) => {
      let settled = false;
      let pendingError: Error | undefined;
      const failAfterClose = (error: Error): void => {
        if (settled) return;
        pendingError = error;
        killSubprocessGroup(subprocess, 'SIGKILL');
        if (subprocess.pid === undefined) {
          settled = true;
          reject(error);
        }
      };
      subprocess.on('error', failAfterClose);
      subprocess.stdin.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EPIPE') failAfterClose(error);
      });
      subprocess.on('close', (code, closeSignal) => {
        if (settled) return;
        settled = true;
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
  let content: string;
  try {
    content = await fs.readFile(timeOutputPath, 'utf8');
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error ? (error as { code: unknown }).code : undefined;
    if (code !== 'ENOENT') throw error;
    return { timeSeconds: 0, memoryBytes: 0 };
  }

  const match = /(\d+(?:[.,]\d+)?) (\d+)\s*$/.exec(content);
  if (!match) return { timeSeconds: 0, memoryBytes: 0 };

  return { timeSeconds: Number(match[1]!.replace(',', '.')), memoryBytes: Number(match[2]) * 1024 };
}
