#!/bin/bash
# Prints the state of one step session: busy | idle | gone.
# Usage: worker-state.sh <worker-session-id>
# busy: working, or waiting to continue by itself. idle: waiting for input. gone: not running.
[ "$#" -eq 1 ] || { echo "usage: worker-state.sh <worker-session-id>" >&2; exit 2; }
SPEC_RUNNER_SOURCE_ONLY=1 . "$(dirname "${BASH_SOURCE[0]}")/watchdog.sh"
worker_state "$1"
