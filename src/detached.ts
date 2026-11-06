import { run, shellQuote } from "./exec.ts";
import type { Target } from "./target.ts";

const TERMINATION_GRACE_SECONDS = 0.25;

/**
 * A command running detached in an environment (local without a target): its own session and process group,
 * without a controlling terminal, with stdin from /dev/null and all output in `log`. It keeps running when the client that started
 * or watches it goes away.
 */
export type Detached = { pgid: number; log: string };

export type LaunchOptions = {
	command: string;
	cwd: string;
	/** Variables exported to the command. */
	exports?: Record<string, string>;
	/** Environment of a local command. */
	env?: NodeJS.ProcessEnv;
	/** Shell and arguments before the command; by default bash, or sh, in the environment, with -c. */
	shell?: string[];
	signal?: AbortSignal;
	onStart: (detached: Detached) => void;
	onData: (data: Buffer) => void;
};

/** How a watched command ended: its exit code, or null when it ended without one. */
export type Ended = { exitCode: number | null };

const statusPath = (log: string) => log.replace(/\.log$/, ".exit");

/**
 * Streams `$log` from byte `$off` until the command ends, then reports its exit status file
 * `$status`. The command ends when the file exists, or when the group's first process, which writes
 * it, is gone or a zombie; processes the command left running do not keep it going. Short commands
 * are checked more often at first.
 */
const WATCH =
	`n=0\n` +
	`while :; do\n` +
	`  if [ -f "$status" ] || ! kill -0 "$pgid" 2>/dev/null || [ "$(cut -d' ' -f3 /proc/$pgid/stat 2>/dev/null)" = Z ]; then end=1; else end=; fi\n` +
	`  size=$(wc -c <"$log" 2>/dev/null) || size=$off\n` +
	`  if [ $((size)) -gt "$off" ]; then tail -c +$((off + 1)) "$log" | head -c $((size - off)); off=$((size)); fi\n` +
	`  [ -n "$end" ] && break\n` +
	`  if [ "$n" -lt 20 ]; then n=$((n + 1)); sleep 0.01; else sleep 0.1; fi\n` +
	`done\n` +
	`code=$(cat "$status" 2>/dev/null)\n` +
	`printf 'end %s\\n' "$code" >&2\n`;

function watchScript({ pgid, log }: Detached, offset: number): string {
	return `pgid=${pgid} log=${shellQuote(log)} status=${shellQuote(statusPath(log))} off=${offset}\n${WATCH}`;
}

/**
 * Runs a start or watch script; resolves when the command ends, and fails when the connection does
 * first. The exit status file is removed once its status is received, so a watcher that loses its
 * connection leaves it for the next one.
 */
async function follow(target: Target | undefined, script: string, options: { env?: NodeJS.ProcessEnv; signal?: AbortSignal; onData: (data: Buffer) => void; onStart?: (detached: Detached) => void }, watched?: Detached): Promise<Ended> {
	let stderr = "";
	let started = watched;
	const code = await run(target, script, {
		env: options.env,
		signal: options.signal,
		onStdout: options.onData,
		onStderr: (data) => {
			stderr += data.toString();
			const match = !started && stderr.match(/^start (\d+) (.+)\n/m);
			if (match) {
				started = { pgid: Number(match[1]), log: match[2]! };
				options.onStart?.(started);
			}
		},
	});
	const end = stderr.match(/^end (\d*)\n/m);
	if (end) {
		if (started) void run(target, `rm -f ${shellQuote(statusPath(started.log))}`, { timeoutMs: 10_000 }).catch(() => {});
		return { exitCode: end[1] ? Number(end[1]) : null };
	}
	if (stderr.startsWith("nocwd\n")) throw new Error("nocwd");
	const message = stderr.replace(/^start .*\n/m, "").trim();
	throw new Error(message || `${target?.backend ?? "sh"} exited with code ${code}`);
}

/**
 * Starts a command and streams its output until it ends. Fails with `nocwd` when `cwd` does not
 * exist, or when the connection fails before the command ends; once `onStart` was called, `watch`
 * picks it up again.
 */
export function launch(target: Target | undefined, options: LaunchOptions): Promise<Ended> {
	const exports = Object.entries(options.exports ?? {}).map(([name, value]) => `export ${name}=${shellQuote(value)}\n`).join("");
	const shell = options.shell
		? `set -- ${options.shell.map(shellQuote).join(" ")}\n`
		: `if command -v bash >/dev/null 2>&1; then set -- bash -c; else set -- sh -c; fi\n`;
	const script =
		`cd ${shellQuote(options.cwd)} 2>/dev/null || { printf 'nocwd\\n' >&2; exit 1; }\n` +
		exports +
		shell +
		// A new session detaches the command from Pi's terminal; macOS has no setsid, so perl starts it there.
		`if command -v setsid >/dev/null 2>&1; then group=setsid; else group='perl -MPOSIX -e POSIX::setsid;exec@ARGV'; fi\n` +
		`dir=\${TMPDIR:-/tmp}; base=$(mktemp "\${dir%/}/pi-bash-XXXXXX") && log=$base.log && mv "$base" "$log" || exit 1\n` +
		`$group sh -c 'c=$1 l=$2 s=$3; shift 3; "$@" "$c" </dev/null >"$l" 2>&1; printf %s "$?" >"$s.tmp" && mv "$s.tmp" "$s"' ` +
		`sh ${shellQuote(options.command)} "$log" "$base.exit" "$@" </dev/null >/dev/null 2>&1 &\n` +
		`printf 'start %s %s\\n' "$!" "$log" >&2\n` +
		`pgid=$! status=$base.exit off=0\n${WATCH}`;
	return follow(target, script, options);
}

/** Streams a started command's output from byte `offset` until it ends; fails as `launch` does. */
export function watch(target: Target | undefined, detached: Detached, offset: number, options: { signal?: AbortSignal; onData: (data: Buffer) => void }): Promise<Ended> {
	return follow(target, watchScript(detached, offset), options, detached);
}

/** Stops process groups: TERM, then KILL after a grace period. */
export function stop(target: Target | undefined, pgids: number[]): Promise<void> {
	const groups = pgids.map((pgid) => `-${pgid}`).join(" ");
	const script = `kill -TERM ${groups} 2>/dev/null; sleep ${TERMINATION_GRACE_SECONDS}; kill -KILL ${groups} 2>/dev/null; true`;
	return run(target, script, { timeoutMs: 10_000 }).then(() => {}, () => {});
}

/** Removes a command's log. */
export function removeLog(target: Target | undefined, log: string): Promise<void> {
	return run(target, `rm -f ${shellQuote(log)}`, { timeoutMs: 10_000 }).then(() => {}, () => {});
}
