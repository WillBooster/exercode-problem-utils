# judge.ts と採点プリセット

## judge.ts の役割

`judge.ts` は採点スクリプト。提出物（cwd）を実行し、各テストケースの結果を
`TEST_CASE_RESULT {...}` という1行 JSON として標準出力に書き出す（この形式が Exercode の採点結果として読まれる）。

採点ロジックを毎回ゼロから書く必要はない。典型的な採点方式は `@exercode/problem-utils/presets/*`
に**プリセット**として用意されており、`judge.ts` はプリセットを呼ぶだけで済むことが多い。

最も単純な標準入出力の問題なら、これだけ：

```ts
import { stdioJudgePreset } from '@exercode/problem-utils/presets/stdio';

await stdioJudgePreset(import.meta.dirname);
```

## プリセットは「常に実装を確認する」

**利用可能なプリセットや各プリセットの引数・オプションは随時追加・変更される。**
このスキルに API を転記すると古くなるため、ここには詳細仕様を書かない。
実際に使うときは、必ず次を確認して**現在の正確な API** を把握すること：

- パッケージのエクスポート: `@exercode/problem-utils/presets/*`
  - このリポジトリで作業している場合は `src/presets/*.ts`（実装そのもの）。
  - パッケージを利用する側では、`node_modules/@exercode/problem-utils/dist/presets/*` の型定義（`*.d.ts`）。
- 各プリセットのオプション型（`...PresetOptions`）と、それを使う `judge.ts` の書き方。

## 採点方式の選び方（方針）

具体的なプリセット名は実装で確認する前提で、**問題の性質 → 採点方式**の対応の目安：

- 標準入力に対する標準出力で正誤が決まる … 標準入出力ベースの採点（最頻・最も低コスト）。
- ファイルを読み書きする … ファイル入出力ベースの採点（`requiredOutputFilePaths` と併用）。
- 入力を動的生成する／外部コマンドを実行する／独自の比較をしたい … コマンド実行ベースの採点。
- LLM へのプロンプト（`prompt.txt`）を採点する … LLM ベースの採点（出力は非決定的なので緩い基準で判定）。
- GUI（デスクトップウィンドウ）をスクリーンショットで判定する … GUI ベースの採点。
- Web ページ（HTML/CSS/JS）の DOM を判定する／上記に当てはまらない … プリセットを使わず、エクスポートされたヘルパ（`parseArgs`, `printTestCaseResult`, `startHttpServer`, `DecisionCode` など）で **judge.ts を自作**する。

迷ったら標準入出力ベースを選ぶ。Node.js 互換で書けるものをわざわざ Web/GUI 方式にしない。

判定結果は `DecisionCode`（`reference/problem-spec.md` の一覧）で返し、必要なら学習者向けの
`feedbackMarkdown` を添える。実際の問題ごとの構成例は、このリポジトリの `example/` 配下が参考になる。

## judge を書く／選ぶときの共通注意（方式によらない）

- 結果は必ずプリセット経由または `printTestCaseResult` で `TEST_CASE_RESULT` 行として出す（デバッグ用の余計な標準出力を混ぜない）。
- 採点ロジックは決定的に。乱数や時刻に依存させない。
- 時間・メモリ・出力サイズの上限チェックは多くのプリセットが内部で行う。自作するときは少なくとも終了コードと実行時間を見る。
- `feedbackMarkdown` で「不足している要素」「期待値」などを返すと学習効果が高い。
