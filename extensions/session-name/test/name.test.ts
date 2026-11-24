import assert from "node:assert/strict";
import { test } from "node:test";
import { nameSession } from "../name.ts";

/** A session that stores its name the way Pi's ExtensionAPI does. */
function fakeSession(initial?: string) {
	let name = initial;
	return {
		setSessionName(next: string) {
			name = next;
		},
		getSessionName: () => name,
	};
}

test("nameSession sets the session name and reports it", () => {
	const session = fakeSession();
	const result = nameSession(session, "toy-orchestrator");
	assert.equal(session.getSessionName(), "toy-orchestrator");
	assert.deepEqual(result, { text: "session named toy-orchestrator", isError: false });
});

test("nameSession trims the name, so the broker lists exactly what peers address", () => {
	const session = fakeSession();
	nameSession(session, "  toy-orchestrator\n");
	assert.equal(session.getSessionName(), "toy-orchestrator");
});

test("nameSession refuses an empty name and keeps the current one", () => {
	const session = fakeSession("toy-orchestrator");
	const result = nameSession(session, "   ");
	assert.equal(session.getSessionName(), "toy-orchestrator");
	assert.deepEqual(result, { text: "name is empty; the session keeps its name", isError: true });
});

test("nameSession reports a name Pi refuses to set", () => {
	const session = {
		setSessionName() {
			throw new Error("no session");
		},
		getSessionName: () => undefined,
	};
	assert.deepEqual(nameSession(session, "toy-orchestrator"), {
		text: "could not name the session: no session",
		isError: true,
	});
});
