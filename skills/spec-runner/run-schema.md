# `run.json`

`.spec-runner/run.json` in the integration worktree is the orchestrator's memory. Rewrite it after
every step, and after every change of a plan's status, so a resume reads the truth from it.

- Times are ISO 8601 UTC strings. An open value is `null`.
- Step names are `p<n>-plan`, `p<n>-execute`, `p<n>-review<k>`, `p<n>-fix<k>`, `p<n>-sync`, `p<n>-redfix`, `audit<g>`.
- `launch.sh` reads the eight fields marked `launch.sh`. `next-plan.sh` reads `orchestrator`, `lane_env`
  and, of each plan, `status`, `depends_on`, `paths`, `exclusive` and `lane`. `watchdog.sh` reads
  nothing from `run.json`. The orchestrator reads and writes everything else.
- Keep `slug`, `orchestrator`, `tmux_session`, `model`, `thinking`, `worker_env`, `worker_flags` and
  `lane_env` exactly as typed below. A different name or type breaks `launch.sh`.

## Fields

Run:

| field | type | written when | read by |
|---|---|---|---|
| `slug` | string | run start | `launch.sh`, orchestrator |
| `orchestrator` | string, `<slug>-orchestrator` | run start | `launch.sh`, `next-plan.sh`, orchestrator |
| `tmux_session` | string, equals `slug` | run start | `launch.sh`, orchestrator |
| `model` | string, `<provider>/<id>` | run start | `launch.sh`, orchestrator |
| `thinking` | string | run start | `launch.sh`, orchestrator |
| `worker_env` | object, string to string | run start | `launch.sh`, orchestrator |
| `worker_flags` | array of strings, extra `pi` flags for every worker, usually empty | run start | `launch.sh`, orchestrator |
| `lane_env` | array of 1 or 2 objects, string to string; the first is `{}`. Lane `i` exports `lane_env[i]` after `worker_env`. A missing `lane_env` is `[{}]`, one lane | run start | `launch.sh`, `next-plan.sh`, orchestrator |
| `integrating` | integer or null: the plan that holds the tail (sync to merge) | a plan takes it after execute; `null` when that plan is merged or blocked | orchestrator |
| `spec` | string, absolute path of the spec in the main checkout | run start | orchestrator |
| `main_branch` | string, the repo's default branch (`<main>` in SKILL.md), such as `main` or `master` | run start | orchestrator |
| `integration_branch` | string, equals `slug` | run start | orchestrator |
| `integration_worktree` | string, absolute path | run start | orchestrator |
| `base_commit` | string, the `main_branch` commit the branch started from, or the reused branch's HEAD | run start | orchestrator |
| `started` | string | run start | orchestrator |
| `ended` | string or null | the final report is written | orchestrator |
| `orchestrator_session_id` | string | run start, and again on resume | orchestrator |

Settled from `AGENTS.md`:

| field | type | written when | read by |
|---|---|---|---|
| `install_command` | string | run start | orchestrator |
| `verification_commands` | array of strings | run start | orchestrator |
| `baseline` | object, or null until recorded | `null` at run start, then the baseline run | orchestrator, on resume |
| `baseline.result` | `green` or `red` | the baseline run at run start | orchestrator |
| `baseline.failing` | array of strings, one per failure beyond a clean run | the baseline run | orchestrator |

Plans, `plans[]` in plan order. A gap plan is appended with the next `n`:

