import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { findPiPackage, piDependency, piCompilerOptions } from "../scripts/pi-install.mjs";

const AGENT = "@earendil-works/pi-coding-agent";
const AI = "@earendil-works/pi-ai";
function fixture(t) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-exec-install-")));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}
function pkg(modules, name) {
	const dir = join(modules, name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name }));
	return dir;
}
function executable(file) {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, "#!/bin/sh\nexit 99\n");
	chmodSync(file, 0o755);
	return file;
}
function link(file, target) {
	mkdirSync(dirname(file), { recursive: true });
	symlinkSync(target, file);
}
function dependencies(modules) {
	for (const name of [AI, "@earendil-works/pi-codemode", "@earendil-works/pi-tui", "typebox", "@types/node"]) pkg(modules, name);
}

test("project npm Pi wins over PATH and resolves hoisted dependencies", (t) => {
	const root = fixture(t);
	const modules = join(root, "node_modules");
	const agent = pkg(modules, AGENT);
	dependencies(modules);
	const other = pkg(join(root, "global/lib/node_modules"), AGENT);
	link(join(root, "global/bin/pi"), executable(join(other, "dist/bundle/cli.js")));
	assert.equal(findPiPackage({ root, path: join(root, "global/bin") }), agent);
	assert.equal(piDependency(AI, agent), join(modules, AI));
	const options = piCompilerOptions(agent, root);
	assert.deepEqual(options.typeRoots, [join(modules, "@types")]);
	assert.deepEqual(options.paths[AI], [join(modules, AI, "dist/compat.d.ts")]);
	assert.deepEqual(options.paths["typebox/value"], [join(modules, "typebox/build/value/index.d.mts")]);
});

test("npm global bin symlink resolves the bundled CLI and nested dependencies", (t) => {
	const root = fixture(t);
	const agent = pkg(join(root, "global/lib/node_modules"), AGENT);
	const nested = join(agent, "node_modules");
	dependencies(nested);
	link(join(root, "global/bin/pi"), executable(join(agent, "dist/bundle/cli.js")));
	assert.equal(findPiPackage({ root, path: join(root, "global/bin") }), agent);
	assert.equal(piDependency(AI, agent), join(nested, AI));
	assert.deepEqual(piCompilerOptions(agent, root).typeRoots, [join(nested, "@types")]);
});

test("Homebrew Cellar wrapper and nested Pi packages still resolve", (t) => {
	const root = fixture(t);
	const cellar = join(root, "Cellar/pi-coding-agent/1.6.0");
	const agent = pkg(join(cellar, "libexec/lib/node_modules"), AGENT);
	dependencies(join(agent, "node_modules"));
	link(join(root, "bin/pi"), executable(join(cellar, "bin/pi")));
	assert.equal(findPiPackage({ root, path: join(root, "bin") }), agent);
	assert.deepEqual(piCompilerOptions(agent, root).paths[AGENT], [join(agent, "dist/index.d.ts")]);
});

test("missing Pi or dependency reports an actionable error without running the CLI", (t) => {
	const root = fixture(t);
	executable(join(root, "bin/pi"));
	assert.throws(() => findPiPackage({ root, path: join(root, "bin") }), /Pi not found/);
	const agent = pkg(join(root, "node_modules"), AGENT);
	assert.throws(() => piDependency(AI, agent), /Cannot resolve @earendil-works\/pi-ai/);
});
