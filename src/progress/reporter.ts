import assert from "node:assert";
import process from "node:process";

import { getTerminalWidth } from "../formatters/shared.ts";
import { createStyles, type Styles } from "../formatters/styles.ts";
import { formatStage, type StageState, type StageView } from "./render.ts";
import { LAST_STAGE, type StageId } from "./stages.ts";

/**
 * The sink every stage announcement goes through. One reporter per run,
 * shared by the span tree (host phases) and the backend (upload, boot
 * probe, dispatch), so the stages of a run keep one order and one renderer.
 */
export interface RunProgress {
	/**
	 * Opens a stage. The returned closer completes it; pass a detail to
	 * whichever call knows one — the place size is known before an upload
	 * starts, the version it produced only after.
	 */
	begin: (id: StageId, detail?: string) => (detail?: string) => void;
	/**
	 * Attaches a detail to a stage already open, for the value the work
	 * itself produces — a place is built before anyone can say how big it is.
	 * Takes the absent case so a caller that could not measure passes it
	 * straight through. Silent in the append-only shape, where the opening
	 * line has gone out and the closing one is yet to be written.
	 */
	describe: (id: StageId, detail: string | undefined) => void;
	/** Settles the block: stops the animation, marks whatever is still open. */
	finish: () => void;
	/**
	 * Runs `write` with the block cleared, then redraws it. Everything that
	 * reaches stdout mid-run goes through here: a bare write lands inside the
	 * block, and the next repaint then erases it in place of its own rows.
	 * Straight through once the block has settled, which is when most of a
	 * run's output arrives.
	 */
	interleave: (write: () => void) => void;
	/**
	 * Records a stage that was over before it could be announced — an upload
	 * the cache answered. One line, not the opening-and-closing pair `begin`
	 * writes: a step that took no time never had a "where is it now" to say.
	 */
	note: (id: StageId, detail: string) => void;
	/**
	 * Lets output through. Called once the run header is out and the
	 * formatter gate has passed, so no stage prints above the header or into
	 * machine-readable output; stages that already finished replay here. The
	 * palette arrives with it, so the block and the header cannot disagree
	 * about colour.
	 */
	reveal: (options: { color: boolean }) => void;
}

export interface RunProgressOptions {
	/** Repaint cadence of the animated block. Ignored when `live` is false. */
	frameMs: number;
	/**
	 * Streams to wrap while the block is drawn, so their writes land above it
	 * rather than inside it. Without this a stderr warning — a stale upload
	 * cache, a snapshot that would not write, a `[TIMING]` line — is what the
	 * next repaint erases, in place of its own rows, and the reader loses the
	 * warning on exactly the run that produced one.
	 */
	guarded: Array<GuardedStream>;
	/**
	 * Whether to repaint one block in place instead of appending a line per
	 * transition. A repaint needs a terminal that honours cursor movement; a
	 * pipe, a file, or a CI log gets the append-only form, where a stage says
	 * it started and later says what it took.
	 */
	live: boolean;
	now: () => number;
	sink: (text: string) => void;
	width: number;
}

type StreamWrite = (...args: Array<never>) => boolean;

/**
 * A stream sharing the terminal with the block, written to by code that knows
 * nothing about it. Narrower than `NodeJS.WriteStream` on purpose: the guard
 * only ever swaps `write` out and back.
 */
interface GuardedStream {
	write: StreamWrite;
}

interface StageRecord {
	id: StageId;
	detail: string | undefined;
	elapsedMs: number;
	openedAtMs: number;
	state: StageState;
}

/** CSI prefix, built from the code point so no escape byte lands in source. */
const CSI = `${String.fromCharCode(27)}[`;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
/** Columns the markers, label, gaps and duration claim before any detail. */
const DETAIL_OVERHEAD = 30;
const MIN_DETAIL_WIDTH = 8;
/** Fast enough to read as motion, slow enough to cost nothing. */
const DEFAULT_FRAME_MS = 90;

function noOp(): void {
	// Deliberately empty.
}

/** Shared reporter for runs that announce nothing: the programmatic API. */
export const NOOP_RUN_PROGRESS: RunProgress = {
	begin: () => noOp,
	describe: noOp,
	finish: noOp,
	interleave: (write) => {
		write();
	},
	note: noOp,
	reveal: noOp,
};

class RunProgressReporter implements RunProgress {
	private readonly maxDetailWidth: number;
	private readonly options: RunProgressOptions;
	private readonly records = new Map<StageId, StageRecord>();
	/**
	 * Restores every guarded stream's own `write`; empty while not guarding.
	 */
	private readonly released: Array<() => void> = [];

