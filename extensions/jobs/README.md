# jobs

A Pi extension that lets an agent run a long command in the background and wait for it, and that blocks `sleep` as a way to wait.

- `job_start` runs a shell command in its own process group, writes its output to a log file under `$TMPDIR/pi-jobs-*`, and returns a job id (`job-1`, `job-2`, …).
- `job_wait` returns when the job ends, with its exit code and the end of its output. When `max_seconds` (default 900) passes first, or the call is aborted, the job keeps running.
- `job_stop` ends the job and everything it started: SIGTERM to the process group, SIGKILL after a grace period.
- A `bash` call with a `sleep` of 60 seconds or more is blocked, and the reason points at `job_start` and `job_wait`.
- When the session shuts down, every job still running is stopped.

Nothing starts when the extension loads; the job table is created at the first `job_start`.

## Settings

The extension loads in every session once the `pi-spec-runner` package is installed. With
[pi-subagents](https://www.npmjs.com/package/pi-subagents), two settings in
`~/.pi/agent/settings.json` give subagents the tools too:

1. Add the installed `extensions/jobs/index.ts` path to `subagents.defaultSubagentOnlyExtensions`.
2. Add `job_start`, `job_wait` and `job_stop` to `subagents.agentOverrides.worker.tools`, so a
   `worker` may call them.

## Tests

From the package root:

```bash
node --test 'extensions/jobs/test/*.test.ts'
```

Quote the glob: Node 24 does not accept the directory form. The tests cover `jobs.ts` and `sleep-guard.ts`; `index.ts` imports Pi and is checked by running `pi` with a real model.
