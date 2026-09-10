import { placeIdentityGuardSource } from "@isentinel/roblox-runner";

import { CODE_BUNDLE_REBUILD_SOURCE } from "./code-bundle-rebuild.ts";
import { countLinesThroughLastDirective } from "./directive-header.ts";

/**
 * Bind each claim after the directives and version guard, before rebuilding.
 */
export function prepareTaskScript({
	hasRebuild,
	placeVersion,
	script,
}: {
	/** Whether the task reads a Code Bundle before anything else runs. */
	hasRebuild: boolean;
	/** Absent for a submit that carries no guard: an owned place, or a pin. */
	placeVersion: number | undefined;
	script: string;
}): (claim: string) => string {
	const lines = script.split("\n");
	// Measured once rather than re-scanned after the guard is in: a second scan
	// would read the guard as the first line of code and put the rebuild above
	// it, where a refused task would pay for a rebuild it never uses.
	let at = countLinesThroughLastDirective(lines);
	if (placeVersion !== undefined) {
		lines.splice(at, 0, placeIdentityGuardSource({ placeVersion }));
		at += 1;
	}

	const prefix = lines
		.slice(0, at)
		.map((line) => `${line}\n`)
		.join("");
	const rebuild = hasRebuild ? `${CODE_BUNDLE_REBUILD_SOURCE}\n` : "";
	const suffix = rebuild + lines.slice(at).join("\n");
	return (claim) => `${prefix}${claim}${suffix}`;
}
