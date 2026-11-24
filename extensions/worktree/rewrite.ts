import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SEARCH_TOOLS = new Set(["grep", "find", "ffgrep", "fffind"]);

export function shellQuote(s: string): string {
	return `'${s.replaceAll("'", "'\\''")}'`;
}

/** Pi turns `file://` URLs into paths (utils/paths.js normalizePath); an invalid URL is left for Pi to reject. */
function fromFileUrl(p: string): string {
	if (!p.startsWith("file://")) return p;
	try {
		return fileURLToPath(p);
	} catch {
		return p;
	}
}

/**
 * Paths that don't resolve against the cwd. Pi expands only `~` and `~/`, so `~name` is
 * relative. Unconvertible `file://` URLs are left alone rather than joined under the root.
 */
function isAnchored(p: string): boolean {
	return path.isAbsolute(p) || p === "~" || p.startsWith("~/") || p.startsWith("file://");
}

function expandHome(p: string): string {
	if (p === "~") return os.homedir();
	if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
	return p;
}

export function resolveIn(root: string, p: string): string {
	const stripped = fromFileUrl(p.startsWith("@") ? p.slice(1) : p);
	if (isAnchored(stripped)) return stripped;
	return path.resolve(root, stripped);
}

/** pi-subagents resolves cwd with `path.resolve(ctx.cwd, cwd)` and does not expand `~`. */
function resolveSubagentCwd(root: string, cwd: string): string {
	return expandHome(resolveIn(root, cwd));
}

function rewriteItemCwd(item: unknown, root: string): void {
	if (typeof item !== "object" || item === null) return;
	const record = item as Record<string, unknown>;
	if (typeof record.cwd === "string" && record.cwd !== "") {
		record.cwd = resolveSubagentCwd(root, record.cwd);
	}
}

function rewriteItemCwds(items: unknown, root: string): void {
	if (!Array.isArray(items)) return;
	for (const item of items) rewriteItemCwd(item, root);
}

export function rewriteInput(toolName: string, input: Record<string, unknown>, root: string): void {
	if (toolName === "read" || toolName === "write" || toolName === "edit") {
		if (typeof input.path === "string") input.path = resolveIn(root, input.path);
		return;
	}
	if (toolName === "bash") {
		// `|| exit 1` on its own line: if the cd fails, no part of a multi-command script runs in the launch dir.
		if (typeof input.command === "string") input.command = `cd -- ${shellQuote(root)} || exit 1\n${input.command}`;
		return;
	}
	if (SEARCH_TOOLS.has(toolName)) {
		if (typeof input.path !== "string" || input.path === "") input.path = root;
		else {
			const searchPath = fromFileUrl(input.path);
			input.path = isAnchored(searchPath) ? searchPath : path.join(root, searchPath);
		}
		return;
	}
	if (toolName === "job_start") {
		// The jobs extension runs the command in `cwd` itself; `path.resolve` there would not expand `~`.
		input.cwd = typeof input.cwd === "string" && input.cwd !== "" ? resolveSubagentCwd(root, input.cwd) : root;
		return;
	}
	if (toolName === "subagent") {
		// With `machine`, pi-subagents treats cwd as a folder on the remote machine.
		if (typeof input.cwd === "string" && input.cwd !== "") input.cwd = resolveSubagentCwd(root, input.cwd);
		else if (input.machine === undefined) input.cwd = root;
		rewriteItemCwds(input.tasks, root);
		rewriteItemCwds(input.chain, root);
		if (Array.isArray(input.chain)) {
			for (const step of input.chain) {
				if (typeof step === "object" && step !== null) {
					rewriteItemCwds((step as Record<string, unknown>).parallel, root);
				}
			}
		}
	}
}
