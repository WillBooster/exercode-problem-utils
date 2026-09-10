import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { DecisionCode, parseArgs, printTestCaseResult, type TestCaseResult } from '../index.js';
import { z } from 'zod';

export interface TomcatJudgePresetOptions {
  problemDirectoryPath: string;
  jspDirectory: '' | 'WEB-INF/jsp';
  forbiddenTexts?: readonly string[];
  evaluate: () => Promise<void>;
}

type JudgeResult = Omit<TestCaseResult, 'testCaseId'>;
type OutputFile = NonNullable<TestCaseResult['outputFiles']>[number];
interface CommandResult {
  status: number | undefined;
  stdout: string;
  stderr: string;
  timeSeconds: number;
  memoryBytes: number;
}
const APPLICATION_NAME = 'judge';
const BUILD_TIMEOUT_SECONDS = 60;
const EVALUATE_TIMEOUT_SECONDS = 30;
const MAX_OUTPUT_LENGTH = 50_000;
const TOMCAT_BASE_URL = 'http://localhost:59000';
const SOURCE_FILE_EXTENSIONS = new Set(['.java', '.jsp', '.html', '.htm', '.xml', '.js', '.css']);

export async function tomcatJudgePreset(options: TomcatJudgePresetOptions): Promise<void> {
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
  const staticAnalysisResult = await judgeByStaticAnalysis(submissionDir, options.forbiddenTexts ?? []);
  if (staticAnalysisResult) {
    printTestCaseResult({ testCaseId, ...staticAnalysisResult });
    return;
  }

  const runRootDir = await fs.promises.mkdtemp(path.join(tmpdir(), 'tomcat_judge_'));
  const buildDir = path.join(runRootDir, 'build');
  let catalinaBaseDir: string | undefined;
  let catalinaHome: string | undefined;

  try {
    await fs.promises.mkdir(buildDir, { recursive: true });
    await prepareBuildDirectory(buildDir, submissionDir, options);

    const buildResult = buildWithMaven(buildDir);
    if (buildResult) {
      printTestCaseResult({ testCaseId, ...buildResult });
      return;
    }

    catalinaHome = getCatalinaHome();
    catalinaBaseDir = await createCatalinaBaseDir(catalinaHome, runRootDir);
    await ensureTomcatStopped(catalinaHome, catalinaBaseDir);
    await deployWarFile(buildDir, catalinaBaseDir);
    await startTomcat(catalinaHome, catalinaBaseDir);

    const judgeResult = runJudgeScript(buildDir, options.problemDirectoryPath);
    printTestCaseResult({ testCaseId, ...judgeResult });
  } catch (error) {
    printTestCaseResult({
      testCaseId,
      decisionCode: DecisionCode.JUDGE_NOT_AVAILABLE,
      stderr: error instanceof Error ? error.message : String(error),
    });
  } finally {
    try {
      if (catalinaHome && catalinaBaseDir) {
        await ensureTomcatStopped(catalinaHome, catalinaBaseDir);
      }
    } catch {
      // 判定結果を優先し、後始末の失敗は握りつぶす。
    }
    await fs.promises.rm(runRootDir, { recursive: true, force: true });
  }
}

async function prepareBuildDirectory(
  buildDir: string,
  submissionDir: string,
  options: TomcatJudgePresetOptions
): Promise<void> {
  await fs.promises.mkdir(path.join(buildDir, 'src/main/java'), { recursive: true });
  await fs.promises.mkdir(path.join(buildDir, 'src/main/webapp/WEB-INF/jsp'), { recursive: true });
  await fs.promises.copyFile(path.join(options.problemDirectoryPath, 'pom.xml'), path.join(buildDir, 'pom.xml'));

  const submissionFiles = await listSubmissionFiles(submissionDir);
  for (const relativePath of submissionFiles) {
    const sourcePath = path.join(submissionDir, relativePath);
    const targetPath = await resolveTargetPath(buildDir, relativePath, sourcePath, options.jspDirectory);
    await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.promises.copyFile(sourcePath, targetPath);
  }
}

