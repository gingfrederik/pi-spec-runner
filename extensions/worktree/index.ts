/**
 * Worktree — lets the agent move its work into a git worktree mid-session.
 *
 * Tools `enter_worktree` / `exit_worktree` set a WorktreeState; while it is set,
 * `tool_call` rewrites relative paths, bash commands and job_start cwds into the
 * worktree and guards the main checkout, `tool_result` makes search output
 * worktree-relative, and the system prompt's cwd section points at the worktree.
 * State is persisted as a "worktree" custom entry and broadcast on `worktree:changed`.
 *
 * Logic lives in the pure modules next to this file; this file only wires them
 * into Pi hooks.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	createLocalBashOperations,
	type ExtensionAPI,
	type ExtensionContext,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { canonPath, mainRootAliases } from "./canon.ts";
import { exitChoice, removalRisks } from "./exit-choice.ts";
import { fillWorktree, formatFill } from "./fill.ts";
import {
	createWorktree,
	ensureWorktree,
	generateName,
	type LaunchWorktree,
	launchWorktree,
	listWorktrees,
	mainRootOf,
	managedDir,
	removeWorktree,
	type WorktreeStatus,
	worktreeStatus,
} from "./git.ts";
import { guardReason } from "./guard.ts";
import { rewriteInput, SEARCH_TOOLS } from "./rewrite.ts";
import { normalizeSearchOutput } from "./search-paths.ts";
import { ENTRY_TYPE, inMain, latestState, restoreState, type WorktreeState } from "./state.ts";

let state: WorktreeState | null = null;
/**
 * Set when pi was started inside a linked worktree. That worktree is then the state by
 * default, and exit_worktree points tools at the main checkout (`launch.main`) instead of
 * clearing the state, since clearing it would leave them in the launch dir.
 */
let launch: LaunchWorktree | null = null;
/** Where exit_worktree goes: the main checkout, which is the launch dir unless pi started in a worktree. */
const home = () => launch?.main ?? null;

/**
 * Last state per session file, for `/clear` right after `/clear`: Pi writes a session file
 * only after its first user/assistant message (session-manager.js `_persist`), so the
 * previous session may have no file to read the state from. Kept on globalThis because
 * module state does not reliably survive session replacement: Pi caches the extension
 * factory per cwd but clears that cache on reload (extensions/loader.js
 * `clearExtensionCache`, `moduleCache: false`), which re-evaluates this module.
 */
const SESSION_STATES_KEY = Symbol.for("pi.worktree.sessionStates");
const globals = globalThis as { [SESSION_STATES_KEY]?: Map<string, WorktreeState | null> };
const sessionStates = (globals[SESSION_STATES_KEY] ??= new Map());
/** toolCallId → rewritten search path, for normalizing that call's output. */
const searchPaths = new Map<string, string>();

const realpath = (p: string) => fs.realpathSync.native(p);
const canon = (p: string) => canonPath(p, realpath);

function inside(child: string, parent: string): boolean {
	return child === parent || child.startsWith(parent + path.sep);
}

function expandHome(p: string): string {
	if (p === "~") return os.homedir();
	if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
	return p;
}

/** Result sentence for the commit `ensureIgnored` made, when it made one. */
function ignoreNote(mainRoot: string, ignoreCommit: string | null): string {
	return ignoreCommit ? `Added .worktrees/ to ${mainRoot}/.gitignore (commit ${ignoreCommit}).` : "";
}

function text(t: string) {
	return { content: [{ type: "text" as const, text: t }], details: undefined };
}

