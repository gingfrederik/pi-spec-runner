#!/bin/bash
# Tests SKILL.md (the orchestrator procedure): frontmatter, size, references, and key literals.
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh" || exit 1

skill_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
skill_file="$skill_dir/SKILL.md"
assert_file "$skill_file" "SKILL.md exists"

frontmatter=$(awk 'NR == 1 && $0 == "---" {inside = 1; next} inside && $0 == "---" {exit} inside' "$skill_file")
[ -n "$frontmatter" ] || fail "SKILL.md has no frontmatter"
printf '%s\n' "$frontmatter" | grep -q -x 'name: spec-runner' || fail "frontmatter lacks 'name: spec-runner'"
description=$(printf '%s\n' "$frontmatter" | sed -n 's/^description: *"\{0,1\}//p')
case "$description" in
  'Use when'*) ;;
  *) fail "description does not start with 'Use when': [$description]" ;;
esac

lines=$(wc -l < "$skill_file" | tr -d ' ')
[ "$lines" -le 300 ] || fail "SKILL.md has $lines lines, expected 300 or fewer"

for target in scripts/launch.sh prompts.md run-schema.md contract.md lanes.md scripts/next-plan.sh; do
  grep -q -F -e "]($target)" "$skill_file" || fail "SKILL.md does not link $target"
done

for needle in '--set-upstream-to' '--no-ff' 'info/exclude' '/alias' 'merge-base --is-ancestor' \
  'at most 3' 'at most 2' 'Never merge into main' 'main_branch' 'check-ignore -q .worktrees' \
  'create_worktree' 'unfilled' 'No .worktreeinclude' 'parent directory is not in this checkout' \
  'the directory the install command creates' 'under `patches/`' 'must print `0`' \
  'job_start' 'current_steps' 'lane_env' 'p<n>-sync' 'merge-base --is-ancestor <slug> <branch>'; do
  grep -q -F -e "$needle" "$skill_file" || fail "SKILL.md does not contain [$needle]"
done
! grep -q -E 'current_step([^s]|$)' "$skill_file" || fail "SKILL.md still names the singular current_step"
! grep -q -F -e '(sleep 600' "$skill_file" || fail "SKILL.md still has the bash recheck timer"

# lanes.md (linked from SKILL.md) holds the rules of a run with two lanes.
lanes_file="$skill_dir/lanes.md"
assert_file "$lanes_file" "lanes.md exists"
lane_lines=$(wc -l < "$lanes_file" | tr -d ' ')
[ "$lane_lines" -le 60 ] || fail "lanes.md has $lane_lines lines, expected 60 or fewer"
for needle in '`paths`' '`exclusive`' '`integrating`' 'only to `pending` plans' 'replyTo' \
  'run halted' 'next-plan.sh' 'one lane'; do
  grep -q -F -e "$needle" "$lanes_file" || fail "lanes.md does not contain [$needle]"
done
# The lane count comes from the repo's instructions; lanes.md reasons about no machine resources.
grep -q -F -e "repo's instructions" "$lanes_file" || fail "lanes.md does not contain [repo's instructions]"
! grep -q -i -E 'device|emulator|simulator| port' "$lanes_file" || fail "lanes.md names a device, emulator, simulator or port"

# resume.md (linked from SKILL.md section 1) covers setup-time restarts and idle listed workers.
resume_file="$skill_dir/resume.md"
assert_file "$resume_file" "resume.md exists"
for needle in '`baseline` is `null`' '`plans` is empty' 'pgrep -f "watchdog.sh <window-id> <session-id>"' \
  '`nudged`' 'resend its report' 'older run' 'current_steps'; do
  grep -q -F -e "$needle" "$resume_file" || fail "resume.md does not contain [$needle]"
done

# Every non-URL markdown link target, and every backticked scripts/*.sh, exists in the skill folder.
links=$(grep -o -E '\]\([^)]+\)' "$skill_file" | sed -e 's/^](//' -e 's/)$//' -e 's/#.*//' |
  grep -v -E '^[a-z]+:' | grep -v '^$')
scripts=$(grep -o -E '`scripts/[^` ]+\.sh' "$skill_file" | sed 's/^`//')
[ -n "$links" ] || fail "SKILL.md has no relative links"
for path in $links $scripts; do
  [ -e "$skill_dir/$path" ] || fail "SKILL.md names $path, which is not in the skill folder"
done
