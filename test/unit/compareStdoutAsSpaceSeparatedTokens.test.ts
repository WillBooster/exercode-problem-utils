import { expect, test } from 'vitest';

import { compareStdoutAsSpaceSeparatedTokens } from '../../src/helpers/compareStdoutAsSpaceSeparatedTokens.js';

test.each<[string, string, boolean]>([
  [' 123\n 456\n', '123 456', true],
  ['123 456', ' 123\n 456\n', true],
  ['123456', '123 456', false],
  ['1 2.0000001 3', '1 2.0 3', true],
  ['1 2 3', '1 2.0 3', true],
  ['1 2.0000001 3', '1 2 3', false],
])('%j %j -> %s', (receivedStdout, expectedStdout, expected) => {
  expect(compareStdoutAsSpaceSeparatedTokens(receivedStdout, expectedStdout)).toBe(expected);
});
