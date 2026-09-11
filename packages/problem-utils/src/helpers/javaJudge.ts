import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { TestCaseResult } from '../types/testCaseResult.js';

type OutputFile = NonNullable<TestCaseResult['outputFiles']>[number];
export const MAX_OUTPUT_LENGTH = 50_000;

export async function resolveJavaRelativePath(sourcePath: string, fallbackRelativePath: string): Promise<string> {
  const sourceCode = await fs.promises.readFile(sourcePath, 'utf8');
  const packageMatch = /^\s*package\s+([a-zA-Z0-9_.]+)\s*;/m.exec(sourceCode);
  if (!packageMatch?.[1]) {
    return fallbackRelativePath;
  }

  return path.join(packageMatch[1].replaceAll('.', '/'), path.basename(fallbackRelativePath));
}

export async function listSubmissionFiles(rootDir: string): Promise<string[]> {
  const filePaths: string[] = [];
  await collectSubmissionFiles(rootDir, '', filePaths);
  return filePaths.toSorted();
}

async function collectSubmissionFiles(rootDir: string, relativeDir: string, filePaths: string[]): Promise<void> {
  const currentDir = relativeDir ? path.join(rootDir, relativeDir) : rootDir;
  const entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    const entryRelativePath = relativeDir ? path.join(relativeDir, entry.name) : entry.name;
    if (entry.isDirectory()) {
      await collectSubmissionFiles(rootDir, entryRelativePath, filePaths);
      continue;
    }
    if (entry.isFile()) {
      filePaths.push(entryRelativePath);
    }
  }
}

export function readOutputFiles(filePath: string): OutputFile[] | undefined {
  if (!fs.existsSync(filePath)) {
    return undefined;
  }

  // Malformed evaluator JSON remains a harness error (JUDGE_NOT_AVAILABLE), not missing screenshots.
  const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const values = z.array(z.unknown()).safeParse(parsed);
  if (!values.success) return undefined;
  const outputFileSchema = z.object({
    path: z.string(),
    data: z.string(),
    encoding: z.literal('base64').optional(),
  });
  return values.data.flatMap((value) => {
    const result = outputFileSchema.safeParse(value);
    return result.success ? [result.data] : [];
  });
}

export function truncateOutput(value: string): string {
  return value.slice(0, MAX_OUTPUT_LENGTH);
}
