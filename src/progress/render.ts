import type { Styles } from "../formatters/styles.ts";
import { STAGE_IDS, STAGE_LABELS, type StageId } from "./stages.ts";

/**
 * Where a stage stands. `unfinished` is the state a stage is left in when the
 * run ends while it is still open — a throw mid-upload, a killed process — so
 * the block says which step it died on rather than freezing on a spinner.
 */
export type StageState = "active" | "done" | "unfinished";

export interface StageView {
	id: StageId;
	detail: string | undefined;
	elapsedMs: number;
	state: StageState;
}

export interface StageRenderOptions {
	/**
	 * The spinner glyph for this repaint, and the whole difference between the
	 * two shapes: with one, an open stage animates and shows how long it has
	 * been running, because the next repaint replaces the row. Without one the
	 * line is already in the scrollback, so it carries neither.
	 */
	frame: string | undefined;
	styles: Styles;
}

const LABEL_WIDTH = Math.max(...STAGE_IDS.map((id) => STAGE_LABELS[id].length));
const MILLISECONDS_PER_SECOND = 1000;

/** One stage, as a line of the scrollback or a row of the repainting block. */
export function formatStage(view: StageView, { frame, styles }: StageRenderOptions): string {
	const label = STAGE_LABELS[view.id].padEnd(LABEL_WIDTH);
	const trailing = [view.detail, elapsedFor(view, frame)]
		.filter((part) => part !== undefined)
		.map((part) => styles.dim(part))
		.join("  ");
	return ` ${markerFor(view.state, { frame, styles })} ${label}  ${trailing}`.trimEnd();
}

/**
 * Durations as a stage reports them: milliseconds below a second, seconds to
 * one decimal above it. A stage is a whole step of a run rather than one test,
 * so `31640ms` is a number to decode where `31.6s` is one to read.
 */
function formatElapsed(elapsedMs: number): string {
	if (elapsedMs < MILLISECONDS_PER_SECOND) {
		return `${elapsedMs.toFixed(0)}ms`;
	}

	return `${(elapsedMs / MILLISECONDS_PER_SECOND).toFixed(1)}s`;
}

/** What a stage in this state has to say about its duration, if anything. */
function elapsedFor(view: StageView, frame: string | undefined): string | undefined {
	if (view.state === "done" || (frame !== undefined && view.state === "active")) {
		return formatElapsed(view.elapsedMs);
	}

	return undefined;
}

function markerFor(state: StageState, { frame, styles }: StageRenderOptions): string {
	if (state === "done") {
		return styles.status.pass("✓");
	}

	if (state === "unfinished") {
		return styles.dim("·");
	}

	return frame === undefined ? styles.dim("→") : styles.status.pending(frame);
}
