#!/bin/bash
# Opens one step session of a spec run in a new tmux window and starts its watchdog.
# Usage: launch.sh <run-dir> <step> <cwd> <role-line> <prompt> [lane]
# lane (default 0) picks run.json's lane_env[<lane>]; those variables follow worker_env.
# Prints "<window-id> <session-id>" on success.
# Exit codes: 0 ok, 1 missing run.json/contract/cwd or tmux failure, 2 usage error.

usage="usage: launch.sh <run-dir> <step> <cwd> <role-line> <prompt> [lane]"
if [ "$#" -ne 5 ] && [ "$#" -ne 6 ]; then
  echo "$usage" >&2
  exit 2
fi

skill_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
run_dir=$1
step=$2
cwd=$3
role=$4
prompt=$5
lane=${6-0}
case "$lane" in
  '' | *[!0-9]* | 0?*)
    echo "$usage" >&2
    echo "launch.sh: lane must be a non-negative integer, got '$lane'" >&2
    exit 2
    ;;
esac

if [ ! -f "$run_dir/run.json" ]; then
  echo "launch.sh: missing $run_dir/run.json" >&2
  exit 1
fi
if [ ! -f "$skill_dir/contract.md" ]; then
  echo "launch.sh: missing $skill_dir/contract.md" >&2
  exit 1
fi
if [ ! -d "$cwd" ]; then
  echo "launch.sh: cwd $cwd is not a directory" >&2
  exit 1
fi
run_dir=$(cd "$run_dir" && pwd) || exit 1
run_json="$run_dir/run.json"

slug=$(jq -r '.slug' "$run_json")
orchestrator=$(jq -r '.orchestrator' "$run_json")
tmux_session=$(jq -r '.tmux_session' "$run_json")
model=$(jq -r '.model' "$run_json")
thinking=$(jq -r '.thinking' "$run_json")
# A run.json without lane_env is one lane, as in next-plan.sh.
lane_count=$(jq -r '(.lane_env // [{}]) | length' "$run_json")
if ! [ "$lane" -lt "$lane_count" ] 2> /dev/null; then
  echo "$usage" >&2
  echo "launch.sh: lane $lane does not exist; run.json has $lane_count lane(s)" >&2
  exit 2
fi
session_id=$(uuidgen | tr 'A-Z' 'a-z')

contract_file="$run_dir/contract-$step.md"
launch_file="$run_dir/launch-$step.sh"

# Fill the placeholders literally. Values come from the environment, so no
# character in them is interpreted; each placeholder is replaced in one pass.
ORCHESTRATOR=$orchestrator STEP=$step ROLE=$role awk '
  BEGIN {
    n = split("ORCHESTRATOR STEP ROLE", names, " ")
    for (i = 1; i <= n; i++) value["{{" names[i] "}}"] = ENVIRON[names[i]]
  }
  {
    rest = $0
    out = ""
    while (1) {
      best = 0
      for (key in value) {
        pos = index(rest, key)
        if (pos > 0 && (best == 0 || pos < best)) { best = pos; bestkey = key }
      }
      if (best == 0) break
      out = out substr(rest, 1, best - 1) value[bestkey]
      rest = substr(rest, best + length(bestkey))
    }
    print out rest
  }
' "$skill_dir/contract.md" > "$contract_file" || exit 1

# The worker's pause signal for the watchdog (watchdog.sh, pause_dir).
pause_dir=$(SPEC_RUNNER_SOURCE_ONLY=1 . "$skill_dir/scripts/watchdog.sh" && pause_dir)

{
  echo '#!/bin/bash'
  echo 'export PI_INTERCOM_ASK_TIMEOUT_MS=1800000'
  # No footer, no auto-resume widget or notices in the pane; pause signalled by file instead.
  echo 'export PI_HIDE_STATUS=1'
  printf 'export PI_AUTO_RESUME_PAUSE_DIR=%q\n' "$pause_dir"
  jq -r '.worker_env | to_entries[] | "\(.key)\t\(.value)"' "$run_json" |
    while IFS=$'\t' read -r key value; do
      printf 'export %s=%q\n' "$key" "$value"
    done
  jq -r --argjson lane "$lane" '((.lane_env // [{}])[$lane]) | to_entries[] | "\(.key)\t\(.value)"' "$run_json" |
    while IFS=$'\t' read -r key value; do
      printf 'export %s=%q\n' "$key" "$value"
    done
  # A failed cd skips pi but not the '[pi exited]' tail, so the window stays open for the watchdog.
  printf 'cd %q && pi --session-id %q --model %q --thinking %q' "$cwd" "$session_id" "$model" "$thinking"
  while IFS= read -r flag; do
    printf ' %q' "$flag"
  done < <(jq -r '.worker_flags[]?' "$run_json")
  printf ' --append-system-prompt %q -n %q %q\n' "$contract_file" "$slug $step" "$prompt"
  echo "echo '[pi exited]'"
  echo 'sleep 86400'
} > "$launch_file"
chmod +x "$launch_file"

# "=" makes tmux match the session name exactly; a bare name also matches by prefix.
if ! tmux has-session -t "=$tmux_session" > /dev/null 2>&1; then
  tmux new-session -d -s "$tmux_session" -n runner -c "$cwd" > /dev/null 2>&1
fi

window_id=$(tmux new-window -d -P -F '#{window_id}' -t "=$tmux_session:" -c "$cwd" "$(printf '%q' "$launch_file")" 2> /dev/null)
if [ -z "$window_id" ]; then
  echo "launch.sh: tmux new-window failed for session $tmux_session" >&2
  exit 1
fi

nohup "$skill_dir/scripts/watchdog.sh" "$window_id" "$session_id" "$orchestrator" "$step" \
  > "$run_dir/watchdog-$step.log" 2>&1 < /dev/null &

echo "$window_id $session_id"
