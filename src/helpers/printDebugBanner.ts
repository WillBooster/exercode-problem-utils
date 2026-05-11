const BANNER_LINE = '='.repeat(72);

/**
 * Print a prominent, multi-line banner to stderr so that debug-mode runs
 * (e.g., judging against model answers without an explicit cwd) are obvious.
 *
 * Written to stderr to avoid interfering with `printTestCaseResult` output on stdout.
 */
export function printDebugBanner(lines: readonly string[]): void {
  const body = lines.map((line) => `  ${line}`).join('\n');
  console.error(`\n${BANNER_LINE}\n${body}\n${BANNER_LINE}`);
}
