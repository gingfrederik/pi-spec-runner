import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeSearchOutput } from "../search-paths.ts";

const existing = new Set(["/t/b/top.txt", "/t/b/src/deep/y.ts", "/t/b/src", "/t/b", "/t"]);
const exists = (p: string) => existing.has(p);
const root = "/t/b";

test("grep path relative to the search dir is rewritten; indented match lines untouched", () => {
	const out = normalizeSearchOutput("deep/y.ts\n 1: export const NEEDLE_B = 1", {
		toolName: "grep",
		searchPath: "/t/b/src",
		root,
		exists,
	});
	assert.equal(out, "src/deep/y.ts\n 1: export const NEEDLE_B = 1");
});

test("grep path already relative to the root is unchanged", () => {
	const text = "src/deep/y.ts\n 1: x";
	assert.equal(normalizeSearchOutput(text, { toolName: "grep", searchPath: "/t/b/src", root, exists }), text);
});

test("fffind with a glob searchPath uses the deepest non-glob prefix", () => {
	const out = normalizeSearchOutput("deep/y.ts", {
		toolName: "fffind",
		searchPath: "/t/b/src/**/*.ts",
		root,
		exists,
	});
	assert.equal(out, "src/deep/y.ts");
});

test("notice lines and indented match lines are untouched; only the path line changes", () => {
	const text = '[0 exact matches. Maybe you meant this?]\ndeep/y.ts\n 1: x\n\n[Continue with cursor="3"]';
	const out = normalizeSearchOutput(text, { toolName: "ffgrep", searchPath: "/t/b/src", root, exists });
	assert.equal(out, '[0 exact matches. Maybe you meant this?]\nsrc/deep/y.ts\n 1: x\n\n[Continue with cursor="3"]');
});

test("find notice lines are untouched", () => {
	const text = "[Continue with cursor=\"3\"]";
	assert.equal(normalizeSearchOutput(text, { toolName: "find", searchPath: "/t/b/src", root, exists }), text);
});

test("unknown path line is unchanged", () => {
	assert.equal(
		normalizeSearchOutput("nope.ts", { toolName: "grep", searchPath: "/t/b/src", root, exists }),
		"nope.ts",
	);
});

test("trailing annotation after a two-space gap or ' (' is preserved", () => {
	const opts = { toolName: "fffind", searchPath: "/t/b/src", root, exists };
	assert.equal(normalizeSearchOutput("deep/y.ts  12 KB", opts), "src/deep/y.ts  12 KB");
	assert.equal(normalizeSearchOutput("deep/y.ts (modified)", opts), "src/deep/y.ts (modified)");
});

test("falls back to ancestors of the search path", () => {
	const out = normalizeSearchOutput("top.txt", { toolName: "find", searchPath: "/t/b/src/gone/**", root, exists });
	assert.equal(out, "top.txt");
	const out2 = normalizeSearchOutput("b/top.txt", { toolName: "find", searchPath: "/t/b/src/gone/**", root, exists });
	assert.equal(out2, "top.txt");
});

test("a file searchPath falls back to its parent directory", () => {
	const withDeepDir = (p: string) => p === "/t/b/src/deep" || exists(p);
	const out = normalizeSearchOutput("y.ts", {
		toolName: "grep",
		searchPath: "/t/b/src/deep/y.ts",
		root,
		exists: withDeepDir,
	});
	assert.equal(out, "src/deep/y.ts");
});

test("line separators are preserved exactly; empty input stays empty", () => {
	const opts = { toolName: "grep", searchPath: "/t/b/src", root, exists };
	assert.equal(normalizeSearchOutput("deep/y.ts\r\n 1: x\r\n", opts), "src/deep/y.ts\r\n 1: x\r\n");
	assert.equal(normalizeSearchOutput("", opts), "");
});

test("non-search tool names are returned unchanged", () => {
	const text = "deep/y.ts";
	assert.equal(normalizeSearchOutput(text, { toolName: "read", searchPath: "/t/b/src", root, exists }), text);
});
