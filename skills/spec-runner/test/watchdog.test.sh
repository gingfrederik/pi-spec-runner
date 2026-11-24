#!/bin/bash
# Tests scripts/watchdog.sh.
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh" || exit 1

skill_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
watchdog="$skill_dir/scripts/watchdog.sh"

setup_stubs
export SPEC_RUNNER_PAUSE_DIR="$SPEC_RUNNER_TEST_TMP/paused"
mkdir -p "$SPEC_RUNNER_PAUSE_DIR"
SPEC_RUNNER_SOURCE_ONLY=1 . "$watchdog"

run_limited() { perl -e 'alarm 5; exec @ARGV' -- "$@"; }

tail_file="$SPEC_RUNNER_TEST_TMP/tail.txt"

# check_decide <label> <expected> <paused> <status> <idle> <nudges> <notified> (tail text on stdin)
check_decide() {
  local label=$1 expected=$2 got
  cat > "$tail_file"
  got=$(decide "$tail_file" "$3" "$4" "$5" "$6" "$7")
  assert_eq "$expected" "$got" "decide: $label"
}

# decide table (defaults: 3 nudges, 300 s idle)
printf 'work\nRetry failed after 3 attempts\n' \
  | check_decide "dropped connection is nudged" nudge no working 0 0 none
printf 'work\nRetry failed after 3 attempts\n' \
  | check_decide "nudges exhausted" none no working 0 3 none
printf 'Retry failed after 3 attempts\n⠋ Working\n' \
  | check_decide "Working after an old Retry marker" none no working 0 0 none
printf 'Retry failed after 3 attempts\n' \
  | check_decide "a paused worker is not nudged" paused yes idle 99999 0 none
printf 'done\n' | check_decide "a paused worker is not reported" paused yes idle 99999 0 none
printf 'done\n' | check_decide "idle at the threshold" notify-idle no idle 300 0 none
printf 'done\n' | check_decide "idle below the threshold" none no idle 299 0 none
printf 'done\n' | check_decide "idle already notified" none no idle 300 0 idle
printf 'done\n' | check_decide "busy worker is not idle" none no working 300 0 none
printf 'done\n' | check_decide "gone worker counts as idle" notify-idle no gone 300 0 none

# pane_tail keeps the last 6 content lines only
{
  for n in 1 2; do echo "line $n"; done
  echo "Retry failed after 3 attempts"
  echo
  echo "────────────────"
  for n in 5 6 7 8; do echo "line $n"; echo; done
  echo "━━━━━━━━━━━━━━━━"
  echo "  ═══  "
  echo "---"
  for n in 9 10 11 12; do echo "line $n"; done
  echo
  echo "────────────────"
  for n in 13 14; do echo "line $n"; done
  echo "────────────────"
} > "$STUB_DIR/tmux.capture-pane.out"
got=$(pane_tail @1)
assert_eq "line 9
line 10
line 11
line 12
line 13
line 14" "$got" "pane_tail keeps the last 6 content lines"
case "$got" in *"Retry failed after"*) fail "pane_tail still has the old marker" ;; esac

# worker_status
echo '{"sessions":[{"id":"other","status":"working"},{"id":"abc","status":"idle"}]}' \
  > "$STUB_DIR/pi-intercom.list.out"
assert_eq "idle" "$(worker_status abc)" "worker_status finds the id"
assert_eq "gone" "$(worker_status missing)" "worker_status of an unknown id"
echo 1 > "$STUB_DIR/pi-intercom.list.exit"
assert_eq "gone" "$(worker_status abc)" "worker_status when list fails"
rm "$STUB_DIR/pi-intercom.list.exit"

# worker_state and worker-state.sh: a paused idle worker is busy; a gone one's leftover file is ignored.
echo '{"sessions":[{"id":"w","status":"working"},{"id":"i","status":"idle"},{"id":"p","status":"idle"}]}' \
  > "$STUB_DIR/pi-intercom.list.out"
touch "$SPEC_RUNNER_PAUSE_DIR/p" "$SPEC_RUNNER_PAUSE_DIR/g"
assert_eq "busy" "$(worker_state w)" "worker_state of a working worker"
assert_eq "idle" "$(worker_state i)" "worker_state of an idle worker"
assert_eq "busy" "$(worker_state p)" "worker_state of a paused worker"
assert_eq "gone" "$(worker_state g)" "worker_state of a gone worker with a leftover pause file"
assert_eq "busy" "$(bash "$skill_dir/scripts/worker-state.sh" p)" "worker-state.sh of a paused worker"
assert_eq "idle" "$(bash "$skill_dir/scripts/worker-state.sh" i)" "worker-state.sh of an idle worker"
bash "$skill_dir/scripts/worker-state.sh" > /dev/null 2>&1
assert_eq "2" "$?" "worker-state.sh without arguments exits 2"
rm -f "$SPEC_RUNNER_PAUSE_DIR/p" "$SPEC_RUNNER_PAUSE_DIR/g"

