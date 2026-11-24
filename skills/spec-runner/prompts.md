# Step prompts

One section per step type. Each has a **Prompt** and a **Role line**. Copy both exactly, replace
every `<placeholder>`, and pass them to `scripts/launch.sh <run-dir> <step> <cwd> <role-line> <prompt>`.
The role line becomes `{{ROLE}}` in `contract.md`.

`launch.sh` passes the prompt as one argument, so a prompt may span several lines.

Placeholders:

| Placeholder | Value |
|---|---|
| `<run-dir>` | absolute path of `.spec-runner/` in the integration worktree |
| `<n>` | plan number; a gap plan takes the next number |
| `<branch>` | the plan branch `<slug>-<n>-<plan-slug>` |
| `<plan-slug>` | the plan's `slug` from `run.json` |
| `<slug>` | the run's slug, the integration branch |
| `<main>` | the repo's default branch, `main_branch` from `run.json` |
| `<plan path>` | absolute path of the plan file the planner reported |
| `<k>` | review round, 1 to 3 |
| `<g>` | audit round, 1 to 3 |
| `<scope>` | the plan's `scope` from `run.json` |
| `<items>` | deferred items and deviations from merged plans |
| `<command>` | the verification command that failed |
| `<merged>` | the plans merged into `<slug>` since `<branch>` was cut, each with its number, slug and one line on what it added |
| `<list>` | the blocked or skipped plans, each with its number and slug |
| `<recommended_executor>` | `subagent-driven-development` or `executing-plans` |

## plan

Step `p<n>-plan`. cwd: the plan worktree.

**Prompt**

```text
/skill:writing-plans <run-dir>/spec.md
Scope of this plan: <scope>
Carried over from earlier plans: <items>
```

Delete the `Carried over` line when `<items>` is empty. For a gap plan, `<scope>` names the audit
file by absolute path: `Close the gaps listed in <run-dir>/audit-<g>.md; read that file first.`

**Role line**

```text
Planner for plan `<n>` on branch `<branch>` (base `<slug>`). Save the plan under `docs/superpowers/plans/` in this worktree. Do not wait for plan approval. Do not commit the plan file. Give every task a focused test command, one that runs only the tests that task adds or changes, and run each form once on an existing test to see that it runs fewer tests than the full check: a script that ignores its filter argument runs them all. List a check that cannot be narrowed under `decisions`, with the script that would have to change. Report `recommended_executor` (`subagent-driven-development` or `executing-plans`), your one-sentence reason as `recommended_executor_reason`, and the plan's path as `plan_path`.
```

## execute

Step `p<n>-execute`. cwd: the plan worktree.

**Prompt**

```text
/skill:<recommended_executor> <plan path>
```

**Role line**

```text
Executor for plan `<n>`. Skip the skill's final whole-branch review and its fix pass; the run's review loop replaces them. Commit every task; leave the plan file under `docs/superpowers/plans/` uncommitted.
```

## sync

Step `p<n>-sync`. cwd: the plan worktree. Used when the integration branch moved after the plan
branch was cut.

**Prompt**

```text
Merge `<slug>` into this branch with `git merge <slug>`; never rebase. Since this branch was cut, these plans merged: <merged>
Resolve each conflict so that both sides' behaviour is kept. Regenerate a generated file with its generator instead of merging it by hand. Then make every verification command pass.
```

**Role line**

```text
Merger for plan `<n>`. Never weaken or delete a test to make verification pass. Commit the merge; leave the plan file under `docs/superpowers/plans/` uncommitted. List the conflicted files under `notes`.
```

## review

Step `p<n>-review<k>`. cwd: the plan worktree.

**Prompt**

```text
/skill:code-review high
Earlier rounds: <one line per finding: location — summary — disposition>
```

Delete the `Earlier rounds` line in round 1. In rounds 2 and 3, write one such line for every
finding of every earlier round.

**Role line**

```text
Reviewer, round `<k>`, for plan `<n>`. The review scope is `git diff @{upstream}...HEAD`. Edit nothing. After the review, tag each finding with `category` (`correctness`, `simplification`, `efficiency`, `reuse`, `altitude`, `conventions`, or a narrower slug) and `blocking` (true for `correctness`, or when the code fails a requirement or a Done-when item of the spec at `<run-dir>/spec.md` or of the plan `<plan path>`; false otherwise). Write the findings to `.spec-runner/review-<k>.md`. Report them, plus `blocking_count`.
```

## fix

Step `p<n>-fix<k>`. cwd: the plan worktree.

**Prompt**

```text
/skill:receiving-code-review .spec-runner/review-<k>.md
```

**Role line**

```text
Fixer, round `<k>`, for plan `<n>`. Fix every finding that holds, blocking or not, test first where a test can show the bug. Report each finding as `fixed in <sha>` or `not fixed: <reason>`.
```

## redfix

Step `p<n>-redfix`. cwd: the plan worktree. Used once per plan, when verification in the plan
worktree is red before the merge.

**Prompt**

The prompt contains a fenced block. The outer fence below has four backticks; the prompt is
everything inside it.

````text
/skill:systematic-debugging
Verification fails: <command>
```
<last 80 lines of the command's output>
```
````

**Role line**

```text
Fixer for plan `<n>` after a red verification. Make the listed command pass without weakening tests.
```

## audit

Step `audit<g>`. cwd: the integration worktree. Used when every plan is merged, blocked or skipped.

**Prompt**

```text
Audit the spec `<run-dir>/spec.md` against `git diff <main>...HEAD` on this branch, section by section. Mark every requirement and Done-when line built, accepted deviation, missing or wrong, citing file:line. Owner-only items (real devices, steps the spec reserves for the owner, features the product lacks) are listed apart and are not gaps. Leave out requirements of these blocked or skipped plans: <list>. Write `.spec-runner/audit-<g>.md`.
```

Delete the `Leave out` sentence when no plan is blocked or skipped.

**Role line**

```text
Auditor, round `<g>`. Read only. Report each gap in one line under `findings`.
```
