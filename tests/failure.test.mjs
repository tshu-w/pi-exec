import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-exec-failure-home-"));
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
