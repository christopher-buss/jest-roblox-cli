import { CODE_BUNDLE_REBUILD_SOURCE } from "./code-bundle-rebuild.ts";
import { countLinesThroughLastDirective } from "./directive-header.ts";

/**
 * Bind each claim after the directives, before rebuilding the Code Bundle.
 */
export function prepareTaskScript({ script }: { script: string }): (claim: string) => string {
	const lines = script.split("\n");
	const at = countLinesThroughLastDirective(lines);
	const prefix = lines
		.slice(0, at)
		.map((line) => `${line}\n`)
		.join("");
	const suffix = `${CODE_BUNDLE_REBUILD_SOURCE}\n${lines.slice(at).join("\n")}`;
	return (claim) => `${prefix}${claim}${suffix}`;
}
