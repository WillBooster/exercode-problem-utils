import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

import { spawnWithTimeout } from '../../src/helpers/spawnWithTimeout.js';

const context = { cwd: process.cwd(), env: process.env };

async function waitUntil(condition: () => boolean, timeoutMilliseconds: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return condition();
}

test('returns once the program exits even if a background child still holds stdout', async () => {
  const startedAt = Date.now();
  const result = await spawnWithTimeout('sh', ['-c', 'sleep 30 & echo done; exit 0'], context, 5);

  // Well below the grace period for pipes held by an escaped child: the child must have been killed.
  expect(Date.now() - startedAt).toBeLessThan(500);
  expect(result.status).toBe(0);
  expect(result.stdout).toBe('done\n');
});

test('returns once the program exits even if a child in its own session still holds stdout', async () => {
  const startedAt = Date.now();
  // The limit expires while the pipes are still held; it must not be reported as a timeout. The
  // parent exits only once the child has left the process group, or the group kill would catch it.
  const result = await spawnWithTimeout(
    'python3',
    [
      '-c',
      [
        'import os, time',
        'ready_read, ready_write = os.pipe()',
        'pid = os.fork()',
        'if pid == 0:',
        '    os.setsid()',
        '    os.write(ready_write, b"1")',
        '    time.sleep(30)',
        'else:',
        '    os.read(ready_read, 1)',
        '    print(pid)',
      ].join('\n'),
    ],
    context,
    0.5
  );
  const elapsedMilliseconds = Date.now() - startedAt;
  // The child escaped the process group on purpose, so end it here.
  const childPid = Number(result.stdout.trim());
  expect(childPid).toBeGreaterThan(0);
  process.kill(childPid, 'SIGKILL');

  expect(elapsedMilliseconds).toBeLessThan(3000);
  expect(result.status).toBe(0);
  expect(result.timeSeconds).toBeLessThan(0.5);
});

test('passes stdin through to the program', async () => {
  const result = await spawnWithTimeout('cat', [], { ...context, stdin: 'hello' }, 5);

  expect(result.status).toBe(0);
  expect(result.stdout).toBe('hello');
});

test('keeps the default signal dispositions for the program', async () => {
  const result = await spawnWithTimeout('sh', ['-c', 'kill -INT $$; echo survived'], context, 5);

  expect(result.status).not.toBe(0);
  expect(result.stdout).toBe('');
});

test('reports a timeout as time limit exceeded even if the program spawned a child', async () => {
  const startedAt = Date.now();
  const result = await spawnWithTimeout('sh', ['-c', 'sleep 30 & sleep 30'], context, 0.5);

  expect(Date.now() - startedAt).toBeLessThan(3000);
  expect(result.status).toBe(0);
  expect(result.timeSeconds).toBeGreaterThan(0.5);
});

test('preserves the exit status and stderr of the program', async () => {
  const result = await spawnWithTimeout('sh', ['-c', 'echo oops >&2; exit 7'], context, 5);

  expect(result.status).toBe(7);
  expect(result.stderr).toBe('oops\nCommand exited with non-zero status 7\n');
  expect(result.memoryBytes).toBeGreaterThan(0);
});

test('reports output beyond the cap as a normal exit with the output truncated', async () => {
  const startedAt = Date.now();
  const result = await spawnWithTimeout('sh', ['-c', 'yes | head -c 10000000; sleep 30'], context, 5);

  // The cap, not the time limit, must have ended the run.
  expect(Date.now() - startedAt).toBeLessThan(3000);
  expect(result.outputLimitExceeded).toBe(true);
  expect(result.status).toBe(0);
  expect(result.stdout.length).toBe(8 * 1024 * 1024);
});

test('ends the program at its limit even after the judge process was killed', { timeout: 30_000 }, async () => {
  const marker = `exercode-orphan-${process.pid}`;
  // The judge script lives in a file so that only the judged program's command line carries the marker.
  const judgeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'exercode-judge-'));
  const judgePath = path.join(judgeDir, 'judge.ts');
  await fs.writeFile(
    judgePath,
    `import { spawnWithTimeout } from ${JSON.stringify(path.resolve('src/helpers/spawnWithTimeout.ts'))};
await spawnWithTimeout('sh', ['-c', 'sleep 30; echo ${marker}'], { cwd: process.cwd(), env: process.env }, 1);`
  );
  const judge = childProcess.spawn('bun', [judgePath], { stdio: 'ignore' });
  const isProgramRunning = (): boolean =>
    childProcess.spawnSync('pgrep', ['-f', `echo ${marker}`], { stdio: 'ignore' }).status === 0;

  try {
    expect(await waitUntil(isProgramRunning, 10_000)).toBe(true);
    expect(judge.exitCode).toBeNull();
    judge.kill('SIGKILL');
    expect(await waitUntil(() => !isProgramRunning(), 10_000)).toBe(true);
  } finally {
    childProcess.spawnSync('pkill', ['-KILL', '-f', `echo ${marker}`], { stdio: 'ignore' });
    await fs.rm(judgeDir, { recursive: true, force: true });
  }
});