async function resolveTargetPath(
  buildDir: string,
  relativePath: string,
  sourcePath: string,
  jspDirectory: string
): Promise<string> {
  const normalizedRelativePath = relativePath.replaceAll('\\', '/');
  if (normalizedRelativePath.startsWith('src/main/')) {
    return path.join(buildDir, normalizedRelativePath);
  }
  if (normalizedRelativePath.startsWith('WEB-INF/') || normalizedRelativePath.startsWith('META-INF/')) {
    return path.join(buildDir, 'src/main/webapp', normalizedRelativePath);
  }

  const extension = path.extname(relativePath).toLowerCase();
  if (extension === '.java') {
    return path.join(buildDir, 'src/main/java', await resolveJavaRelativePath(sourcePath, relativePath));
  }
  if (extension === '.jsp') {
    return path.join(buildDir, 'src/main/webapp', jspDirectory, path.basename(relativePath));
  }

  return path.join(buildDir, 'src/main/webapp', normalizedRelativePath);
}

async function resolveJavaRelativePath(sourcePath: string, fallbackRelativePath: string): Promise<string> {
  const sourceCode = await fs.promises.readFile(sourcePath, 'utf8');
  const packageMatch = /^\s*package\s+([a-zA-Z0-9_.]+)\s*;/m.exec(sourceCode);
  if (!packageMatch?.[1]) {
    return fallbackRelativePath;
  }

  return path.join(packageMatch[1].replaceAll('.', '/'), path.basename(fallbackRelativePath));
}

async function judgeByStaticAnalysis(
  submissionDir: string,
  forbiddenTexts: readonly string[]
): Promise<Pick<JudgeResult, 'decisionCode' | 'feedbackMarkdown'> | undefined> {
  const forbiddenMatches: { path: string; pattern: string }[] = [];
  for (const relativePath of await listSubmissionFiles(submissionDir)) {
    if (!SOURCE_FILE_EXTENSIONS.has(path.extname(relativePath).toLowerCase())) {
      continue;
    }

    const sourceCode = await fs.promises.readFile(path.join(submissionDir, relativePath), 'utf8');
    for (const forbiddenText of forbiddenTexts) {
      if (sourceCode.includes(forbiddenText)) {
        forbiddenMatches.push({ path: relativePath, pattern: forbiddenText });
      }
    }
  }

  if (forbiddenMatches.length === 0) {
    return undefined;
  }

  return {
    decisionCode: DecisionCode.FORBIDDEN_PATTERNS_IN_CODE_ERROR,
    feedbackMarkdown:
      'ソースコード中に禁止された文字列が含まれています。\nソースコードを修正してから再度提出してください。\n\n| ファイル | 禁止パターン |\n| -------- | ------------ |\n' +
      forbiddenMatches.map((match) => `| \`${match.path}\` | \`${match.pattern}\` |`).join('\n'),
  };
}

async function listSubmissionFiles(rootDir: string): Promise<string[]> {
  const filePaths: string[] = [];
  await collectSubmissionFiles(rootDir, '', filePaths);
  return filePaths.toSorted();
}

async function collectSubmissionFiles(rootDir: string, relativeDir: string, filePaths: string[]): Promise<void> {
  const currentDir = relativeDir ? path.join(rootDir, relativeDir) : rootDir;
  const entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    const entryRelativePath = relativeDir ? path.join(relativeDir, entry.name) : entry.name;
    if (entry.isDirectory()) {
      await collectSubmissionFiles(rootDir, entryRelativePath, filePaths);
      continue;
    }
    if (entry.isFile()) {
      filePaths.push(entryRelativePath);
    }
  }
}

function buildWithMaven(buildDir: string): JudgeResult | undefined {
  const commandResult = runCommand(
    ['mvn', 'clean', 'package', '--quiet', '--batch-mode', '--offline'],
    buildDir,
    BUILD_TIMEOUT_SECONDS
  );
  if (commandResult.timeSeconds > BUILD_TIMEOUT_SECONDS) {
    return {
      decisionCode: DecisionCode.BUILD_TIME_LIMIT_EXCEEDED,
      stderr: truncateOutput(commandResult.stderr),
      stdout: truncateOutput(commandResult.stdout),
      exitStatus: commandResult.status,
      timeSeconds: commandResult.timeSeconds,
      memoryBytes: commandResult.memoryBytes,
    };
  }
  if (commandResult.status === 0) {
    return undefined;
  }

  return {
    decisionCode: DecisionCode.BUILD_ERROR,
    stderr: formatMavenBuildError(commandResult.stdout, commandResult.stderr),
    stdout: truncateOutput(commandResult.stdout),
    exitStatus: commandResult.status,
    timeSeconds: commandResult.timeSeconds,
    memoryBytes: commandResult.memoryBytes,
  };
}