| field | type | written when | read by |
|---|---|---|---|
| `plans[].n` | integer | the split | orchestrator |
| `plans[].slug` | string | the split | orchestrator |
| `plans[].scope` | string, one paragraph | the split; revised after each merge | orchestrator |
| `plans[].depends_on` | array of plan numbers | the split | `next-plan.sh`, orchestrator |
| `plans[].paths` | array of strings, repo-relative directories or files the plan will write; `[]` in a one-lane run | the split; revised with `scope` | `next-plan.sh`, orchestrator |
| `plans[].exclusive` | boolean, true for a plan that carries a stop point | the split | `next-plan.sh`, orchestrator |
| `plans[].lane` | integer or null | the plan starts | `next-plan.sh`, orchestrator |
| `plans[].carried_over` | array of strings, deferred items and deviations from earlier plans | after each merge | orchestrator |
| `plans[].branch` | string, `<slug>-<n>-<plan-slug>` | the plan's worktree is created | orchestrator |
| `plans[].worktree` | string, absolute path | the plan's worktree is created | orchestrator |
| `plans[].status` | `pending`, `running`, `merged`, `blocked` or `skipped` | the split, then on every change | `next-plan.sh`, orchestrator |
| `plans[].plan_path` | string or null, absolute path | the planner reports | orchestrator |
| `plans[].recommended_executor` | `subagent-driven-development`, `executing-plans` or null | the planner reports | orchestrator |
| `plans[].unresolved_blocking` | array of strings, blocking findings left after fix 3 | fix 3 is recorded | orchestrator |
| `plans[].decisions` | array of strings, from the step reports | each step's report | orchestrator |
| `plans[].manual_checks` | array of strings | each step's report | orchestrator |
| `plans[].blocked_reason` | string or null | the plan becomes `blocked` or `skipped` | orchestrator |

Steps and reviews of a plan:

| field | type | written when | read by |
|---|---|---|---|
| `plans[].steps[].name` | string | the step is launched | orchestrator |
| `plans[].steps[].session_id` | string | the step is launched | orchestrator |
| `plans[].steps[].window_id` | string, tmux id such as `@12` | the step is launched | orchestrator |
| `plans[].steps[].started` | string | the step is launched | orchestrator |
| `plans[].steps[].ended` | string or null | the step's report is recorded | orchestrator |
| `plans[].steps[].report` | object or null, the step's report JSON as received; the role-line fields `recommended_executor`, `recommended_executor_reason` and `plan_path` (planner) and `blocking_count` (reviewer) sit at its top level | the step's report is recorded | orchestrator |
| `plans[].reviews[].k` | integer, 1 to 3 | review `k` reports | orchestrator |
| `plans[].reviews[].findings[].finding` | string, the reviewer's line: location, summary, category, blocking | review `k` reports | orchestrator |
| `plans[].reviews[].findings[].disposition` | string or null, `fixed in <sha>` or `not fixed: <reason>` | fix `k` reports | orchestrator |
| `plans[].reviews[].blocking_count` | integer | review `k` reports | orchestrator |

Audits, `audits[]`:

| field | type | written when | read by |
|---|---|---|---|
| `audits[].g` | integer, 1 to 3; audit 3 never gets a gap plan | the audit is launched | orchestrator |
| `audits[].file` | string, absolute path of `audit-<g>.md` | the audit reports | orchestrator |
| `audits[].gaps` | array of strings, one per gap | the audit reports | orchestrator |
| `audits[].gap_plan` | integer or null, the number of the gap plan | the gap plan is added | orchestrator |
| `audits[].session_id` | string | the audit is launched | orchestrator |
| `audits[].window_id` | string, tmux id such as `@12` | the audit is launched | orchestrator |
| `audits[].report` | object or null, the audit's report JSON as received | the audit reports | orchestrator |

An audit step has no plan, so its `current_steps[]` entry has `plan: null`. While the audit runs, its session and window ids are in its `audits[]` entry and mirrored in its `current_steps[]` entry for resume; its report is recorded when it reports.

Resume and decisions:

| field | type | written when | read by |
|---|---|---|---|
| `current_steps` | array of one entry per running step; `[]` when none. An entry is `{ plan, step, session_id, window_id, nudged }` | an entry is added before each launch and removed when the report is recorded | orchestrator, on resume |
| `current_steps[].plan` | integer, or null for an audit step | before each launch | orchestrator, on resume |
| `current_steps[].step` | string, the step name | before each launch | orchestrator, on resume |
| `current_steps[].session_id` | string | the launch returns | orchestrator, on resume |
| `current_steps[].window_id` | string | the launch returns | orchestrator, on resume |
| `current_steps[].nudged` | boolean, true once the orchestrator nudged this step's idle worker | false before each launch; true at the nudge | orchestrator, on resume |
| `decisions` | array of strings, the orchestrator's own decisions | when made | orchestrator, for the final report |

