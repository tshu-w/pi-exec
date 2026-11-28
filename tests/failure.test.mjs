import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-exec-failure-home-"));
// Simulate a missing container without contacting a Docker daemon.
const bin = mkdtempSync(join(tmpdir(), "pi-exec-failure-bin-"));
writeFileSync(join(bin, "docker"), "#!/bin/sh\necho 'No such container' >&2\nexit 1\n", { mode: 0o755 });
process.env.PATH = `${bin}:${process.env.PATH}`;
after(() => rmSync(bin, { recursive: true, force: true }));
const { pi, ai, createSession, callTool } = await import("./pi.mjs");

const start = (cwd, flags, sessionManager) => createSession({ cwd, flags, sessionManager, route: () => ai.fauxAssistantMessage("ok"), tools: ["bash", "write"] });

async function assertBlocked(session, cwd) {
	await assert.rejects(callTool(session, "write", { path: "must-not-exist", content: "no" }), /is unavailable/);
	await assert.rejects(callTool(session, "bash", { command: "touch must-not-exist" }), /is unavailable/);
	await assert.rejects(session.extensionRunner.emitUserBash({ type: "user_bash", command: "touch must-not-exist", excludeFromContext: false, cwd }), /is unavailable/);
	assert.equal(existsSync(join(cwd, "must-not-exist")), false);
}

test("an unreachable --env blocks local execution, also in sessions that inherit it, until /env off", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-exec-failure-"));
	const session = await start(cwd, { env: "docker:pi-exec-does-not-exist:/work" }, pi.SessionManager.create(cwd, join(cwd, "sessions")));
	try {
		await assertBlocked(session, cwd);

		const saved = session.sessionManager.getBranch().filter((entry) => entry.customType === "env-state").pop();
		const childManager = pi.SessionManager.create(cwd, join(cwd, "child"));
		childManager.appendCustomEntry("env-state", structuredClone(saved.data));
		const child = await start(cwd, {}, childManager);
		try { await assertBlocked(child, cwd); } finally { child.dispose(); }

		await session.prompt("/env off");
		await callTool(session, "write", { path: "local-after-off", content: "ok" });
		assert.ok(existsSync(join(cwd, "local-after-off")));
	} finally {
		session.dispose();
	}
});
