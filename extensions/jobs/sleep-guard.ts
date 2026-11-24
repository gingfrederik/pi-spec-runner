// Finds a long guessed-time `sleep` in a bash command, so the bash tool can be
// blocked in favor of job_start and job_wait. Pure string work; no Pi imports.

const BLOCK_FROM_SECONDS = 60;
const UNIT_SECONDS: Record<string, number> = { "": 1, s: 1, m: 60, h: 3600, d: 86400 };

// `sleep` starts the command or follows whitespace or one of ; & | (
// and takes a number with an optional unit, so quoted text and `usleep` do not match.
const SLEEP_PATTERN = /(?:^|[\s;&|(])sleep\s+(\d+(?:\.\d+)?|\.\d+)([smhd]?)(?=$|[\s;&|)])/g;

/** The longest `sleep` of the command in seconds when it is 60 or more, else null. */
export function guessedSleep(command: string): number | null {
	if (command.includes("<<")) return null;
	let longest = 0;
	for (const match of command.matchAll(SLEEP_PATTERN)) {
		const seconds = Number(match[1]) * UNIT_SECONDS[match[2]];
		if (seconds > longest) longest = seconds;
	}
	return longest >= BLOCK_FROM_SECONDS ? longest : null;
}

export function sleepBlockReason(seconds: number): string {
	return `Blocked: \`sleep ${seconds}\` waits a guessed time. To wait for a command, start it with job_start and call job_wait: it returns when the command ends. To wait for a condition, test it in a loop with a \`sleep\` under 60.`;
}
