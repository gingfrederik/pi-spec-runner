#!/bin/bash
# Tests prompts.md (visible prompt and role line per step type) and run-schema.md (run.json fields).
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh" || exit 1

skill_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
prompts_file="$skill_dir/prompts.md"
schema_file="$skill_dir/run-schema.md"
assert_file "$prompts_file" "prompts.md exists"
assert_file "$schema_file" "run-schema.md exists"

for heading in plan execute sync review fix redfix audit; do
  grep -q -x "## $heading" "$prompts_file" || fail "prompts.md lacks heading '## $heading'"
done

prompts=$(cat "$prompts_file")
for needle in '/skill:writing-plans' '/skill:code-review high' '/skill:receiving-code-review' \
  'recommended_executor' 'blocking_count' "Skip the skill's final whole-branch review" \
  '@{upstream}...HEAD' 'git diff <main>...HEAD' 'git merge <slug>' '<merged>' 'focused test command' \
  'fewer tests than the full check' 'cannot be narrowed'; do
  assert_contains "$prompts" "$needle" "prompts.md mentions $needle"
done

example=$(awk '/^```json$/ {inside = 1; next} /^```$/ && inside {exit} inside' "$schema_file")
[ -n "$example" ] || fail "run-schema.md has no json fence"
printf '%s\n' "$example" | jq -e '.slug and .orchestrator and .tmux_session and .model and .thinking
  and (.worker_env|type=="object") and (.worker_flags|type=="array") and (.plans|length==2)
  and (.main_branch|type=="string") and (.lane_env|type=="array") and (.current_steps|type=="array")
  and (.plans|all(.paths|type=="array")) and has("integrating") and (has("current_step")|not)' >/dev/null ||
  fail "run-schema.md example fails the jq check"

schema=$(cat "$schema_file")
assert_contains "$schema" 'p<n>-sync' "run-schema.md names the p<n>-sync step"
case "$schema" in
  *'current_step.'*) fail "run-schema.md still has the dotted name current_step." ;;
esac
