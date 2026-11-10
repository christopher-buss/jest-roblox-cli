import type { Styles } from "../terminal/palette.ts";
import { STAGE_IDS, STAGE_LABELS, type StageId } from "./stages.ts";

/** Where a stage stands; `unfinished` marks one open when the run ended. */
export type StageState = "active" | "done" | "unfinished";

/** Snapshot of one stage for rendering. */
export interface StageView {
	/** Stage the row belongs to. */
	id: StageId;
	/** Text after the label, or `undefined` for none. */
	detail: string | undefined;
	/** Time the stage has run, in milliseconds. */
	elapsedMs: number;
	/** Where the stage stands. */
	state: StageState;
}

/** Spinner frame and styles for one render. */
export interface StageRenderOptions {
	/** Spinner glyph for a repaint, or `undefined` for a scrollback line. */
	frame: string | undefined;
	/** Colors for the marker and the trailing parts. */
	styles: Styles;
}

const LABEL_WIDTH = Math.max(...STAGE_IDS.map((id) => STAGE_LABELS[id].length));
const MILLISECONDS_PER_SECOND = 1000;

/**
 * One stage, as a line of the scrollback or a row of the repainting block.
 * @param view - Stage to render.
 * @param options - Spinner frame and styles.
 * @param options.frame - Spinner glyph, or `undefined` for a scrollback line.
 * @param options.styles - Colors for the marker and the trailing parts.
 * @returns The rendered line, without a newline.
 */
export function formatStage(view: StageView, { frame, styles }: StageRenderOptions): string {
	const label = STAGE_LABELS[view.id].padEnd(LABEL_WIDTH);
	const trailing = [view.detail, elapsedFor(view, frame)]
		.filter((part) => part !== undefined)
		.map((part) => styles.dim(part))
		.join("  ");
	return ` ${markerFor(view.state, { frame, styles })} ${label}  ${trailing}`.trimEnd();
}

function formatElapsed(elapsedMs: number): string {
	if (elapsedMs < MILLISECONDS_PER_SECOND) {
		return `${elapsedMs.toFixed(0)}ms`;
	}

	return `${(elapsedMs / MILLISECONDS_PER_SECOND).toFixed(1)}s`;
}

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
