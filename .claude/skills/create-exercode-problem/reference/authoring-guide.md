# 作問ガイド

根拠: `gen-em` 系の作問方針、`WillBoosterLab/judge` の教材実例、`exercode-sakamoto-smartse-courses` の実運用。

## 鉄則

- 入力に対して出力が一意、または `judge.ts` で決定的に正誤判定できる問題だけ作る。
- 人によって答えが変わる問題、途中で手入力や操作を要求する問題は避ける。
- 一意でない成果物は、正規表現、数値抽出、JSON 比較、DOM 検査などの judge で判定基準を明確にする。

## 要件確認

作る前に確認する:

- 学習目標と対象セクション。
- 対象言語と利用可能なライブラリ。
- 学習者が既に学んだ内容、まだ使わせない内容。
- 採点方式: 標準入出力、ファイル入出力、構造化 JSON、ソース検査、LLM、Web/GUI、special judge。
- 例として表示する test case と隠し test case の区別。

## 難易度

- 初級: 直前に学んだ概念をそのまま使う。数を多めにして定着を優先。
- 中級: 学んだ概念を少し組み合わせる。
- 上級: 複数概念を組み合わせる。実装方針の選択が必要。
- 超級: 未知の状況へ応用する挑戦問題。解けなくても進行を阻害しない位置に置く。

未習の構文や API を前提にしない。必要なら問題文で明示的に制限する。

## 問題文

- 簡潔な日本語で、何を入力し何を出力するかを書く。
- 「プログラミングの第一歩として」など、解答に不要な前置きは入れない。
- 専門用語は必要な範囲で定義する。
- 出力形式は JSON だけ、追加フィールド禁止、Markdown 禁止、ログ禁止など、判定に必要な制約を明記する。
- 入力例/出力例は専用見出しに分ける。本文中に混ぜない。

## 構文・API を使わせる問題

問題文と judge の両方で縛る。

- 問題文: 「`Agent` と `run` を `@openai/agents` から import する」「`sandboxMode` を `read-only` にする」など。
- frontmatter: 単純な必須/禁止なら `requiredRegExpsInCode` / `forbiddenRegExpsInCode`。
- `judge.ts`: コメントや文字列での抜け道を避けたい場合は、提出ソースからコメント/文字列を除去して検査する。

失敗時は `feedbackMarkdown` で満たしていない要件を箇条書きにすると学習者が直しやすい。

## テストケース設計

最低限:

- basic: 仕様通りの小さなケース。
- edge: 空、0、境界値、同値、片方だけ大きい、特殊文字など。
- large: 制約上限や時間制限に効くケース。
- negative idea: ありがちな誤答が落ちるケース。

標準入出力のコース問題では、表示用に `example_...`、隠し用に `test_...` を使う。`commandJudgePreset` で test case をコード内に持つ場合も、frontmatter の `testCases` に id/name を置くとプラットフォーム上で認識される。

## model answer と失敗解答

- 正解は最低1つ。コースの対象言語に合わせる。
- 失敗解答は、誤答の種類ごとに `model_answers.fails/<id>/` を用意する。
- SMART-SE の TypeScript 問題では `typescript_no_sdk`, `typescript_missing_agent`, `typescript_local_tool` のように、落としたい理由が分かる名前にする。

## 採点方式の選び方

- 標準入出力: 最優先。最も低コストで安定。
- `commandJudgePreset`: JSON 出力、SDK/API 使用、ソース検査、動的入力、依存付き TypeScript 実行。
- `llmJudgePreset`: prompt そのものを採点する問題。非決定的なので緩い判定にする。
- Web/GUI: 本当に DOM や画面の判定が必要なときだけ。重いので避けられるなら避ける。
- special judge (`java` / `python` / `chainlit`): 既存の judge environment を使う必要があるとき。`solution/` と環境固有ファイルを使う。

## 最終チェック

- 採点可能性が説明できる。
- 学習目標とテストが対応している。
- 例と隠しケースがあり、ありがちな誤答を落とせる。
- model answer と失敗解答で judge の妥当性を確認した。
- 問題ディレクトリだけをコピーして judge が動く。
- 問題外の補助コードやローカル絶対パスに依存していない。