export default function (pi: ExtensionAPI) {
	const emitState = () => {
		pi.events.emit(
			"worktree:changed",
			state && { root: state.root, branch: state.branch, mainRoot: state.mainRoot, inMain: inMain(state) },
		);
	};
	let sessionFile: string | undefined;
	/** Sets the in-memory state without persisting it (restores from the session). */
	const useState = (s: WorktreeState | null) => {
		state = s;
		if (sessionFile) sessionStates.set(sessionFile, s);
		emitState();
	};
	const setState = (s: WorktreeState | null) => {
		pi.appendEntry(ENTRY_TYPE, s);
		useState(s);
	};

	async function enterExisting(
		mainRoot: string,
		requested: string,
		ctx: ExtensionContext,
	): Promise<WorktreeState> {
		const target = canon(path.resolve(state?.root ?? ctx.cwd, expandHome(requested)));
		const entry = listWorktrees(mainRoot).find((wt) => canon(wt.path) === target);
		if (!entry) throw new Error(`${requested} is not a worktree of ${mainRoot} (see git worktree list).`);
		if (canon(entry.path) === canon(mainRoot)) {
			throw new Error(`${entry.path} is the main checkout, not a worktree. Call exit_worktree to go back to it.`);
		}
		const managed = managedDir(mainRoot);
		const isLaunch = launch !== null && canon(entry.path) === canon(launch.worktree.root);
		if (!isLaunch && !inside(canon(entry.path), canon(managed))) {
			if (!ctx.hasUI) {
				throw new Error(`${entry.path} is outside ${managed}; entering it needs user confirmation, and no UI is available.`);
			}
			const ok = await ctx.ui.confirm(
				"Enter unmanaged worktree?",
				`${entry.path} was not created by enter_worktree. exit_worktree will leave it on disk.`,
			);
			if (!ok) throw new Error(`User declined entering ${entry.path}.`);
		}
		const baseSha = execFileSync("git", ["-C", entry.path, "rev-parse", "HEAD"], { stdio: "pipe" }).toString().trim();
		return { root: entry.path, branch: entry.branch ?? "detached HEAD", mainRoot, baseSha, managed: false };
	}

	pi.registerTool({
		name: "enter_worktree",
		label: "Enter worktree",
		executionMode: "sequential",
		description:
			"Move your work into a git worktree for the rest of the session. Creates a new worktree in <repo>/.worktrees/<name> (branch = name) from base (default HEAD), or enters an existing one by path. If .worktrees/ is not git-ignored, it is added to .gitignore and committed first. A new worktree gets the paths listed in the repo's .worktreeinclude cloned copy-on-write from another worktree and checked; the result lists each one. Afterwards relative paths, bash, search and subagents run in the worktree, and the main checkout is read-only until exit_worktree.",
		promptGuidelines: [
			"After enter_worktree, use relative paths; they resolve inside the worktree.",
			"Don't cd into or write to the main checkout while in a worktree; call exit_worktree first.",
			"While in a worktree, read main-checkout files with read, or with bash read commands (cat, head, ls, grep, rg, find, diff, shasum, git log/show/diff/status); cp from the main checkout into the worktree is allowed.",
		],
		parameters: Type.Object({
			name: Type.Optional(
				Type.String({ description: "Name for a new worktree and its branch. Omit for a generated name." }),
			),
			path: Type.Optional(Type.String({ description: "Path of an existing worktree to enter instead of creating one." })),
			base: Type.Optional(Type.String({ description: "Commit-ish to create the new worktree from. Default: HEAD." })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (params.name !== undefined && params.path !== undefined) {
				throw new Error("Pass either name (create a worktree) or path (enter an existing one), not both.");
			}
			const mainRoot = state?.mainRoot ?? mainRootOf(ctx.cwd);
			let next: WorktreeState;
			let ignored = "";
			let filled = "";
			if (params.path !== undefined) {
				next = await enterExisting(mainRoot, params.path, ctx);
			} else {
				const { ignoreCommit, ...created } = createWorktree(mainRoot, params.name ?? generateName(), params.base ?? "HEAD");
				next = created;
				if (ignoreCommit) ignored = ` ${ignoreNote(mainRoot, ignoreCommit)}`;
				filled = `\n${formatFill(await fillWorktree(mainRoot, created.root, { signal }))}`;
			}
			setState(next);
			return text(
				`Now working in ${next.root} (branch ${next.branch}).${ignored} Relative paths and bash commands now run there. Files in ${next.mainRoot} are read-only until exit_worktree.${filled}`,
			);
		},
	});

	pi.registerTool({
		name: "create_worktree",
		label: "Create worktree",
		executionMode: "sequential",
		description:
			"Create a git worktree for a branch without moving this session into it: <repo>/.worktrees/<name> (branch = name) from base (default HEAD of the main checkout). An existing branch gets a worktree, or its existing worktree is returned; base is then ignored. Paths listed in the repo's .worktreeinclude are cloned copy-on-write from another worktree and checked; the result lists each one.",
		promptGuidelines: [
			"Use create_worktree for a branch you will not work in yourself from this session (for example a worktree for another session); use enter_worktree to work in it.",
			"Create branch worktrees with create_worktree or enter_worktree, not with git worktree add, so dependency directories are cloned. Run the install command in a new worktree unless the tool result says it can be skipped.",
		],
		parameters: Type.Object({
			name: Type.String({ description: "Branch name, and the worktree's directory name under .worktrees/." }),
			base: Type.Optional(
				Type.String({
					description: "Commit-ish a new branch starts from. Default: HEAD of the main checkout. Ignored when the branch exists.",
				}),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const mainRoot = state?.mainRoot ?? mainRootOf(ctx.cwd);
			const ensured = ensureWorktree(mainRoot, params.name, params.base ?? "HEAD");
			const report = await fillWorktree(mainRoot, ensured.root, { signal });
			const outcome = { branch: "created", worktree: "added for the existing branch", none: "already existed" }[
				ensured.created
			];
			const lines = [
				`Worktree ${ensured.root} (branch ${ensured.branch}, HEAD ${ensured.baseSha.slice(0, 8)}): ${outcome}.`,
				ignoreNote(mainRoot, ensured.ignoreCommit),
				params.base !== undefined && ensured.created !== "branch" ? "base was ignored: the branch already existed." : "",
				formatFill(report),
			];
			return text(lines.filter((line) => line !== "").join("\n"));
		},
	});

	pi.registerTool({
		name: "exit_worktree",
		label: "Exit worktree",
		executionMode: "sequential",
		description:
			"Leave the current worktree and go back to the main checkout. A clean worktree without new commits is removed; otherwise action decides (keep or remove), asking the user when unset; removing uncommitted changes or commits on no other branch always needs user confirmation. Worktrees entered by path, and the worktree pi was started in, are never removed; when pi was started in a worktree, leaving it points tools at the main checkout. Without an active worktree this does nothing.",
		parameters: Type.Object({
			action: Type.Optional(
				StringEnum(["keep", "remove"] as const, { description: "Keep the worktree on disk, or remove it and its branch." }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const current = state;
			if (!current || inMain(current)) {
				return text(`No worktree is active; already working in ${current?.root ?? ctx.cwd}. Nothing changed.`);
			}
			const back = `Back in ${current.mainRoot}.`;

			if (!fs.existsSync(current.root)) {
				setState(home());
				return text(`Worktree ${current.root} no longer exists. ${back}`);
			}
			// Removing the dir pi runs in would break every later tool call (spawn needs an existing cwd).
			if (inside(canon(ctx.cwd), canon(current.root))) {
				setState(home());
				const note =
					params.action === "remove"
						? ` It was not removed: pi was started in it. Remove it later from the main checkout (git worktree remove ${current.root}).`
						: "";
				return text(`Left worktree ${current.root} (branch ${current.branch}); kept on disk.${note} ${back}`);
			}
			if (!current.managed) {
				setState(home());
				const note = params.action === "remove" ? " It was not created by enter_worktree, so it was not removed." : "";
				return text(`Left worktree ${current.root} (branch ${current.branch}); kept on disk.${note} ${back}`);
			}

			let status: WorktreeStatus;
			try {
				status = worktreeStatus(current);
			} catch (e) {
				setState(home());
				return text(
					`Could not read the status of ${current.root} (${(e as Error).message}), so it was kept on disk. ${back}`,
				);
			}
			const risks = removalRisks(status);
			const choice = exitChoice(status, params.action, ctx.hasUI);
			let remove = choice === "remove";
			if (choice === "ask") {
				remove = (await ctx.ui.select(`Worktree ${current.branch} has changes`, ["Keep", "Remove"])) === "Remove";
			} else if (choice === "confirm") {
				remove = await ctx.ui.confirm(
					"Remove worktree with unsaved work?",
					`${current.root} has ${risks.join(" and ")}. Remove it and branch ${current.branch}?`,
				);
			}

			if (!remove) {
				setState(home());
				const why =
					params.action === "remove" && risks.length > 0
						? ` Not removed: it has ${risks.join(" and ")}${ctx.hasUI ? " and the user declined" : ", and no UI is available to confirm"}.`
						: "";
				return text(`Kept worktree ${current.root} (branch ${current.branch}).${why} ${back}`);
			}
			let branchError: string | undefined;
			try {
				({ branchError } = removeWorktree(current, status.dirty));
			} catch (e) {
				if (fs.existsSync(current.root)) throw e;
				branchError = (e as Error).message;
			}
			setState(home());
			return text(
				branchError === undefined
					? `Removed worktree ${current.root} and branch ${current.branch}. ${back}`
					: `Removed worktree ${current.root}, but branch ${current.branch} may remain: ${branchError} ${back}`,
			);
		},
	});

	pi.on("tool_call", (event, ctx) => {
		if (!state) return;
		const { toolName } = event;
		if (toolName === "enter_worktree" || toolName === "exit_worktree") return;
		const input = event.input as Record<string, unknown>;
		if (inMain(state)) {
			// Pointing tools at the main checkout: rewrite only, nothing to guard.
			rewriteInput(toolName, input, state.root);
			if (SEARCH_TOOLS.has(toolName) && typeof input.path === "string") searchPaths.set(event.toolCallId, input.path);
			return;
		}
		const opts = { canon, mainAliases: mainRootAliases(state.mainRoot, ctx.cwd, realpath) };
		let reason: string | undefined;
		if (toolName === "bash") {
			reason = guardReason(toolName, input, state, opts);
			if (!reason) rewriteInput(toolName, input, state.root);
		} else {
			rewriteInput(toolName, input, state.root);
			reason = guardReason(toolName, input, state, opts);
		}
		if (reason) return { block: true, reason };
		if (SEARCH_TOOLS.has(toolName) && typeof input.path === "string") searchPaths.set(event.toolCallId, input.path);
	});

	pi.on("tool_result", (event) => {
		const searchPath = searchPaths.get(event.toolCallId);
		if (searchPath === undefined) return;
		searchPaths.delete(event.toolCallId);
		if (!state || !SEARCH_TOOLS.has(event.toolName)) return;
		const opts = { toolName: event.toolName, searchPath, root: state.root, exists: fs.existsSync };
		const content = event.content.map((part) =>
			part.type === "text" ? { ...part, text: normalizeSearchOutput(part.text, opts) } : part,
		);
		return { content };
	});

	pi.on("before_agent_start", (event) => {
		if (state) event.systemPromptOptions.cwd = state.root;
	});

	pi.on("user_bash", () => {
		if (!state) return;
		const root = state.root;
		const ops = createLocalBashOperations();
		return { operations: { ...ops, exec: (command, _cwd, options) => ops.exec(command, root, options) } };
	});

	const restoreFrom = (entries: Parameters<typeof restoreState>[0], ctx: ExtensionContext) => {
		const restored = restoreState(entries, fs.existsSync);
		if (restored.dropped) {
			ctx.ui.notify(
				`Worktree ${restored.dropped.root} no longer exists; working in ${restored.dropped.mainRoot}`,
				"warning",
			);
		}
		return restored.state;
	};

	pi.on("session_start", (event, ctx) => {
		sessionFile = ctx.sessionManager.getSessionFile();
		launch = launchWorktree(ctx.cwd);
		let entries: Parameters<typeof restoreState>[0] = ctx.sessionManager.getBranch();
		let fromPrevious = false;
		const previous = event.previousSessionFile;
		if (event.reason === "new" && latestState(entries) === null && previous) {
			if (fs.existsSync(previous)) {
				entries = SessionManager.open(previous).getBranch();
				fromPrevious = true;
			} else if (sessionStates.has(previous)) {
				entries = [{ type: "custom", customType: ENTRY_TYPE, data: sessionStates.get(previous) }];
				fromPrevious = true;
			}
		}
		const restored = restoreFrom(entries, ctx);
		searchPaths.clear();
		if (fromPrevious && restored) setState(restored);
		else useState(restored ?? launch?.worktree ?? null);
	});

	// /tree moves the leaf; the worktree is whatever the new branch last recorded.
	pi.on("session_tree", (_event, ctx) => {
		useState(restoreFrom(ctx.sessionManager.getBranch(), ctx) ?? launch?.worktree ?? null);
	});

	pi.events.on("worktree:query", () => emitState());
}
