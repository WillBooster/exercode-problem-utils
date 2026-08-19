# @exercode/problem-utils

[![Test](https://github.com/WillBooster/exercode-problem-utils/actions/workflows/test.yml/badge.svg)](https://github.com/WillBooster/exercode-problem-utils/actions/workflows/test.yml)
[![semantic-release](https://img.shields.io/badge/%20%20%F0%9F%93%A6%F0%9F%9A%80-semantic--release-e10079.svg)](https://github.com/semantic-release/semantic-release)
[![wbfy](https://img.shields.io/badge/wbfy-18.7.7-1e90ff.svg)](https://github.com/WillBooster/shared/tree/main/packages/wbfy)

:100: A set of utilities for judging programs on Exercode (https://exercode.willbooster.com/).

## CLI

The package ships an `exercode` command for problem authors (run it with `bun x` in a repository that depends on `@exercode/problem-utils`):

```bash
# Judge all model answers of all problems (directories containing problem.md or <id>.problem.md) under a directory.
# model_answers/* must be fully accepted; model_answers.fails/* must fail at least one test case.
bun x exercode                # everything under the current directory
bun x exercode courses/foo    # everything under courses/foo
bun x exercode --only a_plus --skip gui_ --concurrency 2

# Judge one answer directory of the problem in the current directory.
bun x exercode judge model_answers/python
bun x exercode judge model_answers/python '{ "language": "python" }'

# Debug one answer directory of the problem in the current directory.
bun x exercode debug model_answers/python '{ "stdin": "1 2" }'
```

`judge` and `debug` run a custom `judge.ts` / `debug.ts` when the problem has one, and apply `stdioJudgePreset` / `stdioDebugPreset` otherwise, mirroring the Exercode server. The debug fallback applies only to standard problems: a problem with a custom `judge.ts` needs its own `debug.ts`, and `exercode debug` fails with a message otherwise (the server likewise reports debug as unsupported there).

The all-problem check judges serially by default because time limits are measured in wall-clock time; pass `--concurrency <n>` to parallelize when the checked problems are not timing-sensitive.

A standard stdin/stdout problem must NOT commit a `judge.ts` or `debug.ts` that is identical to the default stdio harness: the absence of `judge.ts` marks the problem as standard, and committed copies would drift from the server's defaults. The CLI rejects such files; a file kept intentionally (e.g. to demonstrate the default harness) can add an explanatory comment to be treated as custom.
