# 問題ファイル仕様

根拠: `@exercode/problem-utils` の `src/types/`・`src/helpers/`・`src/presets/`、および `WillBoosterLab/judge` の `problemFileSchema` / `readProblem`。

## 問題ファイル

- `problem.md`: 汎用例、`@exercode/problem-utils/example`、judge 側の多くの教材で使用。
- `<problem_id>.problem.md`: コース内で複数問題を明示しやすい形式。judge サーバは `problem.md` と `*.problem.md` を読む。

frontmatter は YAML、本文は Markdown。

## frontmatter

`@exercode/problem-utils` の採点で読む項目:

| 項目 | 型 | 意味 |
| --- | --- | --- |
| `timeLimitMs` | int >= 0 | 実行時間制限。未指定時は通常 2000ms、GUI は 5000ms。 |
| `memoryLimitByte` | int >= 0 | メモリ制限。judge サーバ未指定時は 256MiB。 |
| `requiredRegExpsInCode` | string[] | 提出コードに必要な正規表現。 |
| `forbiddenRegExpsInCode` | string[] | 提出コードで禁止する正規表現。 |
| `forbiddenTextsInCode` | string[] | 提出コードで禁止する文字列。 |
| `requiredSubmissionFilePaths` | string[] | 提出に必須のファイル。 |
| `requiredOutputFilePaths` | string[] | 実行後に生成されるべきファイル。 |
| `requiredEnvironmentVariables` | string[] | 実行時に必要な環境変数名。 |
| `isManualScoringRequired` | boolean | 手動採点が必要。 |

judge サーバが追加で読む主な項目:

| 項目 | 型 | 意味 |
| --- | --- | --- |
| `name` | string | 必須。表示名。 |
| `type` | `'prompt_study'` | prompt study 問題。 |
| `judgeEnvironmentId` | `general` / `java` / `python` / `chainlit` | special judge を選ぶ。通常は未指定か `general`。 |
| `generalJudgeEnvironmentConfigOverrides` | array | 拡張子ごとの rename/build/command 上書き。 |
| `testCases` | `{ id, name }[]` | 表示/実行対象のテストケース宣言。`test_cases/` と混在不可。 |
| `canCreateFiles` | boolean | ファイル作成を許す。 |
| `isEditorDisabled` | boolean | エディタを非表示にする。 |
| `isAttachedFileRequired` | boolean | 添付ファイルを必須にする。 |
| `isGui` | boolean | GUI 判定を明示する。 |
| `isVotable` | boolean | 投票機能を有効にする。 |

正規表現は YAML のシングルクォートで書くと扱いやすい:

```yaml
requiredRegExpsInCode: ['\+']
forbiddenRegExpsInCode: ['\bsum\s*\(']
```

## 本文

標準入出力の問題は原則この順にする:

```markdown
## 問題文
## 制約
## 入力
## 出力
## 入力例1
## 出力例1
```

judge サーバは `example_` 系 test case を本文に自動追記できるが、学習者に見せたい例は本文へ明示してよい。本文中に雑談や不要な前置きを入れない。

## `test_cases/`

`@exercode/problem-utils` の `readTestCases`:

- `<id>.in` / `<id>.out`: 標準入力と期待標準出力。片方だけでも読めるが、作問では原則ペアにする。
- `<id>.fin/` / `<id>.fout/`: 実行前に cwd へコピーする入力ファイル群と、実行後に比較する期待ファイル群。
- `_shared.fin/`: 全ケース共通でコピーする入力ファイル群。
- ID は文字列ソートされる。`01_small_00` のようにゼロ埋めする。

judge サーバの `readTestCases`:

- `<id>.in` / `<id>.out` は両方必要。
- `<id>.json` は `complexInOut` 用。stdin/out と同時に使えない。
- `example_` を含む ID は例として本文へ自動表示される。隠しケースは `test_` を使う。

## model answers

- general judge: `model_answers/<id>/` に正解。複数言語なら `typescript/`, `python/`, `java/` など。
- 失敗解答: `model_answers.fails/<id>/`。`commandJudgePreset` のデバッグ実行で「棄却されること」を検証できる。
- special judge (`judgeEnvironmentId: java | python | chainlit`): `solution/` を正解として使う。
- エントリポイントは `main.*` または `index.*`。Java は通常 `Main.java` / `public class Main`。

## templates

`templates/` は初期コード。judge サーバは次を許す:

- `templates/` 直下にファイルだけ置く: `_default` として扱う。
- `templates/_default/`: 全言語共通。
- `templates/<languageId>/`: 言語別。

ファイルとディレクトリを `templates/` 直下に混在させない。

## DecisionCode

主な値:

| 値 | 名前 |
| --- | --- |
| 1000 | `WRONG_ANSWER` |
| 1001 | `RUNTIME_ERROR` |
| 1002 | `TIME_LIMIT_EXCEEDED` |
| 1003 | `MEMORY_LIMIT_EXCEEDED` |
| 1004 | `OUTPUT_SIZE_LIMIT_EXCEEDED` |
| 1005 | `PRESENTATION_ERROR` |
| 1006 | `FORBIDDEN_PATTERNS_IN_CODE_ERROR` |
| 1007 | `REQUIRED_PATTERNS_IN_CODE_ERROR` |
| 1100 | `BUILD_ERROR` |
| 1201 | `MISSING_REQUIRED_SUBMISSION_FILE_ERROR` |
| 1202 | `MISSING_REQUIRED_OUTPUT_FILE_ERROR` |
| 2000 | `ACCEPTED` |
