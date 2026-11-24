import assert from "node:assert/strict";
import { test } from "node:test";
import { ENTRY_TYPE, inMain, latestState, restoreState } from "../state.ts";
import type { WorktreeState } from "../state.ts";

const first: WorktreeState = { root: "/w/one", branch: "one", mainRoot: "/main", baseSha: "aaa", managed: true };
const second: WorktreeState = { root: "/w/two", branch: "two", mainRoot: "/main", baseSha: "bbb", managed: false };

test("latestState returns the last worktree entry's data, ignoring other entries", () => {
	const entries = [
		{ type: "custom", customType: ENTRY_TYPE, data: first },
		{ type: "custom", customType: ENTRY_TYPE, data: second },
		{ type: "custom", customType: "other", data: { root: "/nope" } },
		{ type: "message", data: { root: "/nope" } },
	];
	assert.deepEqual(latestState(entries), second);
});

test("latestState ignores non-custom entries that carry the worktree customType", () => {
	const entries = [
		{ type: "custom", customType: ENTRY_TYPE, data: first },
		{ type: "message", customType: ENTRY_TYPE, data: second },
	];
	assert.deepEqual(latestState(entries), first);
});

test("latestState returns null when the last worktree entry has null data", () => {
	const entries = [
		{ type: "custom", customType: ENTRY_TYPE, data: first },
		{ type: "custom", customType: ENTRY_TYPE, data: null },
	];
	assert.equal(latestState(entries), null);
});

test("latestState returns null for no entries", () => {
	assert.equal(latestState([]), null);
});

test("restoreState keeps state whose root exists", () => {
	const entries = [{ type: "custom", customType: ENTRY_TYPE, data: first }];
	assert.deepEqual(restoreState(entries, () => true), { state: first });
});

test("restoreState drops state whose root no longer exists", () => {
	const entries = [{ type: "custom", customType: ENTRY_TYPE, data: first }];
	assert.deepEqual(restoreState(entries, () => false), { state: null, dropped: first });
});

test("inMain is true only for a state that points at the main checkout", () => {
	assert.equal(inMain(null), false);
	assert.equal(inMain(first), false);
	assert.equal(inMain({ ...first, root: "/main" }), true);
});

test("restoreState returns null state without checking existence when there is no state", () => {
	const result = restoreState([], () => {
		throw new Error("exists must not be called");
	});
	assert.deepEqual(result, { state: null });
});
