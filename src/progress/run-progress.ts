import type { StageId } from "./stages.ts";

/** The sink every stage announcement of a run goes through. */
export interface RunProgress {
	/** Opens a stage; the returned closer completes it. */
	begin: (id: StageId, detail?: string) => (detail?: string) => void;
	/** Attaches a detail to a stage already open. */
	describe: (id: StageId, detail: string | undefined) => void;
	/** Settles the block: stops the animation, marks whatever is still open. */
	finish: () => void;
	/** Runs `write` with the block cleared; all mid-run stdout goes here. */
	interleave: (write: () => void) => void;
	/** Records a stage that was over before it could be announced. */
	note: (id: StageId, detail: string) => void;
	/** Lets output through; call only after the run header is out. */
	reveal: (options: { color: boolean }) => void;
}

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
