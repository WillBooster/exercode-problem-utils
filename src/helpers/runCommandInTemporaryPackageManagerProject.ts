import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export type PackageManager = 'bun' | 'cargo' | 'go' | 'gradle' | 'maven' | 'npm' | 'pnpm' | 'ruby' | 'uv' | 'yarn';

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

const defaultOutputLimitBytes = 50 * 1024 * 1024;
const killGracePeriodMilliseconds = 1000;

/**
 * Copies a submission directory to a temporary directory, overlays package
 * manager project files from the problem directory, runs a command, and then
 * removes the temporary directory.
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

    const command = typeof options.command === 'function' ? options.command({ runDir }) : options.command;
    const startedAt = Date.now();
    const result = await spawnWithInput(command, {
      cwd: runDir,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      outputLimitBytes: options.outputLimitBytes ?? defaultOutputLimitBytes,
      stdin: options.stdin ?? '',
      timeLimitSeconds: options.timeLimitSeconds,
    });
    const elapsedTimeSeconds = (Date.now() - startedAt) / 1000;

    return {
      stdin: options.stdin ?? '',
      stdout: result.stdout,
      stderr: result.stderr,
      status: result.timedOut || result.outputLimitExceeded ? 0 : result.status,
      timeSeconds: result.timedOut ? options.timeLimitSeconds + 1e-3 : elapsedTimeSeconds,
      memoryBytes: 0,
      timedOut: result.timedOut,
      signal: result.signal,
      outputLimitExceeded: result.outputLimitExceeded,
    };
  } finally {
    await fs.rm(runDir, { force: true, recursive: true });
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
  timedOut: boolean;
  signal: NodeJS.Signals | undefined;
  outputLimitExceeded: boolean;
}> {
  const subprocess = childProcess.spawn(command[0], command.slice(1), {
    cwd: context.cwd,
    env: context.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let outputBytes = 0;
  let timedOut = false;
  let outputLimitExceeded = false;

  const appendOutputChunk = (chunks: Buffer[], chunk: Buffer): void => {
    if (outputBytes >= context.outputLimitBytes) return;

    const remainingBytes = context.outputLimitBytes - outputBytes;
    const appendedChunk = chunk.byteLength > remainingBytes ? chunk.subarray(0, remainingBytes) : chunk;
    chunks.push(appendedChunk);
    outputBytes += appendedChunk.byteLength;

    if (chunk.byteLength > remainingBytes || outputBytes >= context.outputLimitBytes) {
      outputLimitExceeded = true;
      subprocess.kill('SIGKILL');
    }
  };

  subprocess.stdout.on('data', (chunk: Buffer) => appendOutputChunk(stdoutChunks, chunk));
  subprocess.stderr.on('data', (chunk: Buffer) => appendOutputChunk(stderrChunks, chunk));

  const timeout = setTimeout(() => {
    timedOut = true;
    subprocess.kill('SIGTERM');
  }, context.timeLimitSeconds * 1000);
  const killTimeout = setTimeout(
    () => {
      if (timedOut) subprocess.kill('SIGKILL');
    },
    context.timeLimitSeconds * 1000 + killGracePeriodMilliseconds
  );
  killTimeout.unref();

  const { status, signal } = await new Promise<{ status: number | undefined; signal: NodeJS.Signals | undefined }>(
    (resolve, reject) => {
      let settled = false;
      const rejectOnce = (error: Error): void => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      subprocess.on('error', rejectOnce);
      subprocess.stdin.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EPIPE') rejectOnce(error);
      });
      subprocess.on('close', (code, closeSignal) => {
        if (settled) return;
        settled = true;
        resolve({ status: code ?? undefined, signal: closeSignal ?? undefined });
      });
      subprocess.stdin.end(context.stdin);
    }
  ).finally(() => {
    clearTimeout(timeout);
    clearTimeout(killTimeout);
  });

  return {
    stdout: Buffer.concat(stdoutChunks).toString(),
    stderr: Buffer.concat(stderrChunks).toString(),
    status,
    timedOut,
    signal,
    outputLimitExceeded,
  };
}
