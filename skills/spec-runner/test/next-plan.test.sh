#!/bin/bash
# Tests scripts/next-plan.sh.
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh" || exit 1

skill_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
next_plan="$skill_dir/scripts/next-plan.sh"

setup_stubs
cp "$STUB_DIR/.stub-template" "$STUB_DIR/pgrep"
chmod +x "$STUB_DIR/pgrep"

run_dir=$(mktemp -d "$SPEC_RUNNER_TEST_TMP/run.XXXXXX")
base='{
  "orchestrator": "demo-orchestrator",
  "lane_env": [{}, {}],
  "plans": [
    {"n": 1, "status": "merged",  "depends_on": [],     "paths": ["src/x"],  "exclusive": false, "lane": null},
    {"n": 2, "status": "pending", "depends_on": [1],    "paths": ["src/a"],  "exclusive": false, "lane": null},
    {"n": 3, "status": "pending", "depends_on": [1],    "paths": ["src/b"],  "exclusive": false, "lane": null},
    {"n": 4, "status": "pending", "depends_on": [2, 3], "paths": ["src"],    "exclusive": false, "lane": null},
    {"n": 5, "status": "pending", "depends_on": [1],    "paths": ["docs"],   "exclusive": false, "lane": null}
  ]
}'

# expect <label> <expected stdout> <jq program applied to the base run.json>
expect() {
  local label=$1 expected=$2 program=$3 got status
  printf '%s' "$base" | jq "$program" > "$run_dir/run.json" || fail "$label: bad jq program"
  got=$("$next_plan" "$run_dir" 2>"$run_dir/stderr")
  status=$?
  assert_eq 0 "$status" "$label: exit status"
  assert_eq "$expected" "$got" "$label"
}

# plan <n> <jq update>: shorthand for updating one plan
plan() { echo "(.plans[] | select(.n == $1)) |= ($2)"; }
running() { plan "$1" ".status = \"running\" | .lane = $2"; }

rm -f "$STUB_DIR/pgrep.-fl.out"

expect "nothing running" "2 0" '.'
expect "second lane" "3 1" "$(running 2 0)"
expect "lowest free lane" "3 0" "$(running 2 1)"
expect "both lanes taken" "" "$(running 2 0) | $(running 3 1)"
expect "dependency not merged" "" \
  "$(plan 2 '.status = "merged"') | $(plan 5 '.status = "merged"') | $(plan 3 '.status = "running"')"
expect "blocked dependency" "3 0" "$(plan 2 '.status = "blocked"')"
expect "nested path" "" \
  "$(plan 2 '.status = "running"') | $(plan 3 '.paths = ["src/a/x"]') | $(plan 5 '.status = "merged"')"
expect "sibling prefix" "3 1" \
  "$(plan 2 '.status = "running" | .paths = ["src/app"]') | $(plan 3 '.paths = ["src/application"]')"
expect "trailing slash" "" \
  "$(plan 2 '.status = "running"') | $(plan 3 '.paths = ["src/a/"]') | $(plan 5 '.status = "merged"')"
expect "leading ./" "" \
  "$(plan 2 '.status = "running"') | $(plan 3 '.paths = ["./src/a"]') | $(plan 5 '.status = "merged"')"
expect "whole repo" "" \
  "$(plan 2 '.status = "running"') | $(plan 3 '.paths = ["."]') | $(plan 5 '.status = "merged"')"
expect "candidate without paths" "5 1" \
  "$(plan 2 '.status = "running"') | $(plan 3 '.paths = []')"
expect "running without paths" "" "$(plan 2 '.status = "running" | .paths = []')"
expect "exclusive candidate is passed over" "5 1" \
  "$(plan 2 '.status = "running"') | $(plan 3 '.exclusive = true')"
expect "exclusive plan runs alone" "" "$(plan 2 '.status = "running" | .exclusive = true')"
expect "exclusive plan may start alone" "2 0" "$(plan 2 '.exclusive = true')"
expect "one lane" "" ".lane_env = [{}] | $(plan 2 '.status = "running"')"
older='del(.lane_env) | del(.plans[].paths, .plans[].exclusive, .plans[].lane)'
expect "older run.json" "2 0" "$older"
expect "older run.json, one running" "" "$older | $(plan 2 '.status = "running"')"
expect "all merged" "" '.plans[].status = "merged"'

# another run's watchdog
other='101 /bin/bash /x/scripts/watchdog.sh @3 abc other-orchestrator p1-plan'
mine='102 /bin/bash /x/scripts/watchdog.sh @4 def demo-orchestrator p2-plan'
echo "$other" > "$STUB_DIR/pgrep.-fl.out"
expect "another run is active" "" "$(running 2 0)"
expect "another run, first lane" "2 0" '.'
echo "$mine" > "$STUB_DIR/pgrep.-fl.out"
expect "only this run's watchdog" "3 1" "$(running 2 0)"
printf '%s\n%s\n' "$mine" "$other" > "$STUB_DIR/pgrep.-fl.out"
expect "this and another run" "" "$(running 2 0)"
rm -f "$STUB_DIR/pgrep.-fl.out"

# errors
empty_dir=$(mktemp -d "$SPEC_RUNNER_TEST_TMP/empty.XXXXXX")
"$next_plan" "$empty_dir" >/dev/null 2>&1
assert_eq 1 "$?" "missing run.json exit status"
"$next_plan" >/dev/null 2>&1
assert_eq 2 "$?" "no argument exit status"
"$next_plan" a b >/dev/null 2>&1
assert_eq 2 "$?" "two arguments exit status"

echo "ok next-plan"
