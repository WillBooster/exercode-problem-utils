import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface SpawnWithLimitsResult {
  stdout: string;
  stderr: string;
  status: number | undefined;
  signal: NodeJS.Signals | undefined;
  /** Wall time measured by GNU time, or measured here until the command exited when it produced none. */
  timeSeconds: number;
  /** Peak resident set size measured by GNU time, or 0 when it produced no measurement. */
  memoryBytes: number;
  /** The note GNU time adds when the command exits abnormally, e.g. `Command terminated by signal 11`. */
  timeCommandMessage: string | undefined;
  timedOut: boolean;
  outputLimitExceeded: boolean;
}

const killGracePeriodMilliseconds = 1000;
const timeCommand = resolveTimeCommand();

/** Whether GNU time is available, i.e. whether `timeSeconds` and `memoryBytes` are measured at all. */
export const isTimeCommandAvailable = timeCommand !== undefined;

// The commands run in their own sessions, so they outlive this process unless it ends them itself
// on the way out (e.g. a preset's SIGINT handler calling `process.exit`).
const liveSubprocesses = new Set<childProcess.ChildProcess>();
process.once('exit', () => {
  for (const subprocess of liveSubprocesses) killSubprocessGroup(subprocess, 'SIGKILL');
});

/**
 * Runs a command in its own process group with `stdin` piped in, killing the whole group once it
 * exceeds the time or output limit, and reports the wall time and peak memory measured by GNU time.
 */
export async function spawnWithLimits(
  command: readonly [string, ...string[]],
  context: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    outputLimitBytes: number;
    stdin: string;
    timeLimitSeconds: number;
  }
): Promise<SpawnWithLimitsResult> {
  const timeDir = timeCommand === undefined ? undefined : await fs.mkdtemp(path.join(os.tmpdir(), 'exercode-time-'));
  try {
    const timeOutputPath = timeDir === undefined ? undefined : path.join(timeDir, 'result');
    const detached = process.platform !== 'win32';
    const timedCommand: readonly [string, ...string[]] =
      timeCommand === undefined ? command : [...timeCommand, `--output=${timeOutputPath}`, ...command];
    // The command runs in its own session so the group kill below cannot hit this process, but that
    // also puts it out of reach of whoever kills this process. GNU `timeout` keeps the run bounded
    // in that case; it acts only after the timers below had their chance.
    const spawnedCommand: readonly [string, ...string[]] = detached
      ? [
          'timeout',
          '-k',
          String(killGracePeriodMilliseconds / 1000),
          String(context.timeLimitSeconds + killGracePeriodMilliseconds / 1000),
          ...timedCommand,
        ]
      : timedCommand;
    const startTimeMilliseconds = Date.now();
    const subprocess = childProcess.spawn(spawnedCommand[0], spawnedCommand.slice(1), {
      cwd: context.cwd,
      detached,
      env: context.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    liveSubprocesses.add(subprocess);

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let outputBytes = 0;
    let timedOut = false;
    let outputLimitExceeded = false;
    let wallTimeSeconds = 0;
    let spawnErrorMessage: string | undefined;

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
        let closeTimeout: NodeJS.Timeout | undefined;
        const settle = (code: number | null | undefined, exitSignal: NodeJS.Signals | null | undefined): void => {
          if (settled) return;
          settled = true;
          clearTimeout(closeTimeout);
          if (pendingError) {
            reject(pendingError);
            return;
          }
          resolve({ status: code ?? undefined, signal: exitSignal ?? undefined });
        };
        const failAfterClose = (error: Error): void => {
          if (settled) return;
          if (subprocess.pid === undefined) {
            // The command could not be started (e.g. a missing executable): that is the command's
            // failure, reported like a run that produced only this message.
            spawnErrorMessage = error.message;
            settle(undefined, undefined);
            return;
          }
          pendingError = error;
          killSubprocessGroup(subprocess, 'SIGKILL');
        };
        subprocess.on('error', failAfterClose);
        subprocess.stdin.on('error', (error: NodeJS.ErrnoException) => {
          if (error.code !== 'EPIPE') failAfterClose(error);
        });
        subprocess.on('exit', (code, exitSignal) => {
          // The command is gone, so the limit timers must not fire during the grace period below. A
          // descendant that inherited the pipes (e.g. `sleep 1000 &`) would keep them open and hold
          // back 'close' until it ends: kill what is left of the group. A descendant that moved to
          // its own session survives that, so stop waiting for the pipes after the grace period and
          // keep the output read so far.
          clearTimeout(timeout);
          clearTimeout(killTimeout);
          wallTimeSeconds = (Date.now() - startTimeMilliseconds) / 1000;
          killSubprocessGroup(subprocess, 'SIGKILL');
          closeTimeout = setTimeout(() => {
            subprocess.stdout.destroy();
            subprocess.stderr.destroy();
            settle(code, exitSignal);
          }, killGracePeriodMilliseconds);
        });
        subprocess.on('close', settle);
        subprocess.stdin.end(context.stdin);
      }
    ).finally(() => {
      clearTimeout(timeout);
      clearTimeout(killTimeout);
      liveSubprocesses.delete(subprocess);
    });

    const timeResult = timeOutputPath === undefined ? undefined : await readTimeResult(timeOutputPath);

    return {
      stdout: Buffer.concat(stdoutChunks).toString(),
      stderr: spawnErrorMessage ?? Buffer.concat(stderrChunks).toString(),
      status,
      signal,
      // GNU time rounds a fast run to 0.00; the wall time until 'exit' stands in for it (never the
      // grace period spent on the pipes afterwards).
      timeSeconds: timeResult?.timeSeconds || wallTimeSeconds,
      memoryBytes: timeResult?.memoryBytes ?? 0,
      timeCommandMessage: timeResult?.message,
      // 124 is `timeout` reporting that it had to end the run itself, unless the program exited
      // with that status on its own before the limit.
      timedOut: timedOut || (status === 124 && wallTimeSeconds >= context.timeLimitSeconds),
      outputLimitExceeded,
    };
  } finally {
    // A failed cleanup must not discard a finished run.
    if (timeDir !== undefined) await fs.rm(timeDir, { recursive: true, force: true }).catch(() => {});
  }
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
    if (!isErrorWithCode(error, 'ESRCH') && !isErrorWithCode(error, 'EPERM')) throw error;
  }
}

async function readTimeResult(
  timeOutputPath: string
): Promise<{ timeSeconds: number; memoryBytes: number; message: string | undefined } | undefined> {
  // An absent file means "no measurement" (the command was killed before `time` wrote one).
  let content: string;
  try {
    content = await fs.readFile(timeOutputPath, 'utf8');
  } catch (error) {
    if (isErrorWithCode(error, 'ENOENT')) return undefined;
    throw error;
  }

  const match = /(?:^|\n)(\d+(?:[.,]\d+)?) (\d+)\s*$/.exec(content);
  if (!match) return undefined;

  return {
    timeSeconds: Number(match[1]!.replace(',', '.')),
    memoryBytes: Number(match[2]) * 1024,
    message: content.slice(0, match.index).trim() || undefined,
  };
}

function isErrorWithCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code: unknown }).code === code;
}

function resolveTimeCommand(): readonly [string, ...string[]] | undefined {
  const command = os.platform() === 'darwin' ? 'gtime' : '/usr/bin/time';
  const result = childProcess.spawnSync(command, ['--version'], { stdio: 'ignore' });
  if (result.error || result.status !== 0) return undefined;

  return [command, '--format', '%e %M'];
}
