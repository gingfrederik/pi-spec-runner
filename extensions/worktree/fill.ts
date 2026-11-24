import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { listWorktrees, runGit } from "./git.ts";

export const INCLUDE_FILE = ".worktreeinclude";

export type ParsedInclude = {
	entries: string[];
	rejected: Array<{ line: string; reason: string }>;
};

/**
 * Parses `.worktreeinclude`: one literal path per line, relative to the repo root. `#` starts a
 * comment line and a trailing `/` is optional. Patterns and paths that leave the worktree are
 * rejected with a reason, never used.
 */
export function parseInclude(text: string): ParsedInclude {
	const entries: string[] = [];
	const rejected: ParsedInclude["rejected"] = [];
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (line === "" || line.startsWith("#")) continue;
		if (/[*?[]/.test(line) || line.startsWith("!")) {
			rejected.push({ line, reason: "glob patterns are not supported" });
			continue;
		}
		const segments = line.split("/");
		if (path.isAbsolute(line) || segments.includes("..")) {
			rejected.push({ line, reason: "path is outside the worktree" });
			continue;
		}
		const entry = segments.filter((s) => s !== "" && s !== ".").join("/");
		if (entry === "") {
			rejected.push({ line, reason: "path is the worktree itself" });
			continue;
		}
		if (!entries.includes(entry)) entries.push(entry);
	}
	return { entries, rejected };
}

const LOCK_NAME = /(\.lock|\.lockb|-lock\.json|-lock\.yaml|\.lock\.json)$/;

export function isLockFileName(name: string): boolean {
	return name === "npm-shrinkwrap.json" || LOCK_NAME.test(name);
}

/** Repo-relative paths of the tracked lock files directly inside `entry`'s parent directory. */
export function lockFilesFor(root: string, entry: string): string[] {
	const parent = path.posix.dirname(entry);
	// `:(glob)`: `*` does not cross a `/`, so only the parent directory's own files match.
	const spec = parent === "." ? ":(glob)*" : `:(glob)${parent}/*`;
	return runGit(["-C", root, "ls-files", "-z", "--", spec])
		.split("\0")
		.filter((file) => file !== "" && isLockFileName(path.posix.basename(file)))
		.sort();
}

/**
 * Worktrees to try as a source for `root`, best first: those at the same commit, then the main
 * checkout, then the rest in list order.
 */
export function orderCandidates(
	worktrees: Array<{ path: string; head: string | null }>,
	root: string,
	head: string,
	mainRoot: string,
): string[] {
	const others = worktrees.filter((wt) => wt.path !== root);
	const rank = (wt: { path: string; head: string | null }) => (wt.head === head ? 0 : wt.path === mainRoot ? 1 : 2);
	return others
		.map((wt, index) => ({ wt, index }))
		.sort((a, b) => rank(a.wt) - rank(b.wt) || a.index - b.index)
		.map(({ wt }) => wt.path);
}

export type FillStatus = "cloned" | "kept" | "skipped" | "unfilled";
export type FillLine = { entry: string; status: FillStatus; detail: string };
export type FillReport = {
	/** The `.worktreeinclude` that was read, or null when neither the worktree nor the main checkout has one. */
	includeFile: string | null;
	lines: FillLine[];
};

/** Resolves with the exit code of a command that ran; rejects when it cannot be started or is aborted. */
export type Runner = (
	cmd: string,
	args: string[],
	opts: { cwd?: string; signal?: AbortSignal },
) => Promise<{ code: number; stdout: string; stderr: string }>;

export const defaultRun: Runner = (cmd, args, opts) =>
	new Promise((resolve, reject) => {
		execFile(cmd, args, { cwd: opts.cwd, signal: opts.signal, maxBuffer: 64 << 20 }, (err, stdout, stderr) => {
			if (!err) return resolve({ code: 0, stdout, stderr });
			const code = (err as { code?: unknown }).code;
			if (typeof code === "number") return resolve({ code, stdout, stderr });
			reject(err);
		});
	});

/** `cp` flags that clone copy-on-write where the file system can, or null when this platform has none. */
export function cloneArgs(platform: NodeJS.Platform): string[] | null {
	if (platform === "darwin") return ["-cR"];
	if (platform === "linux") return ["-R", "--reflink=auto"];
	return null;
}

const MAX_SOURCES = 3;
const NPM_LOCK = "package-lock.json";
/**
 * patch-package's directory, beside package.json. A `postinstall` applies it to node_modules, and
 * the dry run below (`--ignore-scripts`, metadata only) cannot see whether that happened, so a
 * source must hold the same patches as the new worktree.
 */
