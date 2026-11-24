#!/bin/bash
# Tests the stubs and helpers in lib.sh.
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh" || exit 1

setup_stubs

tmux new-window -d foo
assert_contains "$(cat "$STUB_DIR/calls.log")" "tmux new-window -d foo" "tmux call is logged"

pi --model "a b" >/dev/null
assert_contains "$(cat "$STUB_DIR/calls.log")" "pi --model a\\ b" "pi call is logged with %q quoting"

"$SPEC_RUNNER_INTERCOM" send orch "hi" >/dev/null
assert_contains "$(cat "$STUB_DIR/calls.log")" "pi-intercom send orch hi" "pi-intercom call is logged"

echo "@7" > "$STUB_DIR/tmux.display-message.out"
assert_eq "@7" "$(tmux display-message -p '#{window_id}')" "tmux display-message prints its .out file"

echo "pong" > "$STUB_DIR/pi-intercom.ask.out"
assert_eq "pong" "$("$SPEC_RUNNER_INTERCOM" ask x)" "pi-intercom prints its .out file"

tmux has-session -t foo
assert_eq "0" "$?" "stub exits 0 by default"
echo 1 > "$STUB_DIR/tmux.has-session.exit"
tmux has-session -t foo
assert_eq "1" "$?" "stub exits with the code in <name>.<subcommand>.exit"
echo 3 > "$STUB_DIR/pi-intercom.send.exit"
"$SPEC_RUNNER_INTERCOM" send a b
assert_eq "3" "$?" "pi-intercom honours its .exit file"

touch "$STUB_DIR/window-gone"
tmux list-panes -t @7 >/dev/null
assert_eq "1" "$?" "tmux list-panes exits 1 when window-gone exists"
tmux new-window -d bar
assert_eq "0" "$?" "window-gone affects only list-panes"

printf '#!/bin/bash\necho custom\n' > "$STUB_DIR/tmux"
assert_eq "custom" "$(tmux anything)" "a test can override the tmux stub"

run_dir=$(new_run_dir)
assert_file "$run_dir/run.json" "new_run_dir creates run.json"
assert_eq "demo" "$(jq -r .slug "$run_dir/run.json")" "run.json slug"
assert_eq "demo-orchestrator" "$(jq -r .orchestrator "$run_dir/run.json")" "run.json orchestrator"
assert_eq "demo" "$(jq -r .tmux_session "$run_dir/run.json")" "run.json tmux_session"
assert_eq "anthropic/claude-sonnet-4-5" "$(jq -r .model "$run_dir/run.json")" "run.json model"
assert_eq "medium" "$(jq -r .thinking "$run_dir/run.json")" "run.json thinking"
assert_eq "emulator-5554" "$(jq -r .worker_env.ANDROID_SERIAL "$run_dir/run.json")" "run.json worker_env"
assert_eq '["--approve"]' "$(jq -c .worker_flags "$run_dir/run.json")" "run.json worker_flags"

lib_path="$(dirname "${BASH_SOURCE[0]}")/lib.sh"
temp_root=$(bash -c '. "$1"; setup_stubs; new_run_dir >/dev/null; dirname "$STUB_DIR"' _ "$lib_path")
if [ -e "$temp_root" ]; then fail "temp dir $temp_root survives after the test process exits"; fi
