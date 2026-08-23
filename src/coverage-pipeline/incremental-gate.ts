import type { InstrumentUniverse } from "./instrument-universe.ts";
import { INSTRUMENTER_VERSION } from "./instrumenter.ts";
import type { CoverageManifest } from "./manifest.ts";

export interface ReuseCoverageManifestOptions {
	/** The `coverageCache` knob, already resolved for this mode. */
	coverageCache: boolean;
	/** The universe this run will instrument against, if any. */
	universe: InstrumentUniverse | undefined;
}

/**
 * Whether a previous Coverage Manifest still describes the shadow tree this
 * run wants.
 *
 * The gates here are the ones every mode shares, so they live in one place:
 * single/multi (`prepare.ts`) and workspace (`workspace-prepare.ts`) both call
 * this and then add only the check that is genuinely theirs — a dropped
 * `luauRoot` for the first, a changed shadow-dir set for the second.
 *
 * `false` means the caller must wipe the shadow tree and start cold. Nothing
 * here can be repaired incrementally: a bumped instrumenter writes different
 * probes into files whose source hashes never moved, and a narrowed universe
 * demotes a file from instrumented to mirrored while its source hash likewise
 * stays put.
 */
export function canReuseCoverageManifest(
	previousManifest: CoverageManifest | undefined,
	{ coverageCache, universe }: ReuseCoverageManifestOptions,
): previousManifest is CoverageManifest {
	if (!coverageCache || previousManifest === undefined) {
		return false;
	}

	if (previousManifest.instrumenterVersion !== INSTRUMENTER_VERSION) {
		return false;
	}

	return previousManifest.coverageUniverseHash === universe?.digest;
}
