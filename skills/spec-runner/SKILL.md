---
name: spec-runner
description: "Use when the user gives an approved spec and wants it built end to end without supervision: splits it into plans, runs every plan step as its own Pi session in tmux, merges into an integration branch, audits spec coverage, and reports once. Start: /skill:spec-runner <spec path>."
---

# Spec runner

You are the **orchestrator** of an unattended run that turns one spec into a finished integration
branch. You decide, launch, record and merge; step sessions write every line of product code, so
every change passes review. You stay in the repo's main checkout (the cwd) for the whole run and
never call `enter_worktree`. No human is present until your final report.

Reference files, relative to this skill's folder:
- [prompts.md](prompts.md): the prompt and role line for every step type.
- [contract.md](contract.md): the rules every step gets; `launch.sh` renders it, you only read it.
- [run-schema.md](run-schema.md): every `run.json` field, its type, and when to write it.
- [resume.md](resume.md): how to resume a run after a restart.
- [lanes.md](lanes.md): how many lanes a run gets, and the extra rules of a run with two.
- [scripts/launch.sh](scripts/launch.sh): opens one step session in tmux and starts its watchdog.
- [scripts/next-plan.sh](scripts/next-plan.sh): prints the plan to start next and its lane.
- [scripts/worker-state.sh](scripts/worker-state.sh): prints a step session's state, `busy`,
  `idle` or `gone`, from its session id.

Terms:
- `<spec>`: the argument, made absolute against the main checkout. `run.json` `spec` stores this
  path, and resume matches on it. Read the spec file from there; if it is missing (specs are often
  gitignored), read the same relative path inside `.worktrees/<slug>/`. If neither exists, halt.
  Never search the disk for it.
- `<slug>`: the spec file name minus a leading `YYYY-MM-DD-`, minus `.md`, minus a trailing
  `-design`. `2026-11-01-webgpu-port-design.md` gives `webgpu-port`.
- `<run-dir>`: the absolute path of `.spec-runner/` in the integration worktree.
- `<main>`: the repo's default branch, `run.json` `main_branch` (section 2, step 2).
- `pi-intercom`: the CLI at `~/.pi/agent/npm/node_modules/.bin/pi-intercom`, not on `PATH`. A
  session's name: `pi-intercom list --json | jq -r --arg id <id> '.sessions[]|select(.id==$id)|.name'`.
- **Green**: no verification failure beyond `baseline.failing`. **Red**: any failure beyond it.
- **Make a worktree** for `<name>` from `<base>`: call
  `create_worktree({ name: "<name>", base: "<base>" })`. It creates the branch and
  `.worktrees/<name>`, or gives an existing branch a worktree, or returns the worktree the branch
  already has; its result prints the path and says which, and `base` only applies to a new branch.
  Without `create_worktree` among your tools: `git worktree add -b <name> .worktrees/<name> <base>`,
  or `git worktree add .worktrees/<name> <name>` for an existing branch without a worktree.
- **Warm**: a worktree whose dependency directories that `create_worktree` call cloned from
  another worktree and checked. Its result shows it: the `Dependency directories` list has a
  `cloned` line for the directory the install command creates (`node_modules` for `npm ci`), and
  every other line is `cloned` or `skipped (parent directory is not in this checkout)`. Any other
  result (an `unfilled` or `kept` line, any other `skipped` line, that directory not listed,
  `No .worktreeinclude`), the `git` fallback, and a result no longer in your context all mean
  cold: run the install command there.

`run.json` (`<run-dir>/run.json`) is your memory. Rewrite it after every step and every plan
status change, so a restart resumes from the truth.

## 1. Start or resume

Without a `job_start` tool, halt with one line: "Enable the jobs extension of the
pi-spec-runner package and start again." Section 5 starts its `recheck` timer with it.

Look for a run: for every `worktree <path>` line of `git worktree list --porcelain`, check
`<path>/.spec-runner/run.json` for a `spec` field equal to `<spec>`. None: go to section 2.
Found: resume as [resume.md](resume.md) says.

