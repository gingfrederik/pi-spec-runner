# spec-runner dry run

An end-to-end run of the skill on a toy repo, with real `tmux`, `pi` and pi-intercom. It is not
part of `test/run.sh`: it costs model tokens and takes a few minutes per run.

## Make the toy repo

From the package root:

```bash
bash skills/spec-runner/test/dry-run/make-toy-repo.sh /tmp/toy            # normal spec
bash skills/spec-runner/test/dry-run/make-toy-repo.sh /tmp/toy-blocked --blocked
bash skills/spec-runner/test/dry-run/make-toy-repo.sh /tmp/toy-parallel --parallel
```

The repo has one commit on `main`: `package.json` (`"test": "node --test"`, a lockfile so
`npm ci` works), `src/trim.js` with one passing test, `AGENTS.md` ("verification: `npm test`"),
and `docs/specs/toy-design.md`:
1. `slugify(s)` with tests;
2. `titleCase(s)` sharing `slugify`'s word splitting, with the stop point "if `slugify` cannot
   handle Unicode, stop and report", checked before the step starts;
3. publish to npm with the owner's token;
plus a Done-when list. `--blocked` makes step 1 need the owner's private package
`@owner/unicode-tables`, which needs the owner's npm token.

The slug is `toy` (the `-design` suffix is stripped): integration branch `toy`, tmux session
`toy`, orchestrator `toy-orchestrator`.

## Run

Start the orchestrator inside tmux; it needs `$TMUX_PANE` to name itself.

```bash
git -C /tmp/toy rev-parse main > /tmp/toy-main-before.txt
tmux new-session -d -s toy-orch -c /tmp/toy \
  "pi --model anthropic/claude-sonnet-5-5 --thinking medium '/skill:spec-runner docs/specs/toy-design.md'"
```

Workers inherit the model and thinking level. Watch with:

```bash
tmux capture-pane -p -t toy-orch
jq . /tmp/toy/.worktrees/toy/.spec-runner/run.json
git -C /tmp/toy log --graph --oneline --all
~/.pi/agent/npm/node_modules/.bin/pi-intercom list --json
```

Use one run at a time per slug. Before the next run, kill `toy-orch` and `toy`
(`tmux kill-session -t …`) and use a fresh repo directory.

## What to check

| Check | How |
|---|---|
| 2 plans; the npm publish is a manual check, not a plan | `jq '.plans[]|{n,slug,depends_on}, [.plans[].manual_checks]' run.json` |
| every step has its own window in tmux session `toy` | `tmux list-windows -t =toy` while it runs; distinct `window_id`s in `steps[]` |
| reports arrive over intercom | the orchestrator's session file has one `intercom_message` per step |
| each plan merges `--no-ff` into `toy`; worktree and branch gone | `git log --graph`; `git branch`; `git worktree list` |
| the audit ran | `audits[0]`, `.spec-runner/audit-1.md` |
| `report.md` lists the npm publish as a manual check | `.spec-runner/report.md` |
| `main` untouched | `git rev-parse main` equals `/tmp/toy-main-before.txt` |
| no watchdog left after the run | `pgrep -fl watchdog.sh` is empty |
| every task has a focused test command | each plan file names, in every task, a test command narrower than `npm test` |
| no step was blocked for sleeping | no step or subagent transcript of the run contains ``Blocked: `sleep`` |
| the orchestrator made every worktree with `create_worktree` | the orchestrator's session file has a `create_worktree` call for `toy` and for each plan branch |
| `npm ci` ran in every new worktree | the toy repo has no `.worktreeinclude`, so each `create_worktree` result says `No .worktreeinclude` and the orchestrator runs `npm ci` there |

**Resume.** While `p1-execute` runs, exit the orchestrator (`tmux send-keys -t toy-orch C-c`
twice), then start a new orchestrator in the same directory with the same command. It must reuse
`run.json` (one `branch: Created from main` entry in `git reflog show toy`, same `decisions`
split) and record `p1-execute`'s report.

**Watchdog.** Start the orchestrator with a short idle threshold, for example
`tmux new-session -d -s toy-orch -e SPEC_RUNNER_IDLE_S=90 …`. Interrupt a worker mid-turn. In Pi
`C-c` only clears the editor and does not interrupt. With pi-vim, the first `Escape` switches to
NORMAL mode and the second one aborts the turn: `tmux send-keys -t <window-id> Escape`, twice.
Within `SPEC_RUNNER_IDLE_S` + 60 s the orchestrator gets `watchdog: <step> idle without a report`,
nudges the worker once, sets its `current_steps` entry's `nudged`, and starts the 600 s recheck
timer. The worker then finishes and reports, and the `recheck <step>` that arrives 10 min later is ignored.

**Blocked path.** Run on a `--blocked` repo. Plan 1 ends `blocked` with branch `toy-1-slugify` and
its worktree kept; plan 2 (`depends_on: [1]`) is `skipped`; the audit leaves both out; the report
lists both.

## Two lanes

`--parallel` makes the same base repo, but `docs/specs/toy-design.md` gives an example split of
three plans: `slugify` in `src/slug/`, `wordCount` in `src/count/` (independent of each other),
and `summary` in `src/summary/`, which uses both. It has no stop point and no manual-only step.
Its `AGENTS.md` says two plans may run at the same time and a second lane needs no environment variables.

```bash
bash skills/spec-runner/test/dry-run/make-toy-repo.sh /tmp/toy-parallel --parallel
git -C /tmp/toy-parallel rev-parse main > /tmp/toy-parallel-main-before.txt
tmux new-session -d -s toy-orch -c /tmp/toy-parallel \
  "pi --model anthropic/claude-sonnet-5-5 --thinking medium '/skill:spec-runner docs/specs/toy-design.md'"
