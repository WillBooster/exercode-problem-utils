# @exercode/problem-utils

[![Test](https://github.com/WillBooster/exercode-problem-utils/actions/workflows/test.yml/badge.svg)](https://github.com/WillBooster/exercode-problem-utils/actions/workflows/test.yml)
[![semantic-release](https://img.shields.io/badge/%20%20%F0%9F%93%A6%F0%9F%9A%80-semantic--release-e10079.svg)](https://github.com/semantic-release/semantic-release)
[![wbfy](https://img.shields.io/badge/wbfy-19.2.0-1e90ff.svg)](https://github.com/WillBooster/shared/tree/main/packages/wbfy)

:100: A set of utilities for judging programs on Exercode (https://exercode.willbooster.com/).

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

## Test cases

A problem keeps its test cases under `test_cases/`. A test case id is the shared name of the following entries, and each entry is optional:

| Entry          | Meaning                                                                                                                           |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `<id>.in`      | Standard input. Omit it (or leave it empty) when the program reads nothing.                                                       |
| `<id>.out`     | Expected standard output.                                                                                                         |
| `<id>.fin/`    | Files copied into the working directory before the run (input files).                                                             |
| `<id>.fout/`   | Expected output files, compared with the files of the same relative paths in the working directory.                               |
| `_shared.fin/` | Files copied into the working directory before every test case.                                                                   |
| `<id>.json`    | Configuration for a custom `judge.ts` that reads it itself; the presets ignore it, and it does not create a test case on its own. |

Standard output and text files are compared as space-separated tokens: consecutive white spaces count as one separator, and an expected token that contains a decimal point and parses as a number (e.g. `3.14`, but not `1` or `1e-3`) accepts a value within an absolute or relative error of `1e-6`. A file is text when it is valid UTF-8 without NUL bytes; other files (e.g. images) must match byte for byte. When a file differs, the result carries `<name>_expected.<ext>` and `<name>_received.<ext>` so Exercode can show both (Exercode decides per test case whether a learner may see them, as it does for expected stdout).

How a missing expectation is treated depends on the harness:

- `stdioJudgePreset` (the default for problems without `judge.ts`) requires `<id>.out` or a non-empty `<id>.fout/` for every test case, so a standard problem cannot accept a run without checking it. A problem whose `problem.md` declares `requiredOutputFilePaths` is exempt, because the presence of those files is judged.
- `commandJudgePreset` without a `test` option checks whatever expectations exist, and a test case with neither only has to run within the limits. A `test` option replaces that comparison; it receives `testCase.output` and `testCase.fileOutputPath` and can call the exported `compareStdoutAsSpaceSeparatedTokens` and `compareExpectedOutputFiles`.
- `guiCommandJudgePreset` passes the expectations to the problem's `test`, which decides everything.
- `llmJudgePreset` runs no program, so it copies no `.fin/`; it hands `<id>.in` as the prompt input and the whole entry (including `fileOutputPath`) to the problem's `test`.
- `stdioDebugPreset` copies `_shared.fin/` and the first test case's `.fin/` into the working directory before the debug run.
- `evaluationJudgePreset` does not use `test_cases/`.

`readTestCases` is exported for harnesses that enumerate `test_cases/` themselves.