const PATCHES_DIR = "patches";
/** Writes nothing; its last stdout line is `up to date …` only when node_modules matches the lockfile. */
const NPM_CHECK = ["install", "--dry-run", "--ignore-scripts", "--no-audit", "--no-fund"];

const lstat = (p: string) => fs.lstatSync(p, { throwIfNoEntry: false });
const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).trim();
const lastLine = (out: string) =>
	out
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l !== "")
		.pop() ?? "";

function sameFile(a: string, b: string): boolean {
	try {
		return fs.readFileSync(a).equals(fs.readFileSync(b));
	} catch {
		return false;
	}
}

/** True when both paths are missing, or hold the same files with the same bytes (and the same symlink targets). */
function sameTree(a: string, b: string): boolean {
	const [statA, statB] = [lstat(a), lstat(b)];
	if (!statA || !statB) return !statA && !statB;
	if (statA.isDirectory() && statB.isDirectory()) {
		const names = fs.readdirSync(a).sort();
		const other = fs.readdirSync(b).sort();
		return (
			names.length === other.length &&
			names.every((name, i) => name === other[i] && sameTree(path.join(a, name), path.join(b, name)))
		);
	}
	if (statA.isSymbolicLink() && statB.isSymbolicLink()) return fs.readlinkSync(a) === fs.readlinkSync(b);
	return statA.isFile() && statB.isFile() && sameFile(a, b);
}

function isIgnored(root: string, pathspec: string): boolean {
	try {
		runGit(["-C", root, "check-ignore", "-q", "--", pathspec]);
		return true;
	} catch {
		return false;
	}
}

type Attempt = { ok: true; note: string } | { ok: false; reason: string; stop?: boolean };

/**
 * Fills a new worktree's dependency directories: each path listed in `.worktreeinclude` is cloned
 * copy-on-write from another worktree whose lock files are byte-identical, and a `node_modules`
 * clone is kept only when npm's dry run reports it up to date. Never throws: every entry gets a
 * report line, and a failure is an `unfilled` line.
 */
