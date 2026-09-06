# Lecture material authoring rules

Write lecture material bodies (normally in Japanese) following all rules below.

## Structure

- After the YAML frontmatter block, start the body with a `# ` title heading, then `## ` section headings following the course outline.
- Cover only the topics assigned to the material; do not duplicate content from other lectures. When a material continues a previous one, continue without repeating.
- Keep the whole material logically ordered and internally consistent.
- Do NOT add a summary or conclusion section (e.g. 「まとめ」, 「結論」) at the end.

## Writing style

- Write for programming beginners: explain carefully, plainly, and step by step.
- Define (explain) every technical term before its first use.
- Wrap example URLs and email addresses in backticks to prevent auto-linking (e.g. `` `https://example.com` ``).

## Code examples

- Include a complete, runnable code example for each concept.
  - Learners run code examples in place, so every example must run to completion. Prefer examples that need no standard input; when the concept being taught is reading standard input (e.g. `input()`, `Scanner`), add the `stdin` attribute after the example's own language (e.g. ` ```python stdin `, ` ```java stdin `) so the block shows an empty standard input field, and state the input the example expects in the surrounding prose. Standard input is available only in blocks that opt in this way; learners cannot supply it elsewhere.
  - Do not embed execution results in the code example; instead prompt learners to run it themselves.
  - Explain the behavior and meaning of every code example in the surrounding prose.
- Specify the syntax-highlighting language on every code block (e.g. ` ```python `).
- Tag a code block that is not meant to be run (a fragment, pseudo-code, or an intentionally broken example) with `no-execute` (e.g. ` ```python no-execute `) so it renders as a plain code block.

## Diagrams

- Where prose alone is hard to follow and a visual helps (e.g. control flow, data structures, architecture), add a Mermaid diagram (` ```mermaid ` block) and explain its content in the surrounding prose.

## Questions and problems

- Insert quiz questions (see [question-authoring.md](question-authoring.md)) immediately after each newly introduced concept rather than batching them at the end.
- Link coding problems near the section that teaches the required concept, ordered from easy to hard.
