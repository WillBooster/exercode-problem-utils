# judge.ts と採点プリセット

プリセット API は変わる可能性がある。作業時は必ず現在の `src/presets/*.ts` または installed package の `dist/presets/*.d.ts` を確認する。

## 標準入出力: `stdioJudgePreset`

単純な入力→出力問題の既定。

```ts
import { stdioJudgePreset } from '@exercode/problem-utils/presets/stdio';

await stdioJudgePreset(import.meta.dirname);
```

検証:

```bash
bun judge.ts model_answers/python '{"language":"python"}'
```

挙動:

- `test_cases/<id>.in` を stdin として実行し、`<id>.out` と比較する。
- 出力は空白区切りトークン比較。
- 浮動小数点は絶対/相対誤差 `1e-6`。
- `requiredOutputFilePaths` がある場合は出力ファイル存在も見る。

## 独自判定: `commandJudgePreset`

次の場合の既定:

- JSON など構造化出力を厳密に比較する。
- 提出コードの import、関数呼び出し、モデル名などを静的検査する。
- 入力ファイルを動的生成する。
- `runCommandInTemporaryPackageManagerProject` で `package.json` など問題内ファイルを一時プロジェクトへ持ち込みたい。
- `model_answers.fails/` をまとめて検証したい。

最小形:

```ts
import { DecisionCode } from '@exercode/problem-utils';
import { commandJudgePreset } from '@exercode/problem-utils/presets/command';

await commandJudgePreset(import.meta.dirname, {
  readTestCases: async () => [{ id: 'test_1', input: '1 2', expected: '3' }],
  test: ({ runResult, testCase }) =>
    runResult.stdout.trim() === testCase.expected
      ? { decisionCode: DecisionCode.ACCEPTED }
      : { decisionCode: DecisionCode.WRONG_ANSWER },
});
```

検証:

```bash
bun judge.ts
```

cwd を省くと `model_answers/*` と `model_answers.fails/*` を列挙し、正解は受理、失敗解答は棄却されることを確認する。デバッグモードでは、問題ディレクトリだけを一時ディレクトリにコピーして judge が動くかも確認する。

## LLM prompt: `llmJudgePreset`

提出物に `prompt.txt` を要求し、各 test case input を `{input}` に差し込んで LLM 出力を判定する。`requiredEnvironmentVariables` に必要な API key を書く。

```ts
import { DecisionCode } from '@exercode/problem-utils';
import { llmJudgePreset } from '@exercode/problem-utils/presets/llm';

await llmJudgePreset(import.meta.dirname, {
  test: ({ result }) =>
    result.output.includes('expected')
      ? { decisionCode: DecisionCode.ACCEPTED }
      : { decisionCode: DecisionCode.WRONG_ANSWER },
});
```

検証時は model を params JSON で渡す:

```bash
bun judge.ts model_answers/default '{"model":"openai/gpt-5.4-nano"}'
```

## judge を自作するとき

プリセットで足りない場合は `parseArgs`, `printTestCaseResult`, `DecisionCode`, `startHttpServer` などのヘルパを使う。結果は必ず `printTestCaseResult` かプリセット経由で `TEST_CASE_RESULT {...}` として出す。

自作時の注意:

- 採点は決定的にする。時刻や乱数に依存させない。
- 余計な標準出力を混ぜない。学習者向け情報は `feedbackMarkdown` に入れる。
- 問題ディレクトリ外の相対 import をしない。補助ファイルは問題内に同梱する。
- source inspection ではコメント/文字列を除去してから見るか、誤検知しない正規表現にする。

## SMART-SE の TypeScript JSON 問題パターン

`exercode-sakamoto-smartse-courses` では、`jsonProblemJudge.ts` を各問題へ同梱し、次の流れで判定している:

1. `commandJudgePreset` の `readTestCases` で stdin と期待 JSON を定義。
2. `runCommandInTemporaryPackageManagerProject` で `bun run main.ts` を実行し、問題内 `package.json` を一時プロジェクトへコピー。
3. `validateSource` で SDK import、関数呼び出し、モデル名などを検査。
4. stdout を JSON.parse し、期待 JSON と深い比較をする。

このパターンを使う場合、`jsonProblemJudge.ts` と `package.json` は問題ディレクトリに含める。コース直下の共通ファイルへ import しない。
