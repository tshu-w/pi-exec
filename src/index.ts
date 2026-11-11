import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionToolContext,
	getAgentDir,
	getShellConfig,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { createUserBashOperations, executeBash } from "./bash.ts";
import { loadContextFiles } from "./context.ts";
import { exec, run, shellQuote } from "./exec.ts";
import { createEditOperations, createFindOperations, createLsOperations, createReadOperations, createWriteOperations } from "./files.ts";
import { grep } from "./grep.ts";
import { type BashResultDetails, type JobRecord, Jobs, MESSAGE_TYPE, titleOf } from "./jobs.ts";
import { registerJobsUi, renderBashResult } from "./ui.ts";
import {
	type Environment,
	expandHome,
	formatAddress,
	formatEnvironment,
	formatTarget,
	parseEnvironment,
	sameTarget,
	USAGE,
} from "./target.ts";

const ENTRY_TYPE = "env-state";
const JOB_ENTRY_TYPE = "bash-job";
const LOST_RESULT = "The session ended before this command did.";
const SETTINGS_KEY = "pi-exec";
const DEFAULT_BACKGROUND_AFTER_SECS = 120;
const ENV_TOOLS = ["read", "write", "edit", "bash", "grep", "find", "ls"];

type PersistedState = { environment: string; home: string } | { environment: null; error?: string };

type SessionEntry = { type: string; customType?: string; data?: unknown; details?: unknown };

/** Starts an environment from its spec: the path must exist; without one, the user's home. */
async function resolveEnvironment(spec: string): Promise<Environment> {
	const { target, path: cwd } = parseEnvironment(spec);
	const script = `${cwd ? `cd ${shellQuote(cwd)}` : "cd"} && printf '%s\\n%s' "$HOME" "$(pwd)"`;
	// Bounded probe: an unreachable environment must not hang /env or session start.
	const [home, resolved] = (await exec(target, script, { timeoutMs: 15_000 })).toString().split("\n");
	return { target, cwd: resolved, home };
}

function serialize(env: Environment | null, error?: string): PersistedState {
	if (env) return { environment: formatEnvironment(env), home: env.home };
	return error ? { environment: null, error } : { environment: null };
}

function deserialize(data: unknown): Environment | null {
	const record = data as Partial<{ environment: string | null; home: string }> | undefined;
	if (!record?.environment || typeof record.home !== "string") return null;
	try {
		const { target, path: cwd } = parseEnvironment(record.environment);
		return cwd ? { target, cwd, home: record.home } : null;
	} catch {
		return null;
	}
}

function findPersisted(entries: SessionEntry[]): { found: boolean; env: Environment | null; error?: string } {
	const entry = entries.filter((item) => item.type === "custom" && item.customType === ENTRY_TYPE).pop();
	if (!entry) return { found: false, env: null };
	const error = (entry.data as { error?: unknown } | undefined)?.error;
	return { found: true, env: deserialize(entry.data), error: typeof error === "string" ? error : undefined };
}

function sshHosts(): string[] {
	try {
		const content = fs.readFileSync(path.join(os.homedir(), ".ssh", "config"), "utf-8");
		const hosts = new Set<string>();
		for (const line of content.split(/\r?\n/)) {
			const match = line.trim().match(/^Host\s+(.+)$/i);
			if (!match) continue;
			for (const host of match[1].split(/\s+/)) if (host && !/[*?!]/.test(host)) hosts.add(host);
		}
		return [...hosts].sort();
	} catch {
		return [];
	}
}