## Example

Two plans. Plan 1 is merged. Plan 2 is running, in its first review round.

```json
{
  "slug": "webgpu-port",
  "orchestrator": "webgpu-port-orchestrator",
  "tmux_session": "webgpu-port",
  "model": "anthropic/claude-opus-4-5",
  "thinking": "high",
  "worker_env": { "ANDROID_SERIAL": "emulator-5554" },
  "worker_flags": [],
  "lane_env": [{}],
  "integrating": 2,
  "spec": "/Users/me/app/docs/superpowers/specs/2026-11-01-webgpu-port-design.md",
  "main_branch": "main",
  "integration_branch": "webgpu-port",
  "integration_worktree": "/Users/me/app/.worktrees/webgpu-port",
  "base_commit": "3f9c2ab",
  "started": "2026-11-01T09:00:12Z",
  "ended": null,
  "orchestrator_session_id": "7d1e0c52-4b1a-4c7e-9a52-0e6f3b8d2a10",
  "install_command": "npm ci",
  "verification_commands": ["npm run typecheck", "npm test"],
  "baseline": { "result": "green", "failing": [] },
  "plans": [
    {
      "n": 1,
      "slug": "canvas-host",
      "scope": "Set up WebGPU and the canvas host with the built-in materials (spec steps 1 and 2).",
      "depends_on": [],
      "paths": [],
      "exclusive": false,
      "lane": 0,
      "carried_over": [],
      "branch": "webgpu-port-1-canvas-host",
      "worktree": "/Users/me/app/.worktrees/webgpu-port-1-canvas-host",
      "status": "merged",
      "plan_path": "/Users/me/app/.worktrees/webgpu-port-1-canvas-host/docs/superpowers/plans/2026-11-01-canvas-host.md",
      "recommended_executor": "subagent-driven-development",
      "unresolved_blocking": [],
      "decisions": ["Kept the renderer behind the existing Scene interface."],
      "manual_checks": ["Run the canvas on a real Android device before merge to main."],
      "blocked_reason": null,
      "steps": [
        {
          "name": "p1-plan",
          "session_id": "0a6b1c3e-1f0d-4c55-8d0a-6c1c2b9e0001",
          "window_id": "@12",
          "started": "2026-11-01T09:10:40Z",
          "ended": "2026-11-01T09:31:02Z",
          "report": {
            "step": "p1-plan",
            "status": "done",
            "summary": "Plan with 11 tasks.",
            "commits": [],
            "decisions": [],
            "manual_checks": [],
            "notes": "",
            "recommended_executor": "subagent-driven-development",
            "recommended_executor_reason": "The tasks are independent.",
            "plan_path": "/Users/me/app/.worktrees/webgpu-port-1-canvas-host/docs/superpowers/plans/2026-11-01-canvas-host.md"
          }
        },
        {
          "name": "p1-execute",
          "session_id": "0a6b1c3e-1f0d-4c55-8d0a-6c1c2b9e0002",
          "window_id": "@13",
          "started": "2026-11-01T09:32:15Z",
          "ended": "2026-11-01T10:14:48Z",
          "report": {
            "step": "p1-execute",
            "status": "done",
            "summary": "11 tasks committed.",
            "commits": ["a1b2c3d", "e4f5a6b"],
            "decisions": ["Kept the renderer behind the existing Scene interface."],
            "manual_checks": [],
            "notes": ""
          }
        },
        {
          "name": "p1-review1",
          "session_id": "0a6b1c3e-1f0d-4c55-8d0a-6c1c2b9e0003",
          "window_id": "@14",
          "started": "2026-11-01T10:15:30Z",
          "ended": "2026-11-01T10:27:11Z",
          "report": {
            "step": "p1-review1",
            "status": "done",
            "summary": "2 findings, none blocking.",
            "commits": [],
            "decisions": [],
            "findings": [
              "src/gpu/host.ts:42 — frame buffer re-allocated every frame — efficiency — blocking: false",
              "src/gpu/host.ts:88 — duplicate adapter lookup — reuse — blocking: false"
            ],
            "manual_checks": [],
            "notes": "",
            "blocking_count": 0
          }
        },
        {
          "name": "p1-fix1",
          "session_id": "0a6b1c3e-1f0d-4c55-8d0a-6c1c2b9e0004",
          "window_id": "@15",
          "started": "2026-11-01T10:28:05Z",
          "ended": "2026-11-01T10:41:37Z",
          "report": {
            "step": "p1-fix1",
            "status": "done",
            "summary": "Both findings handled.",
            "commits": ["c7d8e9f"],
            "decisions": [],
            "findings": [
              "src/gpu/host.ts:42 — fixed in c7d8e9f",
              "src/gpu/host.ts:88 — fixed in c7d8e9f"
            ],
            "manual_checks": [],
            "notes": ""
          }
        }
      ],
      "reviews": [
        {
          "k": 1,
          "findings": [
            {
              "finding": "src/gpu/host.ts:42 — frame buffer re-allocated every frame — efficiency — blocking: false",
              "disposition": "fixed in c7d8e9f"
            },
            {
              "finding": "src/gpu/host.ts:88 — duplicate adapter lookup — reuse — blocking: false",
              "disposition": "fixed in c7d8e9f"
            }
          ],
          "blocking_count": 0
        }
      ]
    },
    {
      "n": 2,
      "slug": "directional-shadows",
      "scope": "Directional shadows (spec step 3). Stop point: check the shadow-acne condition right after this plan.",
      "depends_on": [1],
      "paths": [],
      "exclusive": false,
      "lane": 0,
      "carried_over": ["Plan 1 deferred the fallback for devices without WebGPU."],
      "branch": "webgpu-port-2-directional-shadows",
      "worktree": "/Users/me/app/.worktrees/webgpu-port-2-directional-shadows",
      "status": "running",
      "plan_path": "/Users/me/app/.worktrees/webgpu-port-2-directional-shadows/docs/superpowers/plans/2026-11-01-directional-shadows.md",
      "recommended_executor": "executing-plans",
      "unresolved_blocking": [],
      "decisions": [],
      "manual_checks": [],
      "blocked_reason": null,
      "steps": [
        {
          "name": "p2-plan",
          "session_id": "0a6b1c3e-1f0d-4c55-8d0a-6c1c2b9e0005",
          "window_id": "@16",
          "started": "2026-11-01T10:50:20Z",
          "ended": "2026-11-01T11:04:09Z",
          "report": {
            "step": "p2-plan",
            "status": "done",
            "summary": "Plan with 8 tasks.",
            "commits": [],
            "decisions": [],
            "manual_checks": [],
            "notes": "",
            "recommended_executor": "executing-plans",
            "recommended_executor_reason": "The tasks share one file.",
            "plan_path": "/Users/me/app/.worktrees/webgpu-port-2-directional-shadows/docs/superpowers/plans/2026-11-01-directional-shadows.md"
          }
        },
        {
          "name": "p2-execute",
          "session_id": "0a6b1c3e-1f0d-4c55-8d0a-6c1c2b9e0006",
          "window_id": "@17",
          "started": "2026-11-01T11:05:00Z",
          "ended": "2026-11-01T11:38:26Z",
          "report": {
            "step": "p2-execute",
            "status": "done",
            "summary": "8 tasks committed.",
            "commits": ["1a2b3c4"],
            "decisions": [],
            "manual_checks": [],
            "notes": ""
          }
        },
        {
          "name": "p2-review1",
          "session_id": "0a6b1c3e-1f0d-4c55-8d0a-6c1c2b9e0007",
          "window_id": "@18",
          "started": "2026-11-01T11:39:10Z",
          "ended": null,
          "report": null
        }
      ],
      "reviews": []
    }
  ],
  "audits": [],
  "current_steps": [
    {
      "plan": 2,
      "step": "p2-review1",
      "session_id": "0a6b1c3e-1f0d-4c55-8d0a-6c1c2b9e0007",
      "window_id": "@18",
      "nudged": false
    }
  ],
  "decisions": ["Split the spec into 7 plans along its order of work; plan 7 covers the emulator-only measurement report."]
}
```
