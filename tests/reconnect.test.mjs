import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-exec-reconnect-home-"));
// An `ssh` that runs scripts locally; while `down` exists, it fails or hangs as `down` says, as an unreachable host does.
const bin = mkdtempSync(join(tmpdir(), "pi-exec-ssh-"));
const down = join(bin, "down");
writeFileSync(join(bin, "ssh"), `#!/bin/sh
[ "$(cat ${down} 2>/dev/null)" = hang ] && exec sleep 3600
[ -e ${down} ] && { echo "ssh: connect to host fake: Connection refused" >&2; exit 255; }
exec sh -c "$2"
`);
chmodSync(join(bin, "ssh"), 0o755);
process.env.PATH = `${bin}:${process.env.PATH}`;
const { pi, ai, textOf, createSession, callTool } = await import("./pi.mjs");

for (const mode of ["refuse", "hang"]) {
	test(`a command whose environment stays unreachable (${mode}) ends as failed after 5 minutes`, async () => {
		const cwd = realpathSync(mkdtempSync(join(tmpdir(), "pi-exec-reconnect-")));
		const eventBus = pi.createEventBus();
		const busy = () => {
			const query = { busy: false };
			eventBus.emit("session:busy", query);
			return query.busy;
		};
		const session = await createSession({
			cwd,
			eventBus,
			route: () => ai.fauxAssistantMessage("ok"),
			flags: { env: `ssh:fake:${cwd}` },
			sessionManager: pi.SessionManager.create(cwd, join(cwd, "sessions")),
			tools: ["bash"],
		});
		const realSetTimeout = setTimeout;
		const realDelay = (ms) => new Promise((resolve) => realSetTimeout(resolve, ms));
		const { details: { pgid } } = await callTool(session, "bash", { command: "sleep 600", background: true });
		try {
			mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
			writeFileSync(down, mode);
			// Ends the watcher, as a dropped connection does; [c] keeps pkill from matching itself.
			execFileSync("pkill", ["-f", `^sh -c [c]d '${cwd}'`]);
			const reported = () => session.messages.filter((message) => message.customType === "bash-result");
			for (let elapsed = 0; reported().length === 0 && elapsed <= 400_000; elapsed += 5000) {
				await realDelay(30);
				if (elapsed === 200_000) assert.equal(busy(), true);
				mock.timers.tick(5000);
			}
			const [message] = reported();
			assert.match(textOf(message.content), new RegExp(`^<bash-result pgid="${pgid}" status="failed">\\nCommand: sleep 600\\nWall time [\\d.]+ seconds\\nOutput:\\n\\n\\(no output\\)\\n\\nCommand lost because the environment became unreachable\\n</bash-result>$`));
			assert.ok(message.details.seconds >= 300 && message.details.seconds < 310);
			assert.equal(busy(), false);
		} finally {
			mock.timers.reset();
			rmSync(down, { force: true });
			process.kill(-pgid);
			session.dispose();
		}
	});
}
