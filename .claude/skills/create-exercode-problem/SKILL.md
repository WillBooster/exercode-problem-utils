---
name: create-exercode-problem
description: >-
  Use when creating, fixing, or reviewing Exercode coding problems: problem.md or
  *.problem.md files, judge.ts, test_cases, model_answers, model_answers.fails,
  templates, solution, or @exercode/problem-utils judges. Also use for Japanese
  作問 requests, SMART-SE course problems, test case design, model answers, and
  checking whether a problem is machine-gradable.
---

# Exercode 問題作成

Exercode の問題一式を、機械採点可能で、教材コースに登録できる状態まで作るための手順。

## まず読む参照

- `reference/authoring-guide.md`: 学習目標、問題文、テスト設計の作問判断。新規作問・大きな修正では読む。
- `reference/problem-spec.md`: ファイル構成、frontmatter、`test_cases`、`model_answers`、`templates`、`solution`。ファイルを作る前に読む。
- `reference/judge-presets.md`: `stdioJudgePreset` / `commandJudgePreset` / `llmJudgePreset` と検証方法。`judge.ts` を書く前に読む。

## ワークフロー

1. 学習目標、対象コース/講義、対象言語、使ってよい既習範囲、採点方式を確認する。
2. 既存コースに追加する場合は、近い問題の配置と命名を真似る。SMART-SE では `courses/<course>/<lecture>/<section>/<problem>/<problem>.problem.md` が使われている。
3. 問題ファイルを作る。一般例や `@exercode/problem-utils` の example では `problem.md`、コース内では `<problem_id>.problem.md` も有効。
4. 採点方式を決める。標準入出力で済むなら `stdioJudgePreset`、構造化 JSON・SDK 利用・ソース検査・動的入力なら `commandJudgePreset` を使う。
5. テストケースと model answer を作る。誤答例を想定し、可能なら `model_answers.fails/` も置く。
6. judge を実行して、正解が全て `DecisionCode.ACCEPTED`、失敗解答が棄却されるまで直す。
7. `judge.ts` を追加・変更した場合は、問題ディレクトリだけを `/tmp` にコピーしても実行できることを確認する。

## 最小構成

```text
<problem_id>/
├── problem.md or <problem_id>.problem.md
├── judge.ts
├── test_cases/              # .in/.out, .fin/.fout, or .json
├── model_answers/<id>/      # general judge の正解
├── model_answers.fails/<id>/# 任意: 落ちるべき解答
├── templates/               # 任意: 初期コード
└── solution/                # special judge (java/python/chainlit) の正解
```

`judge.ts` が補助コードを必要とする場合は、問題ディレクトリ内に同梱して `./...` で import する。Exercode では問題ディレクトリだけが展開されるため、コース直下やリポジトリ直下のファイルへ相対 import してはいけない。

## Gotchas

- `test_cases/` と frontmatter の `testCases` は同時に使わない。judge サーバは混在をエラーにする。
- frontmatter の `testCases` は `{ id, name }` の表示/宣言用。実際の入力や期待値を `judge.ts` 内で持つ `commandJudgePreset` 問題でも使われる。
- `testCases: []` は禁止。標準入出力テストがない問題では `testCases` 自体を省くか、手動採点なら `isManualScoringRequired: true` を使う。
- `example_` を含む test case ID は問題本文へ自動表示される。隠しケースは `test_...` にする。
- `requiredRegExpsInCode` / `forbiddenRegExpsInCode` はコメント・文字列の誤検知に注意する。必要なら `removeCommentsInSourceCode` や `removeCommentsAndStringsInSourceCode` で judge 側に検査を書く。
- Java の general judge は public class 名に合わせてファイル名を直す prebuild があるが、学習者向けには通常 `Main.java` / `public class Main` と明示する。
- `requiredEnvironmentVariables` が必要な問題では frontmatter に書く。LLM/API 利用問題は model answer 検証時にも環境変数が必要。

## よく使う `judge.ts`

標準入出力だけなら:

```ts
import { stdioJudgePreset } from '@exercode/problem-utils/presets/stdio';

await stdioJudgePreset(import.meta.dirname);
```

構造化出力やソース検査をするなら `commandJudgePreset` を使い、`readTestCases`、必要なら `runCommand`、`test` を定義する。API は変わり得るので、必ず `src/presets/*.ts` または installed package の型定義を確認する。

## 検証

`stdioJudgePreset` / `llmJudgePreset` は回答ディレクトリを渡して検証する:

```bash
bun judge.ts model_answers/typescript '{"language":"typescript"}'
bun judge.ts model_answers/python '{"language":"python"}'
```

`commandJudgePreset` は cwd 省略で `model_answers/*` と `model_answers.fails/*` をまとめて確認できる。デバッグモードでは問題ディレクトリ隔離チェックも走る。

```bash
bun judge.ts
```

問題ディレクトリ単体でも確認する:

```bash
tmp_problem=$(mktemp -d /tmp/problem_XXXXXX)
cp -R path/to/problem/. "$tmp_problem"/
( cd "$tmp_problem" && bun run judge.ts )
```

## セルフレビュー

- 入力に対して出力が一意、または `judge.ts` で決定的に正誤判定できる。
- 問題文、制約、入力、出力、例が曖昧でない。
- テストケースが basic / edge / large / 誤答を落とすケースを含む。
- model answer が全て受理され、`model_answers.fails` がある場合は棄却される。
- `judge.ts` が問題ディレクトリ外のファイルに依存しない。
- time/memory limit と `requiredEnvironmentVariables` が実行内容に合っている。
