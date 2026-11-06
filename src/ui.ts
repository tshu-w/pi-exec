import {
	DEFAULT_MAX_BYTES,
	DynamicBorder,
	formatSize,
	type ExtensionAPI,
	type ExtensionContext,
	getSelectListTheme,
	keyHint,
	keyText,
	type Theme,
	ToolExecutionComponent,
	truncateToVisualLines,
} from "@earendil-works/pi-coding-agent";
import {
	Box,
	type Component,
	Container,
	type Focusable,
	fuzzyFilter,
	Input,
	type KeybindingsManager,
	type SelectItem,
	SelectList,
	Spacer,
	Text,
	TruncatedText,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { type BashResultDetails, type Job, type Jobs, MESSAGE_TYPE, titleOf } from "./jobs.ts";

const WIDGET_KEY = "pi-exec";
// As Pi's bash output preview.
const PREVIEW_LINES = 5;
const VIEW_UPDATE_MS = 100;

type ToolResult = Parameters<ToolExecutionComponent["updateResult"]>[0];
type BashDefinition = ConstructorParameters<typeof ToolExecutionComponent>[4];
type TimerState = { startedAt?: number; endedAt?: number; interval?: ReturnType<typeof setInterval> };

/** Durations as Pi shows them: `4.2s` below a minute, then `1m 30s` and `2h 3m 4s`. */
function formatDuration(ms: number): string {
	const seconds = ms / 1000;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	const total = Math.floor(seconds);
	const minutes = Math.floor(total / 60);
	if (minutes < 60) return `${minutes}m ${total % 60}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${total % 60}s`;
}

/** The renderer state of a tool component, which holds its timer. */
const timerOf = (tool: ToolExecutionComponent) => (tool as unknown as { rendererState: TimerState }).rendererState;

/** Pi's bash result renderer, with one line in place of the output and duration for a moved or started command. */
export function renderBashResult<F extends (...args: any[]) => Component>(base: F): F {
	return ((result: any, options: any, theme: Theme, context: any) => {
		const details = result.details as { pgid?: number; fullOutputPath?: string } | undefined;
		if (options.isPartial || details?.pgid === undefined) return base(result, options, theme, context);
		const state = context.state as TimerState;
		clearInterval(state.interval);
		state.interval = undefined;
		const text = result.content.find((part: { type: string; text?: string }) => part.type === "text")?.text ?? "";
		const label = text.startsWith("Command started") ? "Started" : "Moved to the background";
		return new Text(`\n${theme.fg("muted", `${label} · ${details.fullOutputPath}`)}`, 0, 0);
	}) as F;
}

/** The output and last line of a notification's text. */
function parseNotification(text: string, details: BashResultDetails): { output: string; ending?: string } {
	let output = text.match(/\nOutput:\n\n([\s\S]*)\n<\/bash-result>$/)?.[1] ?? "";
	let ending: string | undefined;
	if (details.status !== "completed") {
		const index = output.lastIndexOf("\n\n");
		ending = output.slice(index === -1 ? 0 : index + 2);
		output = index === -1 ? "" : output.slice(0, index);
	}
	// As Pi's bash renderer, without the truncation notice.
	const notice = output.lastIndexOf("\n\n[");
	if (details.truncation && details.fullOutputPath && notice !== -1 && output.slice(notice).includes(details.fullOutputPath)) output = output.slice(0, notice);
	return { output, ending };
}

function renderNotification(text: string, details: BashResultDetails, expanded: boolean, outputPad: number, theme: Theme): Component {
	const { output, ending } = parseNotification(text, details);
	const box = new Box(outputPad, 1, (line) => theme.bg("customMessageBg", line));
	box.addChild(new Text(theme.fg("toolTitle", theme.bold(`$ ${titleOf(details.command)}`)) + theme.fg("muted", `  ${details.status}  ${formatDuration(details.seconds * 1000)}`), 0, 0));
	const styled = output.trim() ? output.trim().split("\n").map((line) => theme.fg("toolOutput", line)).join("\n") : "";
	if (styled) {
		box.addChild(new Spacer(1));
		if (expanded) box.addChild(new Text(styled, 0, 0));
		else {
			let cached: { width: number; lines: string[] } | undefined;
			box.addChild({
				render(width) {
					if (cached?.width === width) return cached.lines;
					const preview = truncateToVisualLines(styled, PREVIEW_LINES, width, 0, "end");
					const hint = theme.fg("muted", `... (${preview.skippedCount} earlier lines,`) + ` ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
					const lines = preview.skippedCount > 0 ? [truncateToWidth(hint, width, "..."), ...preview.visualLines] : preview.visualLines;
					cached = { width, lines };
					return lines;
				},
				invalidate() {
					cached = undefined;
				},
			});
		}
	}
	// As Pi's bash renderer warns of truncated output.
	if (details.truncation?.truncated && details.fullOutputPath) {
		const { truncation } = details;
		const shown = truncation.truncatedBy === "lines"
			? `Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`
			: `Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)`;
		box.addChild(new Spacer(1));
		box.addChild(new Text(theme.fg("warning", `[Full output: ${details.fullOutputPath}. ${shown}]`), 0, 0));
	}
	if (ending) {
		box.addChild(new Spacer(1));
		box.addChild(new Text(theme.fg("toolOutput", ending), 0, 0));
	}
	return box;
}

/** The lines a scroll key of Pi's fullscreen mode moves the view up, negative for down, or undefined for another key. */
function scrollKey(keys: KeybindingsManager, data: string, page: number): number | undefined {
	const moves = [
		["tui.altScreen.pageUp", page], ["tui.altScreen.pageDown", -page],
		["tui.altScreen.halfPageUp", Math.ceil(page / 2)], ["tui.altScreen.halfPageDown", -Math.ceil(page / 2)],
		["tui.altScreen.lineUp", 1], ["tui.altScreen.lineDown", -1],
		["tui.altScreen.top", Infinity], ["tui.altScreen.bottom", -Infinity],
	] as const;
	return moves.find(([action]) => keys.matches(data, action))?.[1];
}

/** A background command as Pi's bash tool shows it, live from its output. */
class JobViewer implements Component, Focusable {
	private readonly tool: ToolExecutionComponent;
	private expanded = false;
	/** Lines scrolled up from the end. */
	private scroll = 0;
	private pending?: NodeJS.Timeout;
	private unsubscribe: () => void;
	focused = false;

	constructor(
		private tui: TUI,
		private theme: Theme,
		private keys: KeybindingsManager,
		private jobs: Jobs,
		private job: Job,
		definition: BashDefinition,
		cwd: string,
		private done: () => void,
	) {
		this.tool = new ToolExecutionComponent("bash", `job-${job.detached!.pgid}`, { command: job.command }, { showImages: false }, definition, tui, cwd);
		// Times the command from its start.
		Object.assign(timerOf(this.tool), { startedAt: job.startedAt });
		this.tool.markExecutionStarted();
		this.sync();
		this.unsubscribe = jobs.onChange(() => {
			this.pending ??= setTimeout(() => {
				this.pending = undefined;
				this.sync();
				this.tui.requestRender();
			}, VIEW_UPDATE_MS);
		});
	}

	handleInput(data: string): void {
		const lines = scrollKey(this.keys, data, Math.max(1, this.tui.terminal.rows - 4));
		if (this.keys.matches(data, "app.clear" as never)) return this.done();
		if (this.keys.matches(data, "app.interrupt" as never)) void this.jobs.stop(this.job, "aborted");
		else if (this.keys.matches(data, "app.tools.expand" as never)) {
			this.expanded = !this.expanded;
			this.tool.setExpanded(this.expanded);
		} else if (lines !== undefined) this.scroll = Math.max(0, this.scroll + lines);
		this.tui.requestRender();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "wheel" || !event.wheelDelta) return undefined;
		this.scroll = Math.max(0, this.scroll - event.wheelDelta);
		return { handled: true };
	}

	render(width: number): string[] {
		const running = this.job.status === "running";
		const hints = [...running ? [keyHint("app.interrupt", "stop")] : [], this.theme.fg("accent", `${keyText("app.clear")} back`)].join("  ");
		const footer = truncateToWidth(" ".repeat(Math.max(0, width - visibleWidth(hints))) + hints, width);
		const border = new DynamicBorder().render(width);
		const budget = Math.max(1, this.tui.terminal.rows - border.length - 2);
		const lines = this.tool.render(width);
		this.scroll = Math.min(this.scroll, Math.max(0, lines.length - budget));
		const end = lines.length - this.scroll;
		return [...border, ...lines.slice(Math.max(0, end - budget), end), " ".repeat(width), footer];
	}

	invalidate(): void {
		this.tool.invalidate();
	}

	dispose(): void {
		clearTimeout(this.pending);
		const timer = timerOf(this.tool);
		clearInterval(timer.interval);
		timer.interval = undefined;
		this.unsubscribe();
	}

	private sync(): void {
		const log = this.job.detached!.log;
		if (this.job.status === "running") {
			const truncation = this.job.tail.snapshot();
			this.tool.updateResult({
				content: [{ type: "text", text: truncation.content }],
				details: { ...(truncation.truncated && { truncation }), fullOutputPath: log },
			} as ToolResult, true);
			return;
		}
		Object.assign(timerOf(this.tool), { endedAt: this.job.endedAt });
		const { text, truncation } = this.job.result();
		this.tool.updateResult({
			content: [{ type: "text", text }],
			details: { ...(truncation && { truncation }), fullOutputPath: log },
			isError: this.job.status !== "completed",
		} as ToolResult, false);
	}
}

/** A filterable list in place of the editor, like pi-agents' `/tasks`. */
class ListSelector extends Container implements Focusable {
	private readonly input = new Input();
	private readonly listContainer = new Container();
	private list: SelectList;
	private _focused = false;

	constructor(
		title: string,
		private items: SelectItem[],
		private theme: Theme,
		private keys: KeybindingsManager,
		private onSelect: (value: string) => void,
		private onCancel: () => void,
	) {
		super();
		this.list = this.build(items);
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
		this.addChild(this.input);
		this.addChild(new Spacer(1));
		this.addChild(this.listContainer);
		this.addChild(new DynamicBorder());
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	handleInput(data: string): void {
		const forwarded = ["tui.select.up", "tui.select.down", "tui.select.confirm", "tui.select.cancel"] as const;
		if (forwarded.some((action) => this.keys.matches(data, action))) {
			this.list.handleInput(data);
			return;
		}
		this.input.handleInput(data);
		const query = this.input.getValue();
		this.list = this.build(query.length === 0 ? this.items : fuzzyFilter(this.items, query, (item) => `${item.label} ${item.value}`));
	}

	private build(items: SelectItem[]): SelectList {
		const list = new SelectList(items, 10, {
			...getSelectListTheme(),
			selectedPrefix: (text) => this.theme.fg("accent", text),
			selectedText: (text) => this.theme.fg("accent", text),
			description: (text) => this.theme.fg("muted", text),
		});
		list.onSelect = (item) => this.onSelect(item.value);
		list.onCancel = this.onCancel;
		this.listContainer.clear();
		this.listContainer.addChild(list);
		return list;
	}
}

/**
 * The user's view of background commands: their notifications, the line above the editor while
 * some run, and `/jobs`. `start` and `stop` follow the session.
 */
export function registerJobsUi(pi: ExtensionAPI, jobs: Jobs, definition: object) {
	let ctx: ExtensionContext | undefined;
	let shown = 0;

	pi.registerMessageRenderer<BashResultDetails>(MESSAGE_TYPE, (message, { expanded, outputPad }, theme) => {
		const text = typeof message.content === "string" ? message.content : message.content.find((part) => part.type === "text")?.text;
		if (!message.details || text === undefined) return undefined;
		return renderNotification(text, message.details, expanded, outputPad, theme);
	});

	const update = () => {
		const running = jobs.list().filter((job) => job.status === "running").length;
		if (!ctx?.hasUI || running === shown) return;
		shown = running;
		const line = `${running} ${running === 1 ? "command" : "commands"} running · /jobs to view`;
		ctx.ui.setWidget(WIDGET_KEY, running === 0 ? undefined : (_tui, theme) => new TruncatedText(theme.fg("muted", line), 0, 0));
	};
	jobs.onChange(update);

	pi.registerCommand("jobs", {
		description: "View background bash commands",
		handler: async (_args, current) => {
			const list = jobs.list();
			if (list.length === 0) {
				current.ui.notify("No jobs.", "info");
				return;
			}
			const items: SelectItem[] = list.map((job, index) => ({
				value: String(index),
				label: `$ ${job.title}`,
				description: `${job.status}  ${formatDuration((job.endedAt ?? Date.now()) - job.startedAt)}`,
			}));
			const index = await current.ui.custom<string | undefined>((_tui, theme, keys, done) =>
				new ListSelector("Jobs", items, theme, keys, (value) => done(value), () => done(undefined)));
			const job = index === undefined ? undefined : list[Number(index)];
			if (!job) return;
			await current.ui.custom<void>(
				(tui, theme, keys, done) => new JobViewer(tui, theme, keys, jobs, job, definition as BashDefinition, current.cwd, () => done()),
				{ overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "bottom-center" } },
			);
		},
	});

	return {
		start(current: ExtensionContext) {
			ctx = current;
			shown = 0;
			update();
		},
		stop() {
			if (ctx?.hasUI && shown > 0) ctx.ui.setWidget(WIDGET_KEY, undefined);
			shown = 0;
			ctx = undefined;
		},
	};
}