```

Run it like the normal run, in the same tmux session names. The slug is `toy` here too, so it
collides with the normal run: run one at a time, and kill `toy-orch` and `toy` between runs. In
the checks below, `run.json` is `/tmp/toy-parallel/.worktrees/toy/.spec-runner/run.json`.

| Check | How |
|---|---|
| two lanes were settled | `jq '.lane_env \| length' run.json` prints `2` |
| two plans ran at once | while it runs, `jq '[.plans[] \| select(.status == "running")] \| length' run.json` prints `2`, and `tmux list-windows -t =toy` shows two step windows |
| the tail was serial | the two plans' review steps do not overlap in `steps[].started` / `ended` |
| the second plan to finish was synced | its `steps[]` has `p<n>-sync` before `p<n>-review1` |
| the third plan started only after both merged | its first step's `started` is later than both merge commits' committer times in `git -C /tmp/toy-parallel log --merges --format='%cI %s' toy` |
| every merge was conflict-free and `main` untouched | `git log --graph`; `git rev-parse main` equals `/tmp/toy-parallel-main-before.txt` |
| no watchdog left | `pgrep -fl watchdog.sh` is empty |

## Outcomes, 2026-11-14

Model `anthropic/claude-sonnet-5-5`, thinking `medium`, with the jobs extension installed. The skill ran as a copy named `spec-runner-next`.

| Run | Repo | Result |
|---|---|---|
| Full run, one lane | `/tmp/toy` | Pass, 3.5 min. 2 plans (`slugify`, `title-case` with `depends_on: [1]`), publish in manual checks, 8 reports over intercom (one per step), 2 `--no-ff` merges, worktrees and branches removed, audit 1 with no gaps, `main` unchanged, no watchdog left one tick after the last window closed. `lane_env` `[{}]`, every plan `lane: 0` and `paths: []`, `integrating` never set. The orchestrator picked plans with `next-plan.sh`, made `toy` and both plan worktrees with `create_worktree`, and ran `npm ci` in each (`No .worktreeinclude`). Each planner tried the narrowed form and gave every task a `node --test test/<file>.test.js` command. No step or subagent transcript has `Blocked: \`sleep`. |
| Two lanes | `/tmp/toy-parallel` | Pass, 3.6 min. `lane_env` has 2 entries. Plans 1 (`src/slug`, lane 0) and 2 (`src/count`, lane 1) ran their plan and execute steps at the same time, with two step windows. Plan 2 finished execute first and took `integrating`. Plan 1 waited, then ran `p1-sync` (a clean `git merge toy`) before `p1-review1`. The review steps did not overlap: `p2-review1` ran 13:56:02–13:56:16 and `p1-review1` 13:56:29–13:56:40. Plan 3 (`depends_on: [1, 2]`, `paths` `src/summary`, `src/index.js`) started at 13:56:46, after both merge commits (13:56:16 and 13:56:40). Every merge was conflict-free, `main` was unchanged, no watchdog was left, and no transcript has `Blocked: \`sleep`. |

