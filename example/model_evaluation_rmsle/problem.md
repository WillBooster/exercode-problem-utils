---
name: 価格予測モデルの評価
requiredSubmissionFilePaths: ['submission.csv']
---

## 問題文

5件の商品について価格を予測し、予測結果を`submission.csv`として提出せよ。
評価指標はRMSLEであり、RMSLEが$0.5$以下であれば合格とする。

## 制約

- `submission.csv`の1行目はヘッダー`Id,Price`とする。
- 2行目以降に、評価対象の`Id`（$1 \leq Id \leq 5$）と予測価格を1行ずつ書く。
- 予測価格は$0$以上の数値とする。

## 入力

なし。

## 出力

`submission.csv`を提出せよ。採点結果にRMSLEの値が表示される。

---

## 提出例

形式の例である。値は適当なので、このまま提出しても合格しない。

```text
Id,Price
1,30
2,900
3,80
4,1500
5,120
```
