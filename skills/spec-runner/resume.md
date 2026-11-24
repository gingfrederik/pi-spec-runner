# Resume a run

Follow this when section 1 of [SKILL.md](SKILL.md) finds a `run.json` for `<spec>`. Terms and
section numbers are the ones in SKILL.md.

1. Name the session with that file's `orchestrator` (SKILL.md, "Name the session").
2. Set `orchestrator_session_id` to `$PI_SESSION_ID`. A `run.json` from an older run has
   `current_step`: replace it with `current_steps` (`[]` for `null`, else an array of that one
   object), add `lane_env: [{}]` and `integrating: null` when they are missing, and set `lane: 0`
   on every `running` plan that has no `lane`. An `integrating` that names a plan no longer
   `running` becomes `null`.
3. Record every report that arrives queued, as in "Record a report". The broker queues a report
   sent while no orchestrator ran, unless a second disconnected session has the name
   `<slug>-orchestrator`: then the worker's `send` fails instead of queueing, and step 5 recovers
   the report.
4. If `current_steps` is empty, continue from the state `run.json` shows:
   - `baseline` is `null`: section 2, step 7;
   - `plans` is empty: section 3;
   - otherwise the next step of the `running` plan, the next plan, the audit, or the final report;
     with two lanes, take the turn as [lanes.md](lanes.md) rule 2 says.
5. Otherwise, for each entry of `current_steps`, check the running step's worker: run this
   skill's `scripts/worker-state.sh <session-id>` by its absolute path with the entry's
   `session_id`, and check its window with `tmux list-panes -t <window-id>` (non-zero: the window
   is gone).
   - It reported: record the report.
   - It is `busy` or `idle`:
     1. If `pgrep -f "watchdog.sh <window-id> <session-id>"` finds nothing, its watchdog died with
        the old orchestrator. Start one exactly as `launch.sh` does, with this skill's
        `scripts/watchdog.sh` by its absolute path:
        `nohup <watchdog.sh> <window-id> <session-id> <slug>-orchestrator <step> > <run-dir>/watchdog-<step>.log 2>&1 < /dev/null &`.
     2. If it is `idle`, its report may be lost or its recheck timer died with the old
        orchestrator. Handle it as a watchdog idle notice (section 5): if the entry's `nudged`
        is true, the step is `failed`; otherwise nudge it once, asking it to finish the step and
        resend its report to `<slug>-orchestrator`, set `nudged`, and start the recheck timer.
     3. Otherwise keep waiting (section 5).
   - It is gone without a report: kill its window if it still exists, then launch the same step
     again in the same cwd ("Launch a step").
   Then, with two lanes, take the turn as [lanes.md](lanes.md) rule 2 says.
