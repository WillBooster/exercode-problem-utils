# 問題ファイル仕様（Exercode / @exercode/problem-utils）

このリポジトリの `src/types/`・`src/presets/`・`src/helpers/`、および judge サーバ
(`WillBoosterLab/judge`) の `problemFileSchema` を根拠とした仕様。実例は `example/` 配下。

## ディレクトリ構成

```
<problem_id>/
├── problem.md                  # 必須
├── judge.ts                    # 必須（採点）
├── debug.ts                    # 任意（デバッグ）
├── test_cases/                 # テストデータ
│   ├── <id>.in / <id>.out          # 標準入出力ケース
│   ├── <id>.fin/ / <id>.fout/      # ファイル入出力ケース（ディレクトリ）
│   └── _shared.fin/                # 任意: 全ケース共通の入力ファイル
├── model_answers/<answer_id>/  # 正解（受理されるべき。最低1つ）
├── model_answers.fails/<id>/   # 任意: 棄却されるべき解答（command デバッグで自動検証）
```

- judge サーバのコンテスト形式では、`templates/<言語ID>/`（初期コード）も使える。`_default` を使うと言語選択を無効化できる。
- 特別な採点環境（`judgeEnvironmentId: java | python | chainlit`）では `model_answers/` の代わりに `solution/` を使う。通常は `general`（指定不要）。

## problem.md の frontmatter

YAML frontmatter ＋ Markdown 本文。`@exercode/problem-utils` が採点で読む項目（`src/types/problem.ts`）＋ judge サーバがプラットフォーム表示で読む項目。

| 項目                           | 型       | 必須     | 意味                                                                              |
| ------------------------------ | -------- | -------- | --------------------------------------------------------------------------------- |
| `name`                         | string   | **必須** | 問題の表示名                                                                      |
| `timeLimitMs`                  | int ≥ 0  | 任意     | 実行時間制限(ms)。既定 2000（GUIは5000）。超過で TIME_LIMIT_EXCEEDED              |
| `memoryLimitByte`              | int ≥ 0  | 任意     | メモリ制限(byte)。既定 256MB。超過で MEMORY_LIMIT_EXCEEDED                        |
| `requiredRegExpsInCode`        | string[] | 任意     | 提出コードに**必ず含むべき**正規表現。欠如で REQUIRED_PATTERNS_IN_CODE_ERROR      |
| `forbiddenRegExpsInCode`       | string[] | 任意     | 提出コードで**禁止する**正規表現。一致で FORBIDDEN_PATTERNS_IN_CODE_ERROR         |
| `forbiddenTextsInCode`         | string[] | 任意     | 禁止する**リテラル文字列**（正規表現でなく完全一致）                              |
| `requiredSubmissionFilePaths`  | string[] | 任意     | 提出に**必ず含むべきファイル**。欠如で MISSING_REQUIRED_SUBMISSION_FILE_ERROR     |
| `requiredOutputFilePaths`      | string[] | 任意     | プログラムが**生成すべき出力ファイル**。欠如で MISSING_REQUIRED_OUTPUT_FILE_ERROR |
| `requiredEnvironmentVariables` | string[] | 任意     | 実行時に必要な環境変数名                                                          |
| `isManualScoringRequired`      | boolean  | 任意     | 手動採点が必要（ヒント機能は使えなくなる）                                        |

judge サーバのみが解釈する追加項目（プラットフォーム挙動の調整。通常は不要）:
`type: 'prompt_study'` / `judgeEnvironmentId` / `generalJudgeEnvironmentConfigOverrides`（拡張子ごとの build/command 上書き、リネーム禁止など）/ `testCases`（明示的なテストケース宣言）/ `canCreateFiles` / `isEditorDisabled` / `isAttachedFileRequired` / `isGui` / `isVotable`。

注: 正規表現は文字列として書くため、バックスラッシュをエスケープする（例: `'\\bsum\\s*\\('` は不可、YAML では `'\bsum\s*\('` のようにシングルクォートで囲んで書く。実例 `example/a_plus_b/problem.md` を参照）。

### 本文の標準的な見出し構成

```
## 問題文
## 制約
## 入力
## 出力
## 入力例1
## 出力例1
## 入力例2
## 出力例2
```

- 数式は `$...$`（KaTeX）。
- ファイル入出力問題では、入力例/出力例の中でファイル名を `### a.txt` のように小見出しにする（実例 `example/a_plus_b_file/problem.md`）。

## テストケース形式

`test_cases/` 配下。`src/helpers/readTestCases.ts` が読み取る。

### 標準入出力ケース（`.in` / `.out`）

- `test_cases/<id>.in` … 標準入力
- `test_cases/<id>.out` … 期待する標準出力（入力がなければ空ファイル）
- `<id>` が同じ `.in` と `.out` が1ケースになる。

### ファイル入出力ケース（`.fin/` / `.fout/`）

- `test_cases/<id>.fin/` … 実行前に cwd へコピーされる入力ファイル群
- `test_cases/<id>.fout/` … 実行後に期待される出力ファイル群（内容を完全一致で比較）
- `test_cases/_shared.fin/` … 全ケース共通でコピーされる入力ファイル群（任意）
- 併せて frontmatter で `requiredOutputFilePaths` を指定するとファイル生成の有無もチェックできる。

### テストケース ID の慣習

