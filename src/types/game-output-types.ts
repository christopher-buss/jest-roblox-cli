import type { GameOutputEntry } from "../protocol/game-output.ts";

/** One group in an Aggregated Game Output file. */
export interface PackageGameOutput {
	/** The messages, in log order. */
	entries: Array<GameOutputEntry>;
	/** The workspace package the group belongs to. */
	package?: string;
	/** The project the group belongs to. */
	project: string;
	/**
	 * Set on a vm-parallel run, where the group holds the whole run's output.
	 */
	scope?: "batch";
}
