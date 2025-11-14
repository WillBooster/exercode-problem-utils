const ACCEPTABLE_FLOAT_ERROR = 1e-6;

export function compareStdoutAsSpaceSeparatedTokens(received: string, expected: string): boolean {
  // Consecutive white spaces (including tabs, page breaks, and line breaks) are treated as one space character.
  const receivedTokens = received.trim().split(/\s+/);
  const expectedTokens = expected.trim().split(/\s+/);

  if (receivedTokens.length !== expectedTokens.length) return false;

  for (const [i, expectedToken] of expectedTokens.entries()) {
    const receivedToken = receivedTokens[i];

    const isDecimal = !Number.isNaN(Number(expectedToken)) && expectedToken.includes('.');
    if (isDecimal) {
      const receivedNumber = Number(receivedToken);
      const expectedNumber = Number(expectedToken);

      if (Number.isNaN(expectedNumber)) throw new TypeError(`invalid token in test case: ${expectedToken}`);
      if (Number.isNaN(receivedNumber)) return false;

      const absoluteError = Math.abs(receivedNumber - expectedNumber);
      const relativeError = expectedNumber === 0 ? Number.POSITIVE_INFINITY : Math.abs(absoluteError / expectedNumber);
      if (absoluteError > ACCEPTABLE_FLOAT_ERROR && relativeError > ACCEPTABLE_FLOAT_ERROR) return false;
    } else {
      if (receivedToken !== expectedToken) return false;
    }
  }

  return true;
}
