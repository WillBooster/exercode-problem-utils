# exercode course directory format

## Layout

```
<courseId>/                   # folder name = course id
  course.yaml
  problems/                   # problems are scoped to this course
    <problemId>/problem.md ...
  01_introduction/            # lecture IDs follow course order (01_, 02_, ...)
    01_overview.md            # material order restarts in each lecture (01_, 02_, ...)
    02_first_program.md       # display order = lexicographic filename order
    <contestId>.contest.yaml  # contest materials also live inside lecture directories
  02_variables/
    01_variables.md
```

All IDs (course, lecture, material, problem, contest, division, question) must match `/^[0-9_a-z-]+$/`.

Prefix lecture IDs with zero-padded sequence numbers in course order (`01_`, `02_`, ...), followed by a descriptive name. Prefix markdown material filenames with sequence numbers that restart at `01_` in every lecture.

## course.yaml

The schema is strict: unknown keys are errors.

- `name` (required)
- `description` (required)
- `author` (optional)
- `isMotivationFeatureEnabled`, `isPublic` (optional booleans)
- `lectures`: array of `{ id, name, description }`. Each lecture `id` must have a matching sibling directory. Optional for the importer (a course without lectures imports no materials), but every generated course lists its lectures here.
- Any shared material-config field (see below) as a course-wide default.

Example:

```yaml
name: Python入門
description: プログラミング初学者向けのPython入門コース
isPublic: false
lectures:
  - id: 01_introduction
    name: はじめに
    description: プログラミングとPythonの概要
  - id: 02_variables
    name: 変数とデータ型
    description: 変数の宣言と基本的なデータ型
```

## Markdown material file

Each material file is YAML frontmatter + markdown body. Frontmatter schema (strict):

- `name` (required)
- `problems`: array of `{ id, courseId? }`
- `questions`: array of question objects (same schema as embedded question blocks; prefer embedding questions in the body instead)
- `turtleGraphicsQuestions`: array of `{ id }`
- `isExamination`, `isMockExamination`, `isRealtimeSurvey` (optional booleans)
- Any shared material-config field (below)

Body rules:

- Problem links written as `[表示名](problems/<problemId>)` are merged into the material's problem list and must resolve to existing problem directories.
- Quiz questions are embedded as fenced code blocks tagged `yaml question` (or `yml question`).
- Code blocks in an executable programming language (e.g. `python`, `java`) render as runnable editors. Fence attributes: `no-execute` renders a plain code block; `stdin` shows an empty standard input field (without it, learners cannot supply standard input).
- At most one `<!-- chat -->` line may appear; it marks the start of AI-only content that is hidden from learners and shown only to the AI assistant.

## Shared material-config fields (all optional)

Usable in `course.yaml`, material frontmatter, and contest yaml:

- `availableLanguageIds`: array from `c`, `cpp`, `csharp`, `css`, `dart`, `haskell`, `html`, `java`, `javascript`, `jsp`, `kotlin`, `php`, `python`, `ruby`, `rust`, `text`, `typescript`, `zig`
- `areTestCasesHidden`, `isProblemGradingResultHidden`, `isAutoFormatDisabled`, `isCopyAndPasteDisabled`, `isDebugHintDisabled`, `isFixHintDisabled`, `isDiffHintDisabled` (booleans)
- `debugHintWaitingSeconds`, `fixHintWaitingSeconds`, `diffHintWaitingSeconds` (numbers)
- `submissionOpenedAt`, `submissionSoftClosedAt`, `submissionHardClosedAt`: ISO datetimes with offset (e.g. `2025-04-01T00:00:00+09:00`); must satisfy opened <= soft <= hard
- `isAutoTranslationDisabled`, `isModelAnswerShownAfterDeadline`, `isVotable`, `isMaterialChatDisabled` (booleans)

## Semantic rules the validator enforces

- No duplicate lecture IDs, no duplicate material IDs within a lecture, and no duplicate question, problem, or turtle-graphics references within a material (frontmatter entries and body links both count).
- `answerIndex` / `answerIndices` must be within the bounds of `options`.
- Submission period ordering (opened <= soft <= hard).
- Every referenced problem must exist in the same course, and every referenced lecture must exist.
