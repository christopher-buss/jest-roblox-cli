/**
 * The identity of one (package, project) pair, for the maps a workspace run
 * keys by it — the file selection and the per-package output sinks.
 *
 * JSON-encode the pair so neither segment's content can collide into another
 * pair's key (parity with `groupTypecheckByTsconfig`). A project's
 * `displayName` is unique only within its own package, so keying on it alone
 * would let two packages that both name a project `shared` collapse onto one
 * entry.
 *
 * One encoder, not one per map: the two callers key the same pair, and a rule
 * added to only one of them would surface as a package silently unfiltered, or
 * written to another package's output file, rather than as an error.
 */
export function projectKey(packageName: string, project: string): string {
	return JSON.stringify([packageName, project]);
}