# Loop exit: the window is already gone (Review Focus 4).
: > "$STUB_DIR/calls.log"
touch "$STUB_DIR/window-gone"
SPEC_RUNNER_TICK_S=0 run_limited bash "$watchdog" @1 id orch p1-plan
assert_eq "0" "$?" "loop exits 0 when the window is gone"
if grep -q 'send' "$STUB_DIR/calls.log"; then fail "loop sent something after the window was gone"; fi
assert_eq "1" "$(wc -l < "$STUB_DIR/calls.log" | tr -d ' ')" "loop stops after the first window check"
assert_eq "tmux list-panes -t @1" "$(cat "$STUB_DIR/calls.log")" "the window check is list-panes on the window id"
rm "$STUB_DIR/window-gone"

# Loop acts: an idle worker is reported exactly once, then the window closes.
cat > "$STUB_DIR/tmux" <<'STUB'
#!/bin/bash
stub_dir=$(cd "$(dirname "$0")" && pwd)
line=tmux
for arg in "$@"; do line="$line $(printf '%q' "$arg")"; done
echo "$line" >> "$stub_dir/calls.log"
if [ "$1" = list-panes ]; then
  echo x >> "$stub_dir/window-check-count"
  if [ "$(wc -l < "$stub_dir/window-check-count")" -ge 3 ]; then exit 1; fi
fi
[ -f "$stub_dir/tmux.$1.out" ] && cat "$stub_dir/tmux.$1.out"
exit 0
STUB
: > "$STUB_DIR/calls.log"
rm -f "$STUB_DIR/window-check-count" "$STUB_DIR/tmux.capture-pane.out"
echo '{"sessions":[{"id":"id","status":"idle"}]}' > "$STUB_DIR/pi-intercom.list.out"
SPEC_RUNNER_TICK_S=0 SPEC_RUNNER_IDLE_S=0 run_limited bash "$watchdog" @1 id orch p1-plan
assert_eq "0" "$?" "loop exits 0 after the window closes"
sends=$(grep -c '^pi-intercom send' "$STUB_DIR/calls.log")
assert_eq "1" "$sends" "exactly one notification"
assert_contains "$(cat "$STUB_DIR/calls.log")" \
  'pi-intercom send --to orch --text watchdog:\ p1-plan\ idle\ without\ a\ report' "idle notice text"

# Loop: a crashed worker (gone from the intercom list, window still open) gets one idle notice.
: > "$STUB_DIR/calls.log"
rm -f "$STUB_DIR/window-check-count"
echo '{"sessions":[]}' > "$STUB_DIR/pi-intercom.list.out"
SPEC_RUNNER_TICK_S=0 SPEC_RUNNER_IDLE_S=0 run_limited bash "$watchdog" @1 id orch p1-plan
assert_eq "0" "$?" "gone loop exits 0"
assert_eq "1" "$(grep -c '^pi-intercom send' "$STUB_DIR/calls.log")" "a gone worker gets exactly one idle notice"
assert_contains "$(cat "$STUB_DIR/calls.log")" 'idle\ without\ a\ report' "gone worker notice is the idle notice"

# Loop: a wall-clock jump (the Mac slept) advances neither clock past one tick.
: > "$STUB_DIR/calls.log"
rm -f "$STUB_DIR/window-check-count" "$STUB_DIR/clock-started"
echo '{"sessions":[{"id":"id","status":"idle"}]}' > "$STUB_DIR/pi-intercom.list.out"
SPEC_RUNNER_TICK_S=0 run_limited bash -c '
  SPEC_RUNNER_SOURCE_ONLY=1 . "$1"
  now_s() { # 0 at the start, then 100000 s later
    if [ -e "$STUB_DIR/clock-started" ]; then echo 100000; else touch "$STUB_DIR/clock-started"; echo 0; fi
  }
  watch_loop @1 id orch p1-plan' _ "$watchdog"
assert_eq "0" "$?" "time-jump loop exits 0"
[ -e "$STUB_DIR/clock-started" ] || fail "time-jump loop did not use now_s"
if grep -q '^pi-intercom send' "$STUB_DIR/calls.log"; then
  fail "a time jump produced a notice: [$(grep '^pi-intercom send' "$STUB_DIR/calls.log")]"
