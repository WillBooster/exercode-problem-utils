---
name: review-learning-content
description: Run only when explicitly invoked to review Exercode learning content for correctness, solvability, pedagogical quality, and writing errors.
---

# Review Exercode learning content

1. Read the applicable authoring skill and its linked references before reviewing:
   - [generate-course-materials](../generate-course-materials/SKILL.md) for courses, lecture materials, and embedded questions.
   - [generate-judge-problems](../generate-judge-problems/SKILL.md) for Judge v2 problems.
   - [generate-judge-contest](../generate-judge-contest/SKILL.md) for contests and their problem sets.
2. Check the learning content for:
   - factual accuracy, using authoritative primary sources for material claims that are uncertain or important;
   - consistency with the request, surrounding materials, stated prerequisites, and target difficulty;
   - clear, unambiguous Japanese, correct terminology, spelling, Markdown, examples, and expected results;
   - questions that have exactly the intended answer and can be answered from the question as written;
   - code examples that are complete, runnable, and consistent with their explanations;
   - courses whose learning objectives include writing, modifying, or executing code provide course-scoped Judge problems at meaningful checkpoints, rather than relying only on embedded questions or complete examples;
   - every runtime and third-party dependency required by Judge problem files is declared reproducibly in the repository.
3. For each embedded question, independently answer the question from its prompt and options before reading `answerIndex`, `answerIndices`, `answerPattern`, `modelAnswer`, `hint`, or `explanation`. Then compare your answer with those fields and verify that the intended answer is unique, correct, and supported by the question as written.
4. For each Judge problem, first read only its statement and prerequisite materials. Before reading model answers or expected outputs, independently derive a solution, expected example outputs, and important boundary cases. Then inspect the model answers, test cases, templates, and judge implementation and verify that:
   - the statement provides enough information to solve the problem uniquely;
   - constraints, examples, model answers, expected outputs, and judge behavior agree;
   - the intended solution uses only concepts available to the learner;
   - test cases cover meaningful boundaries and every model answer is accepted by the judge — run `bunx exercode-problem judge model_answers/<languageId>` from the problem directory (it applies the problem's custom `judge.ts` when present and the standard stdio judge otherwise; see [generate-judge-problems/references/problem-format.md](../generate-judge-problems/references/problem-format.md)) and confirm the command exits 0, prints at least one `TEST_CASE_RESULT` line, and every printed line has the accepted decision code `2000`;
   - starter templates do not pass every test case.

   For an agent challenge (`agentChallenge` in `problem.md`), which has no test cases or harness, instead of the harness and test-case checks above (the statement-completeness and studied-concept checks still apply) verify that the statement names the technique to practise and the playground API to use, that `expectedRequest` matches only a request the intended solution sends (not one sent by hand from the playground UI or with a generic phrase), and that the explanation in `model_answers/explanation/` solves the problem.

5. Run the applicable course, problem, and contest validators as supporting evidence. Execute model answers, templates, and judges through the repository-declared runtimes and dependencies. Treat a Judge problem that succeeds only through a global installation, ad hoc download, or temporary dependency environment as a concern. Do not treat validator success as proof of factual, pedagogical, or writing quality.
6. Verify every suspected concern before reporting it. Report only concerns with a concrete correctness or learning-quality impact, not preferences.