function formatMavenBuildError(stdout: string, stderr: string): string {
  return truncateOutput(
    `${stdout}
${stderr}`.trim()
  );
}

async function createCatalinaBaseDir(catalinaHome: string, runRootDir: string): Promise<string> {
  const catalinaBaseDir = path.join(runRootDir, 'catalina-base');
  await fs.promises.cp(path.join(catalinaHome, 'conf'), path.join(catalinaBaseDir, 'conf'), {
    recursive: true,
    dereference: true,
  });
  for (const directoryName of ['logs', 'temp', 'webapps', 'work']) {
    await fs.promises.mkdir(path.join(catalinaBaseDir, directoryName), { recursive: true });
  }

  const serverXmlPath = path.join(catalinaBaseDir, 'conf', 'server.xml');
  const serverXml = await fs.promises.readFile(serverXmlPath, 'utf8');
  await fs.promises.writeFile(serverXmlPath, serverXml.replaceAll('port="8080"', 'port="59000"'), 'utf8');
  return catalinaBaseDir;
}

async function deployWarFile(buildDir: string, catalinaBaseDir: string): Promise<void> {
  const warFilePath = path.join(buildDir, 'target', `${APPLICATION_NAME}.war`);
  const webappsDir = path.join(catalinaBaseDir, 'webapps');
  const deployedDirectoryPath = path.join(webappsDir, APPLICATION_NAME);
  const deployedWarPath = path.join(webappsDir, `${APPLICATION_NAME}.war`);
  await fs.promises.mkdir(webappsDir, { recursive: true });
  await fs.promises.rm(deployedDirectoryPath, { recursive: true, force: true });
  await fs.promises.rm(deployedWarPath, { force: true });
  await fs.promises.copyFile(warFilePath, deployedWarPath);
}

async function startTomcat(catalinaHome: string, catalinaBaseDir: string): Promise<void> {
  const startupScriptPath = path.join(catalinaHome, 'bin', 'startup.sh');
  const startupResult = runCommand([startupScriptPath], undefined, 10, {
    ...process.env,
    CATALINA_BASE: catalinaBaseDir,
    CATALINA_HOME: catalinaHome,
  });
  if (startupResult.status !== 0) {
    throw new Error(`Failed to start Tomcat: ${startupResult.stderr.trim() || startupResult.stdout.trim()}`);
  }

  const started = await waitForTomcatState(true, 10_000);
  if (!started) {
    throw new Error('Tomcat failed to start within 10 seconds');
  }
}

function runJudgeScript(buildDir: string, problemDirectoryPath: string): JudgeResult {
  const commandResult = runCommand(
    ['bun', 'run', './judge.ts', '--evaluate'],
    problemDirectoryPath,
    EVALUATE_TIMEOUT_SECONDS,
    {
      ...process.env,
      WORKING_DIRECTORY_PATH: buildDir,
    }
  );

  const outputFiles = readOutputFiles(path.join(buildDir, '__SCREENSHOTS.json'));
  if (commandResult.timeSeconds > EVALUATE_TIMEOUT_SECONDS) {
    return {
      decisionCode: DecisionCode.TIME_LIMIT_EXCEEDED,
      stderr: truncateOutput(commandResult.stderr),
      stdout: truncateOutput(commandResult.stdout),
      exitStatus: commandResult.status,
      timeSeconds: commandResult.timeSeconds,
      memoryBytes: commandResult.memoryBytes,
      outputFiles,
    };
  }
  if (commandResult.stdout.length > MAX_OUTPUT_LENGTH || commandResult.stderr.length > MAX_OUTPUT_LENGTH) {
    return {
      decisionCode: DecisionCode.OUTPUT_SIZE_LIMIT_EXCEEDED,
      stderr: truncateOutput(commandResult.stderr),
      stdout: truncateOutput(commandResult.stdout),
      exitStatus: commandResult.status,
      timeSeconds: commandResult.timeSeconds,
      memoryBytes: commandResult.memoryBytes,
      outputFiles,
    };
  }
  if (commandResult.status !== 0) {
    return {
      decisionCode: DecisionCode.WRONG_ANSWER,
      stderr: truncateOutput(commandResult.stderr),
      stdout: truncateOutput(commandResult.stdout),
      exitStatus: commandResult.status,
      timeSeconds: commandResult.timeSeconds,
      memoryBytes: commandResult.memoryBytes,
      outputFiles,
    };
  }

  return {
    decisionCode: DecisionCode.ACCEPTED,
    stderr: truncateOutput(commandResult.stderr) || undefined,
    stdout: truncateOutput(commandResult.stdout) || undefined,
    exitStatus: commandResult.status,
    timeSeconds: commandResult.timeSeconds,
    memoryBytes: commandResult.memoryBytes,
    outputFiles,
  };
}

