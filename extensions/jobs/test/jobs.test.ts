import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { formatResult, JobTable } from "../jobs.ts";
import type { JobResult } from "../jobs.ts";

function makeTable(): { table: JobTable; dir: string } {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jobs-test-")));
	return { table: new JobTable({ logDir: path.join(dir, "logs"), graceMs: 300 }), dir };
}

function lines(text: string): string[] {
	return text.split("\n");
}

test("start returns at once with counting ids and separate log files", async () => {
	const { table, dir } = makeTable();
	try {
		const began = Date.now();
		const first = table.start("sleep 3", dir);
		assert.ok(Date.now() - began < 1000);
		assert.equal(first.id, "job-1");
		const second = table.start("sleep 3", dir);
		assert.equal(second.id, "job-2");
		assert.notEqual(first.log, second.log);
		assert.ok(fs.existsSync(first.log));
		assert.ok(fs.existsSync(second.log));
	} finally {
		await table.stopAll();
	}
});

test("wait gives exit code and tail of both streams, again at once", async () => {
	const { table, dir } = makeTable();
	const { id } = table.start("echo out; echo err >&2; exit 3", dir);
	const result = await table.wait(id, 20000);
	assert.equal(result.state, "exited");
	assert.ok(result.state === "exited" && result.code === 3);
	assert.ok(result.state === "exited" && result.tail.includes("out") && result.tail.includes("err"));
	const began = Date.now();
	const again = await table.wait(id, 20000);
	assert.ok(Date.now() - began < 100);
	assert.deepEqual(again, result);
});

test("a wait that times out or is aborted leaves the job running", async () => {
	const { table, dir } = makeTable();
	const { id } = table.start("sleep 2; echo late", dir);
	const timedOut = await table.wait(id, 300);
	assert.equal(timedOut.state, "running");
	const controller = new AbortController();
	setTimeout(() => controller.abort(), 200);
	const aborted = await table.wait(id, 20000, controller.signal);
	assert.equal(aborted.state, "running");
	const done = await table.wait(id, 20000);
	assert.equal(done.state, "exited");
	assert.ok(done.state === "exited" && done.code === 0);
	assert.ok(done.state === "exited" && done.tail.includes("late"));
});

test("a wait with a signal that is already aborted gives running", async () => {
	const { table, dir } = makeTable();
	try {
		const { id } = table.start("sleep 5", dir);
		const controller = new AbortController();
		controller.abort();
		assert.equal((await table.wait(id, 20000, controller.signal)).state, "running");
	} finally {
		await table.stopAll();
	}
});

test("tail of an ended job is its last 20 lines", async () => {
	const { table, dir } = makeTable();
	const { id } = table.start("for i in $(seq 1 100); do echo line $i; done", dir);
	const result = await table.wait(id, 20000);
	assert.equal(result.state, "exited");
	assert.ok(result.state === "exited");
	const tail = lines(result.tail);
	assert.ok(tail.includes("line 81"));
	assert.ok(tail.includes("line 100"));
	assert.ok(!tail.includes("line 80"));
	assert.equal(tail.length, 20);
});

test("tail of a running job is its last 5 lines", async () => {
	const { table, dir } = makeTable();
	try {
		const { id } = table.start("for i in $(seq 1 100); do echo line $i; done; sleep 5", dir);
		await new Promise((resolve) => setTimeout(resolve, 500));
		const result = await table.wait(id, 100);
		assert.equal(result.state, "running");
		assert.ok(result.state === "running");
		assert.deepEqual(lines(result.tail), ["line 96", "line 97", "line 98", "line 99", "line 100"]);
	} finally {
		await table.stopAll();
	}
});

test("printed text that looks like a status line does not change the result", async () => {
	const { table, dir } = makeTable();
	const { id } = table.start('echo "[job] exit 9"', dir);
	const result = await table.wait(id, 20000);
	assert.equal(result.state, "exited");
	assert.ok(result.state === "exited" && result.code === 0);
});

test("a missing command exits 127", async () => {
	const { table, dir } = makeTable();
	const { id } = table.start("no-such-command-xyz", dir);
	const result = await table.wait(id, 20000);
	assert.equal(result.state, "exited");
	assert.ok(result.state === "exited" && result.code === 127);
});

test("the job runs in the given cwd", async () => {
	const { table, dir } = makeTable();
	const { id } = table.start("pwd", dir);
	const result = await table.wait(id, 20000);
	assert.ok(result.state === "exited" && result.tail.trim() === dir);
});

test("a cwd that does not exist gives failed", async () => {
	const { table, dir } = makeTable();
	const { id } = table.start("echo hi", path.join(dir, "missing"));
	const result = await table.wait(id, 20000);
	assert.equal(result.state, "failed");
	assert.ok(result.state === "failed" && result.message.includes(path.join(dir, "missing")));
});

test("a log that cannot be opened gives failed, not a rejection", async () => {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jobs-test-")));
	const blocker = path.join(dir, "blocker");
	fs.writeFileSync(blocker, "");
	const table = new JobTable({ logDir: path.join(blocker, "logs"), graceMs: 300 });
	const { id } = table.start("echo hi", dir);
	const result = await table.wait(id, 20000);
	assert.equal(result.state, "failed");
	assert.deepEqual(await table.stop(id), result);
});

