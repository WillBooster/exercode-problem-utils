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
  /**
   * User plus system CPU time of the command and the descendants it waited for, measured by GNU
   * time, or 0 when it produced no measurement. A run `timeout` ended is measured too, so a caller
   * can tell a program that used up its time limit from one that waited for the CPU.
   */
  cpuTimeSeconds: number;
  /**
   * Peak resident set size measured by GNU time, or 0 when it produced no measurement. GNU time
   * measures its child `timeout` and the descendants it waited for, so the value is at least
   * `timeout`'s own footprint (about 1 MiB), which only shows for the smallest native programs.
   */
  memoryBytes: number;
  /** The note GNU time adds when the command exits abnormally, e.g. `Command terminated by signal 11`. */
  timeCommandMessage: string | undefined;
  timedOut: boolean;
  outputLimitExceeded: boolean;
}

const killGracePeriodMilliseconds = 1000;
const MIN_TIMEOUT_SECONDS = 0.001;
// GNU `timeout` exits with 124 after ending a run at its limit, or with 128 + SIGKILL when the run
// ignored its SIGTERM and it had to be killed after the grace period.
const TIMEOUT_EXIT_STATUS = 124;
const KILLED_AFTER_TIMEOUT_EXIT_STATUS = 137;
// GNU time writes its record to a file this process opened and unlinked at once, handed down as fd 3
// of the command and reopened by GNU time through `/dev/fd`: the command runs as the same OS user,
// so a record reachable by path could be swapped for a fake or for a FIFO that blocks the read.
const TIME_OUTPUT_FD = 3;
// The command inherits that descriptor too, so only the tail that can hold GNU time's record is read.
const TIME_OUTPUT_TAIL_BYTES = 4096;
const timeCommand = resolveTimeCommand();

/** Whether GNU time is available, i.e. whether `timeSeconds`, `cpuTimeSeconds`, and `memoryBytes` are measured at all. */
export const isTimeCommandAvailable = timeCommand !== undefined;

// The commands run in their own sessions, so they outlive this process unless it ends them itself
// on the way out (e.g. a preset's SIGINT handler calling `process.exit`).
const liveSubprocesses = new Set<childProcess.ChildProcess>();
process.once('exit', () => {
  for (const subprocess of liveSubprocesses) killSubprocessGroup(subprocess, 'SIGKILL');
});

/**
 * Runs a command in its own process group with `stdin` piped in, killing the whole group once it
 * exceeds the time or output limit, and reports the wall time, CPU time, and peak memory measured
 * by GNU time.
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
  const timeOutput = timeCommand === undefined ? undefined : await openUnlinkedFile('exercode-time-');
  try {
    const detached = process.platform !== 'win32';
    // The command runs in its own session so the group kill below cannot hit this process, but that
    // also puts it out of reach of whoever kills this process. GNU `timeout` keeps the run bounded
    // in that case, and it is what normally ends a run at its limit: GNU time wraps it, so a run
    // that hit the limit still gets its CPU time recorded (a group kill from here would take GNU
    // time down with the command), and `--foreground` keeps the command in this group so the kill
    // below still reaches every descendant. The timers below only back `timeout` up. Should this
    // process die first, `timeout` ends the command alone (`--foreground` signals no descendant),
    // an accepted gap: the judge server sweeps every process of the request's sandbox user anyway.
    const boundedCommand: readonly [string, ...string[]] = detached
      ? [
          'timeout',
          '--foreground',
          '-k',
          String(killGracePeriodMilliseconds / 1000),
          // A zero duration would disable `timeout`; the front matter allows a zero time limit.
          String(Math.max(context.timeLimitSeconds, MIN_TIMEOUT_SECONDS)),
          ...command,
        ]
      : command;
    const spawnedCommand: readonly [string, ...string[]] =
      timeCommand === undefined
        ? boundedCommand
        : [...timeCommand, `--output=/dev/fd/${TIME_OUTPUT_FD}`, ...boundedCommand];
    // `timeout` sends SIGKILL a grace period after its SIGTERM; the timers here fire once even that
    // should have ended the run.
    const timeLimitMilliseconds = detached
      ? context.timeLimitSeconds * 1000 + 2 * killGracePeriodMilliseconds
      : context.timeLimitSeconds * 1000;
    // Monotonic: a wall-clock step must not turn a run `timeout` ended into one that finished in time.
    const startTimeMilliseconds = performance.now();
    // The standard streams are always pipes; the type cannot express that with the extra entry.
    const subprocess = childProcess.spawn(spawnedCommand[0], spawnedCommand.slice(1), {
      cwd: context.cwd,
      detached,
      env: context.env,
      stdio: timeOutput === undefined ? ['pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe', timeOutput.fd],
    }) as childProcess.ChildProcessWithoutNullStreams;
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
    }, timeLimitMilliseconds);
    const killTimeout = setTimeout(() => {
      if (timedOut) killSubprocessGroup(subprocess, 'SIGKILL');
    }, timeLimitMilliseconds + killGracePeriodMilliseconds);
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
            // The spawn itself failed, i.e. the head of the chain (GNU time, or `timeout` without
            // it, or the command itself on Windows) or the cwd is missing. A missing judged command
            // is reported as status 127 by the wrapper instead. Report this like a run that produced
            // only this message.
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
          wallTimeSeconds = (performance.now() - startTimeMilliseconds) / 1000;
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

    const timeResult =
      timeOutput === undefined ? undefined : parseTimeOutput(await readTail(timeOutput, TIME_OUTPUT_TAIL_BYTES));

    return {
      stdout: Buffer.concat(stdoutChunks).toString(),
      stderr: spawnErrorMessage ?? Buffer.concat(stderrChunks).toString(),
      status,
      signal,
      // GNU time rounds a fast run to 0.00; the wall time until 'exit' stands in for it (never the
      // grace period spent on the pipes afterwards).
      timeSeconds: timeResult?.timeSeconds || wallTimeSeconds,
      cpuTimeSeconds: timeResult?.cpuTimeSeconds ?? 0,
      memoryBytes: timeResult?.memoryBytes ?? 0,
      timeCommandMessage: timeResult?.message,
      timedOut: timedOut || endedByTimeout(status, wallTimeSeconds, context.timeLimitSeconds),
      outputLimitExceeded,
    };
  } finally {
    await timeOutput?.close();
  }
}

/**
 * Whether `timeout` ended the run: 124 says it did so at the limit, and 137 that the run ignored its
 * SIGTERM and had to be killed after the grace period. A program can exit with either status on its
 * own, so each is trusted only once the wall time reached the moment `timeout` would have produced it.
 */
