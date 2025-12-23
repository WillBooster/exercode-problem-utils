/**
 * Parse command line arguments in `judge.ts` or `debug.ts`.
 */
export function parseArgs(argv: readonly string[]): { cwd: string; params: unknown } {
  const cwd = argv[2];
  if (!cwd) throw new Error('cwd argument required');

  const paramsJson = argv[3];

  try {
    return { cwd, params: paramsJson ? JSON.parse(paramsJson) : {} };
  } catch (error) {
    throw new Error('bad params argument', { cause: error });
  }
}
