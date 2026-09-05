# Quiz question authoring guide

## Embedding questions in materials

Embed each question as a fenced code block tagged `yaml question` inside the material body. When the question text itself contains a triple-backtick code block, use a longer outer fence (four backticks or `~~~`) so the fences do not collide.

## Question schema

Every question needs `id` (unique within the material — course-wide uniqueness is a good habit but not required — matching `/^[0-9_a-z-]+$/`), `type`, and `question`. Optional common fields: `hint`, `explanation`, `isResubmittable`, `isSurvey` (a survey must omit `answerIndex` / `answerIndices` / `answerPattern`). Per-type fields (use no other fields):

- `type: 'select'` (single choice): `options` (array of unique strings, min 1) and `answerIndex` (0-based number; use an array of numbers to accept multiple options as correct). `answerIndex` is required unless `isSurvey: true` and must be within the bounds of `options`.
- `type: 'select_multiple'` (multiple choice): `options` and `answerIndices` (array of 0-based numbers, each within bounds).
- `type: 'text'` (free text): `answerPattern` (a valid regex, implicitly anchored like the HTML `pattern` attribute: treated as `^(?:` ... `)$`) and `modelAnswer` (must match `answerPattern`; required whenever `answerPattern` uses regex syntax, i.e. does not match itself literally, and optional otherwise). `answerPattern` is required unless `isSurvey: true`.

Quote option strings with single quotes when they contain no escapes or single quotes.

Write properties in this order: `id`, `type`, `question`, `options`, `answerIndex` / `answerIndices`, `answerPattern`, `modelAnswer`, `hint`, `explanation`.

## Question kinds and rules

### Knowledge questions (知識問題)

Test the learner's knowledge with `select` or `select_multiple`.

- Only ask questions solvable with general programming knowledge, without having read the material. For example, 「講義資料中で紹介したツールを選べ」 is forbidden because it requires the material.
- When asking about language syntax, stick to behavior strictly defined by the language specification and avoid ambiguity. For example, 「基本的な算術演算子を選べ」 is invalid because the specification does not define 「基本的」.

```yaml question
id: 'q1'
type: 'select'
question: |
  Pythonなどのプログラミング言語において加算を表す演算子を、次の選択肢から1つ選びなさい。
options:
  - '+'
  - '++'
  - '-'
  - '--'
answerIndex: 0
```

```yaml question
id: 'q2'
type: 'select_multiple'
question: |
  Pythonにおいて加算演算子よりも優先順位が高い（先に演算される）演算子を、次の選択肢からすべて選びなさい。
options:
  - '**'
  - '*'
  - '/'
  - '%'
  - '<'
answerIndices:
  - 0
  - 1
  - 2
  - 3
```

### Code-tracing questions (コードトレース問題)

Ask what a program prints. Follow all of these rules:

- Use single-choice (`select`) only.
- Ask only about strings printed to standard output (e.g. Java's `System.out.println()`).
- The program must terminate: give every loop or timer a termination condition.
- The program must not require any user interaction or input.
- When the question involves compile or runtime errors, include both 「コンパイルエラーが発生する」 and 「実行時に例外が発生する」 as options.
- Create each question together with a paired review question (`<id>_review`): identical required knowledge, only slightly different constants.

````yaml question
id: 'tracing_q1'
type: 'select'
question: |
  次のプログラムを実行した際の出力結果を選びなさい。
  ```python
  x = 4
  y = 0
  if x >= 5:
      y = 1
  else:
      y = 2
  print(y)
  ```
options:
  - '0'
  - '1'
  - '2'
  - '3'
answerIndex: 2
````

````yaml question
id: 'tracing_q1_review'
type: 'select'
question: |
  次のプログラムを実行した際の出力結果を選びなさい。
  ```python
  x = 10
  y = 5
  if x <= 7:
      y = 3
  else:
      y = 4
  print(y)
  ```
options:
  - '3'
  - '4'
  - '5'
  - '6'
answerIndex: 1
````

### Free-text questions

Use `text` for fill-in-the-blank style questions where the answer is short and mechanically checkable. Make `answerPattern` tolerant of harmless variation (e.g. whitespace).

````yaml question
id: 'fill_q1'
type: 'text'
question: |
  次のソースコードの`sum`は引数`a`と`b`の和を返す関数である。
  ①にあてはまる式を答えなさい。

  ```py
  def sum(a, b):
      return ①
  ```
answerPattern: 'a\s*\+\s*b'
modelAnswer: 'a + b'
````
