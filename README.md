# @exercode/problem-utils

[![npm version](https://img.shields.io/npm/v/@exercode/problem-utils.svg)](https://www.npmjs.com/package/@exercode/problem-utils)
[![Test](https://github.com/WillBooster/exercode-problem-utils/actions/workflows/test.yml/badge.svg)](https://github.com/WillBooster/exercode-problem-utils/actions/workflows/test.yml)
[![semantic-release](https://img.shields.io/badge/%20%20%F0%9F%93%A6%F0%9F%9A%80-semantic--release-e10079.svg)](https://github.com/semantic-release/semantic-release)
[![wbfy](https://img.shields.io/badge/wbfy-20.10.0-1e90ff.svg)](https://github.com/WillBooster/shared/tree/main/packages/wbfy)

:100: A set of utilities for judging programs on Exercode (https://exercode.willbooster.com/).

## Packages

| Package                           | Purpose                                                                                                  |
| --------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `@exercode/problem-utils`         | CLI, validation, result types, and stdio/command/GUI/evaluation presets; no browser or AI SDK dependency |
| `@exercode/problem-utils-browser` | Playwright Chromium lifecycle, browser judging, and screenshots                                          |
| `@exercode/problem-utils-llm`     | LLM judging and AI SDK providers                                                                         |

Install only the packages the problem uses. Import `llmJudgePreset` from
`@exercode/problem-utils-llm`. Browser judges receive Playwright's native `Page`:

```ts
import { DecisionCode } from '@exercode/problem-utils';
import { browserJudgePreset } from '@exercode/problem-utils-browser';

await browserJudgePreset({
  testCases: [
    [
      'heading',
      async (page) => ({
        decisionCode: (await page.locator('h1').count()) === 1 ? DecisionCode.ACCEPTED : DecisionCode.WRONG_ANSWER,
      }),
    ],
  ],
});
```

The browser preset serves the submitted directory, runs checks in order on one page,
prints each result, stops on the first non-accepted result, and closes the browser even
when a check throws. Checks return learner-facing verdicts; uncaught harness errors
propagate to the caller. Use `timeoutMs`, `contextOptions`, and `launchOptions` to set
problem-specific requirements. `screenshotOnFailure` attaches a full-page image to a
non-accepted result; capture failures are recorded in `stderr` without replacing the verdict.
`launchBrowser` and `captureScreenshot` are also exported for harnesses that manage their
own HTTP server or test loop.

The browser package depends on `playwright-core`; installing the package does not
install Chromium. Install the matching Chromium with `playwright-core install chromium`
in the environment containing that dependency. Docker/CI should install its OS
libraries at image build/setup time. Browser versions must match the installed
Playwright version. Install the fonts required by the course content in that environment.

## HTML comparison

`htmlJudgePreset({ solutionDirectoryPath, requiredFiles? })` compares the submitted
page with the specified model-answer directory. It reports `snapshot_body` first,
then `screenshot`, stopping on the first difference. The DOM comparison ignores
comments and normalizes text whitespace and attribute order. Screenshots render
formatted HTML at 800×600, with CSS animations disabled and fonts loaded; a difference
includes both PNG files. If either document cannot be formatted, both are rendered raw.
Each check uses fresh pages for both answers. Pixel comparison requires deterministic
page content; JavaScript timers, random content, and animated images are not frozen. Missing required files are reported before starting Chromium.

For isolated judging, keep shared assets inside the problem directory.
Both directories can use the nearest ancestor's `assets` directory, through `assets/`
or directly from the served root. Local assets are merged with that shared directory;
submission files and links take precedence, followed by local assets. A directory
symlink overrides that entire directory rather than merging shared files into its target. Source files and
linked directories are left unchanged. The temporary
served directories and browser are closed after judging. `captureHtmlBodySnapshot`,
`captureHtmlScreenshot`, and `createHtmlServedDirectory` expose the same operations
for custom checks. See the [HTML example](example/web_page_comparison/judge.ts).

## CLI

The package ships an `exercode-problem` command for problem authors (run it with `bun x` in a repository that depends on `@exercode/problem-utils`):

```bash
# Judge all model answers of all problems (directories containing problem.md or <id>.problem.md) under a directory.
# model_answers/* must be fully accepted; model_answers.fails/* must fail at least one test case.
bun x exercode-problem                # everything under the current directory
bun x exercode-problem courses/foo    # everything under courses/foo
bun x exercode-problem --only a_plus --skip gui_ --concurrency 2

# Judge one answer directory of the problem in the current directory.
bun x exercode-problem judge model_answers/python
bun x exercode-problem judge model_answers/python '{ "language": "python" }'

# Debug one answer directory of the problem in the current directory.
bun x exercode-problem debug model_answers/python '{ "stdin": "1 2" }'
```

`judge` and `debug` run a custom `judge.ts` / `debug.ts` when the problem has one, and apply `stdioJudgePreset` / `stdioDebugPreset` otherwise, mirroring the Exercode server. The debug fallback applies only to standard problems: a problem with a custom `judge.ts` needs its own `debug.ts`, and `exercode-problem debug` fails with a message otherwise (the server likewise reports debug as unsupported there).

The all-problem check judges serially by default because time limits are measured in wall-clock time; pass `--concurrency <n>` to parallelize when the checked problems are not timing-sensitive.

A standard stdin/stdout problem must NOT commit a `judge.ts` or `debug.ts` that is identical to the default stdio harness: the absence of `judge.ts` marks the problem as standard, and committed copies would drift from the server's defaults. The CLI rejects such files; a file kept intentionally (e.g. to demonstrate the default harness) can add an explanatory comment to be treated as custom.

## Validators

The CLI also validates learning-material files without running any program, mirroring the checks the Exercode importer applies:

```bash
# Validate problem directories (problem.md frontmatter, test_cases, model_answers, templates, judge.ts / debug.ts).
bun x exercode-problem validate-problem <problemDir>...
# Validate a course directory (course.yaml, lecture materials with embedded questions, problem references).
bun x exercode-problem validate-course <courseDir> [--problems-dir <dir>]
# Validate a contest (*.contest.yaml) file.
bun x exercode-problem validate-contest <contestYamlPath> [--problems-dir <dir>]
```

Each target prints `OK` or `NG` followed by its errors and warnings; the command exits 1 when any target has an error. `--problems-dir` points to the directory holding the referenced problems; a course is always searched at any depth, since Exercode links a material only to the problems inside its course, so for a course the option must name a directory inside it. The validators are also exported (`validateProblemDirectory`, `validateCourseDirectory`, `validateContestFile`, `validateMaterialFile`).

## Agent skills

The [`skills/`](skills/) directory holds skills for AI coding agents that author and review Exercode learning content: `generate-learning-content` (entry point), `generate-course-materials`, `generate-judge-problems`, `generate-judge-contest`, `review-learning-content`, and `setup-exercode-course-repository`. Agents working in this repository load them through the symlinks under `.claude/skills/`; install them elsewhere with the [skills](https://github.com/vercel-labs/skills) CLI:

```bash
bun x skills add WillBooster/exercode-problem-utils --agent claude-code --agent codex
```

## Test cases

A problem keeps its test cases under `test_cases/`. A test case id is the shared name of the following entries, and each entry is optional:

| Entry          | Meaning                                                                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<id>.in`      | Standard input. Omit it (or leave it empty) when the program reads nothing.                                                                       |
| `<id>.out`     | Expected standard output.                                                                                                                         |
| `<id>.fin/`    | Files copied into the working directory before the run (input files).                                                                             |
| `<id>.fout/`   | Expected output files, compared with the files of the same relative paths in the working directory.                                               |
| `_shared.fin/` | Files copied into the working directory before every test case.                                                                                   |
| `<id>.json`    | Configuration for a custom `judge.ts` that reads it itself; the presets ignore it (the Judge server lists it as a test case of the custom judge). |

A test case whose id contains `example` (the judge server's rule, e.g. `example_1` or `01_example_small`) is an example shown to learners; every other case is hidden.

Standard output and text files are compared as space-separated tokens: consecutive white spaces count as one separator, and an expected token that contains a decimal point and parses as a finite number (e.g. `3.14`, but not `1`, `1e-3` or `1.0e309`) accepts a value within an absolute or relative error of `1e-6`. A file is text when it is valid UTF-8 without NUL bytes; other files (e.g. images) must match byte for byte. A received file larger than 8 MiB counts as not produced, an expected file larger than 8 MiB is an authoring error (the case is reported as a runtime error), and a file larger than 1 MiB is left out of the reported pair. When a file differs, the result carries `<name>_expected.<ext>` and `<name>_received.<ext>` so Exercode can show both (Exercode decides per test case whether a learner may see them, as it does for expected stdout).

How a missing expectation is treated depends on the harness:

- `stdioJudgePreset` (the default for problems without `judge.ts`) requires `<id>.out` or a non-empty `<id>.fout/` for every test case, so a standard problem cannot accept a run without checking it. A problem whose `problem.md` declares `requiredOutputFilePaths` or `isManualScoringRequired` is exempt, because every test case is judged by those instead; code rules (`requiredRegExpsInCode` etc.) and `requiredSubmissionFilePaths` check the submission once, in addition to the output comparison, and do not exempt.
- `commandJudgePreset` without a `test` option checks whatever expectations exist, and a test case with neither only has to run within the limits. A `test` option replaces that comparison; it receives `testCase.output`, `testCase.fileOutputPath` and `cwd` and can call the exported `judgeAgainstExpectations` (or `compareStdoutAsSpaceSeparatedTokens` and `compareExpectedOutputFiles`). A custom `readTestCases` may return any test case type with `id` (plus optional `input` and `fileInputPath`); the default verdict judges any case that exposes a string `output` or `fileOutputPath`, which the default reader's `CommandTestCase` does.
- `guiCommandJudgePreset` passes the expectations to the problem's `test`, which decides everything.
- `llmJudgePreset` runs no program, so it copies no `.fin/`; it hands `<id>.in` as the prompt input and the whole entry (including `fileOutputPath`) to the problem's `test`.
- `stdioDebugPreset` by default copies the answer directory to a temporary directory and builds and runs it there together with `_shared.fin/` and the first example case's `.fin/` (the case's files win; hidden cases' inputs are never handed to learner code), so the answer directory is left untouched (its `node_modules`, and those of its ancestors, are linked into the copy rather than duplicated); files the program writes are reported only through `requiredOutputFilePaths`. Callers that already own a disposable answer directory can pass `{ disposableWorkingDirectory: true }` as the second argument to build and run directly there; they must remove it themselves, including when the harness is terminated.
- `evaluationJudgePreset` does not use `test_cases/`.

`readTestCases` is exported for harnesses that enumerate `test_cases/` themselves.

## Measurements

`stdioJudgePreset`, `stdioDebugPreset`, and `commandJudgePreset` (with its default runner; a custom `runCommand` decides whether its results carry `cpuTimeSeconds`) run a program under GNU time (`/usr/bin/time` on Linux, `gtime` on macOS) and report its wall time (`timeSeconds`), user plus system CPU time (`cpuTimeSeconds`), and peak resident set size (`memoryBytes`, at least the footprint of the GNU `timeout` wrapper the program runs under, about 1 MiB) in every test case result; `guiCommandJudgePreset` reports the wall time and the peak resident set size, and `llmJudgePreset` the wall time only. Time limits are judged by wall time. The CPU time is recorded even for a run that exceeded its limit, so a judge server sharing CPUs between programs can tell a program that used up its limit (its CPU time, summed over its threads, reaches the limit, so it would exceed it on any single CPU) from one that may only have waited for a CPU (its CPU time stays below the limit) and re-run just the latter alone.

`browserJudgePreset` forwards measurements returned by each check; it does not measure elapsed time, CPU time, or memory automatically. Its `timeoutMs` bounds individual Playwright operations, not the complete check. Checks that require their own measurements or time-limit verdicts must provide them explicitly. The hosting judge can independently limit the overall harness process.
