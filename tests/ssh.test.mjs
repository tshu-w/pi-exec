import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-exec-home-"));
const { pi, ai, textOf, createSession, callTool } = await import("./pi.mjs");

const HOST = process.env.PI_EXEC_TEST_SSH ?? "localhost";
const ssh = (script) => execFileSync("ssh", ["-o", "BatchMode=yes", HOST, script], { encoding: "utf8" });
const sshReady = spawnSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", HOST, "true"], { stdio: "ignore" }).status === 0;
const alive = (pid) => spawnSync("ssh", ["-o", "BatchMode=yes", HOST, `kill -0 ${pid}`], { stdio: "ignore" }).status === 0;
let root;

before(() => {
	if (!sshReady) return;
	root = ssh("mktemp -d").trim();
	ssh(`mkdir -p ${root}/src && printf 'alpha\\nneedle one\\nbeta\\n' > ${root}/src/a.txt`);
});

after(() => {
	if (sshReady && root) spawnSync("ssh", ["-o", "BatchMode=yes", HOST, `rm -rf ${root}`], { stdio: "ignore" });
});

test("tools run on the SSH host, and timeout stops every process", { skip: !sshReady && `ssh ${HOST} is not available` }, async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-exec-cwd-"));
	const session = await createSession({
		cwd,
		route: () => ai.fauxAssistantMessage("ok"),
		sessionManager: pi.SessionManager.create(cwd, join(cwd, "sessions")),
		tools: ["read", "write", "bash", "grep"],
	});
	await session.prompt(`/env ssh:${HOST}:${root}`);

	await callTool(session, "write", { path: "out.txt", content: "it's $HOME\n" });
	assert.equal(ssh(`cat ${root}/out.txt`), "it's $HOME\n");

	const pwd = await callTool(session, "bash", { command: "pwd" });
	assert.equal(textOf(pwd.content).trim().replace(/^\/private/, ""), root.replace(/^\/private/, ""));

	if (spawnSync("ssh", ["-o", "BatchMode=yes", HOST, "command -v rg"], { stdio: "ignore" }).status === 0) {
		const found = await callTool(session, "grep", { pattern: "needle", context: 1 });
		assert.equal(textOf(found.content), "src/a.txt-1- alpha\nsrc/a.txt:2: needle one\nsrc/a.txt-3- beta");
	}

	await assert.rejects(callTool(session, "bash", { command: `sleep 300 & echo $! > ${root}/child.pid; sleep 300`, timeout: 1 }), /timed out after 1 seconds/);
	const child = ssh(`cat ${root}/child.pid`).trim();
	for (let i = 0; i < 50 && alive(child); i++) await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal(alive(child), false);
	session.dispose();
});
