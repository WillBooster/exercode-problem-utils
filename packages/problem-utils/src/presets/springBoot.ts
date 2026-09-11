import {
  MAX_OUTPUT_LENGTH,
  resolveJavaRelativePath,
  listSubmissionFiles,
  readOutputFiles,
  truncateOutput,
} from '../helpers/javaJudge.js';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { DecisionCode, parseArgs, printTestCaseResult, type TestCaseResult } from '../index.js';
export interface SpringBootJudgePresetOptions {
  problemDirectoryPath: string;
  evaluate: () => Promise<void>;
}
type JudgeResult = Omit<TestCaseResult, 'testCaseId'>;
const APPLICATION_NAME = 'judge';

const SERVER_PORT = 59_000;

const SERVER_BASE_URL = `http://localhost:${SERVER_PORT}`;

const BUILD_TIMEOUT_MS = 90_000;

const STARTUP_TIMEOUT_MS = 60_000;

const EVALUATE_TIMEOUT_MS = 60_000;

export async function springBootJudgePreset(options: SpringBootJudgePresetOptions): Promise<void> {
  if (process.argv.includes('--evaluate')) {
    try {
      await options.evaluate();
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
    return;
  }

  const { cwd: submissionDir } = parseArgs(process.argv);
  if (!submissionDir) throw new Error('cwd argument required');
  const testCaseId = 'test1';
  const runRootDir = await fs.promises.mkdtemp(path.join(tmpdir(), 'spring_judge_'));
  const buildDir = path.join(runRootDir, 'build');
  let springBootProcess: ChildProcess | undefined;

  try {
    await prepareBuildDirectory(buildDir, submissionDir, options.problemDirectoryPath);

    const buildResult = buildWithMaven(buildDir);
    if (buildResult) {
      printTestCaseResult({ testCaseId, ...buildResult });
      return;
    }

    const jarPath = path.join(buildDir, 'target', `${APPLICATION_NAME}.jar`);
    const startResult = await startSpringBootApplication(buildDir, jarPath);
    springBootProcess = startResult.childProcess;
    if (startResult.failure) {
      printTestCaseResult({ testCaseId, ...startResult.failure });
      return;
    }

    const judgeResult = runJudgeScript(buildDir, options.problemDirectoryPath);
    printTestCaseResult({ testCaseId, ...judgeResult });
  } catch (error) {
    printTestCaseResult({
      testCaseId,
      decisionCode: DecisionCode.JUDGE_NOT_AVAILABLE,
      stderr: error instanceof Error ? error.message : String(error),
    });
  } finally {
    await stopSpringBootApplication(springBootProcess);
    await fs.promises.rm(runRootDir, { recursive: true, force: true });
  }
}

async function prepareBuildDirectory(
  buildDir: string,
  submissionDir: string,
  problemDirectoryPath: string
): Promise<void> {
  await fs.promises.mkdir(path.join(buildDir, 'src/main/java'), { recursive: true });
  await fs.promises.mkdir(path.join(buildDir, 'src/main/resources'), { recursive: true });
  await fs.promises.copyFile(path.join(problemDirectoryPath, 'pom.xml'), path.join(buildDir, 'pom.xml'));
  await fs.promises.writeFile(
    path.join(buildDir, 'src/main/resources/application.properties'),
    createApplicationProperties()
  );

  for (const relativePath of await listSubmissionFiles(submissionDir)) {
    const sourcePath = path.join(submissionDir, relativePath);
    const targetPath = await resolveTargetPath(buildDir, relativePath, sourcePath);
    await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.promises.copyFile(sourcePath, targetPath);
  }
}

function createApplicationProperties(): string {
  return `spring.application.name=${APPLICATION_NAME}
server.port=${SERVER_PORT}
spring.main.banner-mode=off
logging.level.org.springframework=ERROR
logging.level.org.apache=ERROR
spring.main.log-startup-info=false
`;
}

async function resolveTargetPath(buildDir: string, relativePath: string, sourcePath: string): Promise<string> {
  const normalizedRelativePath = relativePath.replaceAll('\\', '/');
  if (normalizedRelativePath.startsWith('src/main/')) {
    return path.join(buildDir, normalizedRelativePath);
  }
  if (path.extname(relativePath).toLowerCase() === '.java') {
    return path.join(buildDir, 'src/main/java', await resolveJavaRelativePath(sourcePath, relativePath));
  }

  return path.join(buildDir, 'src/main/resources', normalizedRelativePath);
}

function buildWithMaven(buildDir: string): JudgeResult | undefined {
  const startedAt = Date.now();
  const result = spawnSync('mvn', ['clean', 'package', '--quiet', '--batch-mode', '--offline', '-DskipTests'], {
    cwd: buildDir,
    encoding: 'utf8',
    env: { ...process.env, CI: '', FORCE_COLOR: '0' },
    timeout: BUILD_TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT_LENGTH * 4,
  });
  const timeSeconds = (Date.now() - startedAt) / 1000;
  const stdout = truncateOutput(result.stdout ?? '');
  const stderr = truncateOutput(result.stderr ?? '');

  if (isTimeoutError(result.error)) {
    return { decisionCode: DecisionCode.BUILD_TIME_LIMIT_EXCEEDED, stderr, stdout, timeSeconds };
  }
  if ((result.status ?? 0) === 0) {
    return undefined;
  }

  return {
    decisionCode: DecisionCode.BUILD_ERROR,
    exitStatus: result.status ?? undefined,
    stderr: truncateOutput(extractMavenErrors(stdout) || stderr),
    stdout,
    timeSeconds,
  };
}

function extractMavenErrors(output: string): string {
  const plainOutput = output.replaceAll(/\[\d*(?:;\d+)*m/gu, '');
  const errorMessages = new Set<string>();
  for (const match of plainOutput.matchAll(/\].*?\[\d+,\d+\]\s+(.*?)$/gmu)) {
    const message = match[1]!.trim();
    if (message) {
      errorMessages.add(message);
    }
  }
  return errorMessages.size > 0 ? `ビルドエラー:\n${[...errorMessages].join('\n')}` : '';
}

async function startSpringBootApplication(
  buildDir: string,
  jarPath: string
): Promise<{ childProcess: ChildProcess; failure?: JudgeResult }> {
  const startedAt = Date.now();
  const childProcess = spawn('java', ['-jar', jarPath], {
    cwd: buildDir,
    env: { ...process.env, SPRING_MAIN_WEB_APPLICATION_TYPE: 'servlet' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let applicationStdout = '';
  let applicationStderr = '';
  childProcess.stdout?.on('data', (chunk: Buffer) => {
    applicationStdout = truncateOutput(applicationStdout + chunk.toString('utf8'));
  });
  childProcess.stderr?.on('data', (chunk: Buffer) => {
    applicationStderr = truncateOutput(applicationStderr + chunk.toString('utf8'));
  });
  let hasExited = false;
  childProcess.on('exit', () => {
    hasExited = true;
  });

  while (Date.now() - startedAt < STARTUP_TIMEOUT_MS) {
    if (await isServerResponding()) {
      return { childProcess };
    }
    if (hasExited) {
      break;
    }
    await sleep(200);
  }

  const timeSeconds = (Date.now() - startedAt) / 1000;
  const feedbackMarkdown = hasExited
    ? 'アプリケーションの起動に失敗しました。コンソールのエラーメッセージを確認してください。'
    : `アプリケーションが ${STARTUP_TIMEOUT_MS / 1000} 秒以内に起動しませんでした。`;
  return {
    childProcess,
    failure: {
      decisionCode: hasExited ? DecisionCode.RUNTIME_ERROR : DecisionCode.TIME_LIMIT_EXCEEDED,
      exitStatus: childProcess.exitCode ?? undefined,
      feedbackMarkdown,
      stderr: applicationStderr || undefined,
      stdout: applicationStdout || undefined,
      timeSeconds,
    },
  };
}

async function isServerResponding(): Promise<boolean> {
  try {
    // Spring Boot answers 404 for an unmapped path, which already proves the port is serving.
    const response = await fetch(SERVER_BASE_URL, { signal: AbortSignal.timeout(1000) });
    await response.body?.cancel();
    return response.ok || response.status === 404;
  } catch {
    return false;
  }
}

async function stopSpringBootApplication(childProcess: ChildProcess | undefined): Promise<void> {
  if (!childProcess || childProcess.exitCode !== null) {
    return;
  }

  childProcess.kill('SIGTERM');
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5000 && childProcess.exitCode === null) {
    await sleep(100);
  }
  if (childProcess.exitCode === null) {
    childProcess.kill('SIGKILL');
  }
}

function runJudgeScript(buildDir: string, problemDirectoryPath: string): JudgeResult {
  const startedAt = Date.now();
  const result = spawnSync('bun', ['run', './judge.ts', '--evaluate'], {
    cwd: problemDirectoryPath,
    encoding: 'utf8',
    env: { ...process.env, WORKING_DIRECTORY_PATH: buildDir },
    timeout: EVALUATE_TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT_LENGTH * 4,
  });
  const timeSeconds = (Date.now() - startedAt) / 1000;
  const stdout = truncateOutput(result.stdout ?? '');
  const stderr = truncateOutput(result.stderr ?? '');
  const outputFiles = readOutputFiles(path.join(buildDir, '__SCREENSHOTS.json'));

  if (isTimeoutError(result.error)) {
    return { decisionCode: DecisionCode.TIME_LIMIT_EXCEEDED, stderr, stdout, timeSeconds, outputFiles };
  }
  if ((result.status ?? 0) !== 0) {
    return {
      decisionCode: DecisionCode.WRONG_ANSWER,
      exitStatus: result.status ?? undefined,
      stderr,
      stdout,
      timeSeconds,
      outputFiles,
    };
  }

  return {
    decisionCode: DecisionCode.ACCEPTED,
    exitStatus: result.status ?? undefined,
    stderr: stderr || undefined,
    stdout: stdout || undefined,
    timeSeconds,
    outputFiles,
  };
}

function isTimeoutError(error: Error | undefined): boolean {
  return !!error && 'code' in error && error.code === 'ETIMEDOUT';
}
