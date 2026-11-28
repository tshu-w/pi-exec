import { accessSync, constants, readFileSync, realpathSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const AGENT = "@earendil-works/pi-coding-agent";

function packageAt(directory, name) {
	try {
		const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
		return manifest.name === name ? realpathSync(directory) : undefined;
	} catch (error) {
		if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
	}
}

function* ancestors(directory) {
	for (let current = resolve(directory); ; current = dirname(current)) {
		yield current;
		if (dirname(current) === current) return;
	}
}

/** Resolve packages from an importer, including npm-hoisted dependencies. */
export function findPackage(name, from) {
	for (const directory of ancestors(from)) {
		const found = packageAt(join(directory, "node_modules", name), name);
		if (found) return found;
	}
}

/** Prefer a project-local Pi, otherwise follow the pi executable on PATH. */
export function findPiPackage({ root = projectRoot, path = process.env.PATH ?? "" } = {}) {
	const local = findPackage(AGENT, root);
	if (local) return local;
	for (const directory of path.split(delimiter)) {
		if (!directory) continue;
		const executable = join(directory, "pi");
		let resolved;
		try {
			accessSync(executable, constants.X_OK);
			resolved = realpathSync(executable);
		} catch { continue; }
		// npm links directly into the package; Homebrew links to a Cellar bin
		// entry that may instead be a wrapper around the libexec installation.
		for (const parent of ancestors(dirname(resolved))) {
			const found = packageAt(parent, AGENT) ?? packageAt(join(parent, "libexec/lib/node_modules", AGENT), AGENT);
			if (found) return found;
		}
	}
	throw new Error("Pi not found: install @earendil-works/pi-coding-agent@1.6 locally or put an npm/Homebrew pi on PATH.");
}

export function piDependency(name, agent) {
	const found = findPackage(name, agent);
	if (!found) throw new Error(`Cannot resolve ${name} from Pi at ${agent}`);
	return found;
}

export function piCompilerOptions(agent, root = projectRoot) {
	const ai = piDependency("@earendil-works/pi-ai", agent);
	const codemode = piDependency("@earendil-works/pi-codemode", agent);
	const tui = piDependency("@earendil-works/pi-tui", agent);
	const typebox = piDependency("typebox", agent);
	const nodeTypes = findPackage("@types/node", root) ?? findPackage("@types/node", agent);
	if (!nodeTypes) throw new Error("Node types not found: install @types/node@22 for development.");
	return {
		typeRoots: [dirname(nodeTypes)],
		paths: {
			[AGENT]: [join(agent, "dist/index.d.ts")],
			"@earendil-works/pi-ai": [join(ai, "dist/compat.d.ts")],
			"@earendil-works/pi-ai/compat": [join(ai, "dist/compat.d.ts")],
			"@earendil-works/pi-codemode": [join(codemode, "dist/index.d.ts")],
			"@earendil-works/pi-tui": [join(tui, "dist/index.d.ts")],
			"typebox": [join(typebox, "build/index.d.mts")],
			"typebox/value": [join(typebox, "build/value/index.d.mts")],
		},
	};
}
