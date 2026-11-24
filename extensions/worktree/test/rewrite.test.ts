import assert from "node:assert/strict";
import os from "node:os";
import { test } from "node:test";
import { SEARCH_TOOLS, resolveIn, rewriteInput, shellQuote } from "../rewrite.ts";

const root = "/w/my repo/o'k";

test("SEARCH_TOOLS lists the four search tools", () => {
	assert.deepEqual([...SEARCH_TOOLS].sort(), ["fffind", "ffgrep", "find", "grep"]);
});

test("shellQuote single-quotes and escapes embedded quotes", () => {
	assert.equal(shellQuote(root), "'/w/my repo/o'\\''k'");
});

test("resolveIn handles relative, @-prefixed, absolute and ~ paths", () => {
	assert.equal(resolveIn(root, "src/a.ts"), "/w/my repo/o'k/src/a.ts");
	assert.equal(resolveIn(root, "@src/a.ts"), "/w/my repo/o'k/src/a.ts");
	assert.equal(resolveIn(root, "/abs/x"), "/abs/x");
	assert.equal(resolveIn(root, "@/abs/x"), "/abs/x");
	assert.equal(resolveIn(root, "~/x"), "~/x");
	assert.equal(resolveIn(root, "~"), "~");
});

test("resolveIn treats ~name (no slash) as relative, like Pi", () => {
	assert.equal(resolveIn(root, "~notes.md"), "/w/my repo/o'k/~notes.md");
	assert.equal(resolveIn(root, "~other/x"), "/w/my repo/o'k/~other/x");
});

test("resolveIn converts file:// URLs to absolute paths, like Pi", () => {
	assert.equal(resolveIn(root, "file:///abs/x.ts"), "/abs/x.ts");
	assert.equal(resolveIn(root, "@file:///abs/my%20x.ts"), "/abs/my x.ts");
});

test("read/write/edit paths are resolved against the root", () => {
	for (const tool of ["read", "write", "edit"]) {
		const relative: Record<string, unknown> = { path: "src/a.ts" };
		rewriteInput(tool, relative, root);
		assert.equal(relative.path, "/w/my repo/o'k/src/a.ts");

		const at: Record<string, unknown> = { path: "@src/a.ts" };
		rewriteInput(tool, at, root);
		assert.equal(at.path, "/w/my repo/o'k/src/a.ts");

		const absolute: Record<string, unknown> = { path: "/abs/x" };
		rewriteInput(tool, absolute, root);
		assert.equal(absolute.path, "/abs/x");

		const home: Record<string, unknown> = { path: "~/x" };
		rewriteInput(tool, home, root);
		assert.equal(home.path, "~/x");
	}
});

test("bash command is prefixed with a quoted cd that exits when it fails", () => {
	const input: Record<string, unknown> = { command: "ls -la; rm x" };
	rewriteInput("bash", input, root);
	assert.equal(input.command, "cd -- '/w/my repo/o'\\''k' || exit 1\nls -la; rm x");
});

test("search tools default a missing or empty path to the root", () => {
	const missing: Record<string, unknown> = { pattern: "x" };
	rewriteInput("ffgrep", missing, root);
	assert.equal(missing.path, root);

	const empty: Record<string, unknown> = { pattern: "x", path: "" };
	rewriteInput("grep", empty, root);
	assert.equal(empty.path, root);
});

test("search tools join relative paths onto the root and keep globs", () => {
	const dir: Record<string, unknown> = { path: "src/" };
	rewriteInput("ffgrep", dir, root);
	assert.equal(dir.path, "/w/my repo/o'k/src/");

	const glob: Record<string, unknown> = { path: "src/**/*.ts" };
	rewriteInput("fffind", glob, root);
	assert.equal(glob.path, "/w/my repo/o'k/src/**/*.ts");
});