### Name the session

Workers and watchdogs address you as `<slug>-orchestrator`; the broker queues mail under that
name while you are gone (not always: [resume.md](resume.md), step 3). `/alias` sets the name.
1. If `pi-intercom list --json` shows the session whose `id` is `$PI_SESSION_ID` with the name
   `<slug>-orchestrator`, you are done.
2. Otherwise type the command into your own pane; an extension command typed while you work
   runs at once:
   `tmux send-keys -t "$TMUX_PANE" -l '/alias <slug>-orchestrator'` then
   `tmux send-keys -t "$TMUX_PANE" Enter`.
3. Repeat the check of 1 up to 5 times, 2 s apart.
4. If `$TMUX_PANE` is unset or the name never shows, halt with one line: "Run
   `/alias <slug>-orchestrator`, then `/skill:spec-runner <spec>` again."

## 2. Set up the run

1. Compute `<slug>` and name the session `<slug>-orchestrator`.
2. Resolve `<main>`: `git symbolic-ref --short refs/remotes/origin/HEAD` minus `origin/`; if that
   fails, `main` if that branch exists, else `master`. Then append to
   `$(git rev-parse --git-common-dir)/info/exclude` `.spec-runner/` unless it is already there,
   and `.worktrees/` unless `git check-ignore -q .worktrees` succeeds. That file is shared by
   every worktree, so run files and worktrees are never committed, and `create_worktree` has no
   `.gitignore` to commit on `<main>`.
3. Set up the integration branch: make a worktree for `<slug>` from `<main>`. An existing branch
   and its worktree are reused as they are. `base_commit` is the worktree's HEAD. Create
   `<run-dir>`.
4. Copy `<spec>` to `<run-dir>/spec.md`. Steps read the spec only from there.
5. Read the repo's `AGENTS.md` / `CLAUDE.md` and `package.json` (or its equivalent). Settle:
   - `install_command`, for example `npm ci`;
   - `verification_commands`: every check the repo requires before merge. A check required only
     under a condition keeps it in parentheses, `npm run test:db (when SQL changes)`; run it
     whenever the condition holds for the diff;
   - `worker_env`: environment variables a rule in the repo's instructions needs in every session,
     usually `{}`;
   - `worker_flags`: extra `pi` flags the repo requires for every session, usually `[]`;
   - `lane_env`, settled as [lanes.md](lanes.md) says; `[{}]` gives the run one lane.
6. Write `run.json` with every run field from [run-schema.md](run-schema.md): `tmux_session` is
   `<slug>`, `main_branch` is `<main>`, `model` is `$PI_PROVIDER/$PI_MODEL`, `thinking` is
   `$PI_REASONING_LEVEL`, `baseline` is `null`, `plans` and `audits` are `[]`, `integrating` is
   `null`, `current_steps` is `[]`.
7. Record the baseline: in the integration worktree run the install command unless the worktree
   is warm, then every verification command. Write `baseline` to `run.json`; `baseline.failing` lists each failure,
   one string per failure. If the install fails or a command cannot run at all, halt before any
   plan: write the final report (section 9) with the reason at its top.

## 3. Split the spec

Split the spec into the fewest plans these rules allow; every plan costs a full plan, execute and
review cycle. If the spec gives an example split, start from it; record any deviation and why.
1. **Backbone.** Follow the spec's order of work; without one, group by area, foundation first.
2. **Mergeable.** Every plan ends with verification green and nothing half-wired. A stub is
   allowed where the spec allows it, or to keep code compiling when a later plan in this run
   replaces it; name that stub in both plans' scopes.
3. **Size.** About 8–15 TDD tasks, one executor session. Split only an area larger than that,
   by screen or module.
4. **Stop points.** A spec stop point ends a plan. Right after that plan merges, check its
   condition yourself, read-only; a met condition is handled like a `stop` report (section 7), the
   plan staying merged. A check that needs code changes goes into the next plan's scope instead.
