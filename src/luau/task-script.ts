import { CODE_BUNDLE_REBUILD_SOURCE } from "./code-bundle-rebuild.ts";
import { countLinesThroughLastDirective } from "./directive-header.ts";

/**
 * Bind each claim after the directives, before rebuilding.
 */
export function prepareTaskScript({
	hasRebuild,
	script,
}: {
	/** Whether the task reads a Code Bundle before anything else runs. */
	hasRebuild: boolean;
	script: string;
}): (claim: string) => string {
	const lines = script.split("\n");
	const at = countLinesThroughLastDirective(lines);
	const prefix = lines
		.slice(0, at)
		.map((line) => `${line}\n`)
		.join("");
	const rebuild = hasRebuild ? `${CODE_BUNDLE_REBUILD_SOURCE}\n` : "";
	const suffix = rebuild + lines.slice(at).join("\n");
	return (claim) => `${prefix}${claim}${suffix}`;
}
