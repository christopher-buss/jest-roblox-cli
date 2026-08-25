export interface GameOutputEntry {
	message: string;
	messageType: number;
	timestamp: number;
}

/**
 * One group in an Aggregated Game Output file. `package` is omitted in
 * `multi` mode (a single config has no package identity) and present in
 * `workspace` mode.
 */
export interface PackageGameOutput {
	entries: Array<GameOutputEntry>;
	package?: string;
	project: string;
	/**
	 * Present only on an experimental vm-parallel run, where the group holds
	 * the whole run's output rather than one project's. `LogService.MessageOut`
	 * reports every message to every listener with no source identity, so once
	 * projects overlap there is no honest per-project split to write — the
	 * label says so instead of implying one.
	 */
	scope?: "batch";
}