function runningContainers(): string[] {
	try {
		return execFileSync("docker", ["ps", "--format", "{{.Names}}"], { encoding: "utf-8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] })
			.split("\n")
			.filter(Boolean)
			.sort();
	} catch {
		return [];
	}
}

/** `a, b, and c` */
function formatList(items: string[]): string {
	if (items.length <= 2) return items.join(" and ");
	return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

export default function (pi: ExtensionAPI) {
	pi.registerFlag("env", { description: `Execution environment: ${USAGE}`, type: "string" });

	const initialCwd = process.cwd();
	const jobs = new Jobs((text, details) => pi.sendMessage<BashResultDetails>(
		{ customType: MESSAGE_TYPE, content: text, display: true, details },
		{ deliverAs: "steer", triggerTurn: true },
	), (record) => pi.appendEntry<JobRecord>(JOB_ENTRY_TYPE, record));
	// Answered so that an idle session is not shut down while commands run.
	pi.events.on("session:busy", (query) => {
		if (jobs.list().some((job) => job.status === "running")) (query as { busy: boolean }).busy = true;
	});
	let backgroundAfterSecs = DEFAULT_BACKGROUND_AFTER_SECS;
	let shellPath: string | undefined;
	let shellCommandPrefix: string | undefined;
	let active: Environment | null = null;
	// Set when a requested environment failed; tools must not fall back to local execution.
	let failure: string | undefined;
	let sessionId: string | undefined;
	// An Agent that pi-agents creates runs in this environment, and its `cwd` is a path there.
	pi.events.on("agent:spawn", (data) => {
		const child = data as { spawnerId: string; disown: boolean; cwd?: string; entries: { customType: string; data: unknown }[]; error?: string };
		if (child.spawnerId !== sessionId || (!active && !failure)) return;
		if (child.disown) {
			if (active) child.error = "An Agent in an execution environment cannot disown an Agent.";
			return;
		}
		const env = active && child.cwd !== undefined ? { ...active, cwd: path.posix.resolve(active.cwd, expandHome(child.cwd, active.home)) } : active;
		child.entries.push({ customType: ENTRY_TYPE, data: serialize(env, failure) });
		if (active) child.cwd = undefined;
	});

	const current = () => {
		if (failure) throw new Error(failure);
		return active;
	};

	const toolList = () => formatList([...ENV_TOOLS.filter((name) => pi.getActiveTools().includes(name)), "user ! commands"]);

	const updateStatus = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		if (!active) return ctx.ui.setStatus("env", undefined);
		const label = active.target.backend === "ssh" ? "SSH" : "Docker";
		ctx.ui.setStatus("env", ctx.ui.theme.fg("accent", `${label}: ${formatAddress(active.target)}:${active.cwd}`));
	};

	/** Switches the environment and stops the commands started in the one left. */
	const setActive = (next: Environment | null, ctx: ExtensionContext, error?: string) => {
		const previous = active;
		active = next;
		failure = next ? undefined : error;
		if (!sameTarget(previous?.target, next?.target)) jobs.stopOutside(next?.target);
		updateStatus(ctx);
	};

	const persist = (ctx: ExtensionContext) => {
		const saved = findPersisted(ctx.sessionManager.getBranch() as SessionEntry[]);
		const same = saved.found && JSON.stringify(serialize(saved.env, saved.error)) === JSON.stringify(serialize(active, failure));
		if (!same) pi.appendEntry(ENTRY_TYPE, serialize(active, failure));
	};

	const notify = (ctx: ExtensionContext, message: string, type: "info" | "error" = "info") => {
		if (ctx.hasUI) ctx.ui.notify(message, type);
	};

	const announceEnabled = (ctx: ExtensionContext) => {
		notify(ctx, `Execution environment enabled: ${formatEnvironment(active!)} (disable: /env off)`);
	};

	const restore = (ctx: ExtensionContext) => {
		const saved = findPersisted(ctx.sessionManager.getBranch() as SessionEntry[]);
		setActive(saved.env, ctx, saved.error);
	};

	/** Reports the background commands of the branch without a notification in the session, in one notification without a turn. */
	const reportLost = async (ctx: ExtensionContext) => {
		const lost = new Map<string, JobRecord & { event: "started" }>();
		for (const entry of ctx.sessionManager.getBranch() as SessionEntry[]) {
			if (entry.type === "custom_message" && entry.customType === MESSAGE_TYPE && entry.details) {
				const { pgid, command } = entry.details as BashResultDetails;
				for (const [log, record] of lost) {
					if (record.pgid !== pgid || record.command !== command) continue;
					lost.delete(log);
					break;
				}
			}
			if (entry.type !== "custom" || entry.customType !== JOB_ENTRY_TYPE) continue;
			const record = entry.data as JobRecord;
			if (record.event === "started") lost.set(record.log, record);
			else lost.delete(record.log);
		}
		if (lost.size === 0) return;
		const results = await Promise.all([...lost.values()].map(async ({ pgid, log, command, environment }) => {
			const target = environment ? parseEnvironment(environment).target : undefined;
			const kept = await run(target, `test -f ${shellQuote(log)}`, { timeoutMs: 10_000 }).then((code) => code === 0, () => false);
			return `<${MESSAGE_TYPE} pgid="${pgid}" status="stopped">\nCommand: ${titleOf(command)}\n${LOST_RESULT}${kept ? `\nFull output: ${log}` : ""}\n</${MESSAGE_TYPE}>`;
		}));
		pi.sendMessage({ customType: MESSAGE_TYPE, content: results.join("\n\n"), display: true }, { deliverAs: "steer", triggerTurn: false });
		for (const { pgid, log } of lost.values()) pi.appendEntry<JobRecord>(JOB_ENTRY_TYPE, { event: "ended", pgid, log });
	};

	const base = {
		read: createReadToolDefinition(initialCwd),
		write: createWriteToolDefinition(initialCwd),
		edit: createEditToolDefinition(initialCwd),
		bash: createBashToolDefinition(initialCwd),
		grep: createGrepToolDefinition(initialCwd),
		find: createFindToolDefinition(initialCwd),
		ls: createLsToolDefinition(initialCwd),
	};

	const withPath = <T extends { path?: string }>(params: T, env: Environment): T =>
		params.path === undefined ? params : { ...params, path: expandHome(params.path, env.home) };

	pi.registerTool({
		...base.read,
		async execute(id, params, signal, onUpdate, ctx) {
			const env = current();
			if (!env) return createReadToolDefinition(ctx.cwd).execute(id, params, signal, onUpdate, ctx);
			const tool = createReadToolDefinition(env.cwd, { operations: createReadOperations({ target: env.target, signal }) });
			return tool.execute(id, withPath(params, env), signal, onUpdate, { ...ctx, cwd: env.cwd });
		},
	});

	pi.registerTool({
		...base.write,
		async execute(id, params, signal, onUpdate, ctx) {
			const env = current();
			if (!env) return createWriteToolDefinition(ctx.cwd).execute(id, params, signal, onUpdate, ctx);
			const tool = createWriteToolDefinition(env.cwd, { operations: createWriteOperations({ target: env.target, signal }) });
			return tool.execute(id, withPath(params, env), signal, onUpdate, { ...ctx, cwd: env.cwd });
		},
	});

	pi.registerTool({
		...base.edit,
		async execute(id, params, signal, onUpdate, ctx) {
			const env = current();
			if (!env) return createEditToolDefinition(ctx.cwd).execute(id, params, signal, onUpdate, ctx);
			const tool = createEditToolDefinition(env.cwd, { operations: createEditOperations({ target: env.target, signal }) });
			return tool.execute(id, withPath(params, env), signal, onUpdate, { ...ctx, cwd: env.cwd });
		},
	});

	const bash = {
		...base.bash,
		description: `${base.bash.description} When a background command ends, you receive a notification with the result.`,
		promptGuidelines: [
			...base.bash.promptGuidelines ?? [],
			"Use `background=true` for servers, watchers, and other commands that do not exit on their own; do not poll a background command for its end.",
		],
		parameters: Type.Object({
			...base.bash.parameters.properties,
			background: Type.Optional(Type.Boolean({ description: "Whether to return at once and run the command in the background (default: false)" })),
		}),
		async execute(id: string, params: { command: string; timeout?: number; background?: boolean }, signal: AbortSignal | undefined, onUpdate: any, ctx: ExtensionToolContext) {
			const env = current();
			// Pi numbers the calls another tool makes `<calling id>/<n>`.
			const nested = id.includes("/");
			if (params.background && nested) throw new Error("`background` is not available in nested tool calls.");
			const moveAfterMs = params.background ? 0 : nested ? undefined : backgroundAfterSecs * 1000;
			// Pi's shell settings are for the local shell.
			const options = { moveAfterMs, started: params.background, ...(!env && { shell: localShell(), commandPrefix: shellCommandPrefix }) };
			return executeBash(jobs, env?.target, env?.cwd ?? ctx.cwd, options, [id, params, signal, onUpdate, env ? { ...ctx, cwd: env.cwd } : ctx]);
		},
		renderResult: renderBashResult(base.bash.renderResult!),
	};
	pi.registerTool(bash);
	const ui = registerJobsUi(pi, jobs, bash);

	const localShell = () => {
		const { shell, args } = getShellConfig(shellPath);
		return [shell, ...args];
	};

	pi.registerTool({
		...base.grep,
		defaultActive: false,
		async execute(id, params, signal, onUpdate, ctx) {
			const env = current();
			if (!env) return createGrepToolDefinition(ctx.cwd).execute(id, params, signal, onUpdate, ctx);
			const searchPath = path.posix.resolve(env.cwd, expandHome(params.path || ".", env.home));
			return grep(env.target, searchPath, params, signal);
		},
	});

	pi.registerTool({
		...base.find,
		defaultActive: false,
		async execute(id, params, signal, onUpdate, ctx) {
			const env = current();
			if (!env) return createFindToolDefinition(ctx.cwd).execute(id, params, signal, onUpdate, ctx);
			const tool = createFindToolDefinition(env.cwd, { operations: createFindOperations({ target: env.target, signal }) });
			return tool.execute(id, withPath(params, env), signal, onUpdate, { ...ctx, cwd: env.cwd });
		},
	});

	pi.registerTool({
		...base.ls,
		defaultActive: false,
		async execute(id, params, signal, onUpdate, ctx) {
			const env = current();
			if (!env) return createLsToolDefinition(ctx.cwd).execute(id, params, signal, onUpdate, ctx);
			const tool = createLsToolDefinition(env.cwd, { operations: createLsOperations({ target: env.target, signal }) });
			return tool.execute(id, withPath(params, env), signal, onUpdate, { ...ctx, cwd: env.cwd });
		},
	});

	pi.registerCommand("env", {
		description: "Show or switch the execution environment. Use `/env off` to return to local execution.",
		getArgumentCompletions: (prefix): AutocompleteItem[] | null => {
			const items: AutocompleteItem[] = [{ value: "off", label: "off", description: "Return to local execution" }];
			if (active) items.push({ value: formatEnvironment(active), label: formatTarget(active.target), description: `Current environment (${active.cwd})` });
			for (const name of runningContainers()) items.push({ value: `docker:${name}`, label: `docker:${name}`, description: "Running container" });
			for (const host of sshHosts()) items.push({ value: `ssh:${host}`, label: `ssh:${host}`, description: "Host from ~/.ssh/config" });
			const trimmed = prefix.trim();
			const unique = items.filter((item, index) => items.findIndex((other) => other.value === item.value) === index);
			const filtered = unique.filter((item) => !trimmed || item.value.startsWith(trimmed));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const spec = args?.trim() ?? "";
			if (!spec) {
				notify(ctx, active
					? `Execution environment: ${formatEnvironment(active)} (disable: /env off)`
					: failure ?? `Execution environment: off. Enable with /env ${USAGE}.`);
				return;
			}
			if (spec === "off") {
				if (!active && !failure) return;
				setActive(null, ctx);
				persist(ctx);
				notify(ctx, "Execution environment disabled.");
				return;
			}
			try {
				setActive(await resolveEnvironment(spec), ctx);
			} catch (error) {
				notify(ctx, `Failed to enable execution environment: ${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			}
			persist(ctx);
			announceEnabled(ctx);
		},
	});

	pi.on("session_start", async (event, ctx) => {
		sessionId = ctx.sessionManager.getSessionId();
		const settings = SettingsManager.create(ctx.cwd, getAgentDir());
		shellPath = settings.getShellPath();
		shellCommandPrefix = settings.getShellCommandPrefix();
		const seconds = (settings.getSettings() as Record<string, any>)[SETTINGS_KEY]?.backgroundAfterSecs;
		const valid = typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0;
		backgroundAfterSecs = valid ? seconds : DEFAULT_BACKGROUND_AFTER_SECS;
		jobs.open();
		ui.start(ctx);
		await reportLost(ctx);
		const flag = pi.getFlag("env");
		const persisted = findPersisted(ctx.sessionManager.getBranch() as SessionEntry[]);
		if (typeof flag === "string" && flag.trim() && (event.reason === "startup" || event.reason === "new" || !persisted.found)) {
			try {
				setActive(await resolveEnvironment(flag), ctx);
				persist(ctx);
				if (event.reason === "startup") announceEnabled(ctx);
				return;
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				setActive(null, ctx, `Execution environment ${flag} is unavailable.\n${reason.trim().replace(/^/gm, "  ")}\nUse /env to select a working environment, or /env off to run locally.`);
				persist(ctx);
				notify(ctx, failure!, "error");
				return;
			}
		}
		restore(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => restore(ctx));

	pi.on("session_shutdown", async () => {
		active = null;
		ui.stop();
		await jobs.shutdown();
	});

	pi.on("user_bash", () => {
		const env = current();
		if (!env) return;
		const ops = createUserBashOperations(jobs, env.target);
		return { operations: { exec: (command, _cwd, options) => ops.exec(command, env.cwd, options) } };
	});

	pi.on("before_agent_start", async (event) => {
		const env = active;
		if (!env) return;
		const options = event.systemPromptOptions;
		options.cwd = env.cwd;
		options.sections.env = `Execution environment: ${formatTarget(env.target)}. ${toolList()} execute there; other tools run locally.\n/env off switches them back to local execution.`;
		// Keep the global context file; project ones come from the environment.
		const agentDir = path.resolve(getAgentDir());
		const global = options.contextFiles.filter((file) => path.dirname(file.path) === agentDir);
		const project = await loadContextFiles(env.target, env.cwd).catch(() => []);
		options.contextFiles = [...global, ...project];
	});
}
