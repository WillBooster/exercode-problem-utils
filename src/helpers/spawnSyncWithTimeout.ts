import child_process from 'node:child_process';
import os from 'node:os';

import { getSandboxUserEnvOverrides, wrapCommandWithSandboxUser } from './sandboxUser.js';

const TIME_COMMAND = [os.platform() === 'darwin' ? 'gtime' : '/usr/bin/time', '--format', '%e %M'] as const;

/**
 * Run an untrusted (submission-derived) command with a timeout. When a judge server delegates
 * untrusted execution via `EXERCODE_SANDBOX_USER` (see `sandboxUser.ts`), the whole command,
 * including `timeout`, runs as the sandbox user so the timer can signal the sandboxed process.
 */
export function spawnSyncWithTimeout(
  command: string,
  args: readonly string[],
  options: child_process.SpawnSyncOptionsWithStringEncoding,
  timeoutSeconds: number
): child_process.SpawnSyncReturns<string> & { timeSeconds: number; memoryBytes: number } {
  const startTimeMilliseconds = Date.now();

  const wrappedCommand = wrapCommandWithSandboxUser([
    'timeout',
    timeoutSeconds.toFixed(3),
    ...TIME_COMMAND,
    command,
    ...args,
  ]);
  const spawnResult = child_process.spawnSync(wrappedCommand[0], wrappedCommand.slice(1), {
    ...options,
    env: { ...(options.env ?? process.env), ...getSandboxUserEnvOverrides() },
  });

  const stopTimeMilliseconds = Date.now();

  const match = /(?:^|\n)(\d+\.\d+) (\d+)\s*$/.exec(spawnResult.stderr);
  const stderr = match ? spawnResult.stderr.slice(0, match.index) : spawnResult.stderr;
  const timeSeconds = Number(match?.[1]) || (stopTimeMilliseconds - startTimeMilliseconds) / 1000;
  const memoryBytes = Number(match?.[2]) * 1024 || 0;

  // timeout
  if (spawnResult.status === 124) {
    return { ...spawnResult, status: 0, stderr, timeSeconds: timeoutSeconds + 1e-3, memoryBytes };
  }

  return { ...spawnResult, stderr, timeSeconds, memoryBytes };
}
