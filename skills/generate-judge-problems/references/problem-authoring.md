# Problem authoring guide

## Machine-grading constraints

Problems are graded automatically against prepared test cases, so every problem must satisfy:

- The output must be uniquely determined by the input (or checkable by a regex). Never create problems whose expected output varies per learner (e.g. printing the learner's own name).
- No interactivity: the program must not require additional user actions or input during execution.
- Use standard input/output. Never create problems that use no stdio or whose expected output is an empty string, except for (a) file input/output problems judged by the default judge through `<id>.fin/` and `<id>.fout/` (see [problem-format.md](problem-format.md)), which need neither stdin nor stdout, and (b) problems with a custom `judge.ts` that judges an output file (e.g. a saved image) instead of stdout, which define their own input contract (stdin, `.fin/` or both) and need no stdout.
- Never include an empty string as an input value in string-input problems (it breaks input parsing).
- Skip topics that cannot be machine-graded instead of forcing a workaround (e.g. do not substitute `console.log` for JavaScript's `alert`).
- The problem must be solvable without information that only appears in the lecture material.

## Difficulty levels

- 初級 (beginner): basic programs using a single learned concept. Provide plenty of these to cement fundamentals.
- 中級 (intermediate): apply learned concepts to new situations.
- 上級 (advanced): combine multiple learned concepts into a more complex program.
- 超級 (expert): open-ended or practical challenges solved by applying learned knowledge independently.

Problems at 中級 and above should be optional challenges: learners who skip them can still progress.

## Statement writing rules

- Match the statement to what the learner has already studied; never require unlearned concepts in the statement or the intended solution. Input parsing (stdin reading) is the one exception: when it has not been taught yet, provide input-reading boilerplate via `templates/` and show it in the statement instead of skipping the problem.
- Write concise, unambiguous Japanese that beginners can understand.
- Omit preambles irrelevant to solving the problem (e.g. 「プログラミングの第一歩として」).
- Specify edge-case behavior explicitly (e.g. truncation of negative integers, modulo of negatives) so no ambiguity remains.
- When the output contains decimals, state 「結果を少なくとも小数点以下6桁まで表示すること」 and define the accepted absolute/relative error (e.g. $10^{-6}$).
- Use only whitespace and newlines as input delimiters; use commas only when the problem is about CSV.
- When the problem targets fixed, predetermined data (e.g. a specific integer sequence), present a code fragment initializing a variable with that data in the statement (e.g. `const fibArray = [1, 1, 2, 3, 5, 8, 13, 21];`) instead of feeding it via test-case input.
- Give code blocks a syntax-highlighting language (e.g. ` ```python `).

## 制約 section rules

Always include a `## 制約` section stating input ranges (e.g. `$1 \leq N \leq 10^9$`, 「入力は全て整数である。」). When the problem's goal is to practice a specific syntax or function:

- Require the target construct explicitly (e.g. 「`for`文を使ってください」, 「`**`演算子を使ってください」, 「`abs`関数を使ってください」).
- Forbid shortcut constructs that bypass the learning goal (e.g. 「`while`文を使ってはいけません」, 「`eval`関数を使ってはいけません」).
- Never forbid classes or functions needed to parse the input (e.g. `Scanner`, `map`, `int`, `split`, regexes) — forbidding them makes the problem unsolvable.
- Both the learner's submission and any provided modules must satisfy the constraints; allow every construct that a provided module needs.
- Mirror these constraints in the frontmatter `requiredRegExpsInCode` / `forbiddenRegExpsInCode` / `forbiddenTextsInCode` fields so they are enforced mechanically.
