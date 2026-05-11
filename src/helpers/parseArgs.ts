/**
 * Parse command line arguments in `judge.ts` or `debug.ts`.
 *
 * `cwd` is optional: when omitted, presets that support it may fall back to
 * judging against model answers under `<problemDir>/model_answers/*`.
 */
export function parseArgs(argv: readonly string[]): { cwd: string | undefined; params: unknown } {
  const cwd = argv[2] || undefined;
  const paramsJson = argv[3];

  try {
    return { cwd, params: paramsJson ? JSON.parse(paramsJson) : {} };
  } catch (error) {
    throw new Error('bad params argument', { cause: error });
  }
}
