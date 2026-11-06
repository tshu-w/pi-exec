import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-exec-home-"));
const { pi, ai, textOf, createSession, callTool, notifications } = await import("./pi.mjs");

const IMAGE = process.env.PI_EXEC_TEST_IMAGE ?? "alpine:3";
const dockerReady = spawnSync("docker", ["image", "inspect", IMAGE], { stdio: "ignore" }).status === 0;
const container = `pi-exec-test-${process.pid}`;
const sh = (script) => execFileSync("docker", ["exec", container, "sh", "-c", script], { encoding: "utf8" });
const alive = (pid) => spawnSync("docker", ["exec", container, "kill", "-0", pid]).status === 0;

before(() => {
	if (!dockerReady) return;
	// --init reaps killed processes, so `kill -0` sees them gone.
	execFileSync("docker", ["run", "-d", "--rm", "--init", "--name", container, IMAGE, "sleep", "3600"], { stdio: "ignore" });
	sh("mkdir -p /work/src/lib /work/node_modules/x && echo 'hello world' > /work/src/a.ts && echo 'x' > /work/src/lib/b.ts && echo y > /work/node_modules/x/c.ts && echo 'Project rules' > /work/AGENTS.md");
});

after(() => {
	if (dockerReady) spawnSync("docker", ["rm", "-f", container], { stdio: "ignore" });
});

async function startSession(options = {}) {
	const cwd = mkdtempSync(join(tmpdir(), "pi-exec-cwd-"));
	const prompts = [];
	const route = (context) => {
		const system = context.messages.find((message) => message.role === "system");
		prompts.push(Object.values(system?.sections ?? {}).join("\n"));
		return ai.fauxAssistantMessage("ok");
	};
	const sessionManager = options.sessionManager ?? pi.SessionManager.create(cwd, join(cwd, "sessions"));
	const session = await createSession({ cwd, route, sessionManager, tools: ["read", "write", "edit", "bash", "grep", "find", "ls"] });
	return { cwd, session, prompts };
}

const skip = !dockerReady && `${IMAGE} is not available`;

test("file tools work on environment files and keep permissions", { skip }, async () => {
	const { cwd, session } = await startSession();
	await session.prompt(`/env docker:${container}:/work`);

	await callTool(session, "write", { path: "notes/plan.txt", content: "one\ntwo\n" });
	assert.equal(sh("cat /work/notes/plan.txt"), "one\ntwo\n");
	assert.equal(existsSync(join(cwd, "notes")), false);

	sh("printf '#!/bin/sh\\necho old\\n' > /work/run.sh && chmod 750 /work/run.sh");
	await callTool(session, "edit", { path: "/work/run.sh", edits: [{ oldText: "old", newText: "new" }] });
	assert.equal(sh("stat -c %a /work/run.sh && /work/run.sh"), "750\nnew\n");

	const read = await callTool(session, "read", { path: "~/../work/src/a.ts" });
	assert.equal(textOf(read.content), "hello world\n");

	const ls = await callTool(session, "ls", {});
	assert.deepEqual(textOf(ls.content).split("\n"), ["AGENTS.md", "node_modules/", "notes/", "run.sh", "src/"]);

	const found = await callTool(session, "find", { pattern: "*.ts" });
	assert.deepEqual(textOf(found.content).split("\n").sort(), ["src/a.ts", "src/lib/b.ts"]);
	const nested = await callTool(session, "find", { pattern: "src/**/*.ts" });
	assert.deepEqual(textOf(nested.content).split("\n").sort(), ["src/a.ts", "src/lib/b.ts"]);

	await assert.rejects(callTool(session, "grep", { pattern: "hello" }), /rg is not available in the execution environment\. Use bash to search\./);
	if (spawnSync("docker", ["exec", container, "apk", "add", "-q", "ripgrep"], { stdio: "ignore", timeout: 60_000 }).status === 0) {
		const grep = await callTool(session, "grep", { pattern: "hello|x", path: "src" });
		assert.deepEqual(textOf(grep.content).split("\n").sort(), ["a.ts:1: hello world", "lib/b.ts:1: x"]);
		const limited = await callTool(session, "grep", { pattern: "hello|x", path: "src", limit: 1 });
		assert.match(textOf(limited.content), /1 matches limit reached/);
	}
	session.dispose();
});

