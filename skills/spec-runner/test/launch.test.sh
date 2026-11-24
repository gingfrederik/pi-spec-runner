#!/bin/bash
# Tests scripts/launch.sh.
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh" || exit 1

skill_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
launch="$skill_dir/scripts/launch.sh"

setup_stubs
printf '#!/bin/bash\nexit 0\n' > "$STUB_DIR/sleep"
chmod +x "$STUB_DIR/sleep"
echo "@42" > "$STUB_DIR/tmux.new-window.out"
# Any watchdog that gets spawned exits on its first check.
touch "$STUB_DIR/window-gone"
export SPEC_RUNNER_TICK_S=0

RUN=$(new_run_dir)
WORKDIR=$(mktemp -d "$SPEC_RUNNER_TEST_TMP/cwd.XXXXXX")

# Happy path.
out=$("$launch" "$RUN" p1-plan "$WORKDIR" 'Role: planner.' "/skill:writing-plans $RUN/spec.md")
assert_eq "0" "$?" "happy path exits 0"
case "$out" in
  @42\ ????????-????-????-????-????????????) ;;
  *) fail "stdout is '<window-id> <session-id>': [$out]" ;;
esac
echo "$out" | grep -Eq '^@42 [0-9a-f-]{36}$' || fail "stdout format: [$out]"
session_id=${out#@42 }

assert_file "$RUN/contract-p1-plan.md" "contract is written"
contract=$(cat "$RUN/contract-p1-plan.md")
assert_contains "$contract" "p1-plan" "contract has the step"
assert_contains "$contract" "Role: planner." "contract has the role line"
assert_contains "$contract" "demo-orchestrator" "contract has the orchestrator"
case "$contract" in *"{{"*) fail "contract still has a placeholder: [$contract]" ;; esac

assert_file "$RUN/launch-p1-plan.sh" "launch file is written"
[ -x "$RUN/launch-p1-plan.sh" ] || fail "launch file is not executable"
launch_file=$(cat "$RUN/launch-p1-plan.sh")
assert_contains "$launch_file" "ANDROID_SERIAL=emulator-5554" "launch file exports worker_env"
assert_contains "$launch_file" "PI_INTERCOM_ASK_TIMEOUT_MS=1800000" "launch file exports the ask timeout"
assert_contains "$launch_file" "export PI_HIDE_STATUS=1" "launch file hides the footer and pause notices"
assert_contains "$launch_file" "export PI_AUTO_RESUME_PAUSE_DIR=$HOME/.pi/agent/state/spec-runner-paused" \
  "launch file passes the watchdog's pause dir"
assert_contains "$launch_file" "--approve" "launch file has the worker flags"
assert_contains "$launch_file" "--session-id $session_id" "launch file has the session id"
assert_contains "$launch_file" "--append-system-prompt" "launch file appends the contract"
# A failed cd falls through to the '[pi exited]' tail, so the window stays open for the watchdog.
case "$launch_file" in *"exit 1"*) fail "launch file exits early: [$launch_file]" ;; esac

calls=$(cat "$STUB_DIR/calls.log")
echo "$calls" | grep 'new-window -d -P -F' | grep -q 'launch-p1-plan.sh' \
  || fail "calls.log has no new-window line naming launch-p1-plan.sh: [$calls]"
# Exact-match targets: a session such as demo-orch must not stand in for demo.
assert_contains "$calls" "has-session -t =demo" "launch checks for the tmux session by exact name"
assert_contains "$calls" "-t =demo: " "launch targets the tmux session by exact name"

# Review Focus 1: the prompt reaches pi as one unchanged argument.
prompt="it's \"\$HOME\" \`x\` a b"
cat > "$STUB_DIR/pi" <<'STUB'
#!/bin/bash
stub_dir=$(cd "$(dirname "$0")" && pwd)
for arg in "$@"; do last=$arg; done
printf '%s' "$last" > "$stub_dir/pi-last-arg"
printf '%s\n' "$#" > "$stub_dir/pi-argc"
STUB
"$launch" "$RUN" p1-plan "$WORKDIR" 'Role: planner.' "$prompt" > /dev/null
assert_eq "0" "$?" "quoting case exits 0"
bash "$RUN/launch-p1-plan.sh" > /dev/null
assert_eq "$prompt" "$(cat "$STUB_DIR/pi-last-arg")" "prompt reaches pi byte for byte"
# --session-id ID --model M --thinking T --approve --append-system-prompt C -n NAME PROMPT
assert_eq "12" "$(cat "$STUB_DIR/pi-argc")" "pi receives the expected number of arguments"

# A cwd that vanished before the window starts: pi does not run elsewhere, the tail still runs.
GONEDIR=$(mktemp -d "$SPEC_RUNNER_TEST_TMP/gone.XXXXXX")
"$launch" "$RUN" p1-plan "$GONEDIR" 'Role: planner.' 'go' > /dev/null
rmdir "$GONEDIR"
rm -f "$STUB_DIR/pi-last-arg"
tail_out=$(bash "$RUN/launch-p1-plan.sh" 2> /dev/null)
[ -e "$STUB_DIR/pi-last-arg" ] && fail "pi ran although cd failed"
assert_contains "$tail_out" "[pi exited]" "a failed cd falls through to the tail"

# The role line is substituted literally.
role='Role: a/b & c \1 $x `y` @{upstream} "q" '"'s'"
"$launch" "$RUN" p2-plan "$WORKDIR" "$role" 'go' > /dev/null
assert_eq "0" "$?" "special-character role exits 0"
grep -qF -- "$role" "$RUN/contract-p2-plan.md" || fail "role line is not verbatim: [$(cat "$RUN/contract-p2-plan.md")]"
grep -qF 'step `p2-plan`' "$RUN/contract-p2-plan.md" || fail "step is not substituted"

