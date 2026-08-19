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
  const judgeContent = await readFileOrUndefined(path.join(problemDir, 'judge.ts'));
  const foundFileNames: HarnessFileName[] = [];
  if (judgeContent !== undefined && isDefaultStdioHarnessSource(judgeContent, HARNESS_FILE_PRESETS['judge.ts'])) {
    foundFileNames.push('judge.ts');
  }
  // A problem with a custom judge.ts gets no stdioDebugPreset fallback, so it must commit its own
  // debug.ts — even one whose content matches the default stdio debug harness.
  const hasCustomJudge = judgeContent !== undefined && foundFileNames.length === 0;
  if (!hasCustomJudge) {
    const debugContent = await readFileOrUndefined(path.join(problemDir, 'debug.ts'));
    if (debugContent !== undefined && isDefaultStdioHarnessSource(debugContent, HARNESS_FILE_PRESETS['debug.ts'])) {
      foundFileNames.push('debug.ts');
    }
  }
  return foundFileNames;
}

async function readFileOrUndefined(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Whether the source consists only of importing the given stdio preset from this package (or its
 * legacy `judge-utils` name) and awaiting it, i.e. it is semantically identical to the default
 * harness the server generates. Comments count as a difference on purpose: a harness kept for
 * demonstration can add an explanatory comment to be treated as custom.
 */
export function isDefaultStdioHarnessSource(source: string, presetName: string): boolean {
  const importRegex = new RegExp(
    String.raw`^\s*import\s*\{\s*${presetName}(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*,?\s*\}\s*from\s*` +
      String.raw`(['"])(?:@exercode/problem-utils|judge-utils)/presets/stdio(?:\.js)?\2\s*;?\s*`
  );
  const importMatch = importRegex.exec(source);
  if (!importMatch) return false;
  const localPresetName = (importMatch[1] ?? presetName).replaceAll('$', String.raw`\$`);
  const callRegex = new RegExp(String.raw`^await\s+${localPresetName}\s*\(\s*import\.meta\.dirname\s*\)\s*;?\s*$`);
  return callRegex.test(source.slice(importMatch[0].length));
}
