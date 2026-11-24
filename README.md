# pi-spec-runner

A [Pi](https://pi.dev) package that turns one approved spec into a finished integration branch
without supervision. The orchestrator session splits the spec into plans, runs every plan step
(plan, execute, review, fix, merge) as its own Pi session in tmux, merges into an integration
branch, audits the result against the spec, and reports once.

## What it ships

| Resource | What it does |
|---|---|
| `spec-runner` skill | The orchestrator: `/skill:spec-runner <spec path>` |
| `jobs` extension | `job_start`, `job_wait`, `job_stop`: run a long command in the background and wait for it; blocks long `sleep` calls. See [extensions/jobs/README.md](extensions/jobs/README.md) |
| `session-name` extension | `name_session`: the agent names its own session, so pi-intercom peers can address it. The orchestrator names itself `<slug>-orchestrator` with it |
| `worktree` extension | `create_worktree`, `enter_worktree`, `exit_worktree`: git worktrees under `.worktrees/`, with dependency directories cloned from another worktree |

## Requirements

- `tmux`, `jq`, `git`, and Node 24 or later for the tests
- [pi-intercom](https://www.npmjs.com/package/pi-intercom): step sessions report to the orchestrator over it
- [superpowers](https://github.com/obra/superpowers): the steps run its `writing-plans`,
  `executing-plans`, `subagent-driven-development`, `receiving-code-review` and
  `systematic-debugging` skills
- [pi-subagents](https://www.npmjs.com/package/pi-subagents), when a plan runs with `subagent-driven-development`
- A skill named `code-review`. The review step runs `/skill:code-review high` and expects a list
  of findings for the current branch's diff. This package does not ship one.

```bash
brew install tmux jq
pi install npm:pi-intercom
pi install npm:pi-subagents
pi install git:github.com/obra/superpowers
```

## Install

```bash
pi install git:github.com/gingfrederik/pi-spec-runner
```

## Use

Start Pi inside tmux, in the main checkout of the repo the spec belongs to:

```text
/skill:spec-runner docs/specs/2026-11-01-my-feature-design.md
```

The repo's `AGENTS.md` should name its install command and its verification commands; the run
records them and holds every merge to them. [skills/spec-runner/SKILL.md](skills/spec-runner/SKILL.md)
is the full procedure.

## Tests

```bash
npm test
```

[skills/spec-runner/test/dry-run/README.md](skills/spec-runner/test/dry-run/README.md) describes an
end-to-end run on a toy repo; it costs model tokens.
