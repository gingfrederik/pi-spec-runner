import os from "node:os";
import path from "node:path";
import { bashReadsOnly, hasDotDotPath, pathPattern, WORKTREE_MARK } from "./bash-read.ts";
import type { WorktreeState } from "./state.ts";

type GuardOptions = {
	canon?: (p: string) => string;
	mainAliases?: string[];
};

/**
 * Bash that points git at another repository or work tree. Read-only queries stay allowed:
 * `git rev-parse --git-dir` (option without a value) and a captured shell variable such as
 * the superpowers skills' `GIT_DIR=$(cd "$(git rev-parse --git-dir)" && pwd -P)`.
 */
const GIT_OVERRIDES = [
	// `--git-dir=x` / `--git-dir x`; a following redirection, operator or option is not a value.
	/--(?:git-dir|work-tree)(?:=|[ \t]+(?!\d*[<>]|[-;&|)]|$))/m,
	// Command-prefix assignment with a literal value: `GIT_DIR=x git log`, `env GIT_DIR=x git log`.
	/(?:^|[;&|(){}]|\benv[ \t])[ \t]*(?:\w+=\S*[ \t]+)*GIT_(?:DIR|WORK_TREE)=(?!["']?(?:\$\(|`))[^\s;&|]*[ \t]+[^\s;&|]/m,
	// `export GIT_DIR=x` with a literal value.
	/\bexport[ \t]+(?:\w+=\S*[ \t]+)*GIT_(?:DIR|WORK_TREE)=(?!["']?(?:\$\(|`))/,
];

function inside(child: string, parent: string): boolean {
	return child === parent || child.startsWith(parent + path.sep);
}

function expandHome(p: string): string {
	if (p === "~") return os.homedir();
	if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
	return p;
}

function itemCwds(items: unknown): unknown[] {
	if (!Array.isArray(items)) return [];
	return items.map((item) => (typeof item === "object" && item !== null ? (item as Record<string, unknown>).cwd : undefined));
}

/** pi-subagents cwds: top-level, `tasks[]`, `chain[]` and `chain[].parallel[]`. */
function subagentCwds(input: Record<string, unknown>): unknown[] {
	const cwds = [input.cwd, ...itemCwds(input.tasks), ...itemCwds(input.chain)];
	if (Array.isArray(input.chain)) {
		for (const step of input.chain) {
			if (typeof step === "object" && step !== null) cwds.push(...itemCwds((step as Record<string, unknown>).parallel));
		}
	}
	return cwds;
}

export function guardReason(
	toolName: string,
	input: Record<string, unknown>,
	state: WorktreeState,
	opts: GuardOptions = {},
): string | undefined {
	const { root, mainRoot } = state;
	const canon = opts.canon ?? ((p: string) => p);
	const reason = `Blocked: ${mainRoot} is the main checkout and is read-only while working in worktree ${root}. Use paths inside the worktree, or call exit_worktree first.`;
	const bashReason = `Blocked: ${mainRoot} is the main checkout and is read-only while working in worktree ${root}. Bash may only read it (cat, head, tail, ls, grep, rg, find, diff, shasum, sed without -i, git log/show/diff/status, cp from it into the worktree; no cd into it, no redirect into it). Use the read tool, paths inside the worktree, or call exit_worktree first.`;

	const blocksFile = (p: unknown): boolean => {
		if (typeof p !== "string") return false;
		const resolved = canon(path.resolve(root, expandHome(p)));
		return inside(resolved, mainRoot) && !inside(resolved, root);
	};

	if (toolName === "write" || toolName === "edit") {
		return blocksFile(input.path) ? reason : undefined;
	}
	if (toolName === "subagent") {
		return subagentCwds(input).some(blocksFile) ? reason : undefined;
	}
	const bashCommandReason = (command: unknown): string | undefined => {
		if (typeof command !== "string") return undefined;
		// Mark the worktree's own path, but only whole: `<root>-old` or a sibling `<root>y` stays.
		const marked = command.replace(pathPattern(root), WORKTREE_MARK);
		if (GIT_OVERRIDES.some((re) => re.test(marked))) return reason;
		const mains = [mainRoot, ...(opts.mainAliases ?? []).filter((alias) => alias !== "")];
		const mentions = mains.some((dir) => pathPattern(dir).test(marked));
		// Reading the main checkout is fine; anything that could write to it is not.
		// With the worktree inside the main checkout, `../../a` from the root reaches it too.
		if ((mentions || hasDotDotPath(marked)) && !bashReadsOnly(marked, mains, { root, mainRoot })) return bashReason;
		return undefined;
	};

	if (toolName === "bash") return bashCommandReason(input.command);
	if (toolName === "job_start") {
		// The job runs `command` in `cwd` (the worktree root after rewriting), so bash semantics hold.
		return blocksFile(input.cwd) ? reason : bashCommandReason(input.command);
	}
	return undefined;
}
