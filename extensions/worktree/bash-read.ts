/**
 * Decides whether a bash command only reads the paths it names, so the guard can let the
 * agent read the main checkout from a worktree while still blocking writes to it.
 *
 * Approximate by design and conservative: anything the lexer cannot follow (an unclosed
 * quote or substitution, `$(…)` inside an unquoted heredoc) or a command it does not know
 * counts as a write.
 */

import path from "node:path";

type Word = { text: string; /** Target of an output redirection (`>`, `>>`, `&>`, `>|`). */ out: boolean };
type Quote = "'" | '"' | null;

/**
 * Splits a bash command into simple commands (at `; & | && || newline ( )`, `$(` and backticks),
 * each a list of words with quotes and backslashes removed. Heredoc bodies are skipped.
 * Returns null when the command cannot be followed.
 */
export function splitCommands(command: string): Word[][] | null {
	return lex(command)?.commands ?? null;
}

/**
 * `pipelines[k]` numbers the pipeline `commands[k]` belongs to: `|` and `|&` keep the number,
 * other separators move on. Commands inside `$(\u2026)` or backticks share their enclosing
 * pipeline, since their output feeds it.
 */
function lex(command: string): { commands: Word[][]; pipelines: number[] } | null {
	const commands: Word[][] = [];
	const pipelines: number[] = [];
	let pipeline = 0;
	let words: Word[] = [];
	let cur = "";
	let started = false;
	let out = false;
	let quote: Quote = null;
	const subs: Array<{ quote: Quote; backtick: boolean }> = [];
	/** `owner` is the command the heredoc feeds; its body is added to it as one word. */
	const heredocs: Array<{ delim: string; stripTabs: boolean; expands: boolean; owner: Word[] }> = [];

	const endWord = () => {
		if (started) {
			words.push({ text: cur, out });
			out = false;
		}
		cur = "";
		started = false;
	};
	const endCommand = () => {
		endWord();
		if (words.length > 0) {
			commands.push(words);
			pipelines.push(pipeline);
		}
		words = [];
		out = false;
	};
	/** Ends the command and, outside substitutions, the pipeline. */
	const endPipeline = () => {
		endCommand();
		if (subs.length === 0) pipeline++;
	};
	/** Skips the bodies of pending heredocs, starting after the newline at `nl`; returns the new index. */
	const skipHeredocs = (nl: number): number | null => {
		let pos = nl + 1;
		for (const doc of heredocs.splice(0)) {
			const body: string[] = [];
			for (;;) {
				if (pos > command.length) return null; // no terminator
				const end = command.indexOf("\n", pos);
				const lineEnd = end === -1 ? command.length : end;
				const line = command.slice(pos, lineEnd);
				if ((doc.stripTabs ? line.replace(/^\t+/, "") : line) === doc.delim) {
					pos = lineEnd + 1;
					doc.owner.push({ text: body.join("\n"), out: false });
					break;
				}
				body.push(line);
				// An unquoted delimiter means the body expands `$(…)` and backticks: they run.
				if (doc.expands && /\$\(|`/.test(line)) return null;
				pos = lineEnd + 1;
			}
		}
		return pos - 1; // the loop's i++ lands on the first character after the last terminator
	};

	for (let i = 0; i < command.length; i++) {
		const c = command[i];
		const next = command[i + 1];
		if (quote === "'") {
			if (c === "'") quote = null;
			else cur += c;
			continue;
		}
		if (c === "\\") {
			if (next !== undefined && next !== "\n") cur += next;
			started = true;
			i++;
			continue;
		}
		if (c === "$" && next === "(") {
			subs.push({ quote, backtick: false });
			quote = null;
			endCommand();
			i++;
			continue;
		}
		if (c === "`") {
			endCommand();
			const top = subs.at(-1);
			if (top?.backtick && quote === null) quote = (subs.pop() as { quote: Quote }).quote;
			else {
				subs.push({ quote, backtick: true });
				quote = null;
			}
			continue;
		}
		if (quote === '"') {
			if (c === '"') quote = null;
			else cur += c;
			started = true; // also after `$(…)` closes inside the quotes
			continue;
		}
		if (c === "'" || c === '"') {
			quote = c;
			started = true;
			continue;
		}
		if (c === ")" && subs.length > 0 && !(subs.at(-1) as { backtick: boolean }).backtick) {
			endCommand();
			quote = (subs.pop() as { quote: Quote }).quote;
			continue;
		}
		if (c === " " || c === "\t") {
			endWord();
			continue;
		}
		if (c === ">" || (c === "&" && next === ">")) {
			// `2>`: the fd number is not a word.
			if (/^\d+$/.test(cur)) {
				cur = "";
				started = false;
			}
			endWord();
			if (c === "&") i++;
			while (command[i + 1] === ">" || command[i + 1] === "|") i++;
			// `>&2` duplicates a file descriptor; anything else names a file.
			if (command[i + 1] === "&") i++;
			else out = true;
			continue;
		}
		if (c === "<") {
			endWord();
			if (next === "<" && command[i + 2] === "<") {
				i += 2; // here-string
				continue;
			}
			if (next !== "<") continue;
			let j = i + 2;
			const stripTabs = command[j] === "-";
			if (stripTabs) j++;
			while (command[j] === " " || command[j] === "\t") j++;
			let delim = "";
			let quoted = false;
			while (j < command.length && !/[\s;&|<>()]/.test(command[j])) {
				if (command[j] === "'" || command[j] === '"' || command[j] === "\\") quoted = true;
				else delim += command[j];
				j++;
			}
			if (delim === "") return null;
			heredocs.push({ delim, stripTabs, expands: !quoted, owner: words });
			i = j - 1;
			continue;
		}
		if (c === "\n") {
			endPipeline();
			if (heredocs.length > 0) {
				const at = skipHeredocs(i);
				if (at === null) return null;
				i = at;
			}
			continue;
		}
		if (c === "|" && next !== "|") {
			endCommand(); // a pipe: same pipeline
			if (next === "&") i++;
			continue;
		}
		if (c === ";" || c === "&" || c === "|" || c === "(" || c === ")") {
			endPipeline();
			if ((c === "|" || c === "&") && next === c) i++; // `||`, `&&`
			continue;
		}
		cur += c;
		started = true;
	}
	if (quote !== null || subs.length > 0 || heredocs.length > 0) return null;
	endCommand();
	return { commands, pipelines };
}

/** Commands that run other code: in a pipeline that names the main checkout, they block it. */
const EXEC_COMMANDS = new Set([
	"sh", "bash", "zsh", "dash", "fish", "eval", "source", ".", "exec", "xargs", "env", "sudo", "command", "builtin",
	"python", "python3", "node", "perl", "ruby", "deno", "bun", "npx", "tsx",
]);

function commandName(words: Word[]): string | undefined {
	return words.filter((w) => !w.out).map((w) => w.text).find((t) => !/^[A-Za-z_]\w*=/.test(t));
}

/** Commands that only read the files they are given. */
const READ_COMMANDS = new Set([
	"cat", "head", "tail", "ls", "stat", "file", "wc", "du", "diff", "cmp", "comm",
	"shasum", "sha1sum", "sha256sum", "md5", "md5sum", "cksum",
	"grep", "egrep", "fgrep", "realpath", "readlink", "basename", "dirname",
	"jq", "cut", "nl", "od", "hexdump", "strings", "column", "test", "[", "echo", "printf",
]);

const GIT_READ_SUBCOMMANDS = new Set([
	"log", "show", "diff", "status", "ls-files", "ls-tree", "rev-parse", "cat-file", "grep", "blame",
	"describe", "shortlog", "rev-list", "merge-base", "show-ref", "for-each-ref", "check-ignore",
]);

const FIND_WRITE_ACTIONS = new Set(["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls"]);

/** Whether one simple command only reads. `cp` may read from the main checkout when its destination is elsewhere. */
function readsOnly(args: string[], mentions: (word: string) => boolean): boolean {
	const [name, ...rest] = args;
	if (name === undefined) return true;
	if (READ_COMMANDS.has(name)) return true;
	switch (name) {
		case "rg":
			// --pre runs a program on every file.
			return !rest.some((a) => a.startsWith("--pre"));
		case "find":
			return !rest.some((a) => FIND_WRITE_ACTIONS.has(a));
		case "sort":
			return !rest.some((a) => a.startsWith("--output") || /^-[a-zA-Z]*o/.test(a));
		case "sed":
			// -i edits in place; a `w file` command (also `s/x/y/w file`) writes.
			return !rest.some((a) => a.startsWith("--in-place") || /^-[a-zA-Z]*i/.test(a) || /(^|[\s;{}/\d])[wW]\s+\S/.test(a));
		case "git": {
			let i = 0;
			while (i < rest.length && rest[i].startsWith("-")) {
				// -c can set config that runs programs.
				if (rest[i] === "-c" || rest[i].startsWith("--config")) return false;
				i += rest[i] === "-C" ? 2 : 1;
			}
			const sub = rest[i];
			if (sub === undefined || !GIT_READ_SUBCOMMANDS.has(sub)) return false;
			return !rest.some((a) => a.startsWith("--output") || a === "-O" || a.startsWith("--open-files-in-pager"));
		}
		case "cp": {
			if (rest.some((a) => a.startsWith("--target-directory") || /^-[a-zA-Z]*t/.test(a))) return false;
			const operands = rest.filter((a) => !a.startsWith("-"));
			return operands.length >= 2 && !mentions(operands[operands.length - 1]);
		}
		default:
			return false;
	}
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `dir` as a path in `text`, not as the prefix of a longer name (`/u/repo` vs `/u/repo-old`). */
export function pathPattern(dir: string): RegExp {
	return new RegExp(`${escapeRegExp(dir)}(?![\\w.-])`, "g");
}

function countMentions(text: string, mains: string[]): number {
	return mains.reduce((n, dir) => n + (text.match(pathPattern(dir))?.length ?? 0), 0);
}

/** Where bash starts (the worktree root) and the main checkout, for relative paths such as `../../a`. */
export type BashPlace = { root: string; mainRoot: string };

function inside(child: string, parent: string): boolean {
	return child === parent || child.startsWith(parent + path.sep);
}

/**
 * Stands in for the worktree root in a command (see guard.ts), so `<root>/x` does not read as
 * the main checkout that contains it while `<root>/../../x` still resolves from the root.
 */
export const WORKTREE_MARK = "\u0000worktree";

/** Path words with a `..` segment, also as the value of `--opt=../x` / `X=../x`. */
function dotDotPaths(word: string): string[] {
	const candidates = [word];
	const eq = word.indexOf("=");
	if (eq >= 0) candidates.push(word.slice(eq + 1));
	return candidates.filter((c) => !c.startsWith("~") && c.split("/").includes(".."));
}

/** Cheap pre-check for the guard: does the command have a `..` path segment at all? (`a..b` ranges do not count.) */
export function hasDotDotPath(command: string): boolean {
	return /(^|[^\w.])\.\.(\/|$|[^\w.])/m.test(command);
}

/**
 * Whether every simple command in `command` that names the main checkout (any spelling in
 * `mains`, a variable holding one, or a relative `..` path that leads into it from `place`)
 * only reads it: a known read command, and no output redirection into it.
 */
export function bashReadsOnly(command: string, mains: string[], place?: BashPlace): boolean {
	const mentionsMain = (word: string) => countMentions(word, mains) > 0;
	const lexed = lex(command);
	if (lexed === null) return false;
	const { commands, pipelines } = lexed;
	// Every literal mention must survive the split; a lost one (a path with `(` in it) could hide a write.
	const parsed = commands.reduce((n, words) => n + words.reduce((m, w) => m + countMentions(w.text, mains), 0), 0);
	if (parsed < countMentions(command, mains)) return false;
	// `M=/main; rm $M/x`: a variable holding a main-checkout path counts as naming it,
	// also through another variable (`S=$M`).
	const tainted = new Set<string>();
	const namesMain = (word: string) =>
		mentionsMain(word) || [...tainted].some((v) => new RegExp(`\\$(?:${v}\\b|\\{${v}[}:#%/^,@])`).test(word));
	const assignments = commands.flatMap((words) =>
		words.flatMap((w) => {
			const m = /^([A-Za-z_]\w*)=(.*)$/s.exec(w.text);
			return m ? [{ name: m[1], value: m[2] }] : [];
		}),
	);
	for (let grew = true; grew; ) {
		grew = false;
		for (const { name, value } of assignments) {
			if (!tainted.has(name) && namesMain(value)) {
				tainted.add(name);
				grew = true;
			}
		}
	}

	// Relative `..` paths resolve against bash's cwd: the worktree root, then wherever `cd` goes.
	// null = unknown (`cd $X`, `cd -`), where any `..` path counts as possibly naming main.
	let cwd: string | null = place?.root ?? null;
	const checks: Array<{ words: Word[]; mentions: (word: string) => boolean }> = [];
	for (const words of commands) {
		const at = cwd;
		const leadsIntoMain = (word: string) =>
			place !== undefined &&
			dotDotPaths(word).some((p) => {
				let resolved: string;
				if (p.startsWith(WORKTREE_MARK)) resolved = path.join(place.root, p.slice(WORKTREE_MARK.length));
				else if (p.startsWith("/")) resolved = path.resolve(p);
				else if (at === null) return true;
				else resolved = path.resolve(at, p);
				return inside(resolved, place.mainRoot) && !inside(resolved, place.root);
			});
		const mentions = (word: string) => namesMain(word) || leadsIntoMain(word);
		checks.push({ words, mentions });
		const args = words.filter((w) => !w.out).map((w) => w.text);
		while (args.length > 0 && /^[A-Za-z_]\w*=/.test(args[0])) args.shift();
		if (args[0] === "cd" || args[0] === "pushd") {
			const target = args.slice(1).find((a) => !a.startsWith("-") || a === "-");
			if (target === undefined || target === "-" || /[$~`*?]/.test(target)) cwd = null;
			else if (place !== undefined && target.startsWith(WORKTREE_MARK)) cwd = path.join(place.root, target.slice(WORKTREE_MARK.length));
			else if (target.startsWith("/")) cwd = path.resolve(target);
			else if (cwd !== null) cwd = path.resolve(cwd, target);
		}
	}
	if (!checks.some(({ words, mentions }) => words.some((w) => mentions(w.text)))) return true;

	// `cat <<EOF | sh`, `cat /main/x.sh | bash`, `ls /main | xargs rm`: code fed from a pipeline
	// that names the main checkout may write to it. `cp /main/a .; bash x.sh` is two pipelines.
	for (let k = 0; k < commands.length; k++) {
		if (!EXEC_COMMANDS.has(commandName(commands[k]) ?? "")) continue;
		const names = checks.some(
			({ words, mentions }, j) => pipelines[j] === pipelines[k] && words.some((w) => mentions(w.text)),
		);
		if (names) return false;
	}
	for (const { words, mentions } of checks) {
		if (!words.some((w) => mentions(w.text))) continue;
		if (words.some((w) => w.out && mentions(w.text))) return false;
		const args = words.filter((w) => !w.out).map((w) => w.text);
		while (args.length > 0 && /^[A-Za-z_]\w*=/.test(args[0])) args.shift();
		if (!readsOnly(args, mentions)) return false;
	}
	return true;
}
