// Naming a session through Pi's API. Typing `/alias <name>` into the session's own pane does the
// same, but the keys are mangled when the prompt is in pi-vim NORMAL mode.

/** The part of Pi's ExtensionAPI that reads and sets the session name. */
export interface NamedSession {
	setSessionName(name: string): void;
	getSessionName(): string | undefined;
}

export interface NameResult {
	text: string;
	isError: boolean;
}

/** Sets the session name to `raw`, trimmed. An empty name is refused. */
export function nameSession(session: NamedSession, raw: string): NameResult {
	const name = raw.trim();
	if (!name) return { text: "name is empty; the session keeps its name", isError: true };
	try {
		session.setSessionName(name);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return { text: `could not name the session: ${reason}`, isError: true };
	}
	return { text: `session named ${name}`, isError: false };
}