	private frameIndex = 0;
	private isRevealed = false;
	/**
	 * Whether the block has handed the terminal back. Set once the last stage
	 * completes and never cleared: from then on the rows are scrollback like
	 * any other, so nothing here writes, erases or repaints again.
	 */
	private isSettled = false;
	/**
	 * How many rows are on screen right now, which is NOT the record count: a
	 * stage is recorded before the repaint that first draws it, so between the
	 * two the block is one row shorter than the map. Deriving this from the map
	 * moves the cursor a line too far up and eats the run header.
	 */
	private paintedRows = 0;
	/**
	 * Assigned by `reveal`, which is also the first moment anything renders.
	 */
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
		// Only the repainting shape: the append-only line for this stage has
		// already gone out, and its closing line will carry the detail.
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
		if (this.paintedRows === 0) {
			write();
			return;
		}

		this.options.sink(this.eraseBlock());
		this.paintedRows = 0;
		write();
		this.repaint();
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
			// Nothing open means nothing moves, so a frame would re-emit the
			// block byte for byte. The next state change repaints it anyway.
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

	/** Keeps a row inside the terminal, so a repaint's cursor maths holds. */
	private clampDetail(detail: string): string {
		if (detail.length <= this.maxDetailWidth) {
			return detail;
		}

		return `${detail.slice(0, this.maxDetailWidth - 1)}…`;
	}

	/**
	 * The move back over the drawn block. Every row is one line — details are
	 * clamped to the terminal width so none can wrap — so the height is the row
	 * count the last repaint emitted.
	 */
	private eraseBlock(): string {
		if (this.paintedRows === 0) {
			return "";
		}

		return `${CSI}${this.paintedRows.toString()}A${CSI}0J`;
	}

	/** The one place a state change reaches the terminal, in either shape. */
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

	/**
	 * Wraps every guarded stream's `write` in `interleave`, so a warning from
	 * code that has never heard of this block still lands above it. Released
	 * when the block settles, or by `finish` for a run that never got that far.
	 */
	private guardStreams(): void {
		for (const stream of this.options.guarded) {
			// The stream's own reference is what goes back, not the bound copy
			// the wrapper calls through — restoring the copy would leave an own
			// property standing in for the prototype's method.
			const own = stream.write;
			const invoke = own.bind(stream);
			stream.write = (...args: Array<never>): boolean => {
				let wasAccepted = true;
				this.interleave(() => {
					wasAccepted = invoke(...args);
				});
				return wasAccepted;
			};

			this.released.push(() => {
				stream.write = own;
			});
		}
	}

	private hasActiveStage(): boolean {
		return this.records.values().some((record) => record.state === "active");
	}

	/**
	 * Reopens a stage that already ran, so a repeat accumulates rather than
	 * stacks.
	 */
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
		const erase = this.eraseBlock();
		if (erase === "" && this.records.size === 0) {
			return;
		}

		const frame = SPINNER_FRAMES[this.frameIndex % SPINNER_FRAMES.length];
		assert(frame !== undefined, "frame index is taken modulo the frame count");
		const rows = Array.from(this.records.values(), (record) => {
			return `${formatStage(this.toView(record), { frame, styles: this.styles })}\n`;
		});
		this.options.sink(`${erase}${rows.join("")}`);
		this.paintedRows = rows.length;
	}

	/**
	 * Hands the terminal back once the last stage is done, leaving the rows
	 * that are on screen as ordinary scrollback: `paintedRows` drops to zero,
	 * so the next `interleave` writes straight through instead of erasing a
	 * block it no longer owns, and every later announcement renders nothing.
	 *
	 * Called from wherever a stage can reach its final state with the block
	 * visible, which is either a state change after the header or the header
	 * itself catching up on stages that already ran.
	 */
	private settleIfComplete(): void {
		if (this.isSettled || this.records.get(LAST_STAGE)?.state !== "done") {
			return;
		}

		this.isSettled = true;
		this.paintedRows = 0;
		this.stopAnimating();
	}

	/** Drops the timer and the stream guards, so nothing repaints unasked. */
	private stopAnimating(): void {
		if (this.timer !== undefined) {
			clearInterval(this.timer);
			this.timer = undefined;
		}

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

export function createRunProgress(options: RunProgressOptions): RunProgress {
	return new RunProgressReporter(options);
}

/**
 * The reporter a real run uses: stdout, the wall clock, and the repainting
 * shape whenever stdout is a terminal. A pipe, a redirect and a CI log all
 * report `isTTY` undefined and get the append-only shape instead.
 */
export function createStdoutRunProgress(): RunProgress {
	return createRunProgress({
		frameMs: DEFAULT_FRAME_MS,
		// Only while stderr shares the terminal: redirected to a file it cannot
		// move the cursor, and the erase codes would land in the file.
		guarded: process.stderr.isTTY ? [process.stderr] : [],
		live: process.stdout.isTTY,
		now: () => Date.now(),
		sink: (text) => void process.stdout.write(text),
		width: getTerminalWidth(),
	});
}