test("the env passed to start reaches the job", async () => {
	const { table, dir } = makeTable();
	const { id } = table.start("echo $PI_SESSION_ID", dir, { ...process.env, PI_SESSION_ID: "sess-42" });
	const result = await table.wait(id, 20000);
	assert.ok(result.state === "exited" && result.tail.trim() === "sess-42");
});

test("the tail of a very large log is read from its end", async () => {
	const { table, dir } = makeTable();
	const { id } = table.start("for i in $(seq 1 30000); do echo line $i; done", dir);
	const result = await table.wait(id, 20000);
	assert.ok(result.state === "exited");
	const tail = lines(result.tail);
	assert.equal(tail.length, 20);
	assert.equal(tail[19], "line 30000");
	assert.equal(tail[0], "line 29981");
});

test("stop gives members that outlive the leader the grace period before SIGKILL", async () => {
	const { table, dir } = makeTable();
	const pidFile = path.join(dir, "member.pid");
	const marker = path.join(dir, "member.done");
	// The leader exits on SIGTERM; the member lives 150 ms longer, under the 300 ms grace.
	const member = `trap 'sleep 0.15; touch ${marker}; exit 0' TERM; echo $$ > ${pidFile}; while true; do sleep 0.05; done`;
	const { id } = table.start(`(${member}) & wait`, dir);
	for (let i = 0; i < 50 && !fs.existsSync(pidFile); i++) await new Promise((resolve) => setTimeout(resolve, 50));
	await new Promise((resolve) => setTimeout(resolve, 100));
	await table.stop(id);
	assert.ok(fs.existsSync(marker), "the member finished its own shutdown before any SIGKILL");
});

test("stop ends the whole process group with SIGTERM", async () => {
	const { table, dir } = makeTable();
	const pidFile = path.join(dir, "child.pid");
	const { id } = table.start(`sleep 600 & echo $! > ${pidFile}; wait`, dir);
	for (let i = 0; i < 50 && !fs.existsSync(pidFile); i++) await new Promise((resolve) => setTimeout(resolve, 50));
	await new Promise((resolve) => setTimeout(resolve, 100));
	const childPid = Number(fs.readFileSync(pidFile, "utf8").trim());
	assert.ok(childPid > 0);
	const began = Date.now();
	const result = await table.stop(id);
	assert.ok(Date.now() - began < 2000);
	assert.ok(result.state === "signaled" && result.signal === "SIGTERM");
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.throws(() => process.kill(childPid, 0));
});

test("stop sends SIGKILL after the grace period to a job that ignores SIGTERM", async () => {
	const { table, dir } = makeTable();
	const { id } = table.start('trap "" TERM; sleep 600', dir);
	await new Promise((resolve) => setTimeout(resolve, 200));
	const result = await table.stop(id);
	assert.ok(result.state === "signaled" && result.signal === "SIGKILL");
});

test("stop of an ended job gives its result unchanged", async () => {
	const { table, dir } = makeTable();
	const { id } = table.start("echo done", dir);
	const ended = await table.wait(id, 20000);
	assert.deepEqual(await table.stop(id), ended);
	assert.ok(ended.state === "exited" && ended.code === 0);
});

test("stopAll ends running jobs and leaves an ended one unchanged", async () => {
	const { table, dir } = makeTable();
	const first = table.start("echo done", dir);
	const ended = await table.wait(first.id, 20000);
	const second = table.start("sleep 600", dir);
	const third = table.start("sleep 600", dir);
	await table.stopAll();
	assert.equal((await table.wait(second.id, 100)).state, "signaled");
	assert.equal((await table.wait(third.id, 100)).state, "signaled");
	assert.deepEqual(await table.wait(first.id, 100), ended);
});

test("an unknown id throws with the known ids", async () => {
	const { table, dir } = makeTable();
	await assert.rejects(table.wait("job-9", 100), { message: "no such job: job-9; known: none" });
	table.start("true", dir);
	await assert.rejects(table.wait("job-9", 100), { message: "no such job: job-9; known: job-1" });
	await assert.rejects(table.stop("job-9"), { message: "no such job: job-9; known: job-1" });
});

test("formatResult ends with one status line per state", () => {
	const cases: Array<[JobResult, number, string, boolean]> = [
		[{ state: "exited", code: 0, tail: "ok" }, 1, "[job] exit 0", false],
		[{ state: "exited", code: 3, tail: "bad" }, 1, "[job] exit 3", true],
		[{ state: "signaled", signal: "SIGTERM", tail: "x" }, 1, "[job] killed by SIGTERM", true],
		[{ state: "running", tail: "x" }, 900, "[job] still running after 900 s; not stopped, call job_wait again", false],
		[{ state: "failed", message: "spawn ENOENT" }, 0, "[job] failed to start: spawn ENOENT", true],
	];
	for (const [result, waited, lastLine, isError] of cases) {
		const formatted = formatResult(result, waited);
		const all = lines(formatted.text);
		assert.equal(all[all.length - 1], lastLine);
		assert.equal(formatted.isError, isError);
	}
	assert.ok(formatResult({ state: "exited", code: 3, tail: "bad" }, 1).text.startsWith("bad\n"));
});
