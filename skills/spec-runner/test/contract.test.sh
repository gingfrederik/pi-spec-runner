#!/bin/bash
# Tests contract.md (the template launch.sh renders into each step's system prompt).
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh" || exit 1

skill_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
contract_file="$skill_dir/contract.md"
assert_file "$contract_file" "contract.md exists"
contract=$(cat "$contract_file")

count_of() { # needle
  grep -o -F "$1" "$contract_file" | wc -l | tr -d ' '
}

assert_eq "1" "$(count_of '{{STEP}}')" "{{STEP}} appears once"
assert_eq "1" "$(count_of '{{ROLE}}')" "{{ROLE}} appears once"
orchestrator_count=$(count_of '{{ORCHESTRATOR}}')
[ "$orchestrator_count" -ge 2 ] || fail "{{ORCHESTRATOR}} appears $orchestrator_count times, expected 2 or more"

for needle in 'intercom' '"send"' 'blocked' 'stop' 'manual_checks' \
  'finishing-a-development-branch' 'Never ask the user'; do
  assert_contains "$contract" "$needle" "contract mentions $needle"
done

assert_contains "$contract" 'Never merge, push, rebase' "contract forbids merge, push, rebase"
assert_contains "$contract" '`status` is one of' "contract lists status values"
assert_contains "$contract" 'review, fix and audit steps' "contract gives findings to audit steps too"

lines=$(wc -l < "$contract_file" | tr -d ' ')
[ "$lines" -le 30 ] || fail "contract.md has $lines lines, expected 30 or fewer"
