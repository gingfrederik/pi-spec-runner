#!/bin/bash
# Creates the toy repo for the spec-runner dry run. Usage: make-toy-repo.sh <dir> [--blocked|--parallel]
# <dir> must not exist. The repo has one commit on `main`, and `npm test` passes in it.
# --blocked writes the spec variant whose step 1 needs the owner's npm token (blocked path).
# --parallel writes the spec variant that gives an example split into three plans, two of them
# independent (two-lane run), and an AGENTS.md that says two plans may run at the same time.

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ] || { [ "$#" -eq 2 ] && [ "$2" != --blocked ] && [ "$2" != --parallel ]; }; then
  echo "usage: make-toy-repo.sh <dir> [--blocked|--parallel]" >&2
  exit 2
fi
dir=$1
variant=${2:-}
if [ -e "$dir" ]; then
  echo "make-toy-repo.sh: $dir already exists" >&2
  exit 1
fi

mkdir -p "$dir/src" "$dir/test" "$dir/docs/specs" || exit 1
cd "$dir" || exit 1

cat > package.json <<'EOF'
{
  "name": "toy-strings",
  "version": "0.1.0",
  "description": "Toy string utilities for the spec-runner dry run.",
  "type": "module",
  "main": "src/index.js",
  "scripts": {
    "test": "node --test"
  },
  "license": "MIT"
}
EOF

cat > src/index.js <<'EOF'
export { trim } from './trim.js';
EOF

cat > src/trim.js <<'EOF'
// Collapses runs of whitespace to one space and trims both ends.
export function trim(s) {
  return String(s).replace(/\s+/g, ' ').trim();
}
EOF

cat > test/trim.test.js <<'EOF'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trim } from '../src/trim.js';

test('trim collapses inner whitespace and trims the ends', () => {
  assert.equal(trim('  a \t b\n'), 'a b');
});
EOF

cat > AGENTS.md <<'EOF'
# toy-strings

Small ESM string utilities. Source in `src/`, tests in `test/` (`node:test`, one `*.test.js`
per module). Export every public function from `src/index.js`. No runtime dependencies.

verification: `npm test`
EOF

if [ "$variant" = --parallel ]; then
  cat >> AGENTS.md <<'EOF'

In this repo the feature layout overrides the base test location above: each feature lives in
its own directory `src/<feature>/` with an `index.js` and its tests (`*.test.js`) beside it, not
in `test/`. `src/index.js` is edited only by the plan whose spec step says so (the summary step).
Import `slugify` and `wordCount` from their own `src/<feature>/index.js`. Two plans may run
at the same time; a second lane needs no environment variables.
EOF
fi

cat > .gitignore <<'EOF'
node_modules/
.worktrees/
EOF

if [ "$variant" = --blocked ]; then
  step1='1. **`slugify(s)`** in `src/slugify.js`, with tests. It must use the owner'"'"'s private
   package `@owner/unicode-tables` for its transliteration tables. Fetching that package from
   the private npm registry needs the owner'"'"'s npm token; nothing else provides the tables.
   `slugify` lowercases, transliterates (`Crème Brûlée` → `creme-brulee`), replaces every run of
   other characters with one `-`, and trims `-` from both ends.'
else
  step1='1. **`slugify(s)`** in `src/slugify.js`, with tests. It lowercases, strips diacritics
   (Unicode NFKD, then drop combining marks: `Crème Brûlée` → `creme-brulee`), replaces every
   run of characters other than `a-z` and `0-9` with one `-`, and trims `-` from both ends.'
fi

if [ "$variant" = --parallel ]; then
cat > docs/specs/toy-design.md <<EOF
# Toy string utilities: design

Add three string utilities to \`toy-strings\`.

## Example split into plans

Three plans. The first two touch different directories and do not depend on each other; the
third uses both.

1. **\`slugify(s)\`** in \`src/slug/\`: \`src/slug/index.js\` and \`src/slug/slug.test.js\`. It
   lowercases, strips diacritics (Unicode NFKD, then drop combining marks:
   \`Crème Brûlée\` → \`creme-brulee\`), replaces every run of characters other than \`a-z\` and
   \`0-9\` with one \`-\`, and trims \`-\` from both ends.

2. **\`wordCount(s)\`** in \`src/count/\`: \`src/count/index.js\` and \`src/count/count.test.js\`. It
   returns the number of whitespace-separated words: \`'  a  b\\tc '\` → \`3\`, \`''\` → \`0\`.

3. **\`summary(s)\`** in \`src/summary/\`: \`src/summary/index.js\` and
   \`src/summary/summary.test.js\`. It returns \`{ slug, words }\`, using \`slugify\` from
   \`src/slug/\` and \`wordCount\` from \`src/count/\`: \`summary('Crème Brûlée')\` →
   \`{ slug: 'creme-brulee', words: 2 }\`. It also adds \`slugify\`, \`wordCount\` and \`summary\`
   to the exports of \`src/index.js\`.

## Done when

- \`slugify\`, \`wordCount\` and \`summary\` are exported from \`src/index.js\`.
- Each has tests for ASCII input, Unicode input, empty string, and leading/trailing separators.
- \`npm test\` passes.
EOF
else
cat > docs/specs/toy-design.md <<EOF
# Toy string utilities: design

Add two string utilities to \`toy-strings\` and prepare its release.

## Order of work

$step1

2. **\`titleCase(s)\`** in \`src/title-case.js\`, with tests. It splits words with the same
   word-splitting internals \`slugify\` uses (move them into a shared helper in
   \`src/words.js\`), then upper-cases the first letter of each word, lower-cases the rest,
   and joins with one space: \`hello   wORLD-again\` → \`Hello World Again\`.
   Stop point (check before this step starts): if \`slugify\` cannot handle Unicode input such
   as \`Crème Brûlée\`, stop and report.

3. **Publish** the package to npm with the owner's token.

## Done when

- \`slugify\` and \`titleCase\` are exported from \`src/index.js\`.
- Each has tests for ASCII input, Unicode input, empty string, and leading/trailing separators.
- \`npm test\` passes.
- \`toy-strings\` is published to npm.
EOF
fi

# A lockfile, so `npm ci` works as the install command. There are no dependencies to fetch.
npm install --package-lock-only --no-audit --no-fund --silent || exit 1

git init -q -b main || exit 1
git config user.name 'Toy Owner'
git config user.email 'toy-owner@example.invalid'
git add -A
git commit -q -m 'Initial toy-strings repo' || exit 1
echo "$dir: toy repo ready on main ($(git rev-parse --short HEAD))"
