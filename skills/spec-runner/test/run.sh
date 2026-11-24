#!/bin/bash
# Runs every test/*.test.sh in its own bash process. Exits 1 if any test fails.
# A passing test's "SKIP ..." lines are shown under its PASS line.
test_dir=$(cd "$(dirname "$0")" && pwd)
failed=0
for test_file in "$test_dir"/*.test.sh; do
  name=$(basename "$test_file")
  if output=$(bash "$test_file" 2>&1); then
    echo "PASS $name"
    printf '%s\n' "$output" | grep '^SKIP ' | sed 's/^/    /'
  else
    echo "FAIL $name"
    printf '%s\n' "$output" | sed 's/^/    /'
    failed=1
  fi
done
exit "$failed"
