import { spawn } from "node:child_process";
import { formatAddress, type Target } from "./target.ts";

const TERMINATION_GRACE_MS = 250;

export type RunOptions = {
	signal?: AbortSignal;
	timeoutMs?: number;
	input?: string | Buffer;
	/** Environment of a local script. */
	env?: NodeJS.ProcessEnv;
	onStdout?: (data: Buffer) => void;
	onStderr?: (data: Buffer) => void;
};

// Quote for a POSIX shell. Double quotes are not enough: $, backticks, and !
// still expand inside them.
export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function command(target: Target | undefined, script: string, input: boolean): [string, string[]] {
	if (!target) return ["sh", ["-c", script]];
	if (target.backend === "ssh") return ["ssh", [formatAddress(target), `sh -c ${shellQuote(script)}`]];
	const args = ["exec", ...(input ? ["-i"] : []), ...(target.user ? ["-u", target.user] : []), target.host, "sh", "-c", script];
	return ["docker", args];
}

/**
 * Runs a shell script in the environment, or locally without a target, and resolves with its exit
 * code. Abort and timeout stop the local client only; callers stop processes in the environment
 * themselves.
 */
export function run(target: Target | undefined, script: string, options: RunOptions = {}): Promise<number | null> {
	if (options.signal?.aborted) return Promise.reject(new Error("aborted"));

	return new Promise((resolve, reject) => {
		const [file, args] = command(target, script, options.input !== undefined);
		const child = spawn(file, args, { stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"], env: options.env });
		let settled = false;
		let stopError: Error | undefined;
		let timeoutTimer: NodeJS.Timeout | undefined;
		let killTimer: NodeJS.Timeout | undefined;

		const settle = (error: Error | undefined, code?: number | null) => {
			if (settled) return;
			settled = true;
			if (timeoutTimer) clearTimeout(timeoutTimer);
			if (killTimer) clearTimeout(killTimer);
			options.signal?.removeEventListener("abort", onAbort);
			if (error) reject(error);
			else resolve(code ?? null);
		};
		const stop = (error: Error) => {
			if (settled || stopError) return;
			stopError = error;
			child.kill("SIGTERM");
			killTimer = setTimeout(() => {
				child.kill("SIGKILL");
				settle(stopError);
			}, TERMINATION_GRACE_MS);
		};
		const onAbort = () => stop(new Error("aborted"));

		child.stdout!.on("data", options.onStdout ?? (() => {}));
		child.stderr!.on("data", options.onStderr ?? (() => {}));
		child.on("error", (error) => settle(stopError ?? error));
		child.on("close", (code) => settle(stopError, code));
		options.signal?.addEventListener("abort", onAbort, { once: true });

		if (options.input !== undefined && child.stdin) {
			child.stdin.on("error", (error: NodeJS.ErrnoException) => {
				if (error.code !== "EPIPE") stop(error);
			});
			child.stdin.end(options.input);
		}
		if (options.timeoutMs) {
			timeoutTimer = setTimeout(() => stop(new Error(`Timed out after ${options.timeoutMs}ms`)), options.timeoutMs);
		}
	});
}

/** Runs a script and returns its stdout; a non-zero exit fails with its stderr. */
export async function exec(target: Target | undefined, script: string, options: Omit<RunOptions, "onStdout" | "onStderr"> = {}): Promise<Buffer> {
	const stdout: Buffer[] = [];
	const stderr: Buffer[] = [];
	const code = await run(target, script, {
		...options,
		onStdout: (data) => stdout.push(data),
		onStderr: (data) => stderr.push(data),
	});
	if (code !== 0) throw new Error(Buffer.concat(stderr).toString().trim() || `${target?.backend ?? "sh"} exited with code ${code}`);
	return Buffer.concat(stdout);
}
