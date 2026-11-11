import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-exec-agents-home-"));
const { pi, ai, createSession } = await import("./pi.mjs");

test("an Agent's Session inherits the environment, with cwd resolved there, and cannot be disowned", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-exec-agents-"));
	const sessionManager = pi.SessionManager.create(cwd, join(cwd, "sessions"));
	sessionManager.appendCustomEntry("env-state", { environment: "docker:box:/work", home: "/root" });
	const eventBus = pi.createEventBus();
	const session = await createSession({ cwd, eventBus, sessionManager, route: () => ai.fauxAssistantMessage("ok") });
	try {
		const child = (disown, cwd) => {
			const event = { id: "child", spawnerId: session.sessionManager.getSessionId(), disown, cwd, entries: [] };
			eventBus.emit("agent:spawn", event);
			return event;
		};
		assert.deepEqual(child(false, "src"), { id: "child", spawnerId: session.sessionManager.getSessionId(), disown: false, cwd: undefined, entries: [{ customType: "env-state", data: { environment: "docker:box:/work/src", home: "/root" } }] });
		assert.equal(child(true).error, "An Agent in an execution environment cannot disown an Agent.");
		await session.prompt("/env off");
		assert.deepEqual(child(false, "src"), { id: "child", spawnerId: session.sessionManager.getSessionId(), disown: false, cwd: "src", entries: [] });
	} finally {
		session.dispose();
	}
});
