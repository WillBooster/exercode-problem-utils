# Contest yaml format

A contest is a `<contestId>.contest.yaml` file (id = filename without `.contest.yaml`, matching `/^[0-9_a-z-]+$/`). It lives inside a lecture directory, next to the markdown materials. The referenced problems live under the same course's `problems/<problemId>/` directory (see [../../generate-judge-problems/references/problem-format.md](../../generate-judge-problems/references/problem-format.md)). A contest must not reference another course's problems.

## Schema (strict: unknown keys are errors)

- `name` (required)
- `description` (optional, markdown)
- `showsProblemsAfterClose` (optional boolean)
- `divisions` (required, min 1): array of `{ id, name, openedAt, closedAt, password? }`
  - `openedAt` / `closedAt`: ISO datetimes with offset (e.g. `2025-01-01T00:00:00+09:00`), `openedAt < closedAt`
  - Division ids must be unique.
- `problems` (required, min 1): array of `{ id, score }` plus optional per-problem overrides `courseId`, `areTestCasesHidden`, `isDebugHintDisabled`, `isFixHintDisabled`, `isDiffHintDisabled`, `debugHintWaitingSeconds`, `fixHintWaitingSeconds`, `diffHintWaitingSeconds`, `isMaterialChatDisabled`
  - `score`: integer >= 0. Problem ids must be unique and each must resolve to an existing problem directory.
- Shared material-config fields (e.g. `availableLanguageIds`; see [../../generate-course-materials/references/course-format.md](../../generate-course-materials/references/course-format.md)) may also be set contest-wide.

## Example

```yaml
name: A + B コンテスト
description: |
  制限時間内にできるだけ多くの問題を解いてください。
showsProblemsAfterClose: true
availableLanguageIds:
  - java
  - python
divisions:
  - id: main
    name: 本戦
    openedAt: '2025-01-01T00:00:00+09:00'
    closedAt: '2025-01-01T02:00:00+09:00'
  - id: makeup
    name: 追試
    openedAt: '2025-02-01T00:00:00+09:00'
    closedAt: '2025-02-01T02:00:00+09:00'
    password: secret
problems:
  - id: a_plus_b
    score: 100
  - id: fizzbuzz
    score: 200
    isDebugHintDisabled: true
```
