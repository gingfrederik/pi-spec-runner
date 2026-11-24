import path from "node:path";

type NormalizeOptions = {
	toolName: string;
	searchPath: string;
	root: string;
	exists: (p: string) => boolean;
};

const GREP_TOOLS = new Set(["grep", "ffgrep"]);
const FIND_TOOLS = new Set(["find", "fffind"]);
const GLOB_CHARS = /[*?[{]/;

/**
 * Directories search output may be relative to: the deepest existing non-glob
 * prefix of `searchPath`, then each existing ancestor up to "/".
 *
 * Only `exists` is available, so a prefix that is a file cannot be told apart
 * from a directory. It is kept as a candidate anyway: joining a file path with
 * a relative path yields a path that does not exist, which is harmless, and
 * the file's parent follows as the next ancestor.
 */
function candidateDirs(searchPath: string, exists: (p: string) => boolean): string[] {
	const segments = searchPath.split("/");
	const globAt = segments.findIndex((segment) => GLOB_CHARS.test(segment));
	const literal = globAt === -1 ? segments : segments.slice(0, globAt);
	const dirs: string[] = [];
	for (let i = literal.length; i > 0; i--) {
		const prefix = literal.slice(0, i).join("/") || "/";
		if (exists(prefix)) dirs.push(prefix);
	}
	if (searchPath.startsWith("/") && !dirs.includes("/") && exists("/")) dirs.push("/");
	return dirs;
}

function splitAnnotation(line: string): { filePath: string; rest: string } {
	const gap = line.indexOf("  ");
	const paren = line.indexOf(" (");
	const cuts = [gap, paren].filter((i) => i >= 0);
	if (cuts.length === 0) return { filePath: line, rest: "" };
	const cut = Math.min(...cuts);
	return { filePath: line.slice(0, cut), rest: line.slice(cut) };
}

function isPathLine(line: string, toolName: string): boolean {
	if (line === "" || line.startsWith("[")) return false;
	if (GREP_TOOLS.has(toolName)) return !/^\s/.test(line);
	return FIND_TOOLS.has(toolName);
}

export function normalizeSearchOutput(text: string, opts: NormalizeOptions): string {
	if (text === "") return "";
	if (!GREP_TOOLS.has(opts.toolName) && !FIND_TOOLS.has(opts.toolName)) return text;
	const dirs = candidateDirs(opts.searchPath, opts.exists);
	// Capturing group keeps the original line separators in the parts array.
	const parts = text.split(/(\r\n|\n)/);
	for (let i = 0; i < parts.length; i += 2) {
		const line = parts[i];
		if (!isPathLine(line, opts.toolName)) continue;
		const { filePath, rest } = splitAnnotation(line);
		if (opts.exists(path.join(opts.root, filePath))) continue;
		for (const dir of dirs) {
			const joined = path.join(dir, filePath);
			if (opts.exists(joined)) {
				parts[i] = path.relative(opts.root, joined) + rest;
				break;
			}
		}
	}
	return parts.join("");
}
