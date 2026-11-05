/** One message the game logged during a run. */
export interface GameOutputEntry {
	/** The logged text. */
	message: string;
	/** The Roblox `Enum.MessageType` value of the message. */
	messageType: number;
	/** When the game logged the message. */
	timestamp: number;
}

/**
 * One group in an Aggregated Game Output file. `package` is omitted in
 * `multi` mode (a single config has no package identity) and present in
 * `workspace` mode.
 */
export interface PackageGameOutput {
	/** The messages, in log order. */
	entries: Array<GameOutputEntry>;
	/** The workspace package the group belongs to. */
	package?: string;
	/** The project the group belongs to. */
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
