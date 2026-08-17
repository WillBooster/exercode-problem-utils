# @exercode/problem-utils

[![Test](https://github.com/WillBooster/exercode-problem-utils/actions/workflows/test.yml/badge.svg)](https://github.com/WillBooster/exercode-problem-utils/actions/workflows/test.yml)
[![semantic-release](https://img.shields.io/badge/%20%20%F0%9F%93%A6%F0%9F%9A%80-semantic--release-e10079.svg)](https://github.com/semantic-release/semantic-release)
[![wbfy](https://img.shields.io/badge/wbfy-18.7.7-1e90ff.svg)](https://github.com/WillBooster/shared/tree/main/packages/wbfy)

:100: A set of utilities for judging programs on Exercode (https://exercode.willbooster.com/).

## CLI

The package ships two commands for problem authors (run them with `bun x` in a repository that depends on `@exercode/problem-utils`):

```bash
# Judge one answer directory of the problem in the current directory.
bun x exercode-judge model_answers/python
bun x exercode-judge model_answers/python '{ "language": "python" }'

# Debug one answer directory of the problem in the current directory.
bun x exercode-debug model_answers/python '{ "stdin": "1 2" }'

# Judge all model answers of all problems (directories containing problem.md) under a directory.
# model_answers/* must be fully accepted; model_answers.fails/* must fail at least one test case.
bun x exercode-judge check                # everything under the current directory
bun x exercode-judge check courses/foo    # everything under courses/foo
bun x exercode-judge check --only a_plus --skip gui_ --concurrency 2
```

Both commands run a custom `judge.ts` / `debug.ts` when the problem has one, and apply `stdioJudgePreset` / `stdioDebugPreset` otherwise, mirroring the Exercode server.

A standard stdin/stdout problem must NOT commit a `judge.ts` or `debug.ts` that is identical to the default stdio harness: the absence of `judge.ts` marks the problem as standard, and committed copies would drift from the server's defaults. The CLI rejects such files; a file kept intentionally (e.g. to demonstrate the default harness) can add an explanatory comment to be treated as custom.
