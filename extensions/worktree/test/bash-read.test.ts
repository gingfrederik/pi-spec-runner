import assert from "node:assert/strict";
import { test } from "node:test";
import { bashReadsOnly, splitCommands } from "../bash-read.ts";

const M = "/u/repo";
const reads = (command: string) => bashReadsOnly(command, [M]);

test("splitCommands splits at operators outside quotes and drops quotes", () => {
	assert.deepEqual(
		splitCommands(`grep "a|b" '/u/x y' && ls;echo 'c;d'`)?.map((ws) => ws.map((w) => w.text)),
		[["grep", "a|b", "/u/x y"], ["ls"], ["echo", "c;d"]],
	);
});

test("splitCommands marks redirect targets and ignores fd numbers and fd duplication", () => {
	const [words] = splitCommands("cat a 2>/dev/null >out >&2 >>log &>both") ?? [];
	assert.deepEqual(
		words.map((w) => [w.text, w.out]),
		[["cat", false], ["a", false], ["/dev/null", true], ["out", true], ["2", false], ["log", true], ["both", true]],
	);
});

test("splitCommands opens command substitutions, also inside double quotes", () => {
	assert.deepEqual(
		splitCommands(`echo "x $(rm /a) y" \`ls /b\``)?.map((ws) => ws.map((w) => w.text)),
		[["echo", "x "], ["rm", "/a"], [" y"], ["ls", "/b"]],
	);
});

test("splitCommands returns null when it cannot follow the command", () => {
	for (const command of ["echo 'open", 'echo "open', "echo $(ls", "cat <<EOF\nno end"]) {
		assert.equal(splitCommands(command), null, command);
	}
});

test("reads of the main checkout are allowed", () => {
	for (const command of [
		`cat ${M}/a`,
		`head -n 5 "${M}/a" | wc -l`,
		`ls ${M}/node_modules >/dev/null && echo ok`,
		`grep -rn foo ${M}/src | head`,
		`rg -n foo ${M}/src`,
		`find ${M}/src -name '*.ts'`,
		`diff ${M}/a b`,
		`shasum ${M}/design/bell.js`,
		`sed -n '1,20p' ${M}/a`,
		`sort ${M}/a | uniq -c`,
		`git -C ${M} log --oneline -5`,
		`git -C ${M} status --short`,
		`git -C ${M} show HEAD:a.txt > a.txt`,
		`cp ${M}/docs/plan.md docs/plan.md`,
		`cp -r ${M}/a ${M}/b dest/`,
		`cat ${M}/a > copy.txt`,
		`x=$(cat ${M}/a); echo "$x"`,
	]) {
		assert.equal(reads(command), true, command);
	}
});

test("the session's blocked commands now pass", () => {
	// S:15 and S:219 of session 01a16cde, with the paths of this test
	const copy = `M=${M}; mkdir -p docs/superpowers/plans; cp $M/docs/superpowers/plans/p.md docs/superpowers/plans/; ls $M/node_modules >/dev/null && echo has_nm; (npm ci --silent 2>&1 | tail -5) ; echo install_exit=$?`;
	assert.equal(reads(copy), true);
	assert.equal(reads(`shasum ${M}/design/mockups/bell.js`), true);
});

test("writes to the main checkout are blocked", () => {
	for (const command of [
		`rm ${M}/a`,
		`cd ${M} && ls`,
		`echo x > ${M}/a`,
		`echo x >> "${M}/a"`,
		`cat a | tee ${M}/a`,
		`cp a ${M}/a`,
		`cp -t ${M} a`,
		`cp --target-directory=${M} a`,
		`mv ${M}/a b`,
		`touch ${M}/a`,
		`mkdir ${M}/x`,
		`sed -i 's/a/b/' ${M}/a`,
		`sed -i.bak 's/a/b/' ${M}/a`,
		`sed -n 'w ${M}/out' a`,
		`sort -o ${M}/a a`,
		`find ${M} -name '*.tmp' -delete`,
		`find ${M} -exec rm {} \\;`,
		`git -C ${M} commit -m x`,
		`git -C ${M} checkout main`,
		`git -C ${M} -c core.pager=evil log`,
		`git -C ${M} diff --output=${M}/x`,
		`rg --pre ./x foo ${M}`,
		`npm --prefix ${M} install`,
		`ls a; rm -rf ${M}/b`,
		`echo "$(rm ${M}/a)"`,
	]) {
		assert.equal(reads(command), false, command);
	}
});

