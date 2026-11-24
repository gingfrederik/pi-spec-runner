import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
	cloneArgs,
	defaultRun,
	type FillReport,
	fillWorktree,
	formatFill,
	isLockFileName,
	lockFilesFor,
	orderCandidates,
	parseInclude,
	type Runner,
} from "../fill.ts";

const IDENT = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"];

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", [...IDENT, "-C", cwd, ...args], { stdio: "pipe" }).toString();
}

type T = { after: (fn: () => void) => void };

function makeTmp(t: T, prefix: string): string {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function write(root: string, rel: string, content: string): void {
	fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
	fs.writeFileSync(path.join(root, rel), content);
}

test("parseInclude keeps literal paths, strips a trailing slash, drops comments, blanks and duplicates", () => {
	const parsed = parseInclude("# c\n\nnode_modules/\nmodules/x/third_party\nnode_modules\n");
	assert.deepEqual(parsed.entries, ["node_modules", "modules/x/third_party"]);
	assert.deepEqual(parsed.rejected, []);
});

test("parseInclude rejects globs and paths that leave the worktree", () => {
	const parsed = parseInclude("*.log\n../x\n/abs/p\n!keep\na/../b\n");
	assert.deepEqual(parsed.entries, []);
	assert.deepEqual(
		parsed.rejected.map((r) => r.line),
		["*.log", "../x", "/abs/p", "!keep", "a/../b"],
	);
	const reasons = parsed.rejected.map((r) => r.reason);
	assert.match(reasons[0], /glob/);
	assert.match(reasons[1], /outside/);
	assert.match(reasons[2], /outside/);
	assert.match(reasons[3], /glob/);
	assert.match(reasons[4], /outside/);
});

test("isLockFileName recognises dependency lock files", () => {
	for (const name of [
		"package-lock.json",
		"yarn.lock",
		"bun.lockb",
		"pnpm-lock.yaml",
		"filament.lock.json",
		"npm-shrinkwrap.json",
	]) {
		assert.equal(isLockFileName(name), true, name);
	}
	for (const name of ["package.json", "lock.txt", "locker.json"]) {
		assert.equal(isLockFileName(name), false, name);
	}
});

test("lockFilesFor lists tracked lock files directly in the entry's parent directory", (t) => {
	const repo = makeTmp(t, "wt-fill-lock-");
	git(repo, "init", "-q", "-b", "main");
	write(repo, "package-lock.json", "{}\n");
	write(repo, "package.json", "{}\n");
	write(repo, "mod/sdk.lock.json", "{}\n");
	git(repo, "add", ".");
	git(repo, "commit", "-q", "-m", "init");
	write(repo, "stray.lock", "x\n");
	assert.deepEqual(lockFilesFor(repo, "node_modules"), ["package-lock.json"]);
	assert.deepEqual(lockFilesFor(repo, "mod/third_party"), ["mod/sdk.lock.json"]);
});

test("orderCandidates: same commit first, then the main checkout, then the rest; never the worktree itself", () => {
	const worktrees = [
		{ path: "/m", head: "a" },
		{ path: "/w1", head: "b" },
		{ path: "/new", head: "c" },
		{ path: "/w2", head: "c" },
	];
	assert.deepEqual(orderCandidates(worktrees, "/new", "c", "/m"), ["/w2", "/m", "/w1"]);
});

type RepoOptions = { include?: string | null; ignore?: string; lock?: string };

/** `<tmp>/repo` on `main`: tracked manifest, lock files and include file; untracked dependency dirs. */
function makeFillRepo(t: T, options: RepoOptions = {}): string {
	const repo = path.join(makeTmp(t, "wt-fill-repo-"), "repo");
	fs.mkdirSync(repo);
	git(repo, "init", "-q", "-b", "main");
	write(repo, ".gitignore", options.ignore ?? ".worktrees/\nnode_modules/\nsdk/\n");
	write(repo, "package.json", '{"name":"x"}\n');
	write(repo, options.lock ?? "package-lock.json", "v1\n");
	write(repo, "sdk.lock.json", "s1\n");
	const include = options.include === undefined ? "node_modules/\nsdk/\n" : options.include;
	if (include !== null) write(repo, ".worktreeinclude", include);
	git(repo, "add", ".");
	git(repo, "commit", "-q", "-m", "init");
	write(repo, "node_modules/marker", "from-main\n");
	write(repo, "sdk/blob", "sdk\n");
	return repo;
}

function newWorktree(repo: string, name: string): string {
	git(repo, "worktree", "add", "-q", "-b", name, path.join(".worktrees", name));
	return path.join(repo, ".worktrees", name);
}

type NpmCall = { args: string[]; cwd: string | undefined };

/** Answers `npm` with the given last stdout lines, in order (the last one repeats); runs everything else. */
function fakeNpm(lines: string | string[], code = 0): Runner & { calls: NpmCall[] } {
	const queue = Array.isArray(lines) ? [...lines] : [lines];
	const calls: NpmCall[] = [];
	const run = (async (cmd, args, opts) => {
		if (cmd !== "npm") return defaultRun(cmd, args, opts);
		calls.push({ args, cwd: opts.cwd });
		const line = queue.length > 1 ? (queue.shift() as string) : queue[0];
		return { code, stdout: `\n${line}\n\n`, stderr: "" };
	}) as Runner & { calls: NpmCall[] };
	run.calls = calls;
	return run;
}

const UP_TO_DATE = "up to date in 412ms";
const CHANGES = "added 1 package in 1s";

function lineFor(report: FillReport, entry: string) {
	const line = report.lines.find((l) => l.entry === entry);
	assert.ok(line, `no report line for ${entry}`);
	return line;
}

function exists(p: string): boolean {
	return fs.lstatSync(p, { throwIfNoEntry: false }) !== undefined;
}

function leftovers(repo: string, name: string): string[] {
	return fs.readdirSync(path.join(repo, ".git", "worktrees", name)).filter((f) => f.startsWith("wt-fill-"));
}

test("fillWorktree clones every listed path from the main checkout and validates node_modules", async (t) => {
	const repo = makeFillRepo(t);
	const wt = newWorktree(repo, "a");
	const run = fakeNpm(UP_TO_DATE);
	const report = await fillWorktree(repo, wt, { run });
	assert.equal(report.includeFile, path.join(wt, ".worktreeinclude"));
	assert.deepEqual(
		report.lines.map((l) => l.entry),
		["node_modules", "sdk"],
	);
	const nm = lineFor(report, "node_modules");
	// Review Focus 5: a `node_modules/` pattern with no destination on disk still counts as ignored.
	assert.notEqual(nm.status, "skipped");
	assert.equal(nm.status, "cloned");
	assert.equal(nm.detail, `from ${repo} (validated against package-lock.json)`);
	const sdk = lineFor(report, "sdk");
	assert.equal(sdk.status, "cloned");
	assert.equal(sdk.detail, `from ${repo} (not validated)`);
	assert.equal(fs.readFileSync(path.join(wt, "node_modules/marker"), "utf8"), "from-main\n");
	assert.equal(fs.readFileSync(path.join(wt, "sdk/blob"), "utf8"), "sdk\n");
	assert.deepEqual(leftovers(repo, "a"), []);
	assert.deepEqual(run.calls, [
		{ args: ["install", "--dry-run", "--ignore-scripts", "--no-audit", "--no-fund"], cwd: wt },
	]);
	assert.equal(git(wt, "status", "--porcelain").trim(), "");
});

test("fillWorktree does not clone node_modules when the lock file differs", async (t) => {
	const repo = makeFillRepo(t);
	const wt = newWorktree(repo, "a");
	write(wt, "package-lock.json", "v2\n");
	git(wt, "commit", "-q", "-am", "bump");
	const report = await fillWorktree(repo, wt, { run: fakeNpm(UP_TO_DATE) });
	const nm = lineFor(report, "node_modules");
	assert.equal(nm.status, "unfilled");
	assert.match(nm.detail, /matching lock files/);
	assert.equal(exists(path.join(wt, "node_modules")), false);
	// Every tracked lock file in the entry's parent directory counts, so `sdk` is held back too.
	assert.equal(lineFor(report, "sdk").status, "unfilled");
	assert.equal(exists(path.join(wt, "sdk")), false);
});

test("fillWorktree tries the next source when npm reports changes", async (t) => {
	const repo = makeFillRepo(t);
	const other = newWorktree(repo, "b");
	write(other, "node_modules/marker", "from-b\n");
	const wt = newWorktree(repo, "a");
	const run = fakeNpm([CHANGES, UP_TO_DATE]);
	const report = await fillWorktree(repo, wt, { run });
	const nm = lineFor(report, "node_modules");
	assert.equal(nm.status, "cloned");
	assert.equal(nm.detail, `from ${other} (validated against package-lock.json)`);
	assert.equal(fs.readFileSync(path.join(wt, "node_modules/marker"), "utf8"), "from-b\n");
	assert.equal(run.calls.length, 2);
	assert.deepEqual(leftovers(repo, "a"), []);
});

test("fillWorktree removes the clone when no source validates", async (t) => {
	const repo = makeFillRepo(t);
	const wt = newWorktree(repo, "a");
	const report = await fillWorktree(repo, wt, { run: fakeNpm(CHANGES) });
	const nm = lineFor(report, "node_modules");
	assert.equal(nm.status, "unfilled");
	assert.equal(nm.detail, `npm reports changes: ${CHANGES}`);
	assert.equal(exists(path.join(wt, "node_modules")), false);
	assert.deepEqual(leftovers(repo, "a"), []);
});

test("fillWorktree treats a non-zero npm exit as a failed validation", async (t) => {
	const repo = makeFillRepo(t);
	const wt = newWorktree(repo, "a");
	const report = await fillWorktree(repo, wt, { run: fakeNpm(UP_TO_DATE, 1) });
	assert.equal(lineFor(report, "node_modules").status, "unfilled");
	assert.equal(exists(path.join(wt, "node_modules")), false);
});

test("fillWorktree tries at most 3 sources per entry", async (t) => {
	const repo = makeFillRepo(t);
	for (const name of ["b", "c", "d"]) write(newWorktree(repo, name), "node_modules/marker", `${name}\n`);
	const wt = newWorktree(repo, "a");
	const run = fakeNpm(CHANGES);
	const report = await fillWorktree(repo, wt, { run });
	assert.equal(lineFor(report, "node_modules").status, "unfilled");
	assert.equal(run.calls.length, 3);
});

test("fillWorktree keeps a destination that already exists", async (t) => {
	const repo = makeFillRepo(t);
	const wt = newWorktree(repo, "a");
	write(wt, "node_modules/own", "mine\n");
	const run = fakeNpm(UP_TO_DATE);
	const report = await fillWorktree(repo, wt, { run });
	const nm = lineFor(report, "node_modules");
	assert.equal(nm.status, "kept");
	assert.equal(nm.detail, "already present");
	assert.equal(fs.readFileSync(path.join(wt, "node_modules/own"), "utf8"), "mine\n");
	assert.equal(exists(path.join(wt, "node_modules/marker")), false);
	assert.equal(run.calls.length, 0);
});

test("fillWorktree skips a path that is not git-ignored", async (t) => {
	const repo = makeFillRepo(t, { include: "scratch\n" });
	write(repo, "scratch/file", "x\n");
	const wt = newWorktree(repo, "a");
	const report = await fillWorktree(repo, wt, { run: fakeNpm(UP_TO_DATE) });
	const line = lineFor(report, "scratch");
	assert.equal(line.status, "skipped");
	assert.match(line.detail, /not git-ignored/);
	assert.equal(exists(path.join(wt, "scratch")), false);
});

test("fillWorktree reports no include file and clones nothing", async (t) => {
	const repo = makeFillRepo(t, { include: null });
	const wt = newWorktree(repo, "a");
	const report = await fillWorktree(repo, wt, { run: fakeNpm(UP_TO_DATE) });
	assert.deepEqual(report, { includeFile: null, lines: [] });
	assert.equal(exists(path.join(wt, "node_modules")), false);
});

test("fillWorktree falls back to the main checkout's include file", async (t) => {
	const repo = makeFillRepo(t, { include: null });
	write(repo, ".worktreeinclude", "sdk/\n");
	const wt = newWorktree(repo, "a");
	const report = await fillWorktree(repo, wt, { run: fakeNpm(UP_TO_DATE) });
	assert.equal(report.includeFile, path.join(repo, ".worktreeinclude"));
	assert.equal(lineFor(report, "sdk").status, "cloned");
	assert.equal(report.lines.length, 1);
});

test("fillWorktree never clones from a symlinked source (Review Focus 1)", async (t) => {
	const repo = makeFillRepo(t);
	fs.renameSync(path.join(repo, "node_modules"), path.join(repo, "..", "real_modules"));
	fs.symlinkSync(path.join(repo, "..", "real_modules"), path.join(repo, "node_modules"));
	const wt = newWorktree(repo, "a");
	const report = await fillWorktree(repo, wt, { run: fakeNpm(UP_TO_DATE) });
	const nm = lineFor(report, "node_modules");
	assert.equal(nm.status, "unfilled");
	assert.match(nm.detail, /no worktree has it/);
	assert.equal(exists(path.join(wt, "node_modules")), false);
});

test("fillWorktree rejects a line that leaves the worktree (Review Focus 2)", async (t) => {
	const repo = makeFillRepo(t, { include: "../escape\n" });
	write(path.dirname(repo), "escape/file", "x\n");
	const wt = newWorktree(repo, "a");
	const report = await fillWorktree(repo, wt, { run: fakeNpm(UP_TO_DATE) });
	const line = lineFor(report, "../escape");
	assert.equal(line.status, "skipped");
	assert.match(line.detail, /outside the worktree/);
	assert.deepEqual(fs.readdirSync(path.join(repo, ".worktrees")), ["a"]);
	assert.deepEqual(fs.readdirSync(path.dirname(repo)).sort(), ["escape", "repo"]);
});

test("fillWorktree skips an entry whose parent directory is not in this checkout (Review Focus 3)", async (t) => {
	const repo = makeFillRepo(t, { include: "mod/third_party\n", ignore: ".worktrees/\nmod/third_party/\n" });
	write(repo, "mod/third_party/blob", "x\n");
	const wt = newWorktree(repo, "a");
	const report = await fillWorktree(repo, wt, { run: fakeNpm(UP_TO_DATE) });
	const line = lineFor(report, "mod/third_party");
	assert.equal(line.status, "skipped");
	assert.match(line.detail, /not in this checkout/);
	assert.equal(exists(path.join(wt, "mod")), false);
});

test("fillWorktree reports an npm that cannot run and still resolves (Review Focus 4)", async (t) => {
	const repo = makeFillRepo(t);
	const wt = newWorktree(repo, "a");
	const run: Runner = async (cmd, args, opts) => {
		if (cmd === "npm") throw Object.assign(new Error("spawn npm ENOENT"), { code: "ENOENT" });
		return defaultRun(cmd, args, opts);
	};
	const report = await fillWorktree(repo, wt, { run });
	const nm = lineFor(report, "node_modules");
	assert.equal(nm.status, "unfilled");
	assert.match(nm.detail, /npm could not run: .*ENOENT/);
	assert.equal(exists(path.join(wt, "node_modules")), false);
	assert.equal(lineFor(report, "sdk").status, "cloned");
});

test("fillWorktree does not clone node_modules beside a non-npm lockfile", async (t) => {
	const repo = makeFillRepo(t, { lock: "yarn.lock" });
	const wt = newWorktree(repo, "a");
	const run = fakeNpm(UP_TO_DATE);
	const report = await fillWorktree(repo, wt, { run });
	const nm = lineFor(report, "node_modules");
	assert.equal(nm.status, "unfilled");
	assert.match(nm.detail, /only npm lockfiles/);
	assert.equal(exists(path.join(wt, "node_modules")), false);
	assert.equal(run.calls.length, 0);
});

test("fillWorktree copies nothing after an abort", async (t) => {
	const repo = makeFillRepo(t);
	const wt = newWorktree(repo, "a");
	const controller = new AbortController();
	controller.abort();
	const report = await fillWorktree(repo, wt, { run: fakeNpm(UP_TO_DATE), signal: controller.signal });
	assert.deepEqual(
		report.lines.map((l) => [l.entry, l.status, l.detail]),
		[
			["node_modules", "unfilled", "aborted"],
			["sdk", "unfilled", "aborted"],
		],
	);
	assert.equal(exists(path.join(wt, "node_modules")), false);
	assert.equal(exists(path.join(wt, "sdk")), false);
});

test("fillWorktree reports a failed copy and leaves nothing behind", async (t) => {
	const repo = makeFillRepo(t, { include: "sdk/\n" });
	const wt = newWorktree(repo, "a");
	const run: Runner = async (cmd, args, opts) => {
		if (cmd === "cp") return { code: 1, stdout: "", stderr: "cp: boom\n" };
		return defaultRun(cmd, args, opts);
	};
	const report = await fillWorktree(repo, wt, { run });
	const sdk = lineFor(report, "sdk");
	assert.equal(sdk.status, "unfilled");
	assert.equal(sdk.detail, "copy failed: cp: boom");
	assert.equal(exists(path.join(wt, "sdk")), false);
	assert.deepEqual(leftovers(repo, "a"), []);
});

test("cloneArgs picks the copy-on-write flags per platform", () => {
	assert.deepEqual(cloneArgs("darwin"), ["-cR"]);
	assert.deepEqual(cloneArgs("linux"), ["-R", "--reflink=auto"]);
	assert.equal(cloneArgs("win32"), null);
});

test("fillWorktree clones nothing on a platform without a clone command", async (t) => {
	const repo = makeFillRepo(t);
	const wt = newWorktree(repo, "a");
	const report = await fillWorktree(repo, wt, { run: fakeNpm(UP_TO_DATE), platform: "win32" });
	const sdk = lineFor(report, "sdk");
	assert.equal(sdk.status, "unfilled");
	assert.match(sdk.detail, /not supported on win32/);
	assert.equal(exists(path.join(wt, "sdk")), false);
});

test("fillWorktree resolves with unfilled lines when the worktree is not a git checkout", async (t) => {
	const repo = makeFillRepo(t);
	const plain = path.join(path.dirname(repo), "plain");
	write(plain, ".worktreeinclude", "sdk/\n");
	const report = await fillWorktree(repo, plain, { run: fakeNpm(UP_TO_DATE) });
	assert.equal(lineFor(report, "sdk").status, "unfilled");
	assert.equal(exists(path.join(plain, "sdk")), false);
});

const INSTALL_RULE =
	"Skip the install command only when the directory it creates is listed above as cloned and every other entry is cloned or skipped (parent directory is not in this checkout).";

test("formatFill lists each entry and when the install command can be skipped", () => {
	const report: FillReport = {
		includeFile: "/r/.worktreeinclude",
		lines: [
			{ entry: "node_modules", status: "cloned", detail: "from /r (validated against package-lock.json)" },
			{ entry: "sdk", status: "unfilled", detail: "no worktree has it with matching lock files" },
		],
	};
	assert.equal(
		formatFill(report),
		[
			"Dependency directories (/r/.worktreeinclude):",
			"- node_modules: cloned (from /r (validated against package-lock.json))",
			"- sdk: unfilled (no worktree has it with matching lock files)",
			INSTALL_RULE,
		].join("\n"),
	);
});

test("formatFill says so when there is no include file", () => {
	assert.equal(
		formatFill({ includeFile: null, lines: [] }),
		"No .worktreeinclude: nothing was cloned. Run the install command if this repo needs one.",
	);
});

test("formatFill gives the same install rule for an include file without entries", () => {
	assert.equal(
		formatFill({ includeFile: "/r/.worktreeinclude", lines: [] }),
		["Dependency directories (/r/.worktreeinclude):", INSTALL_RULE].join("\n"),
	);
});

// Finding 3: a postinstall `patch-package` changes node_modules, and npm's dry run cannot see it.
function withPatches(repo: string): void {
	write(repo, "patches/dep+1.0.0.patch", "p1\n");
	git(repo, "add", ".");
	git(repo, "commit", "-q", "-m", "patches");
}

test("fillWorktree clones node_modules when patches/ is identical", async (t) => {
	const repo = makeFillRepo(t);
	withPatches(repo);
	const wt = newWorktree(repo, "a");
	const report = await fillWorktree(repo, wt, { run: fakeNpm(UP_TO_DATE) });
	assert.equal(lineFor(report, "node_modules").status, "cloned");
});

test("fillWorktree does not clone node_modules from a worktree whose patches/ differs", async (t) => {
	const repo = makeFillRepo(t);
	withPatches(repo);
	const wt = newWorktree(repo, "a");
	write(wt, "patches/dep+1.0.0.patch", "p2\n");
	git(wt, "commit", "-q", "-am", "repatch");
	const run = fakeNpm(UP_TO_DATE);
	const report = await fillWorktree(repo, wt, { run });
	const nm = lineFor(report, "node_modules");
	assert.equal(nm.status, "unfilled");
	assert.equal(nm.detail, "no worktree has it with matching lock files and patches/");
	assert.equal(exists(path.join(wt, "node_modules")), false);
	assert.equal(run.calls.length, 0);
	// patches/ belongs to the npm install only: other entries are not held back.
	assert.equal(lineFor(report, "sdk").status, "cloned");
});

test("fillWorktree does not clone node_modules from a worktree with a patch this one lacks", async (t) => {
	const repo = makeFillRepo(t);
	const wt = newWorktree(repo, "a");
	write(repo, "patches/extra+1.0.0.patch", "p\n");
	const report = await fillWorktree(repo, wt, { run: fakeNpm(UP_TO_DATE) });
	assert.equal(lineFor(report, "node_modules").status, "unfilled");
	assert.equal(exists(path.join(wt, "node_modules")), false);
});

// Review Focus 1, second half: a symlinked source is passed over for the next real one.
test("fillWorktree passes over a symlinked source and clones from the next one", async (t) => {
	const repo = makeFillRepo(t);
	const other = newWorktree(repo, "b");
	write(other, "node_modules/marker", "from-b\n");
	fs.renameSync(path.join(repo, "node_modules"), path.join(repo, "..", "real_modules"));
	fs.symlinkSync(path.join(repo, "..", "real_modules"), path.join(repo, "node_modules"));
	const wt = newWorktree(repo, "a");
	const report = await fillWorktree(repo, wt, { run: fakeNpm(UP_TO_DATE) });
	const nm = lineFor(report, "node_modules");
	assert.equal(nm.status, "cloned");
	assert.equal(nm.detail, `from ${other} (validated against package-lock.json)`);
	assert.equal(fs.lstatSync(path.join(wt, "node_modules")).isSymbolicLink(), false);
	assert.equal(fs.readFileSync(path.join(wt, "node_modules/marker"), "utf8"), "from-b\n");
});
