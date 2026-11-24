import path from "node:path";

type Realpath = (p: string) => string;

/**
 * Realpath of the deepest existing ancestor of `p`, with the missing segments
 * re-joined. Lets the guard compare a path the model typed (`/tmp/repo/new.txt`)
 * against git's realpath'd main root (`/private/tmp/repo`) even when the file
 * does not exist yet. Never throws: falls back to the resolved input.
 */
export function canonPath(p: string, realpath: Realpath): string {
	const resolved = path.resolve(p);
	const tail: string[] = [];
	let dir = resolved;
	for (;;) {
		try {
			return path.join(realpath(dir), ...tail);
		} catch {
			const parent = path.dirname(dir);
			if (parent === dir) return resolved;
			tail.unshift(path.basename(dir));
			dir = parent;
		}
	}
}

/**
 * Other spellings of `mainRoot` a bash command may use, for the guard's string match:
 * - on macOS git reports `/private/tmp/repo` while people type `/tmp/repo`;
 * - the launch cwd's spelling of the main root, when it reaches it through a symlink.
 */
export function mainRootAliases(mainRoot: string, cwd: string, realpath: Realpath): string[] {
	const aliases = new Set<string>();
	if (mainRoot.startsWith("/private/")) {
		const bare = mainRoot.slice("/private".length);
		if (canonPath(bare, realpath) === mainRoot) aliases.add(bare);
	}
	for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
		if (canonPath(dir, realpath) === mainRoot) {
			aliases.add(dir);
			break;
		}
		if (path.dirname(dir) === dir) break;
	}
	aliases.delete(mainRoot);
	return [...aliases];
}
