# QED2 shared client logic

This package contains local grading, review scheduling, storage workflows and
service clients shared by the Web and Desktop shells. Its TypeScript target
uses ECMAScript and standard Web APIs (`URL`, timers, Web Crypto, abort signals),
without browser DOM or Node module dependencies. The `WebWorker` library declares
those shared APIs explicitly rather than inheriting them from the test runner.

## Expression grading

Automatic grading evaluates deterministic scalar mathematics: arithmetic,
powers, roots, logarithms, trigonometry, absolute values, bounded scalar
aggregates such as `sum` and `prod`, and constants such as `pi`, `e` and `tau`.
Assignments, matrix/range constructors, random values, nested evaluators and
other executable programs fall back to self-assessment. Functions with
potentially unbounded argument-dependent work, including `combinations` and
`permutations`, also use that fallback.

The automatic path accepts at most 4,096 source characters, 256 syntax nodes,
48 nesting levels and 32 declared variables. These limits apply to user and
canonical expressions; exceeding them produces `indeterminate`, never an
automatic incorrect verdict. Live preview also bounds source size and nesting.
The preview and grader share one CAS instance.

Equivalence remains a numerical heuristic, using deterministic samples and a
symbolic fallback; it is not a general proof system. Clear counterexamples
override equivalence, and variable sampling avoids the previous 20-variable
alias. When enough samples agree, redundant symbolic simplification is skipped.

## Review scheduling

Scheduler computations constrain legacy/imported stability to
`[0.000001, 36500]` days and difficulty to `[1, 10]`, preventing zero divisions
and non-finite results from blocking subsequent reviews. The minimum stability
survives the archive's six-decimal normalization. Review and lapse counters
saturate at PostgreSQL's signed integer limit (`2147483647`) so an imported
counter at that limit remains synchronizable after another review.

Run `pnpm --filter @qed2/core-logic test` and
`pnpm --filter @qed2/core-logic typecheck` from the workspace root.
