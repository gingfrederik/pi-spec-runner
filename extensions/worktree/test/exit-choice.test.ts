import assert from "node:assert/strict";
import { test } from "node:test";
import { exitChoice, removalRisks } from "../exit-choice.ts";

const clean = { dirty: false, newCommits: 0, unmerged: false };
const dirty = { dirty: true, newCommits: 0, unmerged: false };
const merged = { dirty: false, newCommits: 2, unmerged: false };
const unmerged = { dirty: false, newCommits: 2, unmerged: true };

test("clean worktree without new commits is removed unless action is keep", () => {
	assert.equal(exitChoice(clean, undefined, false), "remove");
	assert.equal(exitChoice(clean, "remove", false), "remove");
	assert.equal(exitChoice(clean, "keep", true), "keep");
});

test("changes with no action: ask keep/remove with UI, keep without", () => {
	for (const status of [dirty, merged, unmerged]) {
		assert.equal(exitChoice(status, undefined, true), "ask");
		assert.equal(exitChoice(status, undefined, false), "keep");
		assert.equal(exitChoice(status, "keep", true), "keep");
	}
});

test("remove on dirty or unmerged work: confirm with UI, keep without", () => {
	for (const status of [dirty, unmerged, { ...unmerged, dirty: true }]) {
		assert.equal(exitChoice(status, "remove", true), "confirm");
		assert.equal(exitChoice(status, "remove", false), "keep");
	}
});

test("remove with merged commits only is removed without a prompt", () => {
	assert.equal(exitChoice(merged, "remove", false), "remove");
	assert.equal(exitChoice(merged, "remove", true), "remove");
});

test("removalRisks names what removal would lose", () => {
	assert.deepEqual(removalRisks(clean), []);
	assert.deepEqual(removalRisks(merged), []);
	assert.deepEqual(removalRisks(dirty), ["uncommitted changes"]);
	assert.deepEqual(removalRisks(unmerged), ["2 commits on no other branch"]);
	assert.deepEqual(removalRisks({ dirty: true, newCommits: 1, unmerged: true }), [
		"uncommitted changes",
		"1 commit on no other branch",
	]);
});
