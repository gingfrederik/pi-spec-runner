#!/bin/bash
# Decides which plan may start next, and in which lane.
# Usage: next-plan.sh <run-dir>
# Prints "<n> <lane>" when a plan may start now; prints nothing when none may.
# Exit codes: 0 ok (with or without output), 1 missing run.json, 2 usage error.
#
# Rules, in order:
#  1. Candidates: pending plans whose depends_on plans are all merged, lowest n first.
#  2. Lanes: 0 to (lane_env length - 1), one lane when lane_env is missing.
#     A running plan takes its lane (missing or null lane = 0).
#  3. No free lane: print nothing.
#  4. No plan running: print the first candidate and lane 0.
#  5. Print nothing when a running plan is exclusive or has empty paths, or when
#     another run is active (a watchdog line whose orchestrator is not this run's).
#  6. Otherwise print the first candidate that is not exclusive, has paths and
#     overlaps no running plan's paths, with the lowest free lane.
# Paths overlap when, after removing a leading "./" and a trailing "/", they are
# equal, one is the other followed by "/...", or either is ".".

if [ "$#" -ne 1 ]; then
  echo "usage: next-plan.sh <run-dir>" >&2
  exit 2
fi

run_json=$1/run.json
if [ ! -f "$run_json" ]; then
  echo "next-plan.sh: missing $run_json" >&2
  exit 1
fi

orchestrator=$(jq -r '.orchestrator // ""' "$run_json") || exit 1

# Rule 5: a watchdog line is "<pid> <shell> <script> <window> <session> <orchestrator> <step>".
other_run=false
if pgrep -fl scripts/watchdog.sh 2>/dev/null | awk -v me="$orchestrator" '
  { for (i = 1; i <= NF; i++) if ($i ~ /scripts\/watchdog\.sh$/) { if ($(i + 3) != "" && $(i + 3) != me) found = 1; break } }
  END { exit !found }'; then
  other_run=true
fi

jq -r --argjson other_run "$other_run" '
  def norm: sub("^\\./"; "") | sub("/$"; "");
  def overlap($a; $b):
    ($a | norm) as $x | ($b | norm) as $y
    | $x == $y or $x == "." or $y == "." or $x == "" or $y == ""
      or ($x | startswith($y + "/")) or ($y | startswith($x + "/"));
  (.plans // []) as $plans
  | ($plans | map(select(.status == "merged") | .n)) as $merged
  | ($plans | map(select(.status == "running"))) as $running
  | ($running | map(.lane // 0)) as $taken
  | ([range(0; ((.lane_env // [{}]) | length))] | map(select(. as $l | $taken | index($l) | not))) as $free
  | ($plans | map(select(.status == "pending" and ((.depends_on // []) | all(. as $d | $merged | index($d)))))
      | sort_by(.n)) as $candidates
  | if ($free | length) == 0 or ($candidates | length) == 0 then empty
    elif ($running | length) == 0 then "\($candidates[0].n) 0"
    elif $other_run or ($running | any((.exclusive // false) or ((.paths // []) | length) == 0)) then empty
    else
      first(
        $candidates[]
        | select((.exclusive // false | not) and ((.paths // []) | length) > 0)
        | select(. as $c | [$running[] | .paths[] as $rp | $c.paths[] | overlap(.; $rp)] | any | not)
        | "\(.n) \($free[0])"
      ) // empty
    end
' "$run_json"
