import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const prefix = dirname(dirname(realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim())));
const PI_PACKAGE = join(prefix, "libexec/lib/node_modules/@earendil-works/pi-coding-agent");
export const EXTENSION = fileURLToPath(new URL("../src/index.ts", import.meta.url));

export const pi = await import(join(PI_PACKAGE, "dist/index.js"));
export const ai = await import(join(PI_PACKAGE, "node_modules/@earendil-works/pi-ai/dist/index.js"));

export const textOf = (content) => typeof content === "string"
	? content
	: content.filter((block) => block.type === "text").map((block) => block.text).join("\n");

/** Creates a Session in `cwd` with Pi Exec, whose faux model answers every request with `route`. */
export async function createSession({ cwd, route, flags = {}, eventBus, ...options }) {
	const agentDir = process.env.PI_CODING_AGENT_DIR;
	const faux = ai.fauxProvider({ provider: "faux", models: [{ id: "model" }], tokensPerSecond: 0 });
	faux.setResponses(Array.from({ length: 200 }, () => route));
	const modelRuntime = await pi.ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null });
	modelRuntime.registerNativeProvider(faux.provider);
	const settingsManager = pi.SettingsManager.create(cwd, agentDir, { projectTrusted: true });
	const resourceLoader = new pi.DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, additionalExtensionPaths: [EXTENSION], eventBus });
	await resourceLoader.reload();
	for (const [name, value] of Object.entries(flags)) resourceLoader.getExtensions().runtime.flagValues.set(name, value);
	const { session } = await pi.createAgentSession({ cwd, agentDir, settingsManager, resourceLoader, modelRuntime, model: faux.getModel(), ...options });
	await session.bindExtensions({ mode: "print" });
	return session;
}

/** Waits until the Session has `count` background command notifications, and returns them. */
export async function notifications(session, count, timeoutMs = 20_000) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const found = session.messages.filter((message) => message.role === "custom" && message.customType === "bash-result");
		if (found.length >= count) return found;
		if (Date.now() > deadline) throw new Error(`${found.length} of ${count} notifications`);
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

/** Calls a tool of the Session; resolves with its result or rejects with its error. */
export function callTool(session, name, args, signal = new AbortController().signal) {
	const id = `test-${Math.random().toString(36).slice(2)}`;
	return session.getToolDefinition(name).execute(id, args, signal, undefined, session.extensionRunner.createToolContext(id, signal));
}