- このリポジトリの実例: `01_small_00`, `02_large_00`, `03_edge_03`（`<優先度>_<グループ>_<連番>`、昇順ソート）。
- judge サーバ／コンテスト形式: `example_` 始まりは**問題ページに自動表示**、`test_` 始まりは**非表示（採点専用）**。誤判定リスクを下げるため **4個以上**（例: `example_` 2個＋`test_` 2個）を推奨。

### 標準出力の一致判定（標準入出力方式の場合）

以下は標準入出力ベースで `.out` と比較する採点（`stdio` プリセット等）の挙動。`command` や自作 judge では比較規則を自分で決めるため、これは当てはまらない。

- 空白（スペース・タブ・改行）区切りでトークンに分割し、トークン同士を比較（AtCoder 方式）。
- トークンが浮動小数点数なら、絶対誤差・相対誤差のいずれかが `1e-6` 以下なら一致とみなす。
- 末尾の空白・改行は無視される。

## model answer / 失敗解答

- `model_answers/<answer_id>/` … 受理されるべき正解。最低1つ。複数言語なら `python/`, `java/`, `cpp/` 等。言語非依存なら `default/`。
- `model_answers.fails/<answer_id>/` … 棄却されるべき解答。`command` プリセットを `bun judge.ts`（cwd 省略）で実行すると、`model_answers/*`（受理期待）と `model_answers.fails/*`（棄却期待）を自動で回し、期待と異なれば終了コード1で知らせる。
- `model_answers.test/<id>/` … 特定の失敗モードを記録するための解答（リポジトリのテスト慣習）。命名は `<言語>_<失敗コード>`:

| 接尾辞    | 期待される判定                                 | DecisionCode                                |
| --------- | ---------------------------------------------- | ------------------------------------------- |
| `_wa`     | 不正解                                         | 1000 WRONG_ANSWER                           |
| `_re`     | 実行時エラー                                   | 1001 RUNTIME_ERROR                          |
| `_tle`    | 時間制限超過                                   | 1002 TIME_LIMIT_EXCEEDED                    |
| `_fpe`    | 禁止パターン                                   | 1006 FORBIDDEN_PATTERNS_IN_CODE_ERROR       |
| `_rpe`    | 必須パターン欠如                               | 1007 REQUIRED_PATTERNS_IN_CODE_ERROR        |
| `_mrsfe`  | 必須提出ファイル欠如                           | 1201 MISSING_REQUIRED_SUBMISSION_FILE_ERROR |
| `_mrofe`  | 必須出力ファイル欠如                           | 1202 MISSING_REQUIRED_OUTPUT_FILE_ERROR     |
| `_rename` | 受理（ファイル名違いでも解決できることの確認） | 2000 ACCEPTED                               |

## 採点コード（DecisionCode）

`src/types/decisionCode.ts` より。judge の `test()` が返す値、および採点結果。

| 値   | 名前                                   | 意味                               |
| ---- | -------------------------------------- | ---------------------------------- |
| 0    | WAITING_JUDGE                          | ジャッジ待ち                       |
| 1    | JUDGE_NOT_AVAILABLE                    | ジャッジ利用不可                   |
| 1000 | WRONG_ANSWER                           | 不正解                             |
| 1001 | RUNTIME_ERROR                          | 実行時エラー（終了コード≠0）       |
| 1002 | TIME_LIMIT_EXCEEDED                    | 時間制限超過                       |
| 1003 | MEMORY_LIMIT_EXCEEDED                  | メモリ制限超過                     |
| 1004 | OUTPUT_SIZE_LIMIT_EXCEEDED             | 出力サイズ超過（上限 50,000 文字） |
| 1005 | PRESENTATION_ERROR                     | 出力形式エラー                     |
| 1006 | FORBIDDEN_PATTERNS_IN_CODE_ERROR       | 禁止表現を含む                     |
| 1007 | REQUIRED_PATTERNS_IN_CODE_ERROR        | 必須表現の欠如                     |
| 1100 | BUILD_ERROR                            | ビルドエラー                       |
| 1101 | BUILD_TIME_LIMIT_EXCEEDED              | ビルド時間超過（上限 10 秒）       |
| 1102 | BUILD_MEMORY_LIMIT_EXCEEDED            | ビルドメモリ超過                   |
| 1103 | BUILD_OUTPUT_SIZE_LIMIT_EXCEEDED       | ビルド出力サイズ超過               |
| 1201 | MISSING_REQUIRED_SUBMISSION_FILE_ERROR | 必須提出ファイル不足               |
| 1202 | MISSING_REQUIRED_OUTPUT_FILE_ERROR     | 必須出力ファイル不足               |
| 2000 | ACCEPTED                               | 受理（最大値）                     |

`test()` の戻り値には `feedbackMarkdown`（学習者向けフィードバック）や `stderr` も含められる。

## 対応言語

`c`, `cpp`, `csharp`, `css`, `dart`, `haskell`, `html`, `java`, `javascript`, `jsp`, `php`, `python`, `ruby`, `rust`, `text`, `typescript`, `zig`。

- エントリポイントは `main.*` または `index.*`（`index` < `main` の順で優先、`main` が最優先）。
- Java は `Main.java`（`public class Main`、`main` メソッド）。
- JavaScript は `main.mjs` または `main.js`。Python は `main.py`。
- `judge.ts` 実行時に `'{"language":"python"}'` のように言語を明示することもできる。