fi

# Loop nudges a dropped connection with the verbatim text, at most the maximum times.
: > "$STUB_DIR/calls.log"
rm -f "$STUB_DIR/window-check-count"
printf 'Retry failed after 3 attempts\n' > "$STUB_DIR/tmux.capture-pane.out"
echo '{"sessions":[{"id":"id","status":"working"}]}' > "$STUB_DIR/pi-intercom.list.out"
sed -i.bak 's/-ge 3/-ge 7/' "$STUB_DIR/tmux"
SPEC_RUNNER_TICK_S=0 SPEC_RUNNER_MAX_NUDGES=2 run_limited bash "$watchdog" @1 id orch p1-plan
assert_eq "0" "$?" "nudge loop exits 0"
assert_eq "2" "$(grep -c '^tmux send-keys -t @1 -l ' "$STUB_DIR/calls.log")" "nudges stop at the maximum"
assert_contains "$(cat "$STUB_DIR/calls.log")" \
  'tmux send-keys -t @1 -l Continue\ the\ task\ from\ where\ you\ stopped\ \(the\ connection\ dropped\).' \
  "nudge text is verbatim"
assert_contains "$(cat "$STUB_DIR/calls.log")" 'tmux send-keys -t @1 Enter' "nudge presses Enter"

# Paused worker (its pause file exists): nothing is sent even when idle (Review Focus 3).
: > "$STUB_DIR/calls.log"
rm -f "$STUB_DIR/window-check-count"
printf 'Retry failed after 3 attempts\n' > "$STUB_DIR/tmux.capture-pane.out"
touch "$SPEC_RUNNER_PAUSE_DIR/id"
echo '{"sessions":[{"id":"id","status":"idle"}]}' > "$STUB_DIR/pi-intercom.list.out"
SPEC_RUNNER_TICK_S=0 SPEC_RUNNER_IDLE_S=0 run_limited bash "$watchdog" @1 id orch p1-plan
assert_eq "0" "$?" "paused loop exits 0"
if grep -Eq '^pi-intercom send|^tmux send-keys' "$STUB_DIR/calls.log"; then
  fail "watchdog sent something to a paused worker"
fi
rm -f "$SPEC_RUNNER_PAUSE_DIR/id"

# Real tmux on a private server (socket in the test's temp dir): the loop exits once its window
# is killed. tmux 3.6a's `display-message -p -t <missing window>` exits 0, which only a real
# server shows.
real_tmux=$(type -a -p tmux | grep -v "^$STUB_DIR/" | head -n 1)
if [ -z "$real_tmux" ]; then
  echo "SKIP real-tmux: no tmux binary outside the stubs"
else
  real_dir="$SPEC_RUNNER_TEST_TMP/real-tmux"
  mkdir -p "$real_dir"
  # -f /dev/null: the private server must not load the user's ~/.tmux.conf or its plugins.
  printf '#!/bin/bash\nunset TMUX\nexec %q -f /dev/null -S %q "$@"\n' "$real_tmux" "$real_dir/socket" > "$real_dir/tmux"
  chmod +x "$real_dir/tmux"
  watchdog_pid=
  # real_fail <message>: stop the watchdog and the private server, then fail.
  real_fail() {
    [ -n "$watchdog_pid" ] && kill "$watchdog_pid" 2>/dev/null
    "$real_dir/tmux" kill-server 2>/dev/null
    fail "$1"
  }
  "$real_dir/tmux" new-session -d -s watchdog-test 'sleep 60'
  real_window=$("$real_dir/tmux" new-window -d -P -F '#{window_id}' -t watchdog-test: 'sleep 60')
  case "$real_window" in
    @*) ;;
    *) real_fail "real tmux new-window gave no window id: [$real_window]" ;;
  esac
  PATH="$real_dir:$PATH" SPEC_RUNNER_TICK_S=1 bash "$watchdog" "$real_window" id orch p1-plan \
    > /dev/null 2>&1 &
  watchdog_pid=$!
  sleep 1
  kill -0 "$watchdog_pid" 2>/dev/null || real_fail "watchdog exited before its real tmux window was killed"
  "$real_dir/tmux" kill-window -t "$real_window"
  for _ in 1 2 3 4 5 6; do
    kill -0 "$watchdog_pid" 2>/dev/null || break
    sleep 1
  done
  if kill -0 "$watchdog_pid" 2>/dev/null; then
    kill "$watchdog_pid"
    still_running=yes
  else
    still_running=no
  fi
  "$real_dir/tmux" kill-server
  assert_eq "no" "$still_running" "loop exits after its real tmux window is killed"
fi
