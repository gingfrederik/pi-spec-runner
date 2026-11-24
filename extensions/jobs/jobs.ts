// Background jobs for the job_start, job_wait and job_stop tools: each job is a
// bash command in its own process group, with output in a log file. A wait that
// times out or is aborted leaves the job running; only stop ends it.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type JobResult =
	| { state: "exited"; code: number; tail: string }
	| { state: "signaled"; signal: string; tail: string }
	| { state: "running"; tail: string }
	| { state: "failed"; message: string };

type EndedResult = Exclude<JobResult, { state: "running" }>;

type Job = {
	log: string;
	pid: number | undefined;
	ended: EndedResult | undefined;
	endedPromise: Promise<EndedResult>;
};

const ENDED_TAIL_LINES = 20;
const RUNNING_TAIL_LINES = 5;
const TAIL_READ_BYTES = 64 * 1024;
const GROUP_POLL_MS = 50;

function tailOf(log: string, lineCount: number): string {
	let text: string;
	let cutMidLine = false;
	try {
		const fd = fs.openSync(log, "r");
		try {
			const size = fs.fstatSync(fd).size;
			const start = Math.max(0, size - TAIL_READ_BYTES);
			const buffer = Buffer.alloc(size - start);
			const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, start);
			text = buffer.toString("utf8", 0, bytesRead);
			cutMidLine = start > 0;
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return "";
	}
	const lines = text.split("\n");
	if (cutMidLine && lines.length > 1) lines.shift();
	if (lines[lines.length - 1] === "") lines.pop();
	return lines.slice(-lineCount).join("\n");
}

function signalGroup(pid: number | undefined, signal: NodeJS.Signals): void {
	if (pid === undefined) return;
	try {
		process.kill(-pid, signal);
	} catch {
		// The group is already gone.
	}
}

function groupIsAlive(pid: number | undefined): boolean {
	if (pid === undefined) return false;
	try {
		process.kill(-pid, 0);
		return true;
	} catch {
		return false;
	}
}

export class JobTable {
	private readonly logDir: string;
	private readonly graceMs: number;
	private readonly jobs = new Map<string, Job>();

	constructor(options: { logDir: string; graceMs?: number }) {
		this.logDir = options.logDir;
		this.graceMs = options.graceMs ?? 2000;
	}

	start(command: string, cwd: string, env?: NodeJS.ProcessEnv): { id: string; log: string } {
		const id = `job-${this.jobs.size + 1}`;
		const log = path.join(this.logDir, `${id}.log`);
		const job: Job = { log, pid: undefined, ended: undefined, endedPromise: undefined as never };
		job.endedPromise = new Promise<EndedResult>((resolve) => {
			const end = (result: EndedResult): void => {
				if (job.ended) return;
				job.ended = result;
				resolve(result);
			};
			let fd: number | undefined;
			try {
				if (!fs.existsSync(cwd)) throw new Error(`working directory does not exist: ${cwd}`);
				fs.mkdirSync(this.logDir, { recursive: true });
				fd = fs.openSync(log, "w");
				const child = spawn("/bin/bash", ["-c", command], { cwd, env, detached: true, stdio: ["ignore", fd, fd] });
				job.pid = child.pid;
				child.on("error", (error) => end({ state: "failed", message: error.message }));
				child.on("exit", (code, signal) => {
					const tail = tailOf(log, ENDED_TAIL_LINES);
					end(signal ? { state: "signaled", signal, tail } : { state: "exited", code: code ?? 0, tail });
				});
			} catch (error) {
				end({ state: "failed", message: error instanceof Error ? error.message : String(error) });
			} finally {
				if (fd !== undefined) fs.closeSync(fd);
			}
		});
		this.jobs.set(id, job);
		return { id, log };
	}

	async wait(id: string, maxMs: number, signal?: AbortSignal): Promise<JobResult> {
		const job = this.lookup(id);
		if (job.ended) return job.ended;
		let stopWaiting: () => void = () => {};
		const interrupted = new Promise<undefined>((resolve) => {
			const timer = setTimeout(() => resolve(undefined), maxMs);
			const onAbort = (): void => resolve(undefined);
			signal?.addEventListener("abort", onAbort, { once: true });
			if (signal?.aborted) resolve(undefined);
			stopWaiting = () => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
			};
		});
		try {
			const result = await Promise.race([job.endedPromise, interrupted]);
			return result ?? job.ended ?? { state: "running", tail: tailOf(job.log, RUNNING_TAIL_LINES) };
		} finally {
			stopWaiting();
		}
	}

	async stop(id: string): Promise<JobResult> {
		const job = this.lookup(id);
		if (job.ended) return job.ended;
		signalGroup(job.pid, "SIGTERM");
		let graceTimer: NodeJS.Timeout | undefined;
		const graceOver = new Promise<void>((resolve) => {
			graceTimer = setTimeout(resolve, this.graceMs);
		});
		const graceDeadline = Date.now() + this.graceMs;
		await Promise.race([job.endedPromise, graceOver]);
		clearTimeout(graceTimer);
		// Members may outlive the leader: give them the rest of the grace period.
		while (job.ended && groupIsAlive(job.pid) && Date.now() < graceDeadline) {
			await new Promise((resolve) => setTimeout(resolve, GROUP_POLL_MS));
		}
		// SIGKILL a leader that ignored SIGTERM, and members that ignored it too.
		if (!job.ended || groupIsAlive(job.pid)) signalGroup(job.pid, "SIGKILL");
		return job.endedPromise;
	}

	async stopAll(): Promise<void> {
		const running = [...this.jobs.entries()].filter(([, job]) => !job.ended);
		await Promise.all(running.map(([id]) => this.stop(id)));
	}

	private lookup(id: string): Job {
		const job = this.jobs.get(id);
		if (job) return job;
		const known = [...this.jobs.keys()].join(", ") || "none";
		throw new Error(`no such job: ${id}; known: ${known}`);
	}
}

export function formatResult(result: JobResult, waitedSeconds: number): { text: string; isError: boolean } {
	const withTail = (tail: string, statusLine: string): string => (tail ? `${tail}\n${statusLine}` : statusLine);
	switch (result.state) {
		case "exited":
			return { text: withTail(result.tail, `[job] exit ${result.code}`), isError: result.code !== 0 };
		case "signaled":
			return { text: withTail(result.tail, `[job] killed by ${result.signal}`), isError: true };
		case "running":
			return {
				text: withTail(result.tail, `[job] still running after ${waitedSeconds} s; not stopped, call job_wait again`),
				isError: false,
			};
		case "failed":
			return { text: `[job] failed to start: ${result.message}`, isError: true };
	}
}