function endedByTimeout(status: number | undefined, wallTimeSeconds: number, timeLimitSeconds: number): boolean {
  if (status === TIMEOUT_EXIT_STATUS) return wallTimeSeconds >= timeLimitSeconds;
  if (status === KILLED_AFTER_TIMEOUT_EXIT_STATUS) {
    return wallTimeSeconds >= timeLimitSeconds + killGracePeriodMilliseconds / 1000;
  }
  return false;
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

// The file is unlinked before it is returned, so nothing can reach it by path anymore.
async function openUnlinkedFile(prefix: string): Promise<fs.FileHandle> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await fs.open(path.join(directory, 'record'), 'wx+', 0o600);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function readTail(file: fs.FileHandle, maxBytes: number): Promise<string> {
  const { size } = await file.stat();
  const length = Math.min(size, maxBytes);
  const { buffer } = await file.read(Buffer.alloc(length), 0, length, size - length);
  return buffer.toString();
}

// Empty when the command was killed before GNU time wrote its record.
function parseTimeOutput(
  content: string
): { timeSeconds: number; cpuTimeSeconds: number; memoryBytes: number; message: string | undefined } | undefined {
  const match = /(?:^|\n)(\d+(?:[.,]\d+)?) (\d+(?:[.,]\d+)?) (\d+(?:[.,]\d+)?) (\d+)\s*$/.exec(content);
  if (!match) return undefined;

  return {
    timeSeconds: parseSeconds(match[1]!),
    cpuTimeSeconds: parseSeconds(match[2]!) + parseSeconds(match[3]!),
    memoryBytes: Number(match[4]) * 1024,
    message: content.slice(0, match.index).trim() || undefined,
  };
}

// GNU time formats its seconds with the locale's decimal separator.
function parseSeconds(text: string): number {
  return Number(text.replace(',', '.'));
}

function isErrorWithCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code: unknown }).code === code;
}

function resolveTimeCommand(): readonly [string, ...string[]] | undefined {
  const command = os.platform() === 'darwin' ? 'gtime' : '/usr/bin/time';
  const result = childProcess.spawnSync(command, ['--version'], { stdio: 'ignore' });
  if (result.error || result.status !== 0) return undefined;

  // Wall seconds, user CPU seconds, system CPU seconds, peak resident set size in KiB.
  return [command, '--format', '%e %U %S %M'];
}
