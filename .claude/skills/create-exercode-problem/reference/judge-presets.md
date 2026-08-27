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

提出物に `prompt.txt` を要求し、各 test case input を `{input}` に差し込んで LLM 出力を判定する。`requiredEnvironmentVariables` に必要な API key を書き、実装時は現在の `llmJudgePreset` の型を確認する。

検証時は model を params JSON で渡す:

```bash
bun judge.ts model_answers/default '{"model":"openai/gpt-5.4-nano"}'
```

## モデル性能評価（Kaggle 形式）: `evaluationJudgePreset`

学習者が隠しテストデータに対する予測値の CSV を提出し、judge が正解データと突き合わせて指標（RMSLE など）を計算する問題に使う。
正解 CSV は問題ディレクトリ内に置く（学習者には配布されない）。結果は `score` / `scoreLabel` として Exercode に表示される。

```ts
import { evaluationJudgePreset, evaluationMetrics } from '@exercode/problem-utils/presets/evaluation';

await evaluationJudgePreset(import.meta.dirname, {
  answerFilePath: 'evaluation/answer.csv', // 問題ディレクトリからの相対パス
  idColumn: 'Id',
  targetColumn: 'TradePrice',
  metric: evaluationMetrics.rmsle, // rmsle / rmse / mae / accuracy、または独自の EvaluationMetric
  acceptableScore: 0.5, // 省略すると形式が正しい提出を全て受理する
});
```

- 提出ファイル名は既定で `submission.csv`（`submissionFilePath` で変更可）。frontmatter の `requiredSubmissionFilePaths` にも書く。
- 提出 CSV に必要なのは `idColumn` と `targetColumn` の列で、正解の全 id が過不足なく 1 回ずつ現れること。不足・重複・数値でない値は `WRONG_ANSWER` として理由を `feedbackMarkdown` に出す。
- `model_answers/<id>/submission.csv` に正解に十分近い予測を置き、`model_answers.fails/` に行不足や精度不足の提出を置いて `bun judge.ts` で確認する。
- 標準入出力は使わないので `test_cases/` は不要。`templates/_default/submission.csv` にヘッダーだけのひな形を置ける。

## judge を自作するとき

プリセットで足りない場合は `parseArgs`, `printTestCaseResult`, `DecisionCode`, `startHttpServer` などのヘルパを使う。結果は必ず `printTestCaseResult` かプリセット経由で `TEST_CASE_RESULT {...}` として出す。

自作時の注意:

- 採点は決定的にする。時刻や乱数に依存させない。
- 余計な標準出力を混ぜない。学習者向け情報は `feedbackMarkdown` に入れる。
- 問題ディレクトリ外の相対 import をしない。補助ファイルは問題内に同梱する。
- source inspection ではコメント/文字列を除去してから見るか、誤検知しない正規表現にする。