| Two lanes, 2026-11-15 | `/tmp/toy-parallel` | Pass, 3.7 min, after the lane rule changed: the lane count comes only from the repo's instructions. The toy `AGENTS.md` says "Two plans may run at the same time; a second lane needs no environment variables", and the orchestrator settled `lane_env` `[{}, {}]` from that sentence. Same shape as the run above: plans 1 and 2 side by side, plan 2 merged first, `p1-sync` before `p1-review1`, reviews not overlapping, plan 3 after both merges, `main` unchanged, no watchdog left, no `Blocked: \`sleep`. `report.md` has a wall-clock line. The orchestrator set `integrating` to 3 during `p3-execute`, one step early; nothing else was running. |

Observations, not changed:
- Neither `report.md` gives the time per plan or the wall-clock total that section 8 asks for. The one-lane orchestrator only said "about 3 minutes" in its last message.
- Orchestrators store a short form of each step's report in `steps[].report` (for example `{step, status, commits}`), not the report JSON as received.
- The one-lane orchestrator left plan 2's carried-over line out of the planner prompt, and sent it to the planner as a message instead. It reported this itself.

## Outcomes, 2026-11-01

Model `anthropic/claude-sonnet-5-5`, thinking `medium`. Each run took 2–6 min.

| Run | Repo | Result |
|---|---|---|
| Full run | `/tmp/toy` | Pass. 2 plans (`slugify`, `title-case` with `depends_on: [1]`), publish in manual checks, 7 reports over intercom, 2 `--no-ff` merges, worktrees and branches removed, audit 1 with no gaps, `main` unchanged. Found fix 1 (watchdogs never exited). Fix 2 stayed hidden here by luck: two `toy-orch*` sessions made the prefix `toy` ambiguous, so `launch.sh` created session `toy`. |
| Resume | `/tmp/toy-resume` | Pass. Orchestrator exited during `p1-execute`; the fresh one reused `run.json` (one branch creation, same split) and recorded `p1-execute`'s report. Exposed fix 2: the first windows opened in session `toy-orch`. |
| Watchdog | `/tmp/toy-watchdog` | Pass. `C-c` did not interrupt; two `Escape`s did. Notice after 106 s (`SPEC_RUNNER_IDLE_S=90`), one nudge, worker finished, `recheck p2-execute` arrived from the background timer 600 s later and was ignored. |
| Blocked | `/tmp/toy-blocked` | Pass. `p1-execute` hit E404 on `@owner/unicode-tables` and reported `blocked`; plan 1 `blocked`, branch and worktree kept; plan 2 `skipped`; audit and report list both. |

## Fixes made to the skill during the dry run

