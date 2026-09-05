# Judge v2 problem directory format

## Layout

```
<problem_id>/                 # id = folder name, matching /^[0-9_a-z-]+$/
  problem.md                  # v2 marker: the filename is exactly problem.md
  judge.ts                    # custom judges ONLY — omit for standard stdin/stdout problems
  debug.ts                    # custom debug harness — usually pairs with a custom judge.ts, but may also stand alone
  test_cases/
    example_1.in              # ids starting with "example" are shown on the problem page
    example_1.out
    test_1.in                 # hidden test case
    test_1.out
    ...
  model_answers/<languageId>/...   # at least one; e.g. python/main.py, javascript/main.mjs, java/Main.java
  templates/<languageId>/...       # optional starter code; templates/_default/ is the fallback for the other languages
```

## judge.ts and debug.ts

A standard stdin/stdout problem must NOT contain judge.ts, and normally contains no debug.ts
either. The absence of judge.ts marks the problem as standard: the judge server automatically
judges it with `stdioJudgePreset` and provides the debug feature with `stdioDebugPreset`. Never
commit copies of these default harnesses — a committed copy can drift from the server's default,
and a default-content judge.ts hides the standard-problem marker (disabling the automatic debug
runner). The validator and the `exercode-problem` CLI reject a default-content judge.ts always, and
a default-content debug.ts unless it accompanies a custom judge.ts (a custom judge may legitimately
reuse the stdio debug preset); any other content, even an added comment, makes the file a custom
harness. A CUSTOM `debug.ts` without `judge.ts` is allowed: the judge runs `debug.ts` whenever it
is present, so it can customize debugging for a problem judged by the default stdio judge.

Only custom judges (GUI, LLM, command-based, and other special judging) provide a `judge.ts`, using
helpers such as `commandJudgePreset`, `guiCommandJudgePreset`, and `llmJudgePreset` from
`@exercode/problem-utils`. A custom judge should ship a `debug.ts` as well; without it the debug
feature is unavailable for the problem.

To verify a problem's answers locally, run the `exercode-problem` CLI (shipped with
`@exercode/problem-utils`) from the problem directory: `bunx exercode-problem judge <answerDir> [paramsJson]`. It judges the answer directory with the same harness the judge server uses — the
problem's own `judge.ts` when present, the standard stdio judge otherwise — printing one
`TEST_CASE_RESULT` + JSON line per judged test case (the stdio judge stops at the first
non-accepted case); decision code `2000` means accepted. A successful run exits 0 and prints at least one result line —
a non-zero exit with no result line means the problem was never judged, not that it passed.
Harnesses that need parameters take them as the JSON second argument (e.g. `'{ "model": "<modelId>" }'`
for an LLM judge, or `'{ "language": "<languageId>" }'` when the answer directory name is not a
language ID):

```bash
cd <problemDir> && bunx exercode-problem judge model_answers/<languageId>
```

`bunx exercode-problem debug <answerDir> '{ "stdin": "..." }'` runs the debug harness the same
way. To check every problem under a directory at once (every `model_answers/*` directory must be
fully accepted), run `bunx exercode-problem <problemsDir>`. Batch mode judges every discovered
`model_answers/*` directory without params, so a problem whose harness requires params (e.g. an
LLM judge) fails the batch run — exclude such problems with `--skip <substring>` (or select with
`--only`) and judge them individually with their params JSON.

## problem.md frontmatter

YAML frontmatter followed by the markdown statement. The schema is strict: unknown keys are errors.

- `name` (required, non-empty string)
- `type`: only `'prompt_study'` is allowed (optional; omit for normal problems)
- `timeLimitMs`: integer >= 0; `memoryLimitByte`: integer >= 0
- `requiredRegExpsInCode`, `forbiddenRegExpsInCode`, `forbiddenTextsInCode`: arrays whose entries are a pattern string or `{ pattern, message }` (a single-line learner-facing message shown instead of the pattern on violation)
  - Required regexps must match every model answer's main source (comments stripped); forbidden regexps/texts must match none.
  - The patterns apply to submissions in every available language, so use patterns every target language's idiomatic solution satisfies (e.g. `\bfor\b`), never language-specific ones (e.g. `range\(`). If the learning target is language-specific, keep the constraint in the statement prose and restrict `availableLanguageIds` on the material instead.
  - Never forbid patterns that could match input-parsing helpers (`Scanner`, `map`, `int`, `split`, regexes) — learners could not pass otherwise.
  - Every regexp must compile.
