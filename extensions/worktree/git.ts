import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { WorktreeState } from "./state.ts";

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;

export function runGit(args: string[]): string {
	try {
		return execFileSync("git", args, { stdio: "pipe", maxBuffer: 64 << 20 }).toString();
	} catch (e) {
		const err = e as { stderr?: Buffer | string; message?: string };
		const stderr = err.stderr?.toString().trim();
		throw new Error(stderr || err.message || `git ${args.join(" ")} failed`);
	}
}

function toplevelOf(cwd: string): string {
	try {
		return runGit(["-C", cwd, "rev-parse", "--show-toplevel"]).trim();
	} catch {
		throw new Error("Not a git repository");
	}
}

/** The main checkout of the repo `cwd` is in, also from inside a linked worktree. */
export function mainRootOf(cwd: string): string {
	const toplevel = toplevelOf(cwd);
	if (runGit(["-C", cwd, "rev-parse", "--show-superproject-working-tree"]).trim()) {
		throw new Error("Inside a submodule");
	}
	// Every worktree shares the main checkout's `.git`; `--show-toplevel` names the worktree itself.
	const common = runGit(["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"]).trim();
	// A bare repository (or a separate git dir) has no main checkout next to it.
	if (path.basename(common) !== ".git") return toplevel;
	return fs.realpathSync.native(path.dirname(common));
}

function headOf(dir: string): { sha: string; branch: string } {
	let sha = "";
	try {
		sha = runGit(["-C", dir, "rev-parse", "--verify", "-q", "HEAD"]).trim();
	} catch {}
	let branch = "detached HEAD";
	try {
		branch = runGit(["-C", dir, "symbolic-ref", "--short", "-q", "HEAD"]).trim();
	} catch {}
	return { sha, branch };
}

export type LaunchWorktree = {
	/** The linked worktree pi was started in. */
	worktree: WorktreeState;
	/** A state whose root is the main checkout: tools run there after exit_worktree. */
	main: WorktreeState;
};

/** When `cwd` is inside a linked worktree (not the main checkout), describes it; otherwise null. */
export function launchWorktree(cwd: string): LaunchWorktree | null {
	let mainRoot: string;
	let root: string;
	try {
		mainRoot = mainRootOf(cwd);
		root = toplevelOf(cwd);
	} catch {
		return null;
	}
	if (root === mainRoot) return null;
	const wt = headOf(root);
	const main = headOf(mainRoot);
	const managed = root.startsWith(managedDir(mainRoot) + path.sep);
	return {
		worktree: { root, branch: wt.branch, mainRoot, baseSha: wt.sha, managed },
		main: { root: mainRoot, branch: main.branch, mainRoot, baseSha: main.sha, managed: false },
	};
}

export const WORKTREES_DIR = ".worktrees";
export const IGNORE_COMMIT_MESSAGE = "chore: ignore .worktrees";

/** New worktrees live in `<mainRoot>/.worktrees/<name>`, the superpowers using-git-worktrees default. */
export function managedDir(mainRoot: string): string {
	return path.join(mainRoot, WORKTREES_DIR);
}

function isIgnored(mainRoot: string): boolean {
	// The trailing slash matters: with a `.worktrees/` pattern and no directory on disk yet,
	// `git check-ignore .worktrees` reports "not ignored".
	try {
		runGit(["-C", mainRoot, "check-ignore", "-q", "--", `${WORKTREES_DIR}/`]);
		return true;
	} catch {
		return false;
	}
}

/**
 * Makes sure `.worktrees/` is git-ignored in the main checkout, like superpowers'
 * using-git-worktrees: if it is not, append it to `.gitignore` and commit that file alone.
 * Returns the new commit's sha, or null when nothing had to change. Refuses when `.gitignore`
 * already has uncommitted changes (they would land in the commit), and restores `.gitignore`
 * when the commit fails (e.g. a pre-commit hook).
 */