test("bash runs in the environment and its long output stays there", { skip }, async () => {
	const { session } = await startSession();
	await session.prompt(`/env docker:${container}:/work/src`);

	const pwd = await callTool(session, "bash", { command: "pwd; echo $PI_SESSION_ID" });
	assert.equal(textOf(pwd.content), `/work/src\n${session.sessionManager.getSessionId()}\n`);

	const long = await callTool(session, "bash", { command: "seq 1 5000" });
	const fullPath = long.details.fullOutputPath;
	assert.match(textOf(long.content), new RegExp(`Full output: ${fullPath}\\]`));
	assert.equal(existsSync(fullPath), false);
	assert.equal(sh(`wc -l < ${fullPath}`).trim(), "5000");

	const failed = await callTool(session, "bash", { command: "echo partial; exit 3" });
	assert.equal(failed.isError, true);
	assert.match(textOf(failed.content), /partial\n\n\nCommand exited with code 3|partial\n\nCommand exited with code 3/);

	const hook = await session.extensionRunner.emitUserBash({ type: "user_bash", command: "pwd", excludeFromContext: false, cwd: session.sessionManager.getCwd() });
	const user = await session.executeBash("pwd", undefined, { operations: hook.operations });
	assert.equal(user.output.trim(), "/work/src");
	session.dispose();
});

test("a command ends with its shell, and timeout stops every process it started", { skip }, async () => {
	const { session } = await startSession();
	await session.prompt(`/env docker:${container}:/work`);

	const started = Date.now();
	const background = await callTool(session, "bash", { command: "sleep 30 & echo $! > /work/bg.pid; echo done" });
	assert.equal(textOf(background.content), "done\n");
	assert.ok(Date.now() - started < 5000);

	await assert.rejects(callTool(session, "bash", { command: "sleep 300 & echo $! > /work/child.pid; sleep 300", timeout: 1 }), /timed out after 1 seconds/);
	const child = sh("cat /work/child.pid").trim();
	for (let i = 0; i < 50 && alive(child); i++) await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal(alive(child), false);
	session.dispose();
});

test("the system prompt uses the environment, and resuming restores it", { skip }, async () => {
	const { cwd, session, prompts } = await startSession();
	await session.prompt(`/env docker:${container}:/work`);
	await session.prompt("hi");
	const prompt = prompts.at(-1);
	assert.match(prompt, /Execution environment: docker:pi-exec-test-\d+\. read, write, edit, bash, grep, find, ls, and user ! commands execute there; other tools run locally\./);
	assert.match(prompt, /Project rules/);
	assert.match(prompt, /\/work/);
	const file = session.sessionManager.getSessionFile();
	session.dispose();

	const resumed = await startSession({ sessionManager: pi.SessionManager.open(file, join(cwd, "sessions")) });
	const pwd = await callTool(resumed.session, "bash", { command: "pwd" });
	assert.equal(textOf(pwd.content), "/work\n");
	resumed.session.dispose();
});

test("switching the environment stops its commands", { skip }, async () => {
	const { session } = await startSession();
	await session.prompt(`/env docker:${container}:/work`);
	const background = await callTool(session, "bash", { command: "sleep 300", background: true });
	const foreground = callTool(session, "bash", { command: "echo partial; sleep 300" });
	await new Promise((resolve) => setTimeout(resolve, 1000));
	await session.prompt("/env off");
	await assert.rejects(foreground, /^Error: partial\n\n\nCommand stopped because the environment changed$/);
	const [message] = await notifications(session, 1);
	assert.match(textOf(message.content), new RegExp(`^<bash-result pgid="${background.details.pgid}" status="stopped">\\nCommand: sleep 300\\nWall time [\\d.]+ seconds\\nOutput:\\n\\nCommand stopped because the environment changed\\n</bash-result>$`));
	assert.equal(alive(background.details.pgid), false);
	session.dispose();
});

test("a background command's result survives a dropped connection", { skip }, async () => {
	const { session } = await startSession();
	await session.prompt(`/env docker:${container}:/work`);
	await callTool(session, "bash", { command: "sleep 1; echo after; exit 3", background: true });
	await new Promise((resolve) => setTimeout(resolve, 300));
	// Ends the watcher in the container, as a dropped connection does; [c] keeps pkill from matching itself.
	sh(`pkill -f "^sh -c [c]d '/work'"`);
	const [message] = await notifications(session, 1);
	assert.match(textOf(message.content), /status="failed">[\s\S]*Output:\n\nafter\n\n\nCommand exited with code 3\n<\/bash-result>$/);
	session.dispose();
});
