import type { z } from 'zod';

/** Outcome of a deterministic learning-material validation; errors are fatal, warnings are advisory. */
export interface ValidationResult {
  errors: string[];
  warnings: string[];
}

export function formatValidationReport(label: string, result: ValidationResult): string {
  const headline =
    result.errors.length === 0
      ? `${label}: OK${result.warnings.length > 0 ? ` (${countText(result.warnings.length, 'warning')})` : ''}`
      : `${label}: NG (${[
          countText(result.errors.length, 'error'),
          result.warnings.length > 0 ? countText(result.warnings.length, 'warning') : '',
        ]
          .filter((text) => text.length > 0)
          .join(', ')})`;
  const lines = [
    headline,
    ...result.errors.map((error) => `  error: ${error}`),
    ...result.warnings.map((warning) => `  warning: ${warning}`),
  ];
  return `${lines.join('\n')}\n`;
}

function countText(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

export function formatZodIssues(error: z.ZodError, prefix: string): string[] {
  return error.issues.map(
    (issue) =>
      `${prefix}: ${issue.path.length > 0 ? `${issue.path.join('.')}: ` : ''}${issue.message}${describeUnionBranches(issue)}`
  );
}

// A union reports only "Invalid input", hiding the branch messages that say what was expected.
function describeUnionBranches(issue: z.core.$ZodIssue): string {
  if (issue.code !== 'invalid_union') return '';
  const branchMessages = [...new Set(issue.errors.flat().map((branchIssue) => branchIssue.message))];
  return branchMessages.length > 0 ? ` (${branchMessages.join('; ')})` : '';
}

export function reportDuplicateIds(ids: string[], itemType: string, errors: string[]): void {
  const seenIds = new Set<string>();
  const duplicateIds = new Set<string>();
  for (const id of ids) {
    (seenIds.has(id) ? duplicateIds : seenIds).add(id);
  }
  if (duplicateIds.size > 0) {
    errors.push(`duplicate ${itemType} IDs: ${[...duplicateIds].join(', ')}`);
  }
}
