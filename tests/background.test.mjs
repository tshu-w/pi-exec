import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-exec-background-home-"));
writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "settings.json"), JSON.stringify({ "pi-exec": { backgroundAfterSecs: 1 } }));
const { pi, ai, textOf, createSession, callTool, notifications } = await import("./pi.mjs");

const start = (cwd, eventBus) => createSession({
	eventBus,
	cwd,
	route: () => ai.fauxAssistantMessage("ok"),
	sessionManager: pi.SessionManager.create(cwd, join(cwd, "sessions")),
	tools: ["bash"],
});

test("a long command moves to the background, and its notification follows Pi's bash result", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-exec-background-"));
	const session = await start(cwd);
	try {
		const moved = await callTool(session, "bash", { command: "sleep 1.5; seq 1 3000; exit 1" });
		const { pgid, fullOutputPath } = moved.details;
		assert.equal(textOf(moved.content), `Command moved to the background (process group ${pgid}). Full output: ${fullOutputPath}`);
		assert.equal(moved.structuredContent, undefined);

		const [message] = await notifications(session, 1);
		const lines = Array.from({ length: 2000 }, (_, i) => i + 1001).join("\n");
		assert.match(textOf(message.content), new RegExp(`^<bash-result pgid="${pgid}" status="failed">\nCommand: sleep 1.5; seq 1 3000; exit 1\nWall time [\\d.]+ seconds\nOutput:\n\n`));
		assert.ok(textOf(message.content).endsWith(`\n\n${lines}\n\n[Showing lines 1001-3000 of 3000. Full output: ${fullOutputPath}]\n\nCommand exited with code 1\n</bash-result>`));
		assert.deepEqual(Object.keys(message.details).sort(), ["command", "fullOutputPath", "pgid", "seconds", "status", "truncation"]);
		assert.equal(readFileSync(fullOutputPath, "utf8").split("\n").length, 3001);

		const started = await callTool(session, "bash", { command: "printf 'one\\ntwo'", background: true });
		assert.match(textOf(started.content), /^Command started \(process group \d+\)\. Full output: .+\.log$/);
		const [, done] = await notifications(session, 2);
		assert.match(textOf(done.content), /status="completed">\nCommand: printf 'one\\ntwo'\nWall time [\d.]+ seconds\nOutput:\n\none\ntwo\n<\/bash-result>$/);
		assert.equal(done.details.fullOutputPath, undefined);

		// Commands that ended and notified are not reported again.
		await session.extensionRunner.emit({ type: "session_start", reason: "reload" });
		assert.equal((await notifications(session, 2)).length, 2);

		// A foreground command does not leave its log behind.
		const quick = await callTool(session, "bash", { command: "echo $PI_SESSION_ID" });
		assert.equal(textOf(quick.content), `${session.sessionManager.getSessionId()}\n`);

		// A command leads its own session, so it cannot take Pi's terminal.
		const leader = await callTool(session, "bash", { command: "ps -o stat= -p $(ps -o pgid= -p $$)" });
		assert.match(textOf(leader.content), /s/);

		const id = "parent/1";
		const nested = session.getToolDefinition("bash").execute(id, { command: "true", background: true }, undefined, undefined, session.extensionRunner.createToolContext(id));
		await assert.rejects(nested, /^Error: `background` is not available in nested tool calls\.$/);
	} finally {
		session.dispose();
	}
});

test("leaving the session stops background commands, and the next start reports them once", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-exec-background-"));
	const eventBus = pi.createEventBus();
	const busy = () => {
		const query = { busy: false };
		eventBus.emit("session:busy", query);
		return query.busy;
	};
	const session = await start(cwd, eventBus);
	assert.equal(busy(), false);
	const pidFile = join(cwd, "pid");
	const { details: { pgid, fullOutputPath } } = await callTool(session, "bash", { command: `echo $$ > ${pidFile}; exec sleep 300`, background: true });
	for (let i = 0; i < 50 && !existsSync(pidFile); i++) await new Promise((resolve) => setTimeout(resolve, 100));
	const pid = Number(readFileSync(pidFile, "utf8"));
	// A running background command keeps an idle session from being shut down.
	assert.equal(busy(), true);
	await session.extensionRunner.emit({ type: "session_shutdown" });
	assert.equal(busy(), false);
	const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
	for (let i = 0; i < 50 && alive(); i++) await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal(alive(), false);
	await new Promise((resolve) => setTimeout(resolve, 500));
	assert.equal(session.messages.filter((message) => message.customType === "bash-result").length, 0);

	for (let i = 0; i < 2; i++) await session.extensionRunner.emit({ type: "session_start", reason: "reload" });
	const reports = session.messages.filter((message) => message.customType === "bash-result");
	assert.equal(reports.length, 1);
	assert.equal(textOf(reports[0].content), `<bash-result pgid="${pgid}" status="stopped">\nCommand: echo $$ > ${pidFile}; exec sleep 300\nThe session ended before this command did.\nFull output: ${fullOutputPath}\n</bash-result>`);
	assert.equal(session.isStreaming, false);
	session.dispose();
});