function runCommand(
  command: readonly [string, ...string[]],
  cwd: string | undefined,
  timeoutSeconds: number,
  env: NodeJS.ProcessEnv = process.env
): CommandResult {
  const startAt = Date.now();
  const timeCommand = process.platform === 'darwin' ? 'gtime' : '/usr/bin/time';
  const timedResult = spawnSync('timeout', [timeoutSeconds.toFixed(3), timeCommand, '--format', '%e %M', ...command], {
    cwd,
    env,
    encoding: 'utf8',
  });
  const elapsedSeconds = (Date.now() - startAt) / 1000;
  const stderrWithError = [timedResult.stderr, timedResult.error?.message].filter(Boolean).join('\n');
  const memoryMatch = /(?:^|\n)(\d+(?:\.\d+)?) (\d+)\s*$/u.exec(stderrWithError);
  const stderr = memoryMatch ? stderrWithError.slice(0, memoryMatch.index) : stderrWithError;
  const timeSeconds = Number(memoryMatch?.[1]) || elapsedSeconds;
  const memoryBytes = 1024 * Number(memoryMatch?.[2] ?? 0);

  return {
    status: timedResult.status === 124 ? 0 : (timedResult.status ?? undefined),
    stdout: timedResult.stdout,
    stderr,
    timeSeconds: timedResult.status === 124 ? timeoutSeconds + 0.001 : timeSeconds,
    memoryBytes,
  };
}

async function ensureTomcatStopped(catalinaHome: string, catalinaBaseDir: string): Promise<void> {
  if (!(await isTomcatRunning())) {
    return;
  }

  runCommand([path.join(catalinaHome, 'bin', 'catalina.sh'), 'stop'], undefined, 10, {
    ...process.env,
    CATALINA_BASE: catalinaBaseDir,
    CATALINA_HOME: catalinaHome,
  });
  await waitForTomcatState(false, 10_000);
}

async function waitForTomcatState(expectedRunning: boolean, timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if ((await isTomcatRunning()) === expectedRunning) {
      return true;
    }
    await sleep(200);
  }
  return (await isTomcatRunning()) === expectedRunning;
}

async function isTomcatRunning(): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const request = http.get(TOMCAT_BASE_URL, (response) => {
      response.resume();
      const status = response.statusCode ?? 0;
      resolve((status >= 200 && status < 300) || status === 404);
    });
    request.on('error', () => resolve(false));
    request.setTimeout(1000, () => request.destroy());
  });
}

function getCatalinaHome(): string {
  const catalinaHome = process.env.CATALINA_HOME;
  if (!catalinaHome) {
    throw new Error('CATALINA_HOME is not set');
  }

  validateCatalinaHome(catalinaHome);
  return path.resolve(catalinaHome);
}

function validateCatalinaHome(catalinaHome: string): void {
  if (
    !fs.existsSync(path.join(catalinaHome, 'bin', 'catalina.sh')) ||
    !fs.existsSync(path.join(catalinaHome, 'conf', 'server.xml'))
  ) {
    throw new Error('Invalid CATALINA_HOME path');
  }
}

function readOutputFiles(filePath: string): OutputFile[] | undefined {
  if (!fs.existsSync(filePath)) {
    return undefined;
  }

  const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const values = z.array(z.unknown()).safeParse(parsed);
  if (!values.success) return undefined;
  const outputFileSchema = z.object({
    path: z.string(),
    data: z.string(),
    encoding: z.literal('base64').optional(),
  });
  return values.data.flatMap((value) => {
    const result = outputFileSchema.safeParse(value);
    return result.success ? [result.data] : [];
  });
}

function truncateOutput(value: string): string {
  return value.slice(0, MAX_OUTPUT_LENGTH);
}

export function buildTomcatUrl(urlPath: string): string {
  return `${TOMCAT_BASE_URL}/${APPLICATION_NAME}${urlPath.startsWith('/') ? urlPath : `/${urlPath}`}`;
}