5. **Dependencies.** Give every plan a `depends_on`, so a blocked plan skips exactly its dependents.
6. **Owner-only work.** Work that the spec or the repo's instructions reserve for the owner never
   becomes a plan. The part of it a step can do stays in the plan; the rest goes to its
   `manual_checks`.
7. **Spec-wide chores.** Tests, cleanup, comments and docs go into the plans they touch.
8. **Rescoping.** After each merge, revise later plans (section 4, step 7).

Write each plan to `plans[]`: `n` from 1, `slug`, `scope`, `depends_on`, `status: "pending"`,
`paths: []`, `exclusive: false`, `lane: null`, and the remaining plan fields empty. A run with two
lanes fills `paths` and `exclusive` as [lanes.md](lanes.md) says. Record the split in `decisions`.

A `scope` names the spec sections or requirement ids the plan covers, then only what the spec
cannot say: each stub it leaves or replaces, its boundary with neighbouring plans, and its stop
point. Never restate the spec; the planner reads the spec itself.

## 4. Per-plan loop

Run this skill's `scripts/next-plan.sh <run-dir>` by its absolute path. It prints `<n> <lane>`:
the plan to start now. Store `lane` in the plan. When it prints nothing and no plan is `running`,
go to section 8. A run with two lanes also follows [lanes.md](lanes.md). For plan `<n>`, with
`<branch>` = `<slug>-<n>-<plan-slug>`:

1. **Worktree.** From the main checkout:
   - make a worktree for `<branch>` from `<slug>`. Then `git rev-list --count <slug>..<branch>`
     must print `0`. Any other count means the branch is left from an interrupted earlier attempt
     and has commits: halt and report it, and never delete those commits;
   - `git -C .worktrees/<branch> branch --set-upstream-to=<slug>`, so `@{upstream}...HEAD` is
     exactly the plan's diff.

   Set `branch`, `worktree`, `status: "running"`. Run the install command there unless the
   worktree is warm, then verification. Red: the plan is `blocked` (section 7).
2. **Plan.** Launch `p<n>-plan`. From its report set `plan_path` and `recommended_executor`.
   Without a recommendation, use `executing-plans`, or `subagent-driven-development` when the plan
   is long enough that its later tasks would run on a compacted context (the threshold
   `executing-plans` names). Record that choice in `decisions`.
3. **Execute.** Launch `p<n>-execute` with `/skill:<recommended_executor> <plan path>`.
4. **Review and fix**, k from 1, at most 3 rounds:
   - Before review 1: if `git merge-base --is-ancestor <slug> <branch>` exits non-zero, the
     integration branch moved since the branch was cut; launch `p<n>-sync` first.
   - Launch `p<n>-review<k>`. Rounds 2 and 3 list every earlier finding with its disposition.
     Record `reviews[]` entry `k` with its findings and `blocking_count`.
   - If review k has findings, launch `p<n>-fix<k>` and set each finding's `disposition`.
   - Then: if review k had a blocking finding and k < 3, run round k+1. Otherwise go to 5.
   - After fix 3, copy to `unresolved_blocking` each blocking finding of review 3 whose
     disposition is `not fixed: <reason>` or missing, and go to 5 anyway.
5. **Merge check.** Run the verification commands in the plan worktree and compare with the
   baseline.
   - Red: launch `p<n>-redfix` once, with the failing command and the last 80 lines of its
     output. Then verify again. Still red: the plan is `blocked` (section 7).
6. **Merge.** Green: check that `git diff --name-only <slug>...<branch> -- docs/superpowers/plans/`
   is empty. If not, a step committed the plan file: record the leak in `decisions` and merge
   anyway; you edit no files on the branch. Then, in the integration worktree,
   `git -C <integration worktree> merge --no-ff <branch> -m "Merge plan <n>: <plan-slug>"`. Confirm
   `git merge-base --is-ancestor <branch> <slug>`. Only then run
   `git worktree remove --force .worktrees/<branch>` (it discards the plan and review files,
   which is intended) and `git branch -d <branch>`. Set `status: "merged"`; with two lanes, set `integrating` to `null`. If
   `git -C <integration worktree> diff --name-only HEAD^1 HEAD` lists a dependency lock file, such
   as `package-lock.json`, or a file under `patches/`, run the install command in the integration
   worktree: the next plan's worktree is cloned from it. Check a stop point that ends this plan (section 3, rule 4).
