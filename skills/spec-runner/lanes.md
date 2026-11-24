# Lanes

A lane is one stream of plans; plans in different lanes run at the same time. A run has one or
two. Terms and section numbers are the ones in [SKILL.md](SKILL.md).

## At run start: how many lanes

`lane_env` holds one object per lane, at most 2, the first `{}`. Add a second lane only when the
repo's instructions say that two plans may run at the same time. The second object holds the
environment variables those instructions give for the second lane, `{}` when they give none. You
never infer this yourself: instructions that do not say it mean one lane.

Otherwise the run has one lane and nothing else in this file applies. A run with one lane takes
the same steps in the same order as without this file.

## Rules of a run with two lanes

1. **Split.** Give every plan `paths`: the directories or files it will write, repo-relative,
   including generated files it regenerates; when unsure, the wider directory. A plan that carries
   a stop point is `exclusive`: set it to `true`. Revise `paths` when you revise `scope`.
2. **Each turn.** Record everything that arrived. For every `running` plan without an entry in
   `current_steps`, launch its next step if rule 3 allows. Then run `next-plan.sh`; while it
   prints a plan, store its lane, then do section 4, steps 1 and 2, and run it again. Then end the turn.
3. **`integrating`.** A plan needs it for every step after `p<n>-execute`. When it is `null`, set
   it to the plan's number and go on. When another plan holds it, launch nothing for this plan and
   look again next turn. Set it to `null` when the holder is merged or blocked.
4. **Rescope.** Add carried-over items only to `pending` plans; a running plan's scope is fixed.
5. **Stop.** When a step reports `stop`, or a stop point's condition is met, while another plan
   has a step running: wait for that step's report and record it. Then set that plan `blocked`
   with the reason `run halted at plan <n>'s stop point`, and keep its worktree.
6. **Questions.** With two asks pending, answer each with
   `intercom({ action: "reply", replyTo: <that ask's message id>, message })`.
7. **Final report.** Plan times overlap: give the wall-clock total, not their sum.
