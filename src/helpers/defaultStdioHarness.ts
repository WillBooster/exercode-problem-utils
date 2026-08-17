import fs from 'node:fs/promises';
import path from 'node:path';

export const HARNESS_FILE_PRESETS = {
  'judge.ts': 'stdioJudgePreset',
  'debug.ts': 'stdioDebugPreset',
} as const;

export type HarnessFileName = keyof typeof HARNESS_FILE_PRESETS;

/**
 * Find harness files (`judge.ts` / `debug.ts`) in a problem directory whose content is identical to
 * the default stdio harness. Such files must not be committed: a problem without `judge.ts` is
 * judged with `stdioJudgePreset` (and debugged with `stdioDebugPreset`) automatically, and
 * committed copies would drift from the server's defaults.
 */
export async function findDefaultStdioHarnessFiles(problemDir: string): Promise<HarnessFileName[]> {
  const foundFileNames: HarnessFileName[] = [];
  for (const [fileName, presetName] of Object.entries(HARNESS_FILE_PRESETS)) {
    let content;
    try {
      content = await fs.readFile(path.join(problemDir, fileName), 'utf8');
    } catch {
      continue;
    }
    if (isDefaultStdioHarnessSource(content, presetName)) foundFileNames.push(fileName as HarnessFileName);
  }
  return foundFileNames;
}

/**
 * Whether the source consists only of importing the given stdio preset and awaiting it, i.e. it is
 * semantically identical to the default harness the server generates. Comments count as a
 * difference on purpose: a harness kept for demonstration can add an explanatory comment to be
 * treated as custom.
 */
export function isDefaultStdioHarnessSource(source: string, presetName: string): boolean {
  const defaultHarnessRegex = new RegExp(
    String.raw`^\s*import\s*\{\s*${presetName}\s*\}\s*from\s*(['"])[^'"]*/presets/stdio(?:\.js)?\1\s*;?` +
      String.raw`\s*await\s+${presetName}\s*\(\s*import\.meta\.dirname\s*\)\s*;?\s*$`
  );
  return defaultHarnessRegex.test(source);
}
