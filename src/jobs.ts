import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateTail, type TruncationResult } from "@earendil-works/pi-coding-agent";
import { type Detached, type Ended, launch, type LaunchOptions, removeLog, stop, watch } from "./detached.ts";
import { formatTarget, type Target } from "./target.ts";

export const MESSAGE_TYPE = "bash-result";
const RECONNECT_MS = 2000;
/** How long a stopped command's watcher may take to see it end. */
const STOP_WAIT_MS = 2000;
/** How long a command stopped while starting may still start, and then be stopped. */
const START_WAIT_MS = 15_000;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms).unref());

/**
 * The tail of a command's output and its totals, kept and truncated as Pi's bash tool keeps its
 * output (Pi's OutputAccumulator, which Pi does not export).
 */
export class Tail {
	private decoder = new TextDecoder();
	private text = "";
	private bytes = 0;
	private startsAtLine = true;
	private totalBytes = 0;
	private completedLines = 0;
	private openLine = false;
	/** Bytes of the last line. */
	lastLineBytes = 0;

	append(data: Buffer): void {
		this.add(this.decoder.decode(data, { stream: true }));
	}

	finish(): void {
		this.add(this.decoder.decode());
	}

	snapshot(): TruncationResult {
		const firstNewline = this.startsAtLine ? -1 : this.text.indexOf("\n");
		const tail = truncateTail(firstNewline === -1 ? this.text : this.text.slice(firstNewline + 1), { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
		const totalLines = this.completedLines + (this.openLine ? 1 : 0);
		const truncated = totalLines > DEFAULT_MAX_LINES || this.totalBytes > DEFAULT_MAX_BYTES;
		const truncatedBy = truncated ? (tail.truncatedBy ?? (this.totalBytes > DEFAULT_MAX_BYTES ? "bytes" : "lines")) : null;
		return { ...tail, truncated, truncatedBy, totalLines, totalBytes: this.totalBytes, maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES };
	}

	private add(text: string): void {
		if (!text) return;
		const bytes = Buffer.byteLength(text);
		this.totalBytes += bytes;
		this.text += text;
		this.bytes += bytes;
		const rolling = DEFAULT_MAX_BYTES * 2;
		if (this.bytes > rolling * 2) {
			const buffer = Buffer.from(this.text);
			let start = buffer.length - rolling;
			while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) start++;
			this.startsAtLine = buffer[start - 1] === 0x0a;
			this.text = buffer.subarray(start).toString();
			this.bytes = Buffer.byteLength(this.text);
		}
		const lastNewline = text.lastIndexOf("\n");
		if (lastNewline === -1) {
			this.lastLineBytes += bytes;
			this.openLine = true;
			return;
		}
		this.completedLines += text.split("\n").length - 1;
		const rest = text.slice(lastNewline + 1);
		this.lastLineBytes = Buffer.byteLength(rest);
		this.openLine = rest.length > 0;
	}
}

/** Output text with Pi's bash truncation notice, as Pi's bash tool formats its output. */
export function formatOutput(tail: Tail, fullOutputPath: string, emptyText = "(no output)"): { text: string; truncation?: TruncationResult } {
	const truncation = tail.snapshot();
	let text = truncation.content || emptyText;
	if (!truncation.truncated) return { text };
	const startLine = truncation.totalLines - truncation.outputLines + 1;
	const endLine = truncation.totalLines;
	if (truncation.lastLinePartial) {
		text += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${formatSize(tail.lastLineBytes)}). Full output: ${fullOutputPath}]`;
	} else if (truncation.truncatedBy === "lines") {
		text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${fullOutputPath}]`;
	} else {
		text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${fullOutputPath}]`;
	}
	return { text, truncation };
}

/** `text`, then a blank line and `status`, as Pi's bash tool ends its results. */
export const appendStatus = (text: string, status: string | undefined) => !status ? text : `${text ? `${text}\n\n` : ""}${status}`;

export type JobStatus = "running" | "completed" | "failed" | "stopped";

/** Why a command was stopped: by the user, its timeout, an environment switch, or the end of the session. */
export type StopReason = "aborted" | "timeout" | "environment" | "session";

export type BashResultDetails = {
	pgid: number;
	command: string;
	status: Exclude<JobStatus, "running">;
	seconds: number;
	truncation?: TruncationResult;
	fullOutputPath?: string;
};

/** The first line of a command, marked when it has more. */
export function titleOf(command: string): string {
	const [first = "", ...rest] = command.split("\n");
	return rest.length > 0 ? `${first} …` : first;
}

export const ENDINGS: Record<Exclude<StopReason, "timeout" | "session">, string> = {
	aborted: "Command aborted",
	environment: "Command stopped because the environment changed",
};

/** A bash command, from its start in the foreground until it ends. */
export class Job {
	detached?: Detached;
	readonly tail = new Tail();
	readonly startedAt = Date.now();
	endedAt?: number;
	status: JobStatus = "running";
	/** The last line of its result; none when it completed. */
	ending?: string;
	exitCode?: number | null;
	reason?: StopReason;
	/** Moved to or started in the background. */
	background = false;
	/** Resolves when it started, or fails when it could not start. */
	started!: Promise<Detached>;
	/** Resolves when it ended or could not start. */
	ended!: Promise<void>;
	/** Receives its output. */
	onData?: (data: Buffer) => void;
	/** The bytes of its log it has received. */
	offset = 0;
	readonly client = new AbortController();
	timer?: NodeJS.Timeout;
	/** Fails `started`. */
	cancelStart!: (error: Error) => void;
	/** Stopped while starting: no result reports its log. */
	cancelledAtStart = false;

	constructor(readonly target: Target | undefined, readonly command: string, readonly timeout?: number) {}

	get title(): string {
		return titleOf(this.command);
	}

	/** Its wall time, rounded to tenths of a second. */
	get seconds(): number {
		return Math.round(((this.endedAt ?? Date.now()) - this.startedAt) / 100) / 10;
	}

	/** Its output with the truncation notice and its last line, as the model sees them. */
	result(): { text: string; truncation?: TruncationResult } {
		const empty = this.reason && this.reason !== "session" ? "" : "(no output)";
		const output = formatOutput(this.tail, this.detached?.log ?? "", empty);
		return { ...output, text: appendStatus(output.text, this.ending) };
	}
}

const keyOf = (target: Target | undefined) => target ? formatTarget(target) : "local";

/** Bash commands of the session, and the background ones' notifications. */
export class Jobs {
	private running = new Set<Job>();
	private background: Job[] = [];
	private listeners = new Set<() => void>();
	/** Set from the end of the session: no more notifications. */
	private closing = false;

	constructor(private notify: (text: string, details: BashResultDetails) => void) {}

	/** Starts a command; `timeout` in seconds stops it. */
	start(target: Target | undefined, options: Omit<LaunchOptions, "onStart" | "onData" | "signal">, timeout?: number): Job {
		const job = new Job(target, options.command, timeout);
		this.running.add(job);
		const onData = (data: Buffer) => {
			job.offset += data.length;
			job.tail.append(data);
			job.onData?.(data);
			if (job.background) this.changed();
		};
		let onStart!: (detached: Detached) => void;
		job.started = new Promise((resolve, reject) => {
			onStart = resolve;
			job.cancelStart = reject;
		});
		job.ended = launch(target, {
			...options,
			signal: job.client.signal,
			onData,
			onStart: (detached) => {
				job.detached = detached;
				onStart(detached);
				if (job.reason) void this.kill(job);
			},
		})
			.catch((error: unknown) => job.detached ? this.reattach(job, onData) : Promise.reject(error))
			.then((ended) => this.finish(job, ended), (error: unknown) => {
				clearTimeout(job.timer);
				this.running.delete(job);
				job.cancelStart(error as Error);
			});
		if (timeout !== undefined) job.timer = setTimeout(() => void this.stop(job, "timeout"), timeout * 1000);
		return job;
	}

	/** Stops a running command. */
	async stop(job: Job, reason: StopReason): Promise<void> {
		if (job.status !== "running" || job.reason) return;
		job.reason = reason;
		if (job.detached) return this.kill(job);
		// Still starting: its caller returns now, a start that arrives later is stopped, and the
		// client gives up after a while.
		job.cancelledAtStart = true;
		job.cancelStart(new Error(reason));
		setTimeout(() => job.client.abort(), START_WAIT_MS).unref();
	}

	/** Lets the session's background commands notify again after an earlier session ended. */
	open(): void {
		this.closing = false;
	}

	/** Stops the commands in environments other than `target`. */
	stopOutside(target: Target | undefined): void {
		for (const job of this.running) if (keyOf(job.target) !== keyOf(target)) void this.stop(job, "environment");
	}

	/** Stops every command; none notifies from now on. Watchers that do not see their command end give up. */
	async shutdown(): Promise<void> {
		this.closing = true;
		const jobs = [...this.running];
		await Promise.allSettled(jobs.map((job) => this.stop(job, "session")));
		const ended = Promise.allSettled(jobs.map((job) => job.ended));
		await Promise.race([ended, delay(STOP_WAIT_MS)]);
		for (const job of jobs) job.client.abort();
		await Promise.race([ended, delay(STOP_WAIT_MS)]);
		this.background = [];
	}

	/** Moves a running command to the background. */
	moveToBackground(job: Job): void {
		job.onData = undefined;
		job.background = true;
		this.background.push(job);
		this.changed();
	}

	/** The background commands of the session, running ones first, then newest first. */
	list(): Job[] {
		return [...this.background].sort((a, b) => Number(b.status === "running") - Number(a.status === "running") || b.startedAt - a.startedAt);
	}

	/** Calls `listener` when a background command starts, has output, or ends. */
	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private changed(): void {
		for (const listener of this.listeners) listener();
	}

	private async kill(job: Job): Promise<void> {
		await stop(job.target, [job.detached!.pgid]);
		// A watcher whose connection hangs gives up.
		setTimeout(() => job.client.abort(), STOP_WAIT_MS).unref();
	}

	/** Watches a command again after its connection failed, until it ends. */
	private async reattach(job: Job, onData: (data: Buffer) => void): Promise<Ended> {
		for (;;) {
			if (job.reason || job.client.signal.aborted) return { exitCode: null };
			await delay(RECONNECT_MS);
			try {
				return await watch(job.target, job.detached!, job.offset, { signal: job.client.signal, onData });
			} catch {
				// Retries while the command may still run.
			}
		}
	}

	private finish(job: Job, { exitCode }: Ended): void {
		clearTimeout(job.timer);
		this.running.delete(job);
		job.tail.finish();
		job.endedAt = Date.now();
		job.exitCode = exitCode;
		if (job.cancelledAtStart) void removeLog(job.target, job.detached!.log);
		if (job.reason === "timeout") {
			job.status = "failed";
			job.ending = `Command timed out after ${job.timeout} seconds`;
		} else if (job.reason === "session") {
			job.status = "stopped";
		} else if (job.reason) {
			job.status = "stopped";
			job.ending = ENDINGS[job.reason];
		} else if (exitCode === null) {
			job.status = "failed";
			job.ending = "Command terminated without an exit code";
		} else {
			job.status = exitCode === 0 ? "completed" : "failed";
			if (exitCode !== 0) job.ending = `Command exited with code ${exitCode}`;
		}
		if (!job.background) return;
		this.changed();
		if (this.closing || job.reason === "session") return;
		const { text, truncation } = job.result();
		const details: BashResultDetails = {
			pgid: job.detached!.pgid,
			command: job.command,
			status: job.status,
			seconds: job.seconds,
			...(truncation && { truncation, fullOutputPath: job.detached!.log }),
		};
		this.notify(
			`<${MESSAGE_TYPE} pgid="${details.pgid}" status="${details.status}">\nCommand: ${job.title}\nWall time ${details.seconds.toFixed(1)} seconds\nOutput:\n\n${text}\n</${MESSAGE_TYPE}>`,
			details,
		);
	}
}