# Review Focus 5: a missing tmux session is created detached, never attached.
: > "$STUB_DIR/calls.log"
echo 1 > "$STUB_DIR/tmux.has-session.exit"
out=$("$launch" "$RUN" p3-plan "$WORKDIR" 'Role: planner.' 'go')
assert_eq "0" "$?" "missing-session case exits 0"
echo "$out" | grep -Eq '^@42 [0-9a-f-]{36}$' || fail "stdout with a missing session: [$out]"
calls=$(cat "$STUB_DIR/calls.log")
assert_contains "$calls" "new-session -d -s demo" "launch creates the missing session detached"
case "$calls" in *attach*) fail "launch must not attach: [$calls]" ;; esac
rm -f "$STUB_DIR/tmux.has-session.exit"

# Missing run.json or contract: exit 1.
EMPTY=$(mktemp -d "$SPEC_RUNNER_TEST_TMP/empty.XXXXXX")
"$launch" "$EMPTY" p1-plan "$WORKDIR" 'r' 'p' > /dev/null 2>&1
assert_eq "1" "$?" "missing run.json exits 1"

# Missing cwd: exit 1 with a message, and no window is opened.
: > "$STUB_DIR/calls.log"
err=$("$launch" "$RUN" p1-plan "$SPEC_RUNNER_TEST_TMP/no-such-dir" 'r' 'p' 2>&1 > /dev/null)
assert_eq "1" "$?" "missing cwd exits 1"
assert_contains "$err" "no-such-dir" "missing cwd message names the directory"
if grep -q 'new-window' "$STUB_DIR/calls.log"; then fail "launch opened a window for a missing cwd"; fi

# Usage: wrong argument count exits 2.
"$launch" "$RUN" p1-plan /tmp/wt > /dev/null 2>&1
assert_eq "2" "$?" "3 arguments exit 2"

# Lanes: the sixth argument picks lane_env[<lane>]; a lane's value wins over worker_env.
LANE_RUN=$(new_run_dir)
jq '.lane_env = [{}, {"ANDROID_SERIAL": "emulator-5556", "SIM_UDID": "B"}]' "$LANE_RUN/run.json" > "$LANE_RUN/run.json.new" \
  && mv "$LANE_RUN/run.json.new" "$LANE_RUN/run.json"
"$launch" "$LANE_RUN" p1-plan "$WORKDIR" 'Role: planner.' 'go' 1 > /dev/null
assert_eq "0" "$?" "lane 1 exits 0"
lane_file="$LANE_RUN/launch-p1-plan.sh"
base_line=$(grep -n 'export ANDROID_SERIAL=emulator-5554' "$lane_file" | cut -d: -f1)
lane_line=$(grep -n 'export ANDROID_SERIAL=emulator-5556' "$lane_file" | cut -d: -f1)
[ -n "$base_line" ] && [ -n "$lane_line" ] && [ "$lane_line" -gt "$base_line" ] \
  || fail "lane 1 value must follow worker_env: [$(cat "$lane_file")]"
grep -q '^export SIM_UDID=B$' "$lane_file" || fail "lane 1 exports SIM_UDID: [$(cat "$lane_file")]"

for lane_args in "0" ""; do
  # shellcheck disable=SC2086
  "$launch" "$LANE_RUN" p1-plan "$WORKDIR" 'Role: planner.' 'go' $lane_args > /dev/null
  assert_eq "0" "$?" "lane [$lane_args] exits 0"
  lane_file=$(cat "$LANE_RUN/launch-p1-plan.sh")
  assert_contains "$lane_file" "ANDROID_SERIAL=emulator-5554" "lane [$lane_args] keeps worker_env"
  case "$lane_file" in *SIM_UDID*|*emulator-5556*) fail "lane [$lane_args] leaked lane 1: [$lane_file]" ;; esac
done

# Review Focus 6: a lane the run does not have opens no window.
for bad_lane in 2 x -1 01 01x 99999999999999999999 ""; do
  : > "$STUB_DIR/calls.log"
  err=$("$launch" "$LANE_RUN" p1-plan "$WORKDIR" 'Role: planner.' 'go' "$bad_lane" 2>&1 > /dev/null)
  assert_eq "2" "$?" "bad lane [$bad_lane] exits 2"
  assert_contains "$err" "usage: launch.sh" "bad lane [$bad_lane] prints a usage-style message"
  if grep -q 'new-window' "$STUB_DIR/calls.log"; then fail "launch opened a window for bad lane [$bad_lane]"; fi
done
: > "$STUB_DIR/calls.log"
"$launch" "$LANE_RUN" p1-plan "$WORKDIR" 'Role: planner.' 'go' 0 extra > /dev/null 2>&1
assert_eq "2" "$?" "7 arguments exit 2"
if grep -q 'new-window' "$STUB_DIR/calls.log"; then fail "launch opened a window for 7 arguments"; fi

# Review Focus 1: a run.json without lane_env is one lane.
"$launch" "$RUN" p1-plan "$WORKDIR" 'Role: planner.' 'go' > /dev/null
assert_eq "0" "$?" "no lane_env, 5 arguments exit 0"
"$launch" "$RUN" p1-plan "$WORKDIR" 'Role: planner.' 'go' 0 > /dev/null
assert_eq "0" "$?" "no lane_env, lane 0 exits 0"
: > "$STUB_DIR/calls.log"
"$launch" "$RUN" p1-plan "$WORKDIR" 'Role: planner.' 'go' 1 > /dev/null 2>&1
assert_eq "2" "$?" "no lane_env, lane 1 exits 2"
if grep -q 'new-window' "$STUB_DIR/calls.log"; then fail "launch opened a window for lane 1 without lane_env"; fi

echo "ok"
