export interface CoverageRoot {
	/** Normalized path of the source root (no trailing slash). */
	luauRoot: string;
	/** Path the shadow directory lives at (caller picks absolute vs relocated). */
	shadowDir: string;
}

/**
 * If `target` falls within any coverage root, return the equivalent path
 * inside the corresponding shadow directory. Otherwise return `undefined`.
 *
 * Inputs must already be normalized (forward slashes, no trailing slash on
 * `luauRoot`). Callers handle their own fallback semantics.
 *
 * Lives in its own module so callers that only need the redirect (e.g. the
 * synthesizer, which runs on every workspace invocation regardless of
 * `--coverage`) don't transitively load the instrumenter and its inlined
 * `parse-ast.luau` source via `shadow-root.ts`.
 */
export function redirectPathToShadow(
	target: string,
	coverageRoots: ReadonlyArray<CoverageRoot>,
): string | undefined {
	for (const root of coverageRoots) {
		if (target === root.luauRoot) {
			return root.shadowDir;
		}

		if (target.startsWith(`${root.luauRoot}/`)) {
			return root.shadowDir + target.slice(root.luauRoot.length);
		}
	}

	return undefined;
}