export function ensureIgnored(mainRoot: string): string | null {
	if (isIgnored(mainRoot)) return null;
	const file = path.join(mainRoot, ".gitignore");
	if (runGit(["-C", mainRoot, "status", "--porcelain", "--", ".gitignore"]).trim() !== "") {
		throw new Error(
			`${WORKTREES_DIR}/ is not git-ignored and ${file} has uncommitted changes. Commit or stash them, or add "${WORKTREES_DIR}/" to .gitignore yourself, then retry.`,
		);
	}
	const existed = fs.existsSync(file);
	const before = existed ? fs.readFileSync(file, "utf8") : "";
	const sep = before === "" || before.endsWith("\n") ? "" : "\n";
	fs.writeFileSync(file, `${before}${sep}${WORKTREES_DIR}/\n`);
	try {
		runGit(["-C", mainRoot, "add", "--", ".gitignore"]);
		runGit(["-C", mainRoot, "commit", "-q", "-m", IGNORE_COMMIT_MESSAGE, "--", ".gitignore"]);
	} catch (e) {
		if (existed) {
			fs.writeFileSync(file, before);
			try {
				runGit(["-C", mainRoot, "add", "--", ".gitignore"]);
			} catch {}
		} else {
			try {
				runGit(["-C", mainRoot, "rm", "-q", "--cached", "--ignore-unmatch", "--", ".gitignore"]);
			} catch {}
			fs.rmSync(file, { force: true });
		}
		throw new Error(`Could not commit "${WORKTREES_DIR}/" to ${file}: ${(e as Error).message}`);
	}
	return runGit(["-C", mainRoot, "rev-parse", "--short", "HEAD"]).trim();
}

export function validName(name: string): boolean {
	return NAME_PATTERN.test(name) && !name.includes("..");
}

export function generateName(): string {
	const now = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
	const rand = Math.floor(Math.random() * 36 ** 4)
		.toString(36)
		.padStart(4, "0");
	return `wt-${date}-${rand}`;
}

function branchExists(mainRoot: string, name: string): boolean {
	try {
		runGit(["-C", mainRoot, "show-ref", "--verify", "--quiet", `refs/heads/${name}`]);
		return true;
	} catch {
		return false;
	}
}

export type CreatedWorktree = WorktreeState & {
	/** Sha of the commit that added `.worktrees/` to `.gitignore`, when one was needed. */
	ignoreCommit: string | null;
};

function assertValidName(name: string): void {
	if (!validName(name)) {
		throw new Error(
			`Invalid worktree name "${name}". Names must match ${NAME_PATTERN.source} and must not contain "..".`,
		);
	}
}

export function createWorktree(mainRoot: string, name: string, base = "HEAD"): CreatedWorktree {
	assertValidName(name);
	const dir = path.join(managedDir(mainRoot), name);
	if (branchExists(mainRoot, name)) {
		throw new Error(
			`Branch "${name}" already exists. Use a different name, or pass \`path\` to enter an existing worktree.`,
		);
	}
	if (fs.existsSync(dir)) {
		throw new Error(
			`Directory ${dir} already exists. Use a different name, or pass \`path\` to enter an existing worktree.`,
		);
	}
	// --end-of-options + ^{commit}: a base like "--orphan" is a bad revision, never an option.
	const resolveBase = () =>
		runGit(["-C", mainRoot, "rev-parse", "--verify", "--end-of-options", `${base}^{commit}`]).trim();
	resolveBase(); // validate before ensureIgnored may commit
	const ignoreCommit = ensureIgnored(mainRoot);
	// Resolved again: with base HEAD the new worktree starts after the ignore commit.
	const baseSha = resolveBase();
	runGit(["-C", mainRoot, "worktree", "add", "-b", name, dir, baseSha]);
	return { root: dir, branch: name, mainRoot, baseSha, managed: true, ignoreCommit };
}

export type EnsuredWorktree = CreatedWorktree & {
	/** What this call created: the branch and its worktree, a worktree for an existing branch, or nothing. */
	created: "branch" | "worktree" | "none";
};

/**
 * A worktree for branch `name`, creating what is missing: branch and worktree from `base`, or a
 * worktree for an existing branch (`base` is then ignored). A branch that already has a worktree
 * gets that one back. Unlike `createWorktree`, an existing branch is not an error.
 */