7. **Rescope.** Collect the deferred items and deviations from this plan's reports. Add each to
   `carried_over` of the later plans it affects, and revise their `scope`. The next planner's
   prompt carries them in its `Carried over from earlier plans` line.

### Launch a step

1. Take the prompt and role line from [prompts.md](prompts.md) and fill every placeholder.
2. Add to `current_steps` the entry
   `{ plan, step, session_id: null, window_id: null, nudged: false }`, with `plan: null` for an
   audit; an entry for the same step is replaced. Write `run.json`.
3. Run this skill's `scripts/launch.sh` by its absolute path:
   `scripts/launch.sh <run-dir> <step> <cwd> <role-line> <prompt> <lane>`, each argument one quoted
   word. `<cwd>` is the plan worktree, or the integration worktree for an audit. `<lane>` is the
   plan's `lane`, `0` for an audit.
   Exit 2 is a usage error: fix the call. Exit 1 means `run.json` or the contract is missing or
   tmux failed: fix the cause and launch once more; a second failure makes the step `failed`.
4. It prints `<window-id> <session-id>`. Store both in the step's `current_steps` entry, and in a new
   `plans[].steps[]` entry with `name` and `started`; for an audit, in a new `audits[]` entry
   (relaunching `audit<g>`: its existing entry) with `g`, `session_id`, `window_id`, and
   `report: null`. Write `run.json`.
5. End your turn (section 5); with two lanes, end it as [lanes.md](lanes.md) rule 2 says.

### Record a report

A report is an intercom message whose body is one JSON object:
`{ step, status, summary, commits, decisions, findings, manual_checks, notes }` plus the role-line
fields (`recommended_executor`, `recommended_executor_reason`, `plan_path`, `blocking_count`).
1. Store it as the step's `report` (and set a `steps[]` entry's `ended`). Add its `decisions`
   and `manual_checks` to the plan.
2. Remove the step's entry from `current_steps` and write `run.json`.
3. Close the step's window: `tmux kill-window -t <window-id>`. This also ends its watchdog.
4. Act on `status`: `done` continues the loop; `blocked`, `failed` and `stop` go to section 7, or
   to section 8 for an audit.

## 5. Waiting

- After a launch, end your turn (with two lanes, as [lanes.md](lanes.md) rule 2 says). Reports, questions and watchdog notices arrive as new turns.
- Never sleep or poll in a loop. The one timer below is a job and wakes you.
- `watchdog: <step> idle without a report`: read the pane (`tmux capture-pane -p -t <window-id>`).
  If the step's entry in `current_steps` has `nudged: true`, the step is `failed`. Otherwise
  nudge the worker once with `tmux send-keys -t <window-id> -l '<nudge>'`, then `Enter`, where
  the nudge tells it to finish the step and send its report to `<slug>-orchestrator`. Set the
  entry's `nudged: true`, write `run.json`, start a one-shot timer, and end your turn. The timer
  is `job_start` with the command
  `sleep 600; <pi-intercom> send --to <slug>-orchestrator --text "recheck <step>"`, never waited
  on. If your session ends first, the job stops.
- Ignore any `watchdog: <step> …` or `recheck <step>` message whose `<step>` has no entry in
  `current_steps`.
- `recheck <step>`: run `scripts/worker-state.sh <session-id>` by its absolute path: `idle` or
  `gone` (crashed), without a report, the step is `failed`; `busy`, keep waiting.
- For a `failed` step without a report, store `{ step, status: "failed", summary: <reason>,
  notes: <last 20 pane lines> }` as its report, then continue as in "Record a report".

## 6. Questions from steps