export async function fillWorktree(
	mainRoot: string,
	root: string,
	opts: { run?: Runner; signal?: AbortSignal; platform?: NodeJS.Platform } = {},
): Promise<FillReport> {
	const run = opts.run ?? defaultRun;
	const signal = opts.signal;
	const platform = opts.platform ?? process.platform;

	let includeFile: string | null = null;
	let parsed: ParsedInclude;
	try {
		includeFile =
			[root, mainRoot].map((dir) => path.join(dir, INCLUDE_FILE)).find((file) => fs.statSync(file, { throwIfNoEntry: false })?.isFile()) ??
			null;
		if (includeFile === null) return { includeFile: null, lines: [] };
		parsed = parseInclude(fs.readFileSync(includeFile, "utf8"));
	} catch {
		return { includeFile: null, lines: [] };
	}

	let candidates: string[];
	let gitDir: string;
	try {
		const real = (p: string) => fs.realpathSync.native(p);
		const worktrees = listWorktrees(mainRoot).flatMap((wt) => {
			try {
				return [{ path: real(wt.path), head: wt.head }];
			} catch {
				return []; // its directory is gone (a prunable worktree)
			}
		});
		const head = runGit(["-C", root, "rev-parse", "--verify", "HEAD"]).trim();
		candidates = orderCandidates(worktrees, real(root), head, real(mainRoot));
		// Under the worktree's own git dir: never in `git status`, and `git worktree remove` deletes it.
		gitDir = runGit(["-C", root, "rev-parse", "--absolute-git-dir"]).trim();
	} catch (e) {
		const detail = `could not inspect the worktree: ${message(e)}`;
		return { includeFile, lines: parsed.entries.map((entry) => ({ entry, status: "unfilled", detail })) };
	}

	const clone = async (source: string, entry: string, args: string[]): Promise<Attempt> => {
		const dest = path.join(root, entry);
		const validated = path.basename(entry) === "node_modules";
		const tmp = fs.mkdtempSync(path.join(gitDir, "wt-fill-"));
		try {
			const staged = path.join(tmp, path.basename(entry));
			try {
				const copied = await run("cp", [...args, path.join(source, entry), staged], { signal });
				if (copied.code !== 0) {
					return { ok: false, reason: `copy failed: ${lastLine(copied.stderr) || `cp exited ${copied.code}`}` };
				}
				// A rename, so an interrupted copy never leaves a partial directory under the real name.
				fs.renameSync(staged, dest);
			} catch (e) {
				return signal?.aborted ? { ok: false, reason: "aborted" } : { ok: false, reason: `copy failed: ${message(e)}` };
			}
			if (!validated) return { ok: true, note: "not validated" };
			let failure: Attempt;
			try {
				const checked = await run("npm", NPM_CHECK, { cwd: path.dirname(dest), signal });
				const last = lastLine(checked.stdout);
				if (checked.code === 0 && last.startsWith("up to date")) {
					return { ok: true, note: `validated against ${NPM_LOCK}` };
				}
				failure =
					checked.code === 0
						? { ok: false, reason: `npm reports changes: ${last}` }
						: {
								ok: false,
								reason: `npm could not run: exit code ${checked.code} (${lastLine(checked.stderr) || last})`,
							};
			} catch (e) {
				// Without a working npm no other source can be validated either.
				failure = signal?.aborted
					? { ok: false, reason: "aborted" }
					: { ok: false, reason: `npm could not run: ${message(e)}`, stop: true };
			}
			await fs.promises.rm(dest, { recursive: true, force: true });
			return failure;
		} finally {
			await fs.promises.rm(tmp, { recursive: true, force: true });
		}
	};

	const fill = async (entry: string): Promise<FillLine> => {
		const dest = path.join(root, entry);
		if (lstat(dest)) return { entry, status: "kept", detail: "already present" };
		if (!fs.statSync(path.dirname(dest), { throwIfNoEntry: false })?.isDirectory()) {
			return { entry, status: "skipped", detail: "parent directory is not in this checkout" };
		}
		const locks = lockFilesFor(root, entry);
		const npm = path.basename(entry) === "node_modules";
		if (npm && !locks.some((f) => path.posix.basename(f) === NPM_LOCK)) {
			return { entry, status: "unfilled", detail: "only npm lockfiles are validated in this version" };
		}
		const patches = path.join(path.dirname(entry), PATCHES_DIR);
		// lstat: a symlinked source (`ln -s ../../node_modules`) is someone else's directory, never cloned.
		const usable = (dir: string) => {
			const stat = lstat(path.join(dir, entry));
			if (!stat || !(stat.isDirectory() || stat.isFile())) return false;
			if (!locks.every((lock) => sameFile(path.join(dir, lock), path.join(root, lock)))) return false;
			return !npm || sameTree(path.join(dir, patches), path.join(root, patches));
		};
		const sources = candidates.filter(usable);
		if (sources.length === 0) {
			const what = npm ? `lock files and ${PATCHES_DIR}/` : "lock files";
			return { entry, status: "unfilled", detail: `no worktree has it with matching ${what}` };
		}
		// The trailing slash matters: a `node_modules/` pattern does not match a path that is not on disk yet.
		const isDir = lstat(path.join(sources[0], entry))?.isDirectory();
		if (!isIgnored(root, isDir ? `${entry}/` : entry)) {
			return { entry, status: "skipped", detail: "not git-ignored" };
		}
		const args = cloneArgs(platform);
		if (args === null) return { entry, status: "unfilled", detail: `cloning is not supported on ${platform}` };
		let reason = "";
		for (const source of sources.slice(0, MAX_SOURCES)) {
			if (signal?.aborted) return { entry, status: "unfilled", detail: "aborted" };
			const attempt = await clone(source, entry, args);
			if (attempt.ok) return { entry, status: "cloned", detail: `from ${source} (${attempt.note})` };
			reason = attempt.reason;
			if (attempt.stop) break;
		}
		return { entry, status: "unfilled", detail: reason };
	};

	const lines: FillLine[] = [];
	for (const entry of parsed.entries) {
		try {
			lines.push(await fill(entry));
		} catch (e) {
			lines.push({ entry, status: "unfilled", detail: message(e) });
		}
	}
	for (const { line, reason } of parsed.rejected) lines.push({ entry: line, status: "skipped", detail: reason });
	return { includeFile, lines };
}

/**
 * The report as tool-result text. The last line is the one rule for skipping an install: a `kept`
 * directory was not checked, and a path that is not listed was not cloned. spec-runner's SKILL.md
 * restates it as "warm" and keys on `cloned`, `unfilled`, `kept` and `No .worktreeinclude`.
 */
export function formatFill(report: FillReport): string {
	if (report.includeFile === null) {
		return `No ${INCLUDE_FILE}: nothing was cloned. Run the install command if this repo needs one.`;
	}
	return [
		`Dependency directories (${report.includeFile}):`,
		...report.lines.map((line) => `- ${line.entry}: ${line.status} (${line.detail})`),
		"Skip the install command only when the directory it creates is listed above as cloned and every other entry is cloned or skipped (parent directory is not in this checkout).",
	].join("\n");
}
