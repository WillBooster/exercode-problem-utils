import fs from 'node:fs';
import path from 'node:path';

import { DecisionCode, parseArgs, printTestCaseResult } from '@exercode/problem-utils';
import { launchBrowser } from './browser.js';
import { startEmptyPageServer } from './emptyPageServer.js';

export async function javascriptDomJudgePreset(problemDir: string): Promise<void> {
  const args = parseArgs(process.argv);
  if (!args.cwd) throw new Error('cwd argument required');
  const testCasesDir = path.join(problemDir, 'test_cases');

  // Find user code
  const entryFile = fs.readdirSync(args.cwd).find((f) => f.endsWith('.mjs') || f.endsWith('.js'));
  if (!entryFile) {
    printTestCaseResult({
      testCaseId: 'setup',
      decisionCode: DecisionCode.WRONG_ANSWER,
      stderr: 'No .mjs or .js file found',
    });
    return;
  }
  const userProgram = fs.readFileSync(path.join(args.cwd, entryFile), 'utf8');

  // Collect test case IDs
  const testCaseIds = [
    ...new Set(
      fs
        .readdirSync(testCasesDir)
        .filter((f) => f.endsWith('.in'))
        .map((f) => f.replace('.in', ''))
    ),
  ].toSorted();

  await using server = await startEmptyPageServer();
  const browser = await launchBrowser();
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    for (const testCaseId of testCaseIds) {
      const input = fs.readFileSync(path.join(testCasesDir, `${testCaseId}.in`), 'utf8');
      const expectedOutput = fs.readFileSync(path.join(testCasesDir, `${testCaseId}.out`), 'utf8').replace(/\n$/, '');

      const page = await context.newPage();
      page.setDefaultTimeout(5000);

      try {
        await page.goto(server.url, { waitUntil: 'domcontentloaded' });

        // Install console.log interceptor in page context
        // This captures ALL logs including those from overridden console.log in .in files
        await page.evaluate(() => {
          const { console } = globalThis;
          (globalThis as typeof globalThis & { __capturedLogs: string[] }).__capturedLogs = [];
          const originalLog = console.log;
          console.log = (...logArgs: unknown[]) => {
            const formatted = logArgs
              .map((arg) => {
                if (arg === null) return 'null';
                if (arg === undefined) return 'undefined';
                if (arg instanceof Node) return 'JSHandle@node';
                if (Array.isArray(arg)) return '[' + arg.join(', ') + ']';
                // oxlint-disable-next-line typescript/no-base-to-string -- Exercise console output follows JavaScript string coercion.
                return String(arg);
              })
              .join(' ');
            (globalThis as typeof globalThis & { __capturedLogs: string[] }).__capturedLogs.push(formatted);
            originalLog.apply(console, logArgs);
          };
        });

        // Clear localStorage for each test case
        await page.evaluate(() => localStorage.clear());

        // Run setup code from .in file (NOT wrapped - window.test etc. need global scope)
        if (input.trim()) {
          await page.evaluate(input);
        }

        const autoCallTest = input.includes('window.test =') && !userProgram.includes('test()') ? 'test?.();' : '';

        // Extract top-level function declarations and expose them on window
        // so they're accessible from verifyDom/test callbacks defined in .in
        const funcNames = [...userProgram.matchAll(/^function\s+(\w+)\s*\(/gm)].map((m) => m[1]);
        const funcExports = funcNames.map((name) => `window.${name} = ${name};`).join('\n');

        await page.evaluate(`(async () => {
window.initializeTest?.();
${userProgram}
${funcExports}
${autoCallTest}
await window.verifyDom?.();
})()`);

        // Wait for async operations if setTimeout/setInterval is used
        if (/\b(?:setInterval|setTimeout)\b/.test(userProgram) || /\b(?:setInterval|setTimeout)\b/.test(input)) {
          let prevLength = -1;
          let currentLength = 0;
          while (prevLength !== currentLength) {
            prevLength = currentLength;
            await new Promise((resolve) => setTimeout(resolve, 1000));
            currentLength = await page.evaluate(
              () => (globalThis as typeof globalThis & { __capturedLogs: string[] }).__capturedLogs.length
            );
          }
        }

        // Also wait for any pending promises
        await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 100)));

        const capturedOutput = await page.evaluate(() =>
          (globalThis as typeof globalThis & { __capturedLogs: string[] }).__capturedLogs.join('\n')
        );
        const actualOutput = capturedOutput.replace(/\n$/, '');

        if (actualOutput === expectedOutput) {
          printTestCaseResult({ testCaseId, decisionCode: DecisionCode.ACCEPTED, stdout: actualOutput });
        } else {
          printTestCaseResult({
            testCaseId,
            decisionCode: DecisionCode.WRONG_ANSWER,
            stdout: actualOutput,
            stderr: `Expected:\n${expectedOutput}\n\nActual:\n${actualOutput}`,
          });
          await page.close();
          break;
        }
      } catch (error) {
        printTestCaseResult({
          testCaseId,
          decisionCode: DecisionCode.RUNTIME_ERROR,
          stderr: error instanceof Error ? error.message : String(error),
        });
        await page.close();
        break;
      }

      await page.close();
    }
  } finally {
    await browser.close();
  }
}
