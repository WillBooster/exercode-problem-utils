---
name: create-exercode-problem
description: >-
  Exercode (https://exercode.willbooster.com/) のコーディング問題を
  作成・修正・検証するためのガイド。「問題を作る」「作問」「judge を書く」「テストケースを作る」「model answer を用意する」
  「問題を Exercode 形式にする」といった依頼や、@exercode/problem-utils を使った problem.md / judge.ts /
  test_cases / model_answers の追加・編集時に使用する。問題ファイルが満たすべき仕様と、良い問題を作るためのノウハウを含む。
---

# Exercode 問題の作成

Exercode は、提出されたプログラムをテストケースで自動採点する学習プラットフォームです。
このリポジトリ `@exercode/problem-utils` は、その採点ロジック（judge）を書くためのユーティリティを提供します。
このスキルは、**仕様を満たし、かつ教育的に良質な問題**を一式そろえて作るための手順・仕様・ノウハウをまとめたものです。

## このスキルの使いどころ

- 新しい問題（ディレクトリ一式）を作る
- 既存の問題を修正する／テストケースや model answer を追加する
- 問題が機械採点可能か、仕様を満たしているかをレビューする

## 参照ファイル（必要に応じて読む）

- `reference/problem-spec.md` — 問題ファイルの**仕様**（ディレクトリ構成・frontmatter 全項目・テストケース形式・採点コード・対応言語）。問題を組み立てる前に必読。
- `reference/judge-presets.md` — `judge.ts` の役割と、採点プリセットの選び方・調べ方。プリセットの具体的な API は変化するため、常に `@exercode/problem-utils/presets` の実装を確認する。
- `reference/authoring-guide.md` — **良い問題を作るためのノウハウ**（機械採点の鉄則・難易度設計・問題文・テストケース設計・よくある失敗）。設計段階で必読。

## 問題ディレクトリの最小構成

```
<problem_id>/
├── problem.md            # 必須: frontmatter（最低 name）＋ 問題文
├── judge.ts              # 必須: 採点スクリプト（プリセットを選ぶ）
├── debug.ts              # 任意: ローカルデバッグ用
├── test_cases/           # テストデータ（.in/.out もしくは .fin/.fout ディレクトリ）
│   ├── 01_small_00.in
│   ├── 01_small_00.out
│   └── ...
├── model_answers/        # 正解（受理されるべき解答）。1ディレクトリ＝1解答
│   └── <answer_id>/      # 例: python/ java/ default/
│       └── main.py
└── model_answers.fails/  # 任意: 不正解（棄却されるべき解答）。command プリセットのデバッグで自動検証
    └── <answer_id>/
```

`<problem_id>` / `<answer_id>` / テストケース ID は **英小文字・数字・アンダースコア** のみ。
`<problem_id>` は Exercode 全体で一意にする（コンテストやコース ID を接頭辞に付けると安全）。

## 作問ワークフロー

### 1. 要件を固める（不明なら確認する）

- **学習目標**（この問題で何を習得させるか）と**対象セクション**
- **難易度**（初級 / 中級 / 上級 / 超級 — 定義は `authoring-guide.md`）
- **対象言語**（特定言語に限定するか／任意か）
- **採点方式**（標準入出力 / ファイル入出力 / LLMプロンプト / GUI / Web など → プリセット選択）
- 学習者が**すでに学んだ内容 / まだ学んでいない内容**（解法で使ってよい構文の範囲）

→ 詳細は `reference/authoring-guide.md` を読む。**機械採点できない問題を作ってはならない**（入力に対して出力が一意、またはプログラムで正誤判定できること）。

### 2. ディレクトリと problem.md を作る

`problem.md` は frontmatter（最低 `name`）＋ 本文。本文は次の見出し構成に従う：

```markdown
---
name: 問題名
timeLimitMs: 2000
---

## 問題文

（簡潔・明確に。前置きや雑談は書かない。例は本文に混ぜず下の入力例/出力例に書く）

## 制約

- $0 \leq A,B \leq 10^9$
- （特定構文の習得が目的なら「`for`文を使ってください」等を明記し、抜け道を禁止する）

## 入力

（標準入力の形式）

## 出力

（標準出力の形式）

## 入力例1

​`
1 1
​`

## 出力例1

​`
2
​`
```

frontmatter の全項目（`forbiddenRegExpsInCode`, `requiredRegExpsInCode`, `requiredOutputFilePaths` など）は `reference/problem-spec.md` 参照。

### 3. judge.ts（採点方式）を選ぶ

標準入出力の単純な問題なら、これだけで済む：

```ts
import { stdioJudgePreset } from '@exercode/problem-utils/presets/stdio';

await stdioJudgePreset(import.meta.dirname);
```

それ以外（独自判定・ファイル生成・LLM・GUI・Web）は `reference/judge-presets.md` を読んでプリセットを選ぶ。

### 4. テストケースを作る

テストケースは「入力」と「期待する結果」の組。**入力をどう与え、結果をどう比較するかは採用した `judge.ts`（プリセット）によって異なる**ので、まず採点方式を決めてから形式を選ぶ。

- ファイルで用意する方式（`stdio` など、`test_cases/` を読むプリセット）:
  - 標準入出力: `test_cases/<id>.in`（標準入力）と `<id>.out`（期待する標準出力）のペア。
  - ファイル入出力: `<id>.fin/`（入力ファイル群）と `<id>.fout/`（期待出力ファイル群）のディレクトリ。
  - ID 例: `01_small_00`, `02_large_00`, `03_edge_00`（昇順ソートされる）。
- `judge.ts` 内に定義する方式（`command` や Web/GUI の自作判定など）: テストケースと比較ロジックを judge のコードに書く。
- 形式の詳細は `reference/problem-spec.md`、比較セマンティクス（例: `stdio` は空白区切りトークン比較・浮動小数点は誤差 1e-6 許容）は採用プリセットの実装（`@exercode/problem-utils/presets`）で確認する。

設計の指針（採点方式を問わず共通）:

- **最低4個以上**。`small`（基本）・`large`（大きい値）・`edge`（0・上限・境界）を網羅する。
- model answer の誤った変種が必ず落ちるようにケースを設計する。

### 5. model answer を作る

- `model_answers/<id>/` に**最低1つ**の正解を置く（複数言語なら `python/`, `java/` など）。
- 任意で `model_answers.fails/<id>/` に**棄却されるべき解答**を置き、判定が正しく落ちることを確認する。
- エントリポイントは `main.*` または `index.*`。Java は `Main.java`（`public class Main`）。

### 6. 検証する（必須）

`judge.ts` を各 model answer に対して実行し、すべて「受理(2000)」になることを確認する。

```bash
# 問題ディレクトリで実行
bun judge.ts model_answers/python      # ACCEPTED (decisionCode: 2000) になるはず
bun judge.ts model_answers/java

# command プリセットは cwd を省略すると
# model_answers/*（受理期待）と model_answers.fails/*（棄却期待）を一括検証できる
bun judge.ts
```

出力は `TEST_CASE_RESULT {...}` 行で、`decisionCode: 2000` が受理。
**全 model answer が受理され、用意した失敗解答が棄却される**まで、テストケース・judge・解答を修正する。
不正解の解答が誤って受理される場合はテストケースが不足しているサイン。

### 7. セルフレビュー（チェックリスト）

- [ ] 入力に対して出力が一意、またはプログラムで正誤判定できる（機械採点可能）
- [ ] 問題文・制約・入出力・入出力例がそろい、曖昧さがない
- [ ] テストケースが4個以上あり、edge ケースを含む
- [ ] model answer が1つ以上あり、全テストケースで受理される
- [ ] 特定構文の習得が目的なら、制約と `requiredRegExpsInCode`/`forbiddenRegExpsInCode` で抜け道を塞いでいる
- [ ] `<problem_id>` 等の ID が英小文字・数字・アンダースコアのみ
- [ ] timeLimitMs / memoryLimitByte が解法に対して妥当
