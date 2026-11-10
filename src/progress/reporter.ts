import process from "node:process";

import { createStyles, type Styles } from "../terminal/palette.ts";
import { getTerminalWidth } from "../terminal/width.ts";
import { formatStage, type StageState, type StageView } from "./render.ts";
import type { RunProgress } from "./run-progress.ts";
import { LAST_STAGE, type StageId } from "./stages.ts";

type StreamWrite = (...args: Array<never>) => boolean;

interface GuardedStream {
	write: StreamWrite;
}

interface RunProgressOptions {
	frameMs: number;
	guarded: Array<GuardedStream>;
	live: boolean;
	now: () => number;
	sink: (text: string) => void;
	width: number;
}

interface StageRecord {
	id: StageId;
	detail: string | undefined;
	elapsedMs: number;
	openedAtMs: number;
	state: StageState;
}

const CSI = `${String.fromCharCode(27)}[`;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
// Must cover the markers, label, gaps and duration in render.ts.
const DETAIL_OVERHEAD = 30;
const MIN_DETAIL_WIDTH = 8;
const DEFAULT_FRAME_MS = 90;

class RunProgressReporter implements RunProgress {
	private readonly maxDetailWidth: number;
	private readonly options: RunProgressOptions;
	private readonly records = new Map<StageId, StageRecord>();
	private readonly released: Array<() => void> = [];

	private frameIndex = 0;
	private isRevealed = false;
	private isSettled = false;
	/**
	 * Not the record count: a stage is recorded before the repaint draws it.
	 */
	private paintedRows = 0;
	private styles!: Styles;
	private timer: NodeJS.Timeout | undefined;

	constructor(options: RunProgressOptions) {
		this.options = options;
		this.maxDetailWidth = Math.max(MIN_DETAIL_WIDTH, options.width - DETAIL_OVERHEAD);
	}

	public begin(id: StageId, detail?: string): (detail?: string) => void {
		const record = this.openRecord(id, detail);
		this.flush(record);

		return (closingDetail?: string) => {
			if (record.state !== "active") {
				return;
			}

			record.detail =
				closingDetail === undefined ? record.detail : this.clampDetail(closingDetail);
			record.elapsedMs += this.options.now() - record.openedAtMs;
			record.state = "done";
			this.flush(record);
		};
	}

	public describe(id: StageId, detail: string | undefined): void {
		const record = this.records.get(id);
		if (record === undefined || detail === undefined) {
			return;
		}

		record.detail = this.clampDetail(detail);
		if (this.options.live) {
			this.flush(record);
		}
	}

	public finish(): void {
		this.stopAnimating();
		if (this.isSettled) {
			return;
		}

		const unfinished = [...this.records.values()].filter((record) => record.state === "active");
		for (const record of unfinished) {
			record.state = "unfinished";
		}

		if (!this.isRevealed) {
			return;
		}

		if (this.options.live) {
			this.repaint();
			return;
		}

		for (const record of unfinished) {
			this.writeStageLine(record);
		}
	}

	public interleave(write: () => void): void {
		this.interleaveValue(write);
	}

	public note(id: StageId, detail: string): void {
		const record = this.openRecord(id, detail);
		record.state = "done";
		this.flush(record);
	}

	public reveal({ color }: { color: boolean }): void {
		if (this.isRevealed) {
			return;
		}

		this.isRevealed = true;
		this.styles = createStyles(color);
		if (!this.options.live) {
			for (const record of this.records.values()) {
				this.writeStageLine(record);
			}

			this.settleIfComplete();
			return;
		}

		this.guardStreams();
		this.timer = setInterval(() => {
			if (!this.hasActiveStage()) {
				return;
			}

			this.frameIndex += 1;
			this.repaint();
		}, this.options.frameMs);
		this.timer.unref();
		this.repaint();
		this.settleIfComplete();
	}

