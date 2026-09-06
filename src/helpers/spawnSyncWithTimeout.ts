import child_process from 'node:child_process';
import os from 'node:os';

const TIME_COMMAND = [os.platform() === 'darwin' ? 'gtime' : '/usr/bin/time', '--format', '%e %M'] as const;

// `spawnSync` returns only after the stdout/stderr pipes close, so a background child that
// outlives the submission (e.g. `sleep 1000 & exit 0`) would stall the judge until that child
// ends. `timeout` places itself and the program in a new process group, so once `timeout`
// returns, the wrapper kills that group to end every descendant that still holds the pipes.
// Standard input is passed through fd 3 because non-interactive shells give `&` commands
// `/dev/null` as stdin.
const KILL_PROCESS_GROUP_SCRIPT = `exec 3<&0
timeout "$@" <&3 3<&- &
pid=$!
exec 3<&-
wait "$pid"
status=$?
kill -s KILL -- "-$pid" 2>/dev/null
exit "$status"`;

export function spawnSyncWithTimeout(
  command: string,
  args: readonly string[],
  options: child_process.SpawnSyncOptionsWithStringEncoding,
  timeoutSeconds: number
): child_process.SpawnSyncReturns<string> & { timeSeconds: number; memoryBytes: number } {
  const startTimeMilliseconds = Date.now();

  const spawnResult = child_process.spawnSync(
    'sh',
    ['-c', KILL_PROCESS_GROUP_SCRIPT, 'sh', timeoutSeconds.toFixed(3), ...TIME_COMMAND, command, ...args],
    options
  );

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
