import { expect, test } from 'vitest';

import { spawnSyncWithTimeout } from '../../src/helpers/spawnSyncWithTimeout.js';

const options = { encoding: 'utf8' } as const;

test('returns once the program exits even if a background child still holds stdout', () => {
  const startedAt = Date.now();
  const result = spawnSyncWithTimeout('sh', ['-c', 'sleep 30 & echo done; exit 0'], options, 5);

  expect(Date.now() - startedAt).toBeLessThan(3000);
  expect(result.status).toBe(0);
  expect(result.stdout).toBe('done\n');
});

test('passes stdin through to the program', () => {
  const result = spawnSyncWithTimeout('cat', [], { ...options, input: 'hello' }, 5);

  expect(result.status).toBe(0);
  expect(result.stdout).toBe('hello');
});

test('reports a timeout as time limit exceeded even if the program spawned a child', () => {
  const startedAt = Date.now();
  const result = spawnSyncWithTimeout('sh', ['-c', 'sleep 30 & sleep 30'], options, 0.5);

  expect(Date.now() - startedAt).toBeLessThan(3000);
  expect(result.status).toBe(0);
  expect(result.timeSeconds).toBeGreaterThan(0.5);
});

test('preserves the exit status and stderr of the program', () => {
  const result = spawnSyncWithTimeout('sh', ['-c', 'echo oops >&2; exit 7'], options, 5);

  expect(result.status).toBe(7);
  expect(result.stderr).toMatch(/^oops\n/);
});