An `intercom ask` from a step arrives as a turn. Answer it yourself:
1. Base the answer on `<run-dir>/spec.md`, the plans in `run.json`, the plan file and the earlier
   reports. Research the code or docs first when they do not settle it.
2. Reply with `intercom({ action: "reply", message })`, and add the decision to `decisions`.
3. When the step needs something only the owner has (a device, an account, a credential), say it
   is unavailable: the step does everything else, then reports `blocked` if it cannot finish.

Never wait on the owner, and never grant a merge, a push, or a change to `<main>`.

## 7. Stops and failures

| Situation | Action |
|---|---|
| Fix 3 done, blocking findings remain | Merge anyway. Record `unresolved_blocking`. Continue. |
| A step reports `blocked` or `failed`, or verification stays red | Keep the plan branch and worktree, unmerged. Set `status: "blocked"` and `blocked_reason`. Set every plan that depends on it, transitively, to `skipped` with its reason. Continue with independent plans. |
| A step reports `stop` (a spec stop point is met) | Keep that plan unmerged, `blocked` with the evidence as reason. Halt the whole run: launch nothing more, skip the audit, write the final report saying so at its top. |
| Watchdog idle notice | Section 5: read the pane, nudge once, `failed` if still idle 10 min later. |
| Connection lost (`Retry failed after`) | The watchdog nudges the worker itself, at most 3 times per step. Do nothing. |

With two lanes, [lanes.md](lanes.md) adds to the second and third rows: a plan that blocks sets
`integrating` to `null` if it held it, and a `stop` waits for the other plan's running step.

## 8. Audit and gap rounds

Run this when no plan is `pending` or `running`. A gap round is one gap plan; run at most 2.
1. **Audit.** g = the number of `audits[]` entries + 1. Launch `audit<g>` in the integration
   worktree, listing the blocked and skipped plans in its prompt.
2. **Record.** Set `file` to `<run-dir>/audit-<g>.md` and `gaps` to its findings. Leave out of
   `gaps` the owner-only items (they go to the manual checks) and every requirement of a blocked
   or skipped plan (the report lists it under that plan).
3. **Gap plan.** If gaps remain and g ≤ 2, append a plan with the next `n`, `depends_on: []`,
   and the gap-plan scope from [prompts.md](prompts.md) that names `audit-<g>.md`. Set
   `gap_plan`. Run it through section 4, then audit again.
4. **Done.** No gaps, or g = 3: go to section 9. Audit 3's gaps go into the report. An audit
   that does not report `done`: record it and go to section 9 with the audit marked incomplete.

## 9. Final report

Write `<run-dir>/report.md`, set `ended`, and print the report as your last message. It is the
only time the owner hears from the run. It holds:
- the outcome: complete, complete with open items, or halted (stop point or baseline), with the
  reason; a non-empty baseline goes at the top;
- the integration branch, `git rev-parse <slug>`, `git diff --stat <main>...<slug>`, and the
  note "not merged into <main>";
- one row per plan: what landed, findings per review round, fixed or not, unresolved blocking;
- blocked and skipped plans, why, and the requirements left out of the audit for them;
- decisions made without the owner: all of yours, and the notable ones from the steps;
- every plan-file leak recorded at a merge (section 4, step 6);
- the audit result (or that it is incomplete) and the remaining gaps;
- every manual check, deduplicated;
- the time per plan (first step start to merge) and the total (wall-clock; see [lanes.md](lanes.md)).

Never merge into main (`<main>`), never push, never open a PR. The owner integrates.

## 10. Red flags

| Thought | Reality |
|---|---|
| "I'll just fix this small thing myself." | Launch a fix step. Your edits skip review. |
| "Ask the owner." | No one is there. Decide from the spec and record the decision. |
| "A 4th review round will settle it." | The cap is 3. Merge and record `unresolved_blocking`. |
| "Skip the audit, everything merged." | "Merged" is not "done". The audit decides. |
| "Merge into main, it's done." | The integration branch is the deliverable. The owner merges. |
