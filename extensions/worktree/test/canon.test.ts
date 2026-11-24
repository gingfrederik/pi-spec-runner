import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { canonPath, mainRootAliases } from "../canon.ts";

// Fake filesystem: /tmp is a symlink to /private/tmp; /private/tmp/repo exists.
const existing = new Set(["/", "/private", "/private/tmp", "/private/tmp/repo", "/private/tmp/repo/sub"]);
function fakeRealpath(p: string): string {
	const real = p === "/tmp" || p.startsWith("/tmp/") ? `/private${p}` : p;
	if (!existing.has(real)) throw new Error(`ENOENT: ${p}`);
	return real;
}

test("canonPath resolves a symlinked existing path", () => {
	assert.equal(canonPath("/tmp/repo", fakeRealpath), "/private/tmp/repo");
});

test("canonPath re-joins missing segments onto the deepest existing ancestor", () => {
	assert.equal(canonPath("/tmp/repo/new/evil.txt", fakeRealpath), "/private/tmp/repo/new/evil.txt");
});

test("canonPath normalizes .. before resolving", () => {
	assert.equal(canonPath("/tmp/repo/sub/../x.txt", fakeRealpath), "/private/tmp/repo/x.txt");
});

test("canonPath never throws and falls back to the resolved input", () => {
	const failing = () => {
		throw new Error("boom");
	};
	assert.equal(canonPath("/a/b/../c", failing), "/a/c");
});

test("canonPath on the real filesystem follows a symlink to a missing file", (t) => {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canon-")));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	fs.mkdirSync(path.join(dir, "real"));
	fs.symlinkSync(path.join(dir, "real"), path.join(dir, "link"));
	assert.equal(canonPath(path.join(dir, "link", "a", "b.txt"), fs.realpathSync.native), path.join(dir, "real", "a", "b.txt"));
});

test("mainRootAliases adds the un-/private spelling when it resolves to mainRoot", () => {
	assert.deepEqual(mainRootAliases("/private/tmp/repo", "/private/tmp/repo", fakeRealpath), ["/tmp/repo"]);
});

test("mainRootAliases adds the cwd's spelling of the main root", () => {
	assert.deepEqual(mainRootAliases("/private/tmp/repo", "/tmp/repo/sub", fakeRealpath), ["/tmp/repo"]);
});

test("mainRootAliases is empty when mainRoot has no other spelling", () => {
	const identity = (p: string) => p;
	assert.deepEqual(mainRootAliases("/u/repo", "/u/repo/src", identity), []);
});

test("mainRootAliases skips a /private-less path that is not the same directory", () => {
	const identity = (p: string) => p;
	assert.deepEqual(mainRootAliases("/private/var/repo", "/private/var/repo", identity), []);
});
