# Complete minimal v2 example problem

Directory `a_plus_b/`:

```
a_plus_b/
  problem.md
  test_cases/
    example_1.in
    example_1.out
    example_2.in
    example_2.out
    test_1.in
    test_1.out
    test_2.in
    test_2.out
  model_answers/
    python/main.py
    java/Main.java
```

## problem.md

````markdown
---
name: A + B
timeLimitMs: 2000
requiredRegExpsInCode: ['\+']
forbiddenRegExpsInCode: ['\bsum\s*\(']
---

## 問題文

整数$A,B$が与えられます。
$A+B$の計算結果を出力してください。

## 制約

- $0 \leq A,B \leq 10^9$
- 入力は全て整数である。
- `+` 演算子を使って計算してください。
- `sum` 関数を使ってはいけません。

---

## 入力

入力は以下の形式で標準入力から与えられる。

```
$A$ $B$
```

## 出力

$A+B$を出力せよ。

---

## 入力例1

```
1 1
```

## 出力例1

```
2
```

---

## 入力例2

```
2 3
```

## 出力例2

```
5
```
````

## judge.ts / debug.ts

None: a standard stdin/stdout problem contains neither file. The judge server automatically judges
it with `stdioJudgePreset` and provides the debug feature with `stdioDebugPreset`.

## test_cases/

| File            | Content                                        |
| --------------- | ---------------------------------------------- |
| `example_1.in`  | `1 1`                                          |
| `example_1.out` | `2`                                            |
| `example_2.in`  | `2 3`                                          |
| `example_2.out` | `5`                                            |
| `test_1.in`     | `0 0` (edge: minimum values)                   |
| `test_1.out`    | `0`                                            |
| `test_2.in`     | `1000000000 1000000000` (edge: maximum values) |
| `test_2.out`    | `2000000000`                                   |

The `example_*` cases match the 入力例/出力例 sections in `problem.md`. Every `.out` was produced by running the Python model answer (e.g. `python3 model_answers/python/main.py < test_cases/test_1.in > test_cases/test_1.out`) and verified against the Java model answer.

## model_answers/python/main.py

```python
a, b = map(int, input().split())
print(a + b)
```

## model_answers/java/Main.java

```java
import java.util.Scanner;

public class Main {

    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);
        int a = sc.nextInt();
        int b = sc.nextInt();
        System.out.println(a + b);
        sc.close();
    }
}
```

Note how the frontmatter constraints hold for both model answers: `\+` matches each answer's addition, and `\bsum\s*\(` matches neither (and would not match parsing helpers such as `Scanner` or `map`).
