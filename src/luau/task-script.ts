import { placeIdentityGuardSource } from "@isentinel/roblox-runner";

import { CODE_BUNDLE_REBUILD_SOURCE } from "./code-bundle-rebuild.ts";
import { countLinesThroughLastDirective } from "./directive-header.ts";

/**
 * The script a task actually runs: the caller's, behind whatever this run has
 * to put in front of it.
 *
 * The one composition point every submit goes through — the head attempt, the
 * pinned retry, a work-stealing shard, a deferral re-send — so no shape can
 * lose one of the two preambles the others carry. It lives here rather than
 * beside the backend for the same reason the two preambles do: what goes in
 * front of a task script is a property of the script, not of the transport.
 *
 * Both sit behind the script's header block: Luau honors `--!strict`,
 * `--!native` and the rest only while nothing else has opened the file, so a
 * plain line-1 prepend would silently disable a caller's directives. The
 * version is the identity available for the guard — the backend runs a place a
 * caller handed it rather than one it built, so there is no Place Content Id it
 * could hold the other half of.
 *
 * The rebuild goes below the guard, and the header is measured once rather than
 * re-scanned after the guard is in: a task refused for booting another place
 * version returns before it rebuilds anything, and a second scan would read the
 * guard as the first line of code and put the rebuild above it.
 */
export function composeTaskScript({
	hasRebuild,
	placeVersion,
	script,
}: {
	/** Whether the task reads a Code Bundle before anything else runs. */
	hasRebuild: boolean;
	/** Absent for a submit that carries no guard: an owned place, or a pin. */
	placeVersion: number | undefined;
	script: string;
}): string {
	const lines = script.split("\n");
	// Measured once rather than re-scanned after the guard is in: a second scan
	// would read the guard as the first line of code and put the rebuild above
	// it, where a refused task would pay for a rebuild it never uses.
	let at = countLinesThroughLastDirective(lines);
	if (placeVersion !== undefined) {
		lines.splice(at, 0, placeIdentityGuardSource({ placeVersion }));
		at += 1;
	}

	if (hasRebuild) {
		lines.splice(at, 0, CODE_BUNDLE_REBUILD_SOURCE);
	}

	// Rejoined even when nothing was spliced: a submit that carries neither
	// preamble gets its own script back byte for byte, and a branch that
	// returned early would be one no test could tell from this.
	return lines.join("\n");
}