	private clampDetail(detail: string): string {
		if (detail.length <= this.maxDetailWidth) {
			return detail;
		}

		return `${detail.slice(0, this.maxDetailWidth - 1)}…`;
	}

	/**
	 * Assumes one line per row; `clampDetail` keeps rows from wrapping.
	 *
	 * @returns The ANSI erase sequence, or an empty string when nothing is drawn.
	 */
	private eraseBlock(): string {
		if (this.paintedRows === 0) {
			return "";
		}

		return `${CSI}${this.paintedRows.toString()}A${CSI}0J`;
	}

	private flush(changed: StageRecord): void {
		if (this.isSettled || !this.isRevealed) {
			return;
		}

		if (this.options.live) {
			this.repaint();
		} else {
			this.writeStageLine(changed);
		}

		this.settleIfComplete();
	}

	private guardStreams(): void {
		for (const stream of this.options.guarded) {
			// Restore the own reference, not the bound copy.
			const own = stream.write;
			const invoke = own.bind(stream);
			stream.write = (...args: Array<never>): boolean => {
				return this.interleaveValue(() => invoke(...args));
			};

			this.released.push(() => {
				stream.write = own;
			});
		}
	}

	private hasActiveStage(): boolean {
		return this.records.values().some((record) => record.state === "active");
	}

	private interleaveValue<T>(write: () => T): T {
		if (this.paintedRows === 0) {
			return write();
		}

		this.options.sink(this.eraseBlock());
		this.paintedRows = 0;
		const result = write();
		this.repaint();
		return result;
	}

	private openRecord(id: StageId, detail: string | undefined): StageRecord {
		const record = this.records.get(id) ?? {
			id,
			detail: undefined,
			elapsedMs: 0,
			openedAtMs: 0,
			state: "active" as StageState,
		};
		this.records.set(id, record);
		record.detail = detail === undefined ? record.detail : this.clampDetail(detail);
		record.openedAtMs = this.options.now();
		record.state = "active";
		return record;
	}

	private repaint(): void {
		if (this.records.size === 0) {
			return;
		}

		const erase = this.eraseBlock();
		const frame = SPINNER_FRAMES[this.frameIndex % SPINNER_FRAMES.length];
		const rows = Array.from(this.records.values(), (record) => {
			return `${formatStage(this.toView(record), { frame, styles: this.styles })}\n`;
		});
		this.options.sink(`${erase}${rows.join("")}`);
		this.paintedRows = rows.length;
	}

	private settleIfComplete(): void {
		if (this.isSettled || this.records.get(LAST_STAGE)?.state !== "done") {
			return;
		}

		this.isSettled = true;
		this.paintedRows = 0;
		this.stopAnimating();
	}

	private stopAnimating(): void {
		clearInterval(this.timer);
		this.timer = undefined;

		for (const release of this.released.splice(0)) {
			release();
		}
	}

	private toView(record: StageRecord): StageView {
		const runningMs = this.options.now() - record.openedAtMs;
		return {
			id: record.id,
			detail: record.detail,
			elapsedMs: record.state === "active" ? runningMs : record.elapsedMs,
			state: record.state,
		};
	}

	private writeStageLine(record: StageRecord): void {
		const line = formatStage(this.toView(record), { frame: undefined, styles: this.styles });
		this.options.sink(`${line}\n`);
	}
}

/**
 * The reporter a real run uses, bound to stdout.
 * @param overrides - Sink, clock or terminal shape to use instead.
 * @returns The reporter bound to the process streams.
 */
export function createStdoutRunProgress(overrides: Partial<RunProgressOptions> = {}): RunProgress {
	return new RunProgressReporter({
		frameMs: DEFAULT_FRAME_MS,
		guarded: process.stderr.isTTY ? [process.stderr] : [],
		live: process.stdout.isTTY,
		now: () => Date.now(),
		sink: (text) => void process.stdout.write(text),
		width: getTerminalWidth(),
		...overrides,
	});
}
