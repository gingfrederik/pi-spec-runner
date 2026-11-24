// The name_session tool: the agent names its own session. pi-intercom lists a session under its
// name, so peers can address it. Logic lives in name.ts; this file wires it into Pi.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { nameSession } from "./name.ts";

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "name_session",
		label: "Name session",
		description:
			"Set this session's name. pi-intercom lists the session under it within a few seconds, and other sessions address it by that name.",
		parameters: Type.Object({
			name: Type.String({ description: "The new session name." }),
		}),
		async execute(_toolCallId, params) {
			const { text, isError } = nameSession(pi, params.name);
			return { content: [{ type: "text" as const, text }], details: undefined, isError };
		},
	});
}