test("a variable holding a main path counts as naming it", () => {
	assert.equal(reads(`M=${M}; rm -rf $M/x`), false);
	assert.equal(reads(`D="${M}/src"; cd "\${D}" && ls`), false);
	assert.equal(reads(`M=${M}; cp a $M/b`), false);
	assert.equal(reads(`M=${M}; cat $M/a; rm $MORE`), true, "$MORE is another variable");
});

test("interpreters block when the main checkout is named anywhere", () => {
	for (const command of [
		`cat ${M}/x.sh | sh`,
		`bash ${M}/x.sh`,
		`. ${M}/env.sh`,
		`ls ${M} | xargs rm`,
		`python3 -c "open('${M}/a','w')"`,
		`cat <<EOF | bash\nrm ${M}/a\nEOF`,
	]) {
		assert.equal(reads(command), false, command);
	}
});

test("heredoc bodies are data for their command", () => {
	// a ledger note that mentions the main checkout, written inside the worktree
	assert.equal(reads(`cat >> progress.md <<'EOF'\nMain checkout: ${M} (read-only)\nEOF`), true);
	// the body belongs to the command that reads it
	assert.equal(reads(`bash <<'EOF'\nrm ${M}/a\nEOF`), false);
	// an apostrophe in the body must not swallow what follows
	assert.equal(reads(`cat > f <<EOF\nit's fine\nEOF\ncd ${M} && rm -rf x`), false);
	// an unquoted delimiter expands $(...) in the body
	assert.equal(reads(`cat > f <<EOF\n$(rm ${M}/a)\nEOF`), false);
	assert.equal(reads(`cat > f <<-EOF\n\tok ${M}\n\tEOF\nls ${M}`), true);
});

test("a main path the lexer splits apart blocks", () => {
	const odd = "/u/re(po)";
	assert.equal(bashReadsOnly(`rm ${odd}/x`, [odd]), false);
	assert.equal(bashReadsOnly(`cat "${odd}/x"; rm ${odd}/y`, [odd]), false);
	assert.equal(bashReadsOnly(`cat "${odd}/x"`, [odd]), true);
});

test("an interpreter in another pipeline does not block a read of main (session 01a16da1 S:18)", () => {
	const line = `M=${M}; mkdir -p docs/superpowers/plans docs/superpowers/specs && cp $M/docs/superpowers/plans/p.md docs/superpowers/plans/ && cp $M/docs/superpowers/specs/s.md docs/superpowers/specs/ && S=/skills/sdd; ls $S $S/scripts $S/references; bash $S/scripts/sdd-workspace docs/superpowers/plans/p.md; pwd; git log --oneline -2`;
	assert.equal(reads(line), true);
	for (const command of [
		`cp ${M}/a . && bash x.sh`,
		`cat ${M}/a || sh fallback.sh`,
		`cat ${M}/a\nnode build.js`,
		`cat ${M}/a & python3 x.py`,
	]) {
		assert.equal(reads(command), true, command);
	}
});

test("an interpreter in the same pipeline as main still blocks", () => {
	for (const command of [
		`cat ${M}/x.sh | sh`,
		`cat ${M}/x.sh |& bash`,
		`ls ${M} | grep x | xargs rm`,
		`echo "$(cat ${M}/x.sh)" | sh`,
		`bash -c "$(cat ${M}/x.sh)"`,
	]) {
		assert.equal(reads(command), false, command);
	}
});

test("taint follows variable chains", () => {
	assert.equal(reads(`M=${M}; S=$M/src; rm -rf $S/x`), false);
	assert.equal(reads(`M=${M}; S="\${M}"; cd $S`), false);
	assert.equal(reads(`M=${M}; S=$M/src; cat $S/x`), true);
});
