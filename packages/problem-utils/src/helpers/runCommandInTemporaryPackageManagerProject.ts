import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { spawnWithLimits, type SpawnWithLimitsResult } from './spawnWithLimits.js';
import { forciblyRemoveDirectory } from './temporaryProblemDirCopy.js';

export type PackageManager = 'bun' | 'cargo' | 'go' | 'gradle' | 'maven' | 'npm' | 'pnpm' | 'ruby' | 'uv' | 'yarn';
type PackageManagerInstallCommand = readonly [string, ...string[]];

export interface PackageManagerCommandRunResult {
  stdin: string;
  stdout: string;
  stderr: string;
  status: number | undefined;
  timeSeconds: number;
  /** See `SpawnWithLimitsResult.cpuTimeSeconds`; the install's CPU time counts too. */
  cpuTimeSeconds: number;
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
  /**
   * Set to false when `command` prepares the dependencies it needs.
   * Defaults to true.
   */
  prepareDependencies?: boolean;
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
    const installCommand =
      options.prepareDependencies === false ? undefined : await resolveInstallCommand(options.packageManager, runDir);
    const command = typeof options.command === 'function' ? options.command({ runDir }) : options.command;
    const outputLimitBytes = options.outputLimitBytes ?? defaultOutputLimitBytes;
    let installResult: SpawnWithLimitsResult | undefined;

    if (installCommand) {
      installResult = await spawnWithLimits(installCommand, {
        cwd: runDir,
        env,
        outputLimitBytes,
        stdin: '',
        timeLimitSeconds: options.timeLimitSeconds,
      });
      if (isFailedSpawnResult(installResult)) {
        return toPackageManagerCommandRunResult({
          options,
          result: installResult,
        });
      }
    }

    // The install's measured time excludes the grace spent releasing pipes after it exited.
    const remainingTimeLimitSeconds = options.timeLimitSeconds - (installResult?.timeSeconds ?? 0);
    if (remainingTimeLimitSeconds <= 0) {
      return {
        stdin: options.stdin ?? '',
        stdout: installResult?.stdout ?? '',
        stderr: installResult?.stderr ?? '',
        status: 0,
        timeSeconds: options.timeLimitSeconds + 1e-3,
        cpuTimeSeconds: installResult?.cpuTimeSeconds ?? 0,
        memoryBytes: installResult?.memoryBytes ?? 0,
        timedOut: true,
        signal: installResult?.signal,
        outputLimitExceeded: false,
      };
    }

    const result = await spawnWithLimits(command, {
      cwd: runDir,
      env,
      outputLimitBytes,
      stdin: options.stdin ?? '',
      timeLimitSeconds: remainingTimeLimitSeconds,
    });

    if (installResult) {
      return toPackageManagerCommandRunResult({
        options,
        result: {
          ...result,
          timeSeconds: installResult.timeSeconds + result.timeSeconds,
          cpuTimeSeconds: installResult.cpuTimeSeconds + result.cpuTimeSeconds,
          memoryBytes: Math.max(installResult.memoryBytes, result.memoryBytes),
        },
      });
    }

    return toPackageManagerCommandRunResult({ options, result });
  } finally {
    // The command may have left permission-locked entries (e.g. a mode-000 directory).
    await forciblyRemoveDirectory(runDir);
  }
}

function toPackageManagerCommandRunResult(context: {
  options: RunCommandInTemporaryPackageManagerProjectOptions;
  result: SpawnWithLimitsResult;
}): PackageManagerCommandRunResult {
  return {
    stdin: context.options.stdin ?? '',
    stdout: context.result.stdout,
    stderr: context.result.stderr,
    status: context.result.timedOut || context.result.outputLimitExceeded ? 0 : context.result.status,
    timeSeconds: context.result.timedOut ? context.options.timeLimitSeconds + 1e-3 : context.result.timeSeconds,
    cpuTimeSeconds: context.result.cpuTimeSeconds,
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

function isFailedSpawnResult(result: SpawnWithLimitsResult): boolean {
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
    // Before touching the destination: creating the parent levels must not happen for a project
    // file the problem does not even ship.
    await fs.lstat(sourcePath);
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.cp(sourcePath, destinationPath, { force: true, recursive: true });
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error ? (error as { code: unknown }).code : undefined;
    if (code !== 'ENOENT') throw error;
  }
}
