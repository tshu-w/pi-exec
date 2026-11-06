import { rm } from "node:fs/promises";
import { type AgentToolResult, type BashOperations, createBashToolDefinition, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { removeLog } from "./detached.ts";
import { appendStatus, ENDINGS, formatOutput, type Job, type Jobs } from "./jobs.ts";
import type { Target } from "./target.ts";

const MOVED = "pi-exec:moved";
const ENVIRONMENT_CHANGED = "pi-exec:environment-changed";

type BashOptions = {
	/** Shell and arguments before the command; by default bash, or sh, in the environment. */
	shell?: string[];
	/** Moves the command to the background after this long; never when undefined. */
	moveAfterMs?: number;
	onJob?: (job: Job) => void;
};

/**
 * Bash operations that run each command detached in the environment, or locally without a target.
 * A timeout or abort stops the command's process group. The call ends when the command's shell
 * exits, even if background processes keep its output open.
 */
export function createBashOperations(jobs: Jobs, target: Target | undefined, options: BashOptions = {}): BashOperations {
	return {
		exec: async (command, cwd, { onData, signal, timeout, env }) => {
			if (signal?.aborted) throw new Error("aborted");
			const exports = target
				? Object.fromEntries(Object.entries(env ?? {}).filter((entry): entry is [string, string] => entry[0].startsWith("PI_") && entry[1] !== undefined))
				: undefined;
			const job = jobs.start(target, { command, cwd, exports, env: target ? undefined : env, shell: options.shell }, timeout);
			job.onData = onData;
			options.onJob?.(job);
			const onAbort = () => void jobs.stop(job, "aborted");
			signal?.addEventListener("abort", onAbort, { once: true });
			let timer: NodeJS.Timeout | undefined;
			try {
				await job.started.catch((error: unknown) => {
					if (job.reason === "aborted") throw new Error("aborted");
					if (job.reason === "timeout") throw new Error(`timeout:${timeout}`);
					if (job.reason === "environment") throw new Error(ENVIRONMENT_CHANGED);
					if (error instanceof Error && error.message === "nocwd") throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`);
					throw error;
				});
				const moved = new Promise<"moved">((resolve) => {
					if (options.moveAfterMs !== undefined) timer = setTimeout(() => resolve("moved"), options.moveAfterMs);
				});
				if (await Promise.race([job.ended, moved]) === "moved" && job.status === "running") {
					jobs.moveToBackground(job);
					throw new Error(MOVED);
				}
			} finally {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
			}
			if (job.reason === "aborted") throw new Error("aborted");
			if (job.reason === "timeout") throw new Error(`timeout:${timeout}`);
			if (job.reason === "environment") throw new Error(ENVIRONMENT_CHANGED);
			return { exitCode: job.exitCode ?? null };
		},
	};
}

/** Operations for user `!` commands, whose full output Pi keeps itself. */
export function createUserBashOperations(jobs: Jobs, target: Target): BashOperations {
	let job: Job | undefined;
	const ops = createBashOperations(jobs, target, { onJob: (started) => (job = started) });
	return {
		exec: async (command, cwd, options) => {
			try {
				return await ops.exec(command, cwd, options);
			} catch (error) {
				throw error instanceof Error && error.message === ENVIRONMENT_CHANGED ? new Error("aborted") : error;
			} finally {
				if (job?.detached) void removeLog(target, job.detached.log);
			}
		},
	};
}

type ToolResult = AgentToolResult<any> & { structuredContent?: any; isError?: boolean };

/**
 * Runs Pi's bash tool with job operations. The full output file is the command's log in the
 * environment, which is removed unless the output was truncated or the command moved to the
 * background. A moved command returns at once.
 */
export async function executeBash(
	jobs: Jobs,
	target: Target | undefined,
	cwd: string,
	options: BashOptions & { started?: boolean; commandPrefix?: string },
	[id, params, signal, onUpdate, ctx]: [string, { command: string; timeout?: number }, AbortSignal | undefined, ((result: any) => void) | undefined, ExtensionToolContext],
): Promise<ToolResult> {
	let job: Job | undefined;
	// Pi's own full output file, which the log replaces.
	let localPath: string | undefined;
	const tool = createBashToolDefinition(cwd, { commandPrefix: options.commandPrefix, operations: createBashOperations(jobs, target, { ...options, onJob: (started) => (job = started) }) });
	const update = (partial: ToolResult) => {
		localPath = partial.details?.fullOutputPath ?? localPath;
		if (localPath && job?.detached) partial.details.fullOutputPath = job.detached.log;
		onUpdate?.(partial);
	};
	const relocate = (text: string) => localPath && job?.detached ? text.replaceAll(localPath, job.detached.log) : text;
	const discardLog = () => {
		if (job?.detached && !localPath) void removeLog(target, job.detached.log);
	};
	try {
		const result = await tool.execute(id, { command: params.command, timeout: params.timeout }, signal, update, ctx) as ToolResult;
		localPath = result.details?.fullOutputPath ?? localPath;
		discardLog();
		if (!localPath || !job?.detached) return result;
		for (const block of result.content) if (block.type === "text" && block.text) block.text = relocate(block.text);
		result.details.fullOutputPath = job.detached.log;
		if (result.structuredContent?.full_output_path) result.structuredContent.full_output_path = job.detached.log;
		return result;
	} catch (error) {
		if (!(error instanceof Error) || !job) throw error;
		if (error.message === ENVIRONMENT_CHANGED) {
			const { text, truncation } = formatOutput(job.tail, job.detached?.log ?? "", "");
			if (!truncation && job.detached) void removeLog(target, job.detached.log);
			throw new Error(appendStatus(text, ENDINGS.environment));
		}
		if (!job.detached) throw error;
		const { pgid, log } = job.detached;
		if (error.message === MOVED) {
			const text = options.started ? `Command started (process group ${pgid}). Full output: ${log}` : `Command moved to the background (process group ${pgid}). Full output: ${log}`;
			return { content: [{ type: "text", text }], details: { pgid, fullOutputPath: log } };
		}
		discardLog();
		throw new Error(relocate(error.message));
	} finally {
		if (localPath) await rm(localPath, { force: true });
	}
}
