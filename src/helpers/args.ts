export function parseArgs(argv: readonly string[]): { params: unknown } {
  const paramsJson = argv[2];
  if (!paramsJson) throw new Error('params argument required');

  try {
    return { params: JSON.parse(paramsJson) };
  } catch (error) {
    throw new Error('bad params argument', { cause: error });
  }
}
