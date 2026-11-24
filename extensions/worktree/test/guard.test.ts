import assert from "node:assert/strict";
import os from "node:os";
import { test } from "node:test";
import { guardReason } from "../guard.ts";
import type { WorktreeState } from "../state.ts";

const root = "/u/.pi/worktrees/repo-abc123/feat";
const state: WorktreeState = { root, branch: "feat", mainRoot: "/u/repo", baseSha: "aaa", managed: true };
const ancestorState: WorktreeState = { ...state, mainRoot: "/u" };

test("write to the main checkout is blocked with the read-only reason", () => {
	const reason = guardReason("write", { path: "/u/repo/a.ts" }, state);
	assert.equal(
		reason,
		`Blocked: /u/repo is the main checkout and is read-only while working in worktree ${root}. Use paths inside the worktree, or call exit_worktree first.`,
	);
	assert.match(reason as string, /read-only/);
});

test("write inside the worktree is allowed", () => {
	assert.equal(guardReason("write", { path: `${root}/a.ts` }, state), undefined);
});

test("a sibling path sharing the mainRoot prefix is allowed", () => {
	assert.equal(guardReason("write", { path: "/u/repository/a.ts" }, state), undefined);
});

test("ancestor main checkout: worktree paths allowed, other paths under main blocked", () => {
	assert.equal(guardReason("edit", { path: `${root}/a.ts` }, ancestorState), undefined);
	assert.match(guardReason("edit", { path: "/u/other.ts" }, ancestorState) as string, /read-only/);
});

test("bash writing to the main checkout is blocked", () => {
	assert.match(guardReason("bash", { command: "cd /u/repo && rm a" }, state) as string, /read-only/);
	assert.match(guardReason("bash", { command: 'rm "/u/repo/a"' }, state) as string, /read-only/);
	assert.match(guardReason("bash", { command: "echo x > '/u/repo/a'" }, state) as string, /read-only/);
	assert.match(guardReason("bash", { command: "cp a.md /u/repo/a.md" }, state) as string, /Bash may only read it/);
});

test("bash reading the main checkout is allowed", () => {
	for (const command of [
		'cat "/u/repo/a"',
		"cat '/u/repo/a'",
		"ls /u/repo",
		"shasum /u/repo/design/bell.js",
		"cp /u/repo/docs/plan.md docs/plan.md",
		"git -C /u/repo log --oneline -3",
	]) {
		assert.equal(guardReason("bash", { command }, state), undefined, command);
	}
});

test("bash on a sibling prefix or inside the worktree is allowed", () => {
	assert.equal(guardReason("bash", { command: "ls /u/repository" }, state), undefined);
	assert.equal(guardReason("bash", { command: `ls ${root}/src` }, state), undefined);
	for (const command of ["ls /u/repox", "ls /u/repo.bak", "ls /u/repo-old", "ls /u/repo_2"]) {
		assert.equal(guardReason("bash", { command }, state), undefined, command);
	}
});

test("bash mainRoot followed by a shell operator is blocked", () => {
	for (const command of ["cd /u/repo;rm x", "cd /u/repo&&rm x", "echo $(rm /u/repo)", "ls x|tee /u/repo", "ls x>/u/repo", "cd /u/repo\nrm x"]) {
		assert.match(guardReason("bash", { command }, state) ?? "", /read-only/, command);
	}
});

test("bash inside the worktree is allowed when mainRoot is an ancestor", () => {
	assert.equal(guardReason("bash", { command: `ls ${root}/src` }, ancestorState), undefined);
	assert.match(guardReason("bash", { command: "rm /u/other" }, ancestorState) as string, /read-only/);
});

test("bash git-dir overrides are blocked", () => {
	for (const command of [
		"git --git-dir=x status",
		"git --work-tree=x status",
		"git --git-dir x status",
		"git -C . --work-tree /x status",
		"GIT_DIR=x git log",
		"GIT_WORK_TREE=x git log",
		"ls && GIT_DIR=/x/.git git log",
		"FOO=1 GIT_DIR=x git log",
		"env GIT_DIR=x git log",
		"export GIT_DIR=/x/.git",
		"export GIT_WORK_TREE=x; git status",
	]) {
		assert.match(guardReason("bash", { command }, state) ?? "", /read-only/, command);
	}
});

