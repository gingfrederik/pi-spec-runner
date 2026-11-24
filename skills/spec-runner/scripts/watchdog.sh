#!/bin/bash
# Watches one step session. Usage: watchdog.sh <window-id> <worker-session-id> <orchestrator-name> <step>
# Nudges a worker whose connection dropped; tells the orchestrator over pi-intercom when the worker
# is idle without a report (a worker gone from the intercom list counts as idle). A step has no
# run-time limit. Exits when the tmux window is gone.
# A paused worker (auto-resume.ts has scheduled a resume) is neither nudged nor reported.
# Overrides: SPEC_RUNNER_TICK_S (60), SPEC_RUNNER_IDLE_S (300), SPEC_RUNNER_MAX_NUDGES (3),
# SPEC_RUNNER_INTERCOM (pi-intercom CLI path), SPEC_RUNNER_PAUSE_DIR (pause_dir below).

NUDGE_TEXT='Continue the task from where you stopped (the connection dropped).'

intercom_cli() {
  "${SPEC_RUNNER_INTERCOM:-$HOME/.pi/agent/npm/node_modules/.bin/pi-intercom}" "$@"
}

# pane_tail <window-id>: last 6 non-empty, non-rule lines of the pane.
# A rule line holds only whitespace and box-drawing characters or "-".
pane_tail() {
  tmux capture-pane -p -t "$1" 2>/dev/null \
    | perl -CSD -ne 'print unless /^[\s\x{2500}-\x{257F}-]*$/' \
    | tail -n 6
}

# worker_status <session-id>: prints the intercom status of that session, or "gone".
worker_status() {
  local listing status
  listing=$(intercom_cli list --json 2>/dev/null) || { echo gone; return; }
  status=$(printf '%s' "$listing" \
    | jq -r --arg id "$1" '.sessions[]|select(.id==$id)|.status' 2>/dev/null | head -n 1)
  echo "${status:-gone}"
}

# pause_dir: where auto-resume.ts keeps one empty file per paused session; launch.sh passes it to
# workers as PI_AUTO_RESUME_PAUSE_DIR.
pause_dir() {
  echo "${SPEC_RUNNER_PAUSE_DIR:-$HOME/.pi/agent/state/spec-runner-paused}"
}

# is_paused <session-id> <status>: a listed worker whose pause file exists. A gone worker's
# leftover file does not count.
is_paused() {
  [ "$2" != gone ] && [ -e "$(pause_dir)/$1" ]
}

# worker_state <session-id>: busy | idle | gone. A paused worker is busy: it continues by itself.
worker_state() {
  local status
  status=$(worker_status "$1")
  if [ "$status" = gone ]; then
    echo gone
  elif [ "$status" = idle ] && ! is_paused "$1" "$status"; then
    echo idle
  else
    echo busy
  fi
}

# now_s: wall-clock seconds. Tests override it to simulate a sleeping machine.
now_s() {
  date +%s
}

# decide <pane-tail-file> <paused yes|no> <status> <idle-s> <nudges> <notified>
# Prints paused | nudge | notify-idle | none.
decide() {
  local tail_file=$1 paused=$2 status=$3 idle=$4 nudges=$5 notified=$6
  local max_nudges=${SPEC_RUNNER_MAX_NUDGES:-3}
  local idle_s=${SPEC_RUNNER_IDLE_S:-300}
  if [ "$paused" = yes ]; then
    echo paused
  elif grep -q 'Retry failed after' "$tail_file" && ! grep -q 'Working' "$tail_file" \
    && [ "$nudges" -lt "$max_nudges" ]; then
    echo nudge
  elif { [ "$status" = idle ] || [ "$status" = gone ]; } && [ "$idle" -ge "$idle_s" ] \
    && [ "$notified" = none ]; then
    echo notify-idle
  else
    echo none
  fi
}

# watch_loop <window-id> <session-id> <orchestrator> <step>
watch_loop() {
  local window_id=$1 session_id=$2 orchestrator=$3 step=$4
  local tick_s=${SPEC_RUNNER_TICK_S:-60}
  local tail_file idle=0 nudges=0 notified=none
  local now last delta status paused action next_idle
  tail_file=$(mktemp "${TMPDIR:-/tmp}/spec-runner-watchdog.XXXXXX") || return 1
  trap 'rm -f "$tail_file"' EXIT
  last=$(now_s)

  while :; do
    # list-panes fails for a missing window; display-message -p does not (tmux 3.6a).
    tmux list-panes -t "$window_id" >/dev/null 2>&1 || return 0

    now=$(now_s)
    delta=$((now - last))
    last=$now
    # A tick far longer than tick_s means the machine slept; count it as one tick.
    [ "$delta" -gt $((tick_s + 120)) ] && delta=$tick_s

    pane_tail "$window_id" > "$tail_file"
    status=$(worker_status "$session_id")
    # A crashed or exited worker drops off the intercom list ("gone"); it is idle too.
    if [ "$status" = idle ] || [ "$status" = gone ]; then
      next_idle=$((idle + delta))
    else
      next_idle=0
      # A worker that resumed and went idle again deserves a new notice.
      [ "$notified" = idle ] && notified=none
    fi

    if is_paused "$session_id" "$status"; then paused=yes; else paused=no; fi
    action=$(decide "$tail_file" "$paused" "$status" "$next_idle" "$nudges" "$notified")
    [ "$action" != paused ] && idle=$next_idle

    case "$action" in
      nudge)
        echo "watchdog: nudging $step ($((nudges + 1)))"
        tmux send-keys -t "$window_id" -l "$NUDGE_TEXT"
        tmux send-keys -t "$window_id" Enter
        nudges=$((nudges + 1))
        ;;
      notify-idle)
        if intercom_cli send --to "$orchestrator" --text "watchdog: $step idle without a report"; then
          notified=idle
          echo "watchdog: notified $orchestrator that $step is idle"
        else
          echo "watchdog: notify-idle send failed; retrying next tick"
        fi
        ;;
    esac

    sleep "$tick_s"
  done
}

[ "${SPEC_RUNNER_SOURCE_ONLY:-}" = 1 ] && return 0 2>/dev/null

[ "$#" -eq 4 ] || { echo "usage: watchdog.sh <window-id> <worker-session-id> <orchestrator-name> <step>" >&2; exit 2; }
watch_loop "$@"
exit 0