- `canCreateFiles`, `isEditorDisabled`, `isAttachedFileRequired`, `isManualScoringRequired`, `isVotable`: booleans
- The v1 judge keys `judgeEnvironmentId`, `generalJudgeEnvironmentConfigOverrides`, `testCases`, and `isGui` were removed; the server and the validator reject them.
- `requiredEnvironmentVariables`: string array, each matching `/^\w+$/`
- `requiredOutputFilePaths`, `requiredSubmissionFilePaths`: string arrays

## Statement body

Japanese, with these sections in order: `## 問題文`, `## 制約`, `## 入力`, `## 出力`, then `## 入力例1` / `## 出力例1`, `## 入力例2` / `## 出力例2`, ... matching the `example_*` test cases (for an input-only problem — see Test cases below — `## 出力` describes the judged output file, and each `## 出力例N` shows that file for the example input, e.g. an embedded image, instead of stdout). Separate section groups with `---` lines as in [example-problem.md](example-problem.md). Write math in `$...$` LaTeX. If the statement has no 入力例/出力例/サンプルケース heading, the server auto-appends the example cases from their `.in`/`.out`; an example case whose input and output live only in `.fin/` or `.fout/` is not appended, so write its 入力例/出力例 by hand with a heading per file.

## Test cases

- A test case id is the shared name of these optional entries: `<id>.in` (stdin; omit it when the program reads nothing — an empty file also works), `<id>.out` (expected stdout), `<id>.fin/` (input files copied into the working directory before the run), `<id>.fout/` (expected output files compared with the same relative paths in the working directory), and `_shared.fin/` (input files copied for every case). A standard problem (no `judge.ts`) needs `.out` or a non-empty `.fout/` for every case: the validator rejects a case without an expectation, and the default stdio judge refuses to run such a problem; only a problem whose frontmatter judges every case otherwise (`isManualScoringRequired` or `requiredOutputFilePaths`) is exempt; code rules and `requiredSubmissionFilePaths` check the submission once, add to the output comparison and do not exempt. Without `.out`, stdout is not compared, so a `.fout/`-only case may print anything. `<id>.json` is configuration that only a custom `judge.ts` reads (the validator rejects it without one; the presets ignore it, and the judge server lists it as a test case of the custom judge); do not generate it by default.
- A problem with a custom `judge.ts` that judges something other than stdout (e.g. a file listed in `requiredOutputFilePaths`, such as a saved image) may ship `.in` only (uniformly: the validator warns about a missing `.out` or `.fout/` when other cases have one; a case that carries a `.json` is exempt, and `.json` itself is configuration, not an expectation); do not make such a problem print a marker (e.g. the output file name) just to have stdout to compare.
- Outputs are compared token by token: both sides are trimmed at both ends and split on whitespace runs, token counts must match, and a token is compared numerically (absolute or relative error up to `1e-6`) only when the expected token contains `.` and parses as a number; all other tokens must match exactly. Text files under `.fout/` follow the same rule; binary files (e.g. images) must match byte for byte.
- At least 1 `example_*` case and at least 1 hidden case are required; provide at least 4 cases in total (the validator warns below 4).
- Do not duplicate `.in` contents across cases (the validator compares stdin only, not `.fin/` contents), and never produce an empty `.out` (omit the file instead when stdout is not compared; the validator warns about one). A `.out` must not exceed 50,000 characters: the stdio judge rejects a longer run output (and a trailing newline counts).

## Templates

Starter code under `templates/<languageId>/` (or `templates/_default/`; files placed directly under `templates/` also count as `_default`) must be incomplete: it must not solve the problem, and no template file may be identical to a model answer file. When a problem provides helper modules to learners (e.g. a module to import), ship them via templates.
