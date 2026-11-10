interface InstrumentationSkipInput {
	excluded: ReadonlySet<string>;
	skipFiles: ReadonlySet<string> | undefined;
}

/**
 * Excluded files go to shadow-mirror; cached files keep their prior manifest records.
 * Both must stay out of instrumentRoot.
 * @param input - Cached and excluded paths relative to the instrumented root.
 * @returns The skip set consumed by instrumentRoot.
 */
export function buildInstrumentationSkipFiles({
	excluded,
	skipFiles,
}: InstrumentationSkipInput): Set<string> | undefined {
	return skipFiles === undefined && excluded.size === 0
		? undefined
		: new Set([...(skipFiles ?? []), ...excluded]);
}