test("bash read-only git-dir queries and captured GIT_DIR assignments are allowed", () => {
	for (const command of [
		// superpowers using-git-worktrees Step 0 / finishing-a-development-branch Step 2
		'GIT_DIR=$(cd "$(git rev-parse --git-dir)" 2>/dev/null && pwd -P)',
		'GIT_DIR=$(cd "$(git rev-parse --git-dir)" 2>/dev/null && pwd -P)\nGIT_COMMON=$(cd "$(git rev-parse --git-common-dir)" 2>/dev/null && pwd -P)',
		"git rev-parse --git-dir",
		"git rev-parse --git-dir 2>/dev/null",
		"git rev-parse --git-dir && git status",
		"git rev-parse --git-dir --show-toplevel",
		"echo $(git rev-parse --git-dir)",
		"MY_GIT_DIR=x git log",
	]) {
		assert.equal(guardReason("bash", { command }, state), undefined, command);
	}
});

test("read is never blocked", () => {
	assert.equal(guardReason("read", { path: "/u/repo/a.ts" }, state), undefined);
});

test("subagent with cwd in the main checkout is blocked; worktree cwd allowed", () => {
	assert.match(guardReason("subagent", { cwd: "/u/repo" }, state) as string, /read-only/);
	assert.equal(guardReason("subagent", { cwd: root }, state), undefined);
	assert.equal(guardReason("subagent", { agent: "x" }, state), undefined);
});

test("subagent per-item cwds in the main checkout are blocked", () => {
	for (const input of [
		{ cwd: root, tasks: [{ cwd: root }, { cwd: "/u/repo/pkg" }] },
		{ cwd: root, chain: [{ cwd: "/u/repo" }] },
		{ cwd: root, chain: [{ cwd: root }, { parallel: [{ cwd: root }, { cwd: "/u/repo" }] }] },
	]) {
		assert.match(guardReason("subagent", input, state) ?? "", /read-only/, JSON.stringify(input));
	}
	const ok = { cwd: root, tasks: [{ cwd: `${root}/a` }, {}], chain: [{ parallel: [{ cwd: root }, "x"] }, null] };
	assert.equal(guardReason("subagent", ok, state), undefined);
});

test("only ~ and ~/ are expanded to the home directory; ~name is relative to the root", () => {
	const home = os.homedir();
	const homeState: WorktreeState = { ...state, mainRoot: home, root: "/elsewhere/wt" };
	assert.match(guardReason("write", { path: "~/x" }, homeState) as string, /read-only/);
	assert.match(guardReason("write", { path: "~" }, homeState) as string, /read-only/);
	// Pi resolves "~other/x" like any relative path; rewriteInput puts it under the root.
	assert.equal(guardReason("write", { path: "~other/x" }, homeState), undefined);
	const insideHome: WorktreeState = { ...state, mainRoot: home, root: `${home}/.pi/worktrees/r-abc123/feat` };
	assert.equal(guardReason("write", { path: "~other/x" }, insideHome), undefined);
});

test("file paths with .. traversal are normalized before the mainRoot check", () => {
	assert.match(guardReason("write", { path: `${root}/../../../../repo/a.ts` }, state) as string, /read-only/);
	assert.match(guardReason("write", { path: "/u/other/../repo/a.ts" }, state) as string, /read-only/);
});

test("opts.canon is applied to file paths", () => {
	const canonState: WorktreeState = { ...state, mainRoot: "/private/tmp/repo", root: "/private/tmp/wt" };
	const canon = (p: string) => (p.startsWith("/tmp/") ? `/private${p}` : p);
	assert.equal(guardReason("write", { path: "/tmp/repo/a" }, canonState), undefined);
	assert.match(guardReason("write", { path: "/tmp/repo/a" }, canonState, { canon }) as string, /read-only/);
});

test("bash mainAliases are checked like mainRoot", () => {
	const aliasState: WorktreeState = { ...state, mainRoot: "/private/tmp/repo", root: "/private/tmp/wt" };
	assert.match(
		guardReason("bash", { command: "echo x > /tmp/repo/evil" }, aliasState, { mainAliases: ["/tmp/repo"] }) as string,
		/read-only/,
	);
	assert.equal(guardReason("bash", { command: "echo x > /tmp/repository/ok" }, aliasState, { mainAliases: ["/tmp/repo"] }), undefined);
});

