export const ENTRY_TYPE = "worktree";

export type WorktreeState = {
	root: string;
	branch: string;
	mainRoot: string;
	baseSha: string;
	managed: boolean;
};

/**
 * A state whose root is the main checkout: only used when pi was started inside a linked
 * worktree, to point tools back at the main checkout after exit_worktree. Nothing is guarded.
 */
export function inMain(state: WorktreeState | null): boolean {
	return state !== null && state.root === state.mainRoot;
}

type SessionEntryLike = { type: string; customType?: string; data?: unknown };

export function latestState(entries: SessionEntryLike[]): WorktreeState | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "custom" && entry.customType === ENTRY_TYPE) {
			return (entry.data as WorktreeState | null | undefined) ?? null;
		}
	}
	return null;
}

export function restoreState(
	entries: SessionEntryLike[],
	exists: (p: string) => boolean,
): { state: WorktreeState | null; dropped?: WorktreeState } {
	const state = latestState(entries);
	if (state && !exists(state.root)) return { state: null, dropped: state };
	return { state };
}
