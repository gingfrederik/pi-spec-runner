#!/bin/bash
# Shared helpers for test/*.test.sh. Source with: . "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
# Works with bash 3.2.

SPEC_RUNNER_TEST_TMP=$(mktemp -d "${TMPDIR:-/tmp}/spec-runner-test.XXXXXX") || exit 1
trap 'rm -rf "$SPEC_RUNNER_TEST_TMP"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_eq() { # expected actual label
  [ "$1" = "$2" ] || fail "$3: expected [$1], got [$2]"
}

assert_contains() { # haystack needle label
  case "$1" in
    *"$2"*) ;;
    *) fail "$3: [$1] does not contain [$2]" ;;
  esac
}

assert_file() { # path label
  [ -f "$1" ] || fail "$2: missing file $1"
}

# Creates $STUB_DIR with tmux, pi and pi-intercom stubs and puts it first on PATH.
# Every stub logs "<name> <%q-quoted args>" to $STUB_DIR/calls.log, then:
#   - tmux list-panes (the window-exists check) exits 1 if $STUB_DIR/window-gone exists;
#   - prints $STUB_DIR/<name>.<subcommand>.out if it exists (subcommand = first argument);
#   - exits with the number in $STUB_DIR/<name>.<subcommand>.exit if it exists, else 0.
# A test can overwrite $STUB_DIR/tmux or $STUB_DIR/pi after this call.
setup_stubs() {
  STUB_DIR="$SPEC_RUNNER_TEST_TMP/stubs"
  mkdir -p "$STUB_DIR"
  : > "$STUB_DIR/calls.log"
  cat > "$STUB_DIR/.stub-template" <<'STUB'
#!/bin/bash
stub_dir=$(cd "$(dirname "$0")" && pwd)
name=$(basename "$0")
sub=$1
line=$name
for arg in "$@"; do line="$line $(printf '%q' "$arg")"; done
echo "$line" >> "$stub_dir/calls.log"
if [ "$name" = tmux ] && [ "$sub" = list-panes ] && [ -e "$stub_dir/window-gone" ]; then
  exit 1
fi
[ -f "$stub_dir/$name.$sub.out" ] && cat "$stub_dir/$name.$sub.out"
if [ -f "$stub_dir/$name.$sub.exit" ]; then
  exit "$(cat "$stub_dir/$name.$sub.exit")"
fi
exit 0
STUB
  local name
  for name in tmux pi pi-intercom; do
    cp "$STUB_DIR/.stub-template" "$STUB_DIR/$name"
    chmod +x "$STUB_DIR/$name"
  done
  export STUB_DIR
  export SPEC_RUNNER_INTERCOM="$STUB_DIR/pi-intercom"
  export PATH="$STUB_DIR:$PATH"
}

# Creates a temporary run folder with a minimal run.json and prints its path.
new_run_dir() {
  local dir
  dir=$(mktemp -d "$SPEC_RUNNER_TEST_TMP/run.XXXXXX") || return 1
  cat > "$dir/run.json" <<'JSON'
{
  "slug": "demo",
  "orchestrator": "demo-orchestrator",
  "tmux_session": "demo",
  "model": "anthropic/claude-sonnet-4-5",
  "thinking": "medium",
  "worker_env": {"ANDROID_SERIAL": "emulator-5554"},
  "worker_flags": ["--approve"]
}
JSON
  echo "$dir"
}