test("search tools leave absolute and ~ paths untouched", () => {
	const absolute: Record<string, unknown> = { path: "/abs" };
	rewriteInput("find", absolute, root);
	assert.equal(absolute.path, "/abs");

	const home: Record<string, unknown> = { path: "~/x" };
	rewriteInput("grep", home, root);
	assert.equal(home.path, "~/x");
});

test("search tools join ~name onto the root and convert file:// URLs", () => {
	const tildeName: Record<string, unknown> = { path: "~notes" };
	rewriteInput("grep", tildeName, root);
	assert.equal(tildeName.path, "/w/my repo/o'k/~notes");

	const url: Record<string, unknown> = { path: "file:///abs/src" };
	rewriteInput("fffind", url, root);
	assert.equal(url.path, "/abs/src");
});

test("subagent top-level cwd defaults to the root and resolves relative values", () => {
	const missing: Record<string, unknown> = {};
	rewriteInput("subagent", missing, root);
	assert.equal(missing.cwd, root);

	const relative: Record<string, unknown> = { cwd: "pkg" };
	rewriteInput("subagent", relative, root);
	assert.equal(relative.cwd, root + "/pkg");

	const absolute: Record<string, unknown> = { cwd: "/abs" };
	rewriteInput("subagent", absolute, root);
	assert.equal(absolute.cwd, "/abs");
});

test("subagent cwds expand ~ and ~/ to the home directory (pi-subagents does not)", () => {
	const input: Record<string, unknown> = { cwd: "~/proj", tasks: [{ cwd: "~" }], chain: [{ parallel: [{ cwd: "~/a" }] }] };
	rewriteInput("subagent", input, root);
	assert.deepEqual(input, {
		cwd: `${os.homedir()}/proj`,
		tasks: [{ cwd: os.homedir() }],
		chain: [{ parallel: [{ cwd: `${os.homedir()}/a` }] }],
	});
});

test("subagent with a machine gets no default top-level cwd", () => {
	const input: Record<string, unknown> = { agent: "x", machine: "box" };
	rewriteInput("subagent", input, root);
	assert.deepEqual(input, { agent: "x", machine: "box" });
});

test("subagent per-item cwd rewrites only relative values", () => {
	const input: Record<string, unknown> = {
		tasks: [{ cwd: "a" }, {}, { cwd: "/abs" }],
		chain: [{ cwd: "b" }, { parallel: [{ cwd: "c" }, {}] }, {}],
	};
	rewriteInput("subagent", input, root);
	assert.deepEqual(input, {
		cwd: root,
		tasks: [{ cwd: root + "/a" }, {}, { cwd: "/abs" }],
		chain: [{ cwd: root + "/b" }, { parallel: [{ cwd: root + "/c" }, {}] }, {}],
	});
});

test("unknown tools are untouched", () => {
	const input: Record<string, unknown> = { path: "x" };
	rewriteInput("mystery", input, root);
	assert.deepEqual(input, { path: "x" });
});

test("job_start cwd defaults to the root and resolves relative values", () => {
	const missing: Record<string, unknown> = { command: "npm test" };
	rewriteInput("job_start", missing, root);
	assert.equal(missing.cwd, root);
	const empty: Record<string, unknown> = { command: "npm test", cwd: "" };
	rewriteInput("job_start", empty, root);
	assert.equal(empty.cwd, root);
	const relative: Record<string, unknown> = { command: "npm test", cwd: "sub" };
	rewriteInput("job_start", relative, root);
	assert.equal(relative.cwd, `${root}/sub`);
	const absolute: Record<string, unknown> = { command: "npm test", cwd: "/tmp/elsewhere" };
	rewriteInput("job_start", absolute, root);
	assert.equal(absolute.cwd, "/tmp/elsewhere");
});

test("job_start cwd expands ~/ to the home directory and leaves the command alone", () => {
	const input: Record<string, unknown> = { command: "npm test", cwd: "~/x" };
	rewriteInput("job_start", input, root);
	assert.equal(input.cwd, `${os.homedir()}/x`);
	assert.equal(input.command, "npm test");
});
