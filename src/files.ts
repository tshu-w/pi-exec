import { constants } from "node:fs";
import { access as fsAccess, open, readFile as fsReadFile } from "node:fs/promises";
import { posix } from "node:path";
import {
	detectSupportedImageMimeTypeFromFile,
	type EditOperations,
	type FindOperations,
	type LsOperations,
	type ReadOperations,
	type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { exec, run, shellQuote } from "./exec.ts";
import type { Target } from "./target.ts";

type Ops = { target: Target; signal?: AbortSignal };

function detectImage(buffer: Buffer): string | null {
	if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
	if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
	if (buffer.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
	if (buffer.subarray(0, 4).toString("latin1") === "RIFF" && buffer.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
	return null;
}

/** Checks a file like fs.access: missing and unpermitted files fail with Node's messages. */
async function access({ target, signal }: Ops, path: string, ...tests: string[]): Promise<void> {
	const quoted = shellQuote(path);
	const script = `[ -e ${quoted} ] || exit 3; ${tests.map((test) => `[ ${test} ${quoted} ] || exit 4`).join("; ")}`;
	let stderr = "";
	const code = await run(target, script, { signal, onStderr: (data) => { stderr += data.toString(); } });
	if (code === 3) throw new Error(`ENOENT: no such file or directory, access '${path}'`);
	if (code === 4) throw new Error(`EACCES: permission denied, access '${path}'`);
	if (code !== 0) throw new Error(stderr.trim() || `${target.backend} exited with code ${code}`);
}

/**
 * Pi's local read operations. Temporary: in Pi 1.5.1, an abort between opening the file and reading it
 * makes the stream emit an AbortError with no listener, which crashes Pi. The listener here only stops
 * that; read errors still reject the read through the stream's iterator. Remove once Pi handles it.
 */
export const localReadOperations: ReadOperations = {
	readFile: (path) => fsReadFile(path),
	access: (path) => fsAccess(path, constants.R_OK),
	detectImageMimeType: detectSupportedImageMimeTypeFromFile,
	async *createReadStream(path, { signal }) {
		const handle = await open(path, "r");
		try {
			const stats = await handle.stat();
			const end = stats.isFile() && stats.size > 0 ? stats.size - 1 : undefined;
			const stream = handle.createReadStream({ end, signal, autoClose: false });
			stream.on("error", () => {});
			yield* stream;
		} finally {
			await handle.close();
		}
	},
};

export function createReadOperations({ target, signal }: Ops): ReadOperations {
	// read detects the image type and then reads the same file: one transfer serves both.
	const files = new Map<string, Promise<Buffer>>();
	const readFile = (path: string) => {
		let file = files.get(path);
		if (!file) {
			file = exec(target, `cat -- ${shellQuote(path)}`, { signal });
			files.set(path, file);
		}
		return file;
	};
	return {
		readFile,
		access: (path) => access({ target, signal }, path, "-r"),
		detectImageMimeType: async (path) => detectImage(await readFile(path)),
	};
}

export function createWriteOperations({ target, signal }: Ops): WriteOperations {
	return {
		writeFile: async (path, content) => {
			const expectedBytes = Buffer.byteLength(content);
			const script =
				`set -eu; target=${shellQuote(path)}; tmp=$(mktemp "\${target}.XXXXXX"); ` +
				`trap 'rm -f "$tmp"' EXIT HUP INT TERM; cat > "$tmp"; ` +
				`actual=$(wc -c < "$tmp"); ` +
				`if [ "$actual" -ne ${expectedBytes} ]; then ` +
				`printf 'incomplete write: expected ${expectedBytes} bytes, received %s bytes\\n' "$actual" >&2; exit 1; fi; ` +
				`if [ -e "$target" ]; then ` +
				`mode=$(stat -c %a "$target" 2>/dev/null || stat -f %Lp "$target"); chmod "$mode" "$tmp"; ` +
				`else chmod 644 "$tmp"; fi; mv "$tmp" "$target"; trap - EXIT`;
			await exec(target, script, { signal, input: content });
		},
		mkdir: async (path) => {
			await exec(target, `mkdir -p -- ${shellQuote(path)}`, { signal });
		},
	};
}

export function createEditOperations(ops: Ops): EditOperations {
	const write = createWriteOperations(ops);
	return {
		readFile: (path) => exec(ops.target, `cat -- ${shellQuote(path)}`, { signal: ops.signal }),
		access: (path) => access(ops, path, "-r", "-w"),
		writeFile: write.writeFile,
	};
}

type Kind = "d" | "f" | null;

function kindScript(path: string): string {
	const quoted = shellQuote(path);
	return `if [ -d ${quoted} ]; then echo d; elif [ -e ${quoted} ]; then echo f; fi`;
}

function stat(kind: Kind, path: string) {
	if (!kind) throw new Error(`ENOENT: no such file or directory, stat '${path}'`);
	return { isDirectory: () => kind === "d" };
}

export function createLsOperations({ target, signal }: Ops): LsOperations {
	// ls stats every entry; listing the directory records their kinds in one call.
	const kinds = new Map<string, Kind>();
	const kindOf = async (path: string): Promise<Kind> => {
		if (!kinds.has(path)) kinds.set(path, ((await exec(target, kindScript(path), { signal })).toString().trim() || null) as Kind);
		return kinds.get(path)!;
	};
	return {
		exists: async (path) => (await kindOf(path)) !== null,
		stat: async (path) => stat(await kindOf(path), path),
		readdir: async (path) => {
			const script =
				`cd -- ${shellQuote(path)} || exit 1; for f in .* *; do ` +
				`case "$f" in .|..) continue;; esac; ` +
				`if [ -d "$f" ]; then printf 'd%s\\0' "$f"; elif [ -e "$f" ] || [ -L "$f" ]; then printf 'f%s\\0' "$f"; fi; done`;
			const output = (await exec(target, script, { signal })).toString();
			const names: string[] = [];
			for (const item of output.split("\0")) {
				if (!item) continue;
				const name = item.slice(1);
				kinds.set(posix.join(path, name), item[0] as Kind);
				names.push(name);
			}
			return names;
		},
	};
}

/** Converts a glob to a regex: `**` crosses directories and matches hidden files, like fd --hidden. */
export function globToRegExp(glob: string): RegExp {
	let source = "";
	for (let i = 0; i < glob.length; i++) {
		const char = glob[i];
		if (char === "*" && glob[i + 1] === "*") {
			if (glob[i + 2] === "/") {
				source += "(?:.*/)?";
				i += 2;
			} else {
				source += ".*";
				i += 1;
			}
		} else if (char === "*") source += "[^/]*";
		else if (char === "?") source += "[^/]";
		else if (char === "[") {
			const end = glob.indexOf("]", i + 1);
			if (end === -1) source += "\\[";
			else {
				source += `[${glob.slice(i + 1, end).replace(/^!/, "^").replace(/\\/g, "\\\\")}]`;
				i = end;
			}
		} else if (char === "{") {
			const end = glob.indexOf("}", i + 1);
			if (end === -1) source += "\\{";
			else {
				source += `(?:${glob.slice(i + 1, end).split(",").map((part) => globToRegExp(part).source.slice(1, -1)).join("|")})`;
				i = end;
			}
		} else source += char.replace(/[.+^$()|\\]/g, "\\$&");
	}
	return new RegExp(`^${source}$`);
}

export function createFindOperations({ target, signal }: Ops): FindOperations {
	return {
		exists: async (path) => (await exec(target, kindScript(path), { signal })).toString().trim() !== "",
		glob: async (pattern, root, { limit }) => {
			// Like fd: a pattern without a slash matches file names, one with a slash matches paths.
			const fullPath = pattern.includes("/");
			const regex = globToRegExp(fullPath && !pattern.startsWith("/") && !pattern.startsWith("**/") ? `**/${pattern}` : pattern);
			const matches = (file: string) => {
				if (!fullPath) return regex.test(posix.basename(file));
				return regex.test(pattern.startsWith("/") ? posix.join(root, file) : file);
			};
			// Inside a git work tree, list files that git does not ignore; elsewhere, all files.
			const script =
				`cd -- ${shellQuote(root)} || exit 1; ` +
				`if command -v git >/dev/null 2>&1 && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then ` +
				`git ls-files -z --cached --others --exclude-standard; ` +
				`else find . \\( -name .git -o -name node_modules \\) -prune -o ! -type d -print0; fi`;
			const results: string[] = [];
			const stop = new AbortController();
			const onAbort = () => stop.abort();
			signal?.addEventListener("abort", onAbort, { once: true });
			let rest = "";
			let stderr = "";
			try {
				const code = await run(target, script, {
					signal: stop.signal,
					onStdout: (data) => {
						const items = (rest + data.toString()).split("\0");
						rest = items.pop()!;
						for (const item of items) {
							const file = item.replace(/^\.\//, "");
							if (results.length >= limit) break;
							if (file && !file.split("/").includes("node_modules") && matches(file)) results.push(file);
						}
						if (results.length >= limit) stop.abort();
					},
					onStderr: (data) => {
						stderr += data.toString();
					},
				});
				rest = rest.replace(/^\.\//, "");
				if (rest && results.length < limit && matches(rest)) results.push(rest);
				if (code !== 0) throw new Error(stderr.trim() || `${target.backend} exited with code ${code}`);
			} catch (error) {
				if (signal?.aborted || results.length < limit) throw error;
			} finally {
				signal?.removeEventListener("abort", onAbort);
			}
			return results;
		},
	};
}
