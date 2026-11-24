import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
	createWorktree,
	ensureIgnored,
	ensureWorktree,
	IGNORE_COMMIT_MESSAGE,
	generateName,
	launchWorktree,
	listWorktrees,
	mainRootOf,
	managedDir,
	removeWorktree,
	validName,
	worktreeStatus,
} from "../git.ts";

const IDENT = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"];

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", [...IDENT, "-C", cwd, ...args], { stdio: "pipe" }).toString();
}

function makeTmp(t: { after: (fn: () => void) => void }, prefix: string): string {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function makeRepo(t: { after: (fn: () => void) => void }): string {
	const dir = makeTmp(t, "wt-git-repo-");
	git(dir, "init", "-q", "-b", "main");
	fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
	git(dir, "add", ".");
	git(dir, "commit", "-q", "-m", "init");
	return dir;
}

function commitCount(repo: string): number {
	return Number(git(repo, "rev-list", "--count", "HEAD").trim());
}

function branchExists(repo: string, name: string): boolean {
	try {
		git(repo, "show-ref", "--verify", "--quiet", `refs/heads/${name}`);
		return true;
	} catch {
		return false;
	}
}

test("mainRootOf throws outside a git repository", (t) => {
	const dir = makeTmp(t, "wt-git-nonrepo-");
	assert.throws(() => mainRootOf(dir), /Not a git repository/);
});

test("mainRootOf returns the toplevel of a repo", (t) => {
	const repo = makeRepo(t);
	fs.mkdirSync(path.join(repo, "sub"));
	assert.equal(mainRootOf(path.join(repo, "sub")), repo);
});

test("mainRootOf throws inside a submodule", (t) => {
	const sub = makeRepo(t);
	const parent = makeRepo(t);
	git(parent, "-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "mod");
	assert.throws(() => mainRootOf(path.join(parent, "mod")), /Inside a submodule/);
});

test("mainRootOf returns the main checkout from inside a linked worktree", (t) => {
	const repo = makeRepo(t);
	const wt = path.join(makeTmp(t, "wt-git-linked-"), "wt");
	git(repo, "worktree", "add", "-q", "-b", "side", wt);
	fs.mkdirSync(path.join(wt, "sub"));
	assert.equal(mainRootOf(wt), repo);
	assert.equal(mainRootOf(path.join(wt, "sub")), repo);
});

test("launchWorktree is null outside a repo and in the main checkout", (t) => {
	assert.equal(launchWorktree(makeTmp(t, "wt-git-nonrepo-")), null);
	const repo = makeRepo(t);
	fs.mkdirSync(path.join(repo, "sub"));
	assert.equal(launchWorktree(repo), null);
	assert.equal(launchWorktree(path.join(repo, "sub")), null);
});

test("launchWorktree describes the linked worktree a cwd is in, and the main checkout", (t) => {
	const repo = makeRepo(t);
	const state = createWorktree(repo, "feat");
	fs.mkdirSync(path.join(state.root, "sub"));
	const head = git(state.root, "rev-parse", "HEAD").trim();
	assert.deepEqual(launchWorktree(path.join(state.root, "sub")), {
		worktree: { root: state.root, branch: "feat", mainRoot: repo, baseSha: head, managed: true },
		main: { root: repo, branch: "main", mainRoot: repo, baseSha: head, managed: false },
	});
});

test("launchWorktree marks worktrees outside .worktrees unmanaged and names a detached HEAD", (t) => {
	const repo = makeRepo(t);
	const wt = path.join(makeTmp(t, "wt-git-linked-"), "wt");
	git(repo, "worktree", "add", "-q", "--detach", wt);
	const launch = launchWorktree(wt);
	assert.equal(launch?.worktree.root, wt);
	assert.equal(launch?.worktree.managed, false);
	assert.equal(launch?.worktree.branch, "detached HEAD");
	assert.equal(launch?.main.root, repo);
});

test("validName accepts and rejects names", () => {
	assert.equal(validName("feat x"), false);
	assert.equal(validName("../evil"), false);
	assert.equal(validName("a..b"), false);
	assert.equal(validName(""), false);
	assert.equal(validName("-lead"), false);
	assert.equal(validName("feat-1.2"), true);
});

test("generateName produces a valid wt-<date>-<rand> name", () => {
	const name = generateName();
	assert.match(name, /^wt-\d{8}-[0-9a-z]{4}$/);
	assert.equal(validName(name), true);
});

test("managedDir is <mainRoot>/.worktrees", () => {
	assert.equal(managedDir("/a/my-repo"), "/a/my-repo/.worktrees");
});

test("createWorktree creates a worktree and branch; repeat throws exists", (t) => {
	const repo = makeRepo(t);
	const state = createWorktree(repo, "feat", "HEAD");
	assert.ok(fs.existsSync(state.root));
	assert.equal(state.branch, "feat");
	assert.equal(state.mainRoot, repo);
	assert.equal(state.managed, true);
	assert.equal(state.baseSha, git(repo, "rev-parse", "HEAD").trim());
	assert.equal(state.root, path.join(managedDir(repo), "feat"));
	const listed = listWorktrees(repo).map((w) => fs.realpathSync(w.path));
	assert.ok(listed.includes(fs.realpathSync(state.root)));
	assert.equal(listWorktrees(repo).find((w) => w.path === repo)?.branch, "main");
	assert.equal(listWorktrees(repo).find((w) => w.path === state.root)?.branch, "feat");
	assert.throws(() => createWorktree(repo, "feat", "HEAD"), /exists.*path/s);
});

test("createWorktree rejects invalid name and creates nothing", (t) => {
	const repo = makeRepo(t);
	for (const bad of ["../evil", "feat x"]) {
		assert.throws(() => createWorktree(repo, bad, "HEAD"), /A-Za-z0-9/);
	}
	assert.equal(branchExists(repo, "../evil"), false);
	assert.equal(branchExists(repo, "feat x"), false);
	assert.equal(fs.existsSync(managedDir(repo)), false);
	assert.equal(fs.existsSync(path.join(path.dirname(repo), "evil")), false);
	assert.equal(listWorktrees(repo).length, 1);
	assert.equal(commitCount(repo), 1, "no .gitignore commit for a rejected name");
});

test("createWorktree with pre-existing branch throws exists and creates no dir", (t) => {
	const repo = makeRepo(t);
	git(repo, "branch", "feat2");
	assert.throws(() => createWorktree(repo, "feat2", "HEAD"), /exists/);
	assert.equal(fs.existsSync(path.join(managedDir(repo), "feat2")), false);
	assert.equal(listWorktrees(repo).length, 1);
});

test("createWorktree with pre-existing directory throws exists and creates no branch", (t) => {
	const repo = makeRepo(t);
	fs.mkdirSync(path.join(managedDir(repo), "feat3"), { recursive: true });
	assert.throws(() => createWorktree(repo, "feat3", "HEAD"), /exists/);
	assert.equal(branchExists(repo, "feat3"), false);
});

test("worktreeStatus tracks dirty and new commits", (t) => {
	const repo = makeRepo(t);
	const state = createWorktree(repo, "feat", "HEAD");
	assert.deepEqual(worktreeStatus(state), { dirty: false, newCommits: 0, unmerged: false });
	fs.writeFileSync(path.join(state.root, "b.txt"), "b\n");
	assert.deepEqual(worktreeStatus(state), { dirty: true, newCommits: 0, unmerged: false });
	git(state.root, "add", ".");
	git(state.root, "commit", "-q", "-m", "work");
	assert.deepEqual(worktreeStatus(state), { dirty: false, newCommits: 1, unmerged: true });
});

test("worktreeStatus: new commits contained in another local branch are not unmerged", (t) => {
	const repo = makeRepo(t);
	const state = createWorktree(repo, "feat", "HEAD");
	fs.writeFileSync(path.join(state.root, "b.txt"), "b\n");
	git(state.root, "add", ".");
	git(state.root, "commit", "-q", "-m", "work");
	git(repo, "merge", "-q", "--ff-only", "feat");
	assert.deepEqual(worktreeStatus(state), { dirty: false, newCommits: 1, unmerged: false });
});

test("createWorktree with a base starting with - throws and creates nothing", (t) => {
	const repo = makeRepo(t);
	for (const bad of ["--orphan", "-q", "--detach"]) {
		assert.throws(() => createWorktree(repo, "feat", bad), Error, bad);
	}
	assert.equal(branchExists(repo, "feat"), false);
	assert.equal(fs.existsSync(managedDir(repo)), false);
	assert.equal(listWorktrees(repo).length, 1);
	assert.equal(commitCount(repo), 1, "no .gitignore commit for a rejected base");
});

test("createWorktree resolves a branch-name base to its commit", (t) => {
	const repo = makeRepo(t);
	const state = createWorktree(repo, "feat", "main");
	assert.equal(state.baseSha, git(repo, "rev-parse", "main").trim());
	assert.equal(git(state.root, "rev-parse", "HEAD").trim(), state.baseSha);
	assert.equal(git(state.root, "branch", "--show-current").trim(), "feat");
});

test("removeWorktree force removes dir and branch", (t) => {
	const repo = makeRepo(t);
	const state = createWorktree(repo, "feat", "HEAD");
	fs.writeFileSync(path.join(state.root, "b.txt"), "b\n");
	assert.deepEqual(removeWorktree(state, true), {});
	assert.equal(fs.existsSync(state.root), false);
	assert.equal(branchExists(repo, "feat"), false);
});

test("removeWorktree reports a branch-delete failure after the dir is gone", (t) => {
	const repo = makeRepo(t);
	const state = createWorktree(repo, "feat", "HEAD");
	git(state.root, "branch", "-m", "renamed");
	const result = removeWorktree(state, false);
	assert.equal(fs.existsSync(state.root), false);
	assert.match(result.branchError ?? "", /feat/);
	assert.equal(branchExists(repo, "renamed"), true);
});

test("removeWorktree without force fails on dirty tree and keeps branch", (t) => {
	const repo = makeRepo(t);
	const state = createWorktree(repo, "feat", "HEAD");
	fs.writeFileSync(path.join(state.root, "b.txt"), "b\n");
	git(state.root, "add", ".");
	assert.throws(() => removeWorktree(state, false));
	assert.ok(fs.existsSync(state.root));
	assert.equal(branchExists(repo, "feat"), true);
});

// ---- .worktrees/ placement and ignore (superpowers using-git-worktrees convention)

test("createWorktree puts the worktree in <repo>/.worktrees/<name>", (t) => {
	const repo = makeRepo(t);
	const state = createWorktree(repo, "feat");
	assert.equal(state.root, path.join(repo, ".worktrees", "feat"));
	assert.ok(fs.existsSync(path.join(state.root, "a.txt")));
});

test("createWorktree commits .worktrees/ to .gitignore when it is not ignored", (t) => {
	const repo = makeRepo(t);
	fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules/"); // no trailing newline
	git(repo, "add", ".gitignore");
	git(repo, "commit", "-q", "-m", "ignore");
	const state = createWorktree(repo, "feat");
	assert.equal(fs.readFileSync(path.join(repo, ".gitignore"), "utf8"), "node_modules/\n.worktrees/\n");
	assert.equal(git(repo, "log", "-1", "--format=%s").trim(), IGNORE_COMMIT_MESSAGE);
	assert.equal(git(repo, "show", "--name-only", "--format=", "HEAD").trim(), ".gitignore");
	assert.equal(state.ignoreCommit, git(repo, "rev-parse", "--short", "HEAD").trim());
	// base HEAD is resolved after the ignore commit, so the branch carries it
	assert.equal(state.baseSha, git(repo, "rev-parse", "HEAD").trim());
	assert.equal(git(repo, "status", "--porcelain").trim(), "", "main checkout stays clean");
});

test("createWorktree creates .gitignore when there is none", (t) => {
	const repo = makeRepo(t);
	const state = createWorktree(repo, "feat");
	assert.equal(fs.readFileSync(path.join(repo, ".gitignore"), "utf8"), ".worktrees/\n");
	assert.ok(state.ignoreCommit);
	assert.equal(git(repo, "status", "--porcelain").trim(), "");
});

test("no commit when .worktrees is already ignored, in any spelling", (t) => {
	for (const pattern of [".worktrees/", ".worktrees", "/.worktrees/", "**/.worktrees/"]) {
		const repo = makeRepo(t);
		fs.writeFileSync(path.join(repo, ".gitignore"), `${pattern}\n`);
		git(repo, "add", ".gitignore");
		git(repo, "commit", "-q", "-m", "ignore");
		const state = createWorktree(repo, "feat");
		assert.equal(state.ignoreCommit, null, pattern);
		assert.equal(commitCount(repo), 2, pattern);
	}
});

test("no commit when .worktrees is ignored through .git/info/exclude", (t) => {
	const repo = makeRepo(t);
	fs.appendFileSync(path.join(repo, ".git", "info", "exclude"), ".worktrees/\n");
	assert.equal(ensureIgnored(repo), null);
	assert.equal(commitCount(repo), 1);
});

test("ensureIgnored refuses when .gitignore has uncommitted changes", (t) => {
	const repo = makeRepo(t);
	fs.writeFileSync(path.join(repo, ".gitignore"), "dist/\n");
	git(repo, "add", ".gitignore");
	git(repo, "commit", "-q", "-m", "ignore");
	fs.writeFileSync(path.join(repo, ".gitignore"), "dist/\nbuild/\n");
	assert.throws(() => createWorktree(repo, "feat"), /uncommitted changes/);
	assert.equal(fs.readFileSync(path.join(repo, ".gitignore"), "utf8"), "dist/\nbuild/\n");
	assert.equal(commitCount(repo), 2);
	assert.equal(branchExists(repo, "feat"), false);
});

test("ensureIgnored commits .gitignore alone and leaves other staged work staged", (t) => {
	const repo = makeRepo(t);
	fs.writeFileSync(path.join(repo, "a.txt"), "changed\n");
	git(repo, "add", "a.txt");
	ensureIgnored(repo);
	assert.equal(git(repo, "show", "--name-only", "--format=", "HEAD").trim(), ".gitignore");
	assert.equal(git(repo, "diff", "--cached", "--name-only").trim(), "a.txt");
});

test("ensureIgnored restores .gitignore when the commit fails", (t) => {
	for (const existed of [true, false]) {
		const repo = makeRepo(t);
		if (existed) {
			fs.writeFileSync(path.join(repo, ".gitignore"), "dist/\n");
			git(repo, "add", ".gitignore");
			git(repo, "commit", "-q", "-m", "ignore");
		}
		const hook = path.join(repo, ".git", "hooks", "pre-commit");
		fs.writeFileSync(hook, "#!/bin/sh\necho hook says no >&2\nexit 1\n");
		fs.chmodSync(hook, 0o755);
		assert.throws(() => createWorktree(repo, "feat"), /hook says no/);
		if (existed) assert.equal(fs.readFileSync(path.join(repo, ".gitignore"), "utf8"), "dist/\n");
		else assert.equal(fs.existsSync(path.join(repo, ".gitignore")), false);
		assert.equal(git(repo, "status", "--porcelain").trim(), "", `existed=${existed}`);
		assert.equal(branchExists(repo, "feat"), false);
	}
});

test("listWorktrees reports each worktree's HEAD commit", (t) => {
	const repo = makeRepo(t);
	const created = createWorktree(repo, "feat");
	fs.writeFileSync(path.join(created.root, "b.txt"), "b\n");
	git(created.root, "add", ".");
	git(created.root, "commit", "-q", "-m", "b");
	const list = listWorktrees(repo);
	assert.equal(list.length, 2);
	for (const wt of list) assert.equal(wt.head, git(wt.path, "rev-parse", "HEAD").trim());
	assert.notEqual(list[0].head, list[1].head);
});

test("ensureWorktree creates branch and worktree for a new name", (t) => {
	const repo = makeRepo(t);
	const head = git(repo, "rev-parse", "HEAD").trim();
	fs.writeFileSync(path.join(repo, ".gitignore"), ".worktrees/\n");
	git(repo, "add", ".");
	git(repo, "commit", "-q", "-m", "ignore");
	const ensured = ensureWorktree(repo, "feat", head);
	assert.deepEqual(ensured, {
		root: path.join(repo, ".worktrees", "feat"),
		branch: "feat",
		mainRoot: repo,
		baseSha: head,
		managed: true,
		ignoreCommit: null,
		created: "branch",
	});
	assert.equal(git(ensured.root, "rev-parse", "HEAD").trim(), head);
});

/** Branch `feat` one commit ahead of main, with no worktree. */
function makeBranchWithoutWorktree(repo: string): string {
	fs.writeFileSync(path.join(repo, ".gitignore"), ".worktrees/\n");
	git(repo, "add", ".");
	git(repo, "commit", "-q", "-m", "ignore");
	git(repo, "branch", "feat");
	const tmp = path.join(repo, ".worktrees", "tmp");
	git(repo, "worktree", "add", "-q", tmp, "feat");
	fs.writeFileSync(path.join(tmp, "b.txt"), "b\n");
	git(tmp, "add", ".");
	git(tmp, "commit", "-q", "-m", "b");
	git(repo, "worktree", "remove", tmp);
	return git(repo, "rev-parse", "feat").trim();
}

test("ensureWorktree adds a worktree to an existing branch and ignores base", (t) => {
	const repo = makeRepo(t);
	const tip = makeBranchWithoutWorktree(repo);
	const ensured = ensureWorktree(repo, "feat", "main");
	assert.equal(ensured.created, "worktree");
	assert.equal(ensured.root, path.join(repo, ".worktrees", "feat"));
	assert.equal(ensured.managed, true);
	assert.equal(ensured.baseSha, tip);
	assert.equal(git(ensured.root, "rev-parse", "HEAD").trim(), tip);
	assert.notEqual(tip, git(repo, "rev-parse", "main").trim());
	assert.equal(git(ensured.root, "symbolic-ref", "--short", "HEAD").trim(), "feat");
});

test("ensureWorktree returns the worktree an existing branch already has", (t) => {
	const repo = makeRepo(t);
	const first = createWorktree(repo, "feat");
	const before = listWorktrees(repo).length;
	const ensured = ensureWorktree(repo, "feat");
	assert.equal(ensured.created, "none");
	assert.equal(ensured.root, first.root);
	assert.equal(ensured.managed, true);
	assert.equal(ensured.ignoreCommit, null);
	assert.equal(ensured.baseSha, git(first.root, "rev-parse", "HEAD").trim());
	assert.equal(listWorktrees(repo).length, before);
});

test("ensureWorktree marks an existing worktree outside .worktrees unmanaged", (t) => {
	const repo = makeRepo(t);
	const outside = path.join(makeTmp(t, "wt-git-outside-"), "wt");
	git(repo, "worktree", "add", "-q", "-b", "feat", outside);
	const ensured = ensureWorktree(repo, "feat");
	assert.equal(ensured.created, "none");
	assert.equal(ensured.root, outside);
	assert.equal(ensured.managed, false);
});

test("ensureWorktree refuses the branch checked out in the main checkout", (t) => {
	const repo = makeRepo(t);
	assert.throws(() => ensureWorktree(repo, "main"), /checked out in the main checkout/);
	assert.equal(listWorktrees(repo).length, 1);
});

test("ensureWorktree refuses when the directory exists for an existing branch without a worktree", (t) => {
	const repo = makeRepo(t);
	const tip = makeBranchWithoutWorktree(repo);
	fs.mkdirSync(path.join(repo, ".worktrees", "feat"), { recursive: true });
	assert.throws(() => ensureWorktree(repo, "feat"), /already exists/);
	assert.equal(git(repo, "rev-parse", "feat").trim(), tip);
	assert.equal(listWorktrees(repo).length, 1);
});

test("ensureWorktree rejects an invalid name", (t) => {
	const repo = makeRepo(t);
	assert.throws(() => ensureWorktree(repo, "../evil"), /Invalid worktree name/);
});

test("ensureWorktree commits .worktrees/ to .gitignore before adding a worktree to an existing branch", (t) => {
	const repo = makeRepo(t);
	git(repo, "branch", "feat");
	const before = commitCount(repo);
	const ensured = ensureWorktree(repo, "feat");
	assert.equal(ensured.created, "worktree");
	assert.ok(ensured.ignoreCommit);
	assert.equal(commitCount(repo), before + 1);
	assert.equal(git(repo, "status", "--porcelain").trim(), "");
});

test("ensureWorktree reports a worktree whose directory is gone", (t) => {
	const repo = makeRepo(t);
	const first = createWorktree(repo, "feat");
	fs.rmSync(first.root, { recursive: true, force: true });
	assert.throws(() => ensureWorktree(repo, "feat"), /git worktree prune/);
});
