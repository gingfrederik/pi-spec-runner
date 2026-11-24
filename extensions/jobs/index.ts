// The job_start, job_wait and job_stop tools, and the guard that blocks a long
// guessed-time `sleep` in bash. Logic lives in jobs.ts and sleep-guard.ts; this
// file wires it into Pi.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type ExtensionAPI, isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { formatResult, JobTable } from "./jobs.ts";
import { guessedSleep, sleepBlockReason } from "./sleep-guard.ts";

const DEFAULT_MAX_SECONDS = 900;

function textResult(text: string, isError = false) {
	return { content: [{ type: "text" as const, text }], details: undefined, isError };
}

export default function (pi: ExtensionAPI) {
	let table: JobTable | undefined;
	const jobTable = (): JobTable => {
		table ??= new JobTable({ logDir: fs.mkdtempSync(path.join(os.tmpdir(), "pi-jobs-")) });
		return table;
	};

	// The worktree extension announces the active worktree; jobs run there, like bash.
	let worktreeRoot: string | undefined;
	pi.events.on("worktree:changed", (data) => {
		worktreeRoot = (data as { root?: string } | null | undefined)?.root;
	});
	pi.on("session_start", () => {
		pi.events.emit("worktree:query", undefined);
	});

	/** An unknown id is an error result with the `no such job` text. */
	const failed = (error: unknown) => textResult(error instanceof Error ? error.message : String(error), true);

	pi.registerTool({
		name: "job_start",
		label: "Start job",
		description:
			"Start a shell command in the background and return at once with a job id. Use it for any command that may take more than a minute (a build, an install, a device test) instead of `&` or `nohup`. Collect the result with job_wait.",
		parameters: Type.Object({
			command: Type.String({ description: "The shell command to run." }),
			cwd: Type.Optional(Type.String({ description: "Directory to run it in; a relative path starts from the session's working directory (the active worktree, if any). Default: that directory." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const cwd = path.resolve(worktreeRoot ?? ctx.cwd, params.cwd ?? ".");
			// Like bash commands, jobs carry the session id so proc-reaper.ts can find leftovers.
			const env = { ...process.env, PI_SESSION_ID: ctx.sessionManager.getSessionId() };
			const { id, log } = jobTable().start(params.command, cwd, env);
			return textResult(`started ${id}; log ${log}`);
		},
	});

	pi.registerTool({
		name: "job_wait",
		label: "Wait for job",
		description:
			"Wait for a job. Returns the moment the command ends, with its exit code and the end of its output. If max_seconds (default 900) passes first, the job keeps running: call job_wait again. Never `sleep` to wait for a job.",
		parameters: Type.Object({
			id: Type.String({ description: "The job id from job_start." }),
			max_seconds: Type.Optional(Type.Number({ description: "Longest wait in seconds. Default: 900." })),
		}),
		async execute(_toolCallId, params, signal) {
			const maxSeconds = params.max_seconds ?? DEFAULT_MAX_SECONDS;
			try {
				const result = await jobTable().wait(params.id, maxSeconds * 1000, signal);
				const { text, isError } = formatResult(result, maxSeconds);
				return textResult(text, isError);
			} catch (error) {
				return failed(error);
			}
		},
	});

	pi.registerTool({
		name: "job_stop",
		label: "Stop job",
		description: "Stop a job and everything it started.",
		parameters: Type.Object({
			id: Type.String({ description: "The job id from job_start." }),
		}),
		async execute(_toolCallId, params) {
			try {
				const result = await jobTable().stop(params.id);
				const tail = result.state === "failed" ? "" : result.tail;
				return textResult(tail ? `${tail}\n[job] stopped` : "[job] stopped");
			} catch (error) {
				return failed(error);
			}
		},
	});

	pi.on("tool_call", (event) => {
		if (!isToolCallEventType("bash", event)) return;
		const seconds = guessedSleep(event.input.command);
		if (seconds !== null) return { block: true, reason: sleepBlockReason(seconds) };
	});

	pi.on("session_shutdown", async () => {
		await table?.stopAll();
	});
}