export function ensureWorktree(mainRoot: string, name: string, base = "HEAD"): EnsuredWorktree {
	assertValidName(name);
	if (!branchExists(mainRoot, name)) return { ...createWorktree(mainRoot, name, base), created: "branch" };
	const real = (p: string) => fs.realpathSync.native(p);
	const existing = listWorktrees(mainRoot).find((wt) => wt.branch === name);
	if (existing) {
		if (!fs.existsSync(existing.path)) {
			throw new Error(
				`Branch "${name}" has a worktree at ${existing.path}, but that directory is gone. Run \`git worktree prune\` in ${mainRoot}, then retry.`,
			);
		}
		if (real(existing.path) === real(mainRoot)) {
			throw new Error(`Branch "${name}" is checked out in the main checkout (${mainRoot}); it needs no worktree.`);
		}
		const managed = real(existing.path).startsWith(managedDir(real(mainRoot)) + path.sep);
		const baseSha = existing.head ?? headOf(existing.path).sha;
		return { root: existing.path, branch: name, mainRoot, baseSha, managed, ignoreCommit: null, created: "none" };
	}
	const dir = path.join(managedDir(mainRoot), name);
	if (fs.existsSync(dir)) {
		throw new Error(`Directory ${dir} already exists and is not a worktree of branch "${name}". Remove it, then retry.`);
	}
	const ignoreCommit = ensureIgnored(mainRoot);
	runGit(["-C", mainRoot, "worktree", "add", dir, name]);
	const baseSha = runGit(["-C", mainRoot, "rev-parse", "--verify", `refs/heads/${name}`]).trim();
	return { root: dir, branch: name, mainRoot, baseSha, managed: true, ignoreCommit, created: "worktree" };
}

export type ListedWorktree = { path: string; branch: string | null; head: string | null };

export function listWorktrees(mainRoot: string): ListedWorktree[] {
	const out = runGit(["-C", mainRoot, "worktree", "list", "--porcelain"]);
	const result: ListedWorktree[] = [];
	for (const block of out.split(/\n\s*\n/)) {
		let wtPath: string | null = null;
		let branch: string | null = null;
		let head: string | null = null;
		for (const line of block.split("\n")) {
			if (line.startsWith("worktree ")) wtPath = line.slice("worktree ".length);
			else if (line.startsWith("HEAD ")) head = line.slice("HEAD ".length);
			else if (line.startsWith("branch ")) branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
		}
		if (wtPath !== null) result.push({ path: wtPath, branch, head });
	}
	return result;
}

export type WorktreeStatus = {
	dirty: boolean;
	newCommits: number;
	/** New commits whose HEAD no local branch other than `state.branch` contains: deleting that branch loses them. */
	unmerged: boolean;
};

export function worktreeStatus(state: WorktreeState): WorktreeStatus {
	const dirty = runGit(["-C", state.root, "status", "--porcelain"]).trim() !== "";
	const count = runGit(["-C", state.root, "rev-list", "--count", `${state.baseSha}..HEAD`]).trim();
	const newCommits = Number.parseInt(count, 10);
	let unmerged = false;
	if (newCommits > 0) {
		const head = runGit(["-C", state.root, "rev-parse", "--verify", "HEAD"]).trim();
		const containing = runGit(["-C", state.root, "for-each-ref", "--contains", head, "--format=%(refname)", "refs/heads/"])
			.split("\n")
			.filter((ref) => ref !== "" && ref !== `refs/heads/${state.branch}`);
		unmerged = containing.length === 0;
	}
	return { dirty, newCommits, unmerged };
}

/** Removes the worktree (throws if that fails), then its branch; a branch-delete failure is returned, not thrown. */
export function removeWorktree(state: WorktreeState, force: boolean): { branchError?: string } {
	const args = ["-C", state.mainRoot, "worktree", "remove"];
	if (force) args.push("--force");
	args.push(state.root);
	runGit(args);
	try {
		runGit(["-C", state.mainRoot, "branch", "-D", state.branch]);
		return {};
	} catch (e) {
		return { branchError: (e as Error).message };
	}
}
