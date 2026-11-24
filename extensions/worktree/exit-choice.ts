import type { WorktreeStatus } from "./git.ts";

export type ExitAction = "keep" | "remove" | undefined;

/**
 * What exit_worktree does with a managed worktree:
 * - "remove" / "keep": do it without asking;
 * - "ask": let the user pick keep or remove (`ctx.ui.select`);
 * - "confirm": the agent asked to remove work that removal would lose; confirm with the user.
 * Without UI every question resolves to "keep".
 */
export function exitChoice(status: WorktreeStatus, action: ExitAction, hasUI: boolean): "remove" | "keep" | "ask" | "confirm" {
	if (!status.dirty && status.newCommits === 0) return action === "keep" ? "keep" : "remove";
	if (action === "keep") return "keep";
	if (action === undefined) return hasUI ? "ask" : "keep";
	if (removalRisks(status).length === 0) return "remove";
	return hasUI ? "confirm" : "keep";
}

/** Work that removing the worktree and deleting its branch would lose. */
export function removalRisks(status: WorktreeStatus): string[] {
	const risks: string[] = [];
	if (status.dirty) risks.push("uncommitted changes");
	if (status.unmerged) risks.push(`${status.newCommits} commit${status.newCommits === 1 ? "" : "s"} on no other branch`);
	return risks;
}
