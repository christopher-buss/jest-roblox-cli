import type { PosixRoot } from "../utils/normalize-windows-path.ts";

/** One source root and the instrumented shadow tree standing in for it. */
export interface CoverageRoot {
	/** The source root, in the one spelling `toPosixRoot` gives it. */
	luauRoot: PosixRoot;
	/**
	 * Path the shadow directory lives at (caller picks absolute vs relocated).
	 */
	shadowDir: string;
}

/**
 * True when `target` is `root` itself or sits inside it. Both must already be
 * normalized (forward slashes, no trailing slash), and the `/` guards the
 * boundary so `out-tsc` does not read as inside `out`.
 *
 * The one containment rule the coverage path has: it decides which `$path`
 * mounts a redirect rewrites, and so — read the other way round — which
 * coverage roots the synthesized place can load at all.
 */
export function isWithinRoot(target: string, root: string): boolean {
	return target === root || target.startsWith(`${root}/`);
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
 * `--coverage`) don't transitively load the instrumenter and its embedded
 * wasm parser via `shadow-root.ts`.
 */
export function redirectPathToShadow(
	target: string,
	coverageRoots: ReadonlyArray<CoverageRoot>,
): string | undefined {
	for (const root of coverageRoots) {
		// An exact hit slices nothing off, so it lands on `shadowDir` itself.
		if (isWithinRoot(target, root.luauRoot)) {
			return root.shadowDir + target.slice(root.luauRoot.length);
		}
	}

	return undefined;
}