1. **`scripts/watchdog.sh` never exited.** In tmux 3.6a, `display-message -p -t <missing window>`
   exits 0, so the window check always passed and every watchdog looped until the 4 h cap, then
   sent a false cap notice. The check is now `tmux list-panes -t <window-id>`, which fails for a
   missing window. `resume.md` step 5 (then `SKILL.md` §1 step 6) uses the same check on
   resume. Tests: the stub's `window-gone` switch moved to `list-panes` (`test/lib.sh`, `test/harness.test.sh`);
   `test/watchdog.test.sh` asserts the check is `list-panes` and runs the loop against a real
   tmux server on a private socket (`-S`, a socket file in the test's temp dir), killing its
   window.
2. **`scripts/launch.sh` matched tmux sessions by prefix.** `tmux has-session -t toy` succeeds
   when only `toy-orch` exists, so windows opened in the orchestrator's session. `launch.sh` now
   uses exact targets, `-t "=<session>"` and `-t "=<session>:"`. `test/launch.test.sh` asserts
   both.

## Open observations (not changed)

- **Ambiguous orchestrator name.** The intercom broker remembers disconnected sessions for 24 h.
  With two disconnected sessions named `toy-orchestrator` (here: the killed full-run orchestrator
  and the resume run's exited one), a worker's `send` to that name fails with
  `E_AMBIGUOUS_TARGET` instead of queueing. In a real run this happens after a second
  orchestrator restart, or when the same slug ran elsewhere within 24 h. Recovery works: the
  worker goes idle, the watchdog's notice (retried every tick) reaches the live orchestrator,
  which nudges the worker to send again. In the resume run the fresh orchestrator went further
  than the skill says and asked the worker to resend straight away.
- **Nudging a pane in pi-vim NORMAL mode** eats the first keys of the nudge (`Your last…`
  arrived as `ur last…`). A pane is in NORMAL mode only after someone pressed `Escape`.
- The full-run orchestrator first aliased itself `toy-strings-orchestrator` (from
  `package.json`), then corrected to `toy-orchestrator`.
- Orchestrators checked the spec's stop point themselves after plan 1 (a read-only `node -e`)
  rather than through a step that reports `stop`.
- Known deferred minors not hit in these runs (resume of a `nudged` idle step losing its recheck
  timer; a relaunched audit adding a second `audits[]` entry; untyped `baseline: null`) are fixed
  below, under "Final review fixes".

## Untested

Not run live; covered only by the procedure text and, where noted, unit tests:
- the broker-queued resume path: a report sent while no orchestrator ran, queued by the broker
  and delivered to the next orchestrator. Every resume run so far had a stale same-name session,
  so `send` failed with `E_AMBIGUOUS_TARGET` instead;
- the resume nudge of `resume.md` step 5: an idle, still-listed worker nudged to resend its
  report, the watchdog restarted when `pgrep` finds none, and a `nudged` step failed on resume.

## Final review fixes

Made after the final whole-branch review, without a new live run.
- **Resume of an idle listed worker (I1).** The resume procedure moved to `resume.md` (SKILL.md
  stays at 250 lines). An idle, listed worker is handled like a watchdog idle notice: nudged to
  resend its report with the recheck timer, or `failed` if already `nudged`. A missing watchdog
  (`pgrep -f "watchdog.sh <window-id> <session-id>"`) is restarted as `launch.sh` starts it. The
  broker-queue claim now names the same-name disconnected session case.
- **Resume during setup (I2).** `baseline` null resumes at section 2 step 7, empty `plans` at
  section 3. `run-schema.md` types `baseline` as "object, or null until recorded".
- **Crashed or exited worker (I3).** `watchdog.sh` counts status `gone` as `idle` for the idle
  clock and the notice reset, so a crashed worker gets the idle notice. `launch.sh` exits 1 when
  `<cwd>` is not a directory; the launch file runs `cd <cwd> && pi …`, so a failed `cd` skips
  `pi` and falls through to the `[pi exited]` tail. Tests: a `gone` worker gets exactly one idle
  notice; a missing cwd exits 1 and opens no window; a vanished cwd does not run `pi`.
- **Mac sleep (I4).** A tick longer than `tick_s + 120` s counts as one tick on both clocks. The
  clock is `now_s`, overridden in a loop test where a 100000 s jump sends no notice.
- **Minors.** `findings` covers audit steps (M1); an audit that does not report `done` goes to
  the final report marked incomplete (M2); a relaunched audit reuses its `audits[]` entry (M3);
  the default branch is resolved once into `run.json` `main_branch` and used as `<main>` in
  SKILL.md and the audit prompt (M4); `.worktrees/` is added to `info/exclude` unless already
  ignored (M5); the orchestrator checks a stop point read-only right after its plan merges (M6);
  `watchdog:` and `recheck` messages for another step are ignored (M7); the final report lists
  plan-file leaks.
- **Real-tmux test.** It fails on a window id without `@` and on a watchdog that exits before
  its window is killed, prints `SKIP real-tmux` when tmux is absent (`test/run.sh` shows `SKIP`
  lines under `PASS`), and starts the private server with `-f /dev/null`.
