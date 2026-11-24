import assert from "node:assert/strict";
import { test } from "node:test";
import { guessedSleep, sleepBlockReason } from "../sleep-guard.ts";

const cases: Array<[string, number | null]> = [
	["sleep 600; tail -5 /tmp/build.log", 600],
	["(nohup npx expo run:ios > /tmp/ios.log 2>&1 &); sleep 240; tail -20 /tmp/ios.log", 240],
	["sleep 60", 60],
	["sleep 59; echo x", null],
	["sleep 2m", 120],
	["sleep 1.5m", 90],
	["sleep 90s", 90],
	["sleep 1h", 3600],
	["sleep 0.5", null],
	["sleep 30; make; sleep 45", null],
	["sleep 30; make; sleep 90", 90],
	["timeout 700 sleep 600", 600],
	["until grep -q BUILD /tmp/b.log; do sleep 5; done", null],
	["grep -n 'sleep 120' tools/warmup.sh", null],
	['echo "sleep 600"', null],
	["echo sleeping 600", null],
	["usleep 600", null],
	["sleep $N; tail x.log", null],
	["cat > /tmp/s.sh <<'EOF'\nsleep 300\nEOF", null],
];

for (const [command, expected] of cases) {
	test(`guessedSleep(${JSON.stringify(command)}) is ${expected}`, () => {
		assert.equal(guessedSleep(command), expected);
	});
}

test("sleepBlockReason names the sleep and the tools to use", () => {
	const reason = sleepBlockReason(600);
	assert.ok(reason.includes("`sleep 600`"));
	assert.ok(reason.includes("job_start"));
	assert.ok(reason.includes("job_wait"));
	assert.equal(
		reason,
		"Blocked: `sleep 600` waits a guessed time. To wait for a command, start it with job_start and call job_wait: it returns when the command ends. To wait for a condition, test it in a loop with a `sleep` under 60.",
	);
});
