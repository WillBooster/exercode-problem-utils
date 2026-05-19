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
}

export interface RunCommandInTemporaryPackageManagerProjectOptions {
  cwd: string;
  projectDir: string;
  packageManager: PackageManager;
  command: readonly [string, ...string[]] | ((context: { runDir: string }) => readonly [string, ...string[]]);
  stdin?: string;
  env?: NodeJS.ProcessEnv;
  timeLimitSeconds: number;
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

/**
 * Copies a submission directory to a temporary directory, overlays package
 * manager project files from the problem directory, runs a command, and then
 * removes the temporary directory.
 */
export async function runCommandInTemporaryPackageManagerProject(
  options: RunCommandInTemporaryPackageManagerProjectOptions
): Promise<PackageManagerCommandRunResult> {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), options.tempDirPrefix ?? 'exercode-'));
  const startedAt = Date.now();
  try {
    await fs.cp(options.cwd, runDir, { recursive: true });
    await copyPackageManagerProjectFiles({
      packageManager: options.packageManager,
      projectDir: options.projectDir,
      runDir,
      projectFilePaths: options.projectFilePaths,
    });

    const command = typeof options.command === 'function' ? options.command({ runDir }) : options.command;
    const result = await spawnWithInput(command, {
      cwd: runDir,
      env: options.env ?? process.env,
      stdin: options.stdin ?? '',
      timeLimitSeconds: options.timeLimitSeconds,
    });

    return {
      stdin: options.stdin ?? '',
      stdout: result.stdout,
      stderr: result.stderr,
      status: result.status,
      timeSeconds: Math.min((Date.now() - startedAt) / 1000, options.timeLimitSeconds),
      memoryBytes: 0,
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
    stdin: string;
    timeLimitSeconds: number;
  }
): Promise<{ stdout: string; stderr: string; status: number | undefined }> {
  const subprocess = childProcess.spawn(command[0], command.slice(1), {
    cwd: context.cwd,
    env: context.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  subprocess.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
  subprocess.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

  const timeout = setTimeout(() => subprocess.kill(), context.timeLimitSeconds * 1000);
  subprocess.stdin.end(context.stdin);

  const status = await new Promise<number | undefined>((resolve, reject) => {
    subprocess.on('error', reject);
    subprocess.on('close', (code) => resolve(code ?? undefined));
  });
  clearTimeout(timeout);

  return {
    stdout: Buffer.concat(stdoutChunks).toString(),
    stderr: Buffer.concat(stderrChunks).toString(),
    status,
  };
}