test("empty mainAliases entries are ignored", () => {
	assert.equal(guardReason("bash", { command: "ls /x" }, state, { mainAliases: [""] }), undefined);
});

test("mainRoot with regex metacharacters is matched literally", () => {
	const special: WorktreeState = { ...state, mainRoot: "/u/re+po(1)" };
	assert.match(guardReason("bash", { command: "rm /u/re+po(1)/x" }, special) as string, /read-only/);
	assert.equal(guardReason("bash", { command: "rm /u/reeepo1/x" }, special), undefined);
});

// ---- worktree inside the main checkout: <repo>/.worktrees/<name>

const nestedRoot = "/u/repo/.worktrees/feat";
const nested: WorktreeState = { root: nestedRoot, branch: "feat", mainRoot: "/u/repo", baseSha: "aaa", managed: true };

test("nested: the worktree's own paths are not the main checkout", () => {
	for (const command of [`rm ${nestedRoot}/a`, `echo x > ${nestedRoot}/a`, `cd ${nestedRoot}/src && rm b`, "rm a", "cd src && rm ../a"]) {
		assert.equal(guardReason("bash", { command }, nested), undefined, command);
	}
	assert.equal(guardReason("write", { path: `${nestedRoot}/a` }, nested), undefined);
});

test("nested: a sibling worktree whose name extends this one is not mistaken for it", () => {
	assert.match(guardReason("bash", { command: "rm /u/repo/.worktrees/featx/a" }, nested) ?? "", /read-only/);
	assert.match(guardReason("bash", { command: "echo x > /u/repo/.worktrees/feat-old/a" }, nested) ?? "", /read-only/);
	assert.equal(guardReason("bash", { command: "cat /u/repo/.worktrees/featx/a" }, nested), undefined);
});

test("nested: relative .. paths that climb into the main checkout are checked", () => {
	for (const command of [
		"rm ../../a.txt",
		"echo x > ../../a.txt",
		"cd ../.. && rm a.txt",
		"cd src && rm ../../../a.txt",
		"rm ../other/a", // a sibling worktree
		`rm ${nestedRoot}/../../a.txt`,
		"rm /u/repo/.worktrees/feat/../../a.txt",
		"cp a ../../a.txt",
		"sed -i s/a/b/ ../../a.txt",
		"cd $HOME && rm ../x",
	]) {
		assert.match(guardReason("bash", { command }, nested) ?? "", /read-only/, command);
	}
});

test("nested: relative .. reads of the main checkout and .. inside the worktree are allowed", () => {
	for (const command of [
		"cat ../../a.txt",
		"cp ../../docs/plan.md docs/",
		"cd src && cat ../package.json",
		"cd src && node ../scripts/build.js",
		"git log 8a12a0e..HEAD",
		"git diff HEAD~1..HEAD -- src",
		"npm test 2>&1 | tail -5",
	]) {
		assert.equal(guardReason("bash", { command }, nested), undefined, command);
	}
});

test("job_start with a cwd in the main checkout is blocked, elsewhere allowed", () => {
	assert.match(guardReason("job_start", { command: "ls", cwd: "/u/repo" }, state) as string, /read-only/);
	assert.match(guardReason("job_start", { command: "ls", cwd: "/u/repo/src" }, state) as string, /read-only/);
	assert.equal(guardReason("job_start", { command: "ls", cwd: `${root}/sub` }, state), undefined);
	assert.equal(guardReason("job_start", { command: "ls", cwd: root }, state), undefined);
	assert.equal(guardReason("job_start", { command: "ls", cwd: "/tmp" }, state), undefined);
});

test("job_start commands get the bash check", () => {
	const cwd = root;
	assert.equal(guardReason("job_start", { command: "npm test", cwd }, state), undefined);
	assert.equal(guardReason("job_start", { command: "cat /u/repo/package.json", cwd }, state), undefined);
	for (const command of ["cd /u/repo && npm install", "echo x > /u/repo/f"]) {
		assert.match(guardReason("job_start", { command, cwd }, state) as string, /Bash may only read it/, command);
	}
	assert.match(guardReason("job_start", { command: "git --git-dir=x status", cwd }, state) as string, /read-only/);
});
