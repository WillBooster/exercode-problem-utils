import child_process from 'node:child_process';

import { forciblyRemoveDirectorySync } from './temporaryProblemDirCopy.js';

export interface HarnessProcessOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes: number;
  /** A temporary copy to remove when the check itself is interrupted by a signal. */
  tempRoot?: string;
}

export interface HarnessProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | undefined;
  /** The signal that terminated the harness when it did not exit on its own. */
  signal: NodeJS.Signals | undefined;
  /** Set when the run was killed by this helper (timeout or output cap) or could not be spawned. */
  failureReason: string | undefined;
  timedOut: boolean;
}

interface LiveHarnessRun {
  pid: number;
  tempRoot: string | undefined;
}

// Detached harness groups no longer receive the terminal's SIGINT, so an interrupted run must
// tear them down (and remove their temp copies) itself before exiting. The handlers stay installed
// for the process lifetime: once the last run has settled they only iterate an empty set and re-raise
// the signal, so removing them would change nothing observable.
const liveHarnessRuns = new Set<LiveHarnessRun>();
let signalHandlersInstalled = false;

/**
 * Run a judge harness with `process.execPath` in its own process group, killing the whole group on
 * timeout or when the output cap is exceeded. The submissions a harness judges through
 * `spawnWithLimits` run in sessions of their own, out of that kill's reach; each is bounded by its
 * own GNU `timeout` wrapper instead.
 */
export function runHarnessProcess(
  commandArgs: readonly string[],
  options: HarnessProcessOptions
): Promise<HarnessProcessResult> {
  installSignalHandlers();
  return new Promise((resolve) => {
    // process.execPath keeps the harness on the same bun executable regardless of PATH.
    const child = child_process.spawn(process.execPath, commandArgs, {
      cwd: options.cwd,
      detached: process.platform !== 'win32',
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const liveRun: LiveHarnessRun | undefined =
      child.pid === undefined ? undefined : { pid: child.pid, tempRoot: options.tempRoot };
    if (liveRun) liveHarnessRuns.add(liveRun);
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let totalOutputBytes = 0;
    let failureReason: string | undefined;
    let timedOut = false;
    let settled = false;

    // Returns false when an earlier kill already recorded its reason, so callers can tell whether theirs won.
    const killProcessGroup = (reason: string): boolean => {
      if (failureReason !== undefined) return false;
      failureReason = reason;
      // Stop buffering immediately: OS pipe buffers can keep emitting data after the kill, and
      // destroyed streams also let `close` fire even if a stray grandchild inherited the pipes.
      child.stdout?.destroy();
      child.stderr?.destroy();
      try {
        if (child.pid === undefined) {
          child.kill('SIGKILL');
        } else {
          killHarnessTree(child.pid);
        }
      } catch {
        child.kill('SIGKILL');
      }
      return true;
    };
    const timeoutId = setTimeout(() => {
      timedOut = killProcessGroup(`timed out after ${options.timeoutMs / 1000} seconds`);
    }, options.timeoutMs);

    const appendOutput = (chunk: Buffer, chunks: Buffer[]): void => {
      totalOutputBytes += chunk.byteLength;
      if (totalOutputBytes > options.maxOutputBytes) {
        killProcessGroup(`the harness printed more than ${options.maxOutputBytes / 1024 / 1024} MB of output`);
        return;
      }
      chunks.push(chunk);
    };
    child.stdout?.on('data', (chunk: Buffer) => appendOutput(chunk, stdoutChunks));
    child.stderr?.on('data', (chunk: Buffer) => appendOutput(chunk, stderrChunks));

    const settle = (exitCode: number | undefined, signal: NodeJS.Signals | undefined, spawnError?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      if (liveRun) liveHarnessRuns.delete(liveRun);
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        exitCode,
        signal,
        failureReason: failureReason ?? (spawnError ? `failed to run the harness: ${spawnError.message}` : undefined),
        timedOut,
      });
    };
    child.on('error', (error) => settle(undefined, undefined, error));
    child.on('close', (exitCode, signal) => settle(exitCode ?? undefined, signal ?? undefined));
  });
}

function installSignalHandlers(): void {
  if (signalHandlersInstalled) return;
  signalHandlersInstalled = true;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      for (const liveRun of liveHarnessRuns) {
        try {
          killHarnessTree(liveRun.pid);
        } catch {
          // The tree already exited.
        }
        // Best-effort cleanup while exiting; judged code may have left permission-locked entries.
        if (liveRun.tempRoot) forciblyRemoveDirectorySync(liveRun.tempRoot);
      }
      process.kill(process.pid, signal);
    });
  }
}

// On Windows the harness is not detached (process groups are unavailable), so killing only the
// direct child would leave submission grandchildren running; taskkill terminates the whole tree.
function killHarnessTree(pid: number): void {
  if (process.platform === 'win32') {
    child_process.spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    process.kill(-pid, 'SIGKILL');
  }
}
