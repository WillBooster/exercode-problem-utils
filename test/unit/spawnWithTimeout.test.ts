import { expect, test } from 'vitest';

import { spawnWithTimeout } from '../../src/helpers/spawnWithTimeout.js';

const context = { cwd: process.cwd(), env: process.env };

test('returns once the program exits even if a background child still holds stdout', async () => {
  const startedAt = Date.now();
  const result = await spawnWithTimeout('sh', ['-c', 'sleep 30 & echo done; exit 0'], context, 5);

  expect(Date.now() - startedAt).toBeLessThan(3000);
  expect(result.status).toBe(0);
  expect(result.stdout).toBe('done\n');
});

test('returns once the program exits even if a child in its own session still holds stdout', async () => {
  const startedAt = Date.now();
  // The limit expires while the pipes are still held; it must not be reported as a timeout.
  const result = await spawnWithTimeout(
    'python3',
    ['-c', 'import os, time\nif os.fork() == 0:\n    os.setsid()\n    time.sleep(30)\nelse:\n    print("done")'],
    context,
    0.5
  );

  expect(Date.now() - startedAt).toBeLessThan(3000);
  expect(result.status).toBe(0);
  expect(result.stdout).toBe('done\n');
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
