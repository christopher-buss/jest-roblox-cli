import * as path from "node:path";
import process from "node:process";

import type { ResolvedConfig } from "../config/schema.ts";
import type { StubMount } from "../staging/synthesizer-types.ts";
import type { ChildProcessRunner } from "../utils/child-process.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { hashFileAsync } from "../utils/hash.ts";
import type { PosixRoot } from "../utils/normalize-windows-path.ts";
import type { BuildManifestArtifact, BuildManifestFileRecord } from "./build-manifest.ts";
import { readBuildManifest, toBuildManifestFiles } from "./build-manifest.ts";
import type { BuildCoveragePlaceOptions } from "./place-build.ts";
import {
	buildPlaceAndManifestAsync,
	COVERAGE_PLACE_FILE,
	describeCodeSplit,
	reuseCodeBundle,
	SHADOW_DIR,
} from "./place-build.ts";
import type {
	CoverageInputs,
	InstrumentedCoverage,
	PrepareCoverageResult,
	ShadowRootsResult,
} from "./prepare-types.ts";
import type { ShadowBake } from "./spine.ts";
import { createShadowLayout } from "./spine.ts";

interface PriorPlaceReuse {
	/**
	 * The prior manifest's validated coverage place, when a build manifest
	 * exists. `readBuildManifest` already re-hashed it, so the caller reuses
	 * this rather than hashing the same `.rbxl` a second time. Absent for
	 * pre-BuildManifest caches (coverage manifest only).
	 */
	coveragePlace?: BuildManifestArtifact | undefined;
	reusable: boolean;
}

/**
 * The place the bake settled on, reused or built: the result minus the two
 * phase timings, which only the caller that spanned them can supply.
 */
type BakedCoveragePlace = Pick<
	PrepareCoverageResult,
	"buildId" | "codeBundle" | "coveragePlace" | "files" | "manifest" | "placeFile" | "rebuilt"
>;

interface BakeCoveragePlaceOptions {
	bake: ShadowBake | undefined;
	childProcess: ChildProcessRunner;
	codeRoots: ReadonlyArray<PosixRoot> | undefined;
	config: ResolvedConfig;
	instrumented: InstrumentedCoverage;
}

/**
 * Bake the run's stubs into the instrumented tree, decide whether the cached
 * place still answers for it, and build one when it does not. Everything a
 * non-coverage run would pay for over uninstrumented sources, which is why the
 * caller reports it as staging rather than as coverage.
 * @param options - Bake hook, process runner, code roots, config and the
 *   instrumented tree.
 * @returns The reused or freshly built place, without phase timings.
 */
export async function bakeCoveragePlaceAsync({
	bake,
	childProcess,
	codeRoots,
	config,
	instrumented: { inputs, isIncremental, shadow },
}: BakeCoveragePlaceOptions): Promise<BakedCoveragePlace> {
	const { hasBakeChanges, stubMounts } = runBake(bake, inputs.narrowed);
	const build = toBuildOptions({ childProcess, codeRoots, config, inputs, shadow, stubMounts });
	const hasChanges = hasCoverageChanges(inputs, {
		hasExtraChanges:
			hasBakeChanges ||
			stubMounts.length > 0 ||
			inputs.previousManifest?.codeSplitKey !== describeCodeSplit(codeRoots),
		isIncremental,
		shadow,
	});
	const files = toBuildManifestFiles(shadow.files);
	const reused = await reuseCoverageResultAsync({ ...inputs, files, hasChanges });
	// The bundle is written either way: the reused place never held this run's
	// code, and the gate above only proved the harness itself is still current.
	if (reused !== undefined) {
		return { ...reused, codeBundle: reuseCodeBundle(build) };
	}

	const built = await buildPlaceAndManifestAsync({ build, inputs, shadow });
	return {
		buildId: built.buildId,
		codeBundle: built.codeBundle,
		coveragePlace: built.coveragePlace,
		files,
		manifest: built.manifest,
		placeFile: COVERAGE_PLACE_FILE,
		rebuilt: true,
	};
}

/**
 * A non-luauRoot rojo input changed — the shadow diff can't see those, so force
 * a rebuild rather than reuse a stale place built from the old include/ or
 * vendored sources. When the inputs couldn't be hashed the check is skipped
 * (not forced): a project too broken to hash would also fail the rebuild's own
 * parse, so preserve the prior reuse behavior instead of converting it into a
 * hard failure.
 * @param inputs - Coverage inputs holding the previous and current rojo hash.
 * @param isIncremental - Whether this run may reuse a prior place.
 * @returns True when an incremental run sees a changed rojo input hash.
 */
function hasRojoInputDrift(
	{ previousManifest, rojoInputsHash }: CoverageInputs,
	isIncremental: boolean,
): boolean {
	return (
		isIncremental &&
		rojoInputsHash !== undefined &&
		previousManifest?.rojoInputsHash !== rojoInputsHash
	);
}

/**
 * Rebuild unless every input is unchanged: a non-incremental run always
 * rebuilds, and so does any drift in the shadow tree, the caller's bake hook, or
 * a rojo input.
 * @param inputs - Previous manifest and rojo input hash.
 * @param options - Extra drift flag, incremental flag and shadow result.
 * @returns True when the place must be rebuilt.
 */
function hasCoverageChanges(
	inputs: CoverageInputs,
	{
		hasExtraChanges,
		isIncremental,
		shadow,
	}: { hasExtraChanges: boolean; isIncremental: boolean; shadow: ShadowRootsResult },
): boolean {
	return (
		!isIncremental ||
		shadow.changed ||
		hasExtraChanges ||
		hasRojoInputDrift(inputs, isIncremental)
	);
}

function priorPlaceIsReusable({
	buildManifestPath,
	fileSystem,
	placeFilePath,
}: {
	buildManifestPath: string;
	fileSystem: FileSystem;
	placeFilePath: string;
}): PriorPlaceReuse {
	if (!fileSystem.existsSync(placeFilePath)) {
		return { reusable: false };
	}

	// A prior build manifest validates the cached artifacts: `readBuildManifest`
	// re-hashes the coverage place (and sources), so any drift or corruption
	// yields a non-ok result and forces a rebuild. Pre-BuildManifest caches
	// (coverage manifest only) have no build manifest yet, so the existence check
	// above is the only gate — keeping the no-change path working across
	// upgrades.
	const previous = readBuildManifest(buildManifestPath, { fileSystem });
	if (previous.kind === "missing") {
		return { reusable: true };
	}

	if (previous.kind !== "ok") {
		process.stderr.write(
			`Warning: Previous build manifest is unusable (${previous.kind}); rebuilding place.\n`,
		);
		return { reusable: false };
	}

	return { coveragePlace: previous.manifest.coveragePlace, reusable: true };
}

/**
 * Incremental no-change short-circuit: reuse the prior place only if it is
 * still on disk and its bytes match the prior build manifest's record. A
 * missing or drifted artifact (for example an interrupted prior build) returns
 * `undefined` so the caller does a full rebuild rather than publishing a
 * manifest that points at a stale or absent `.rbxl`.
 * @param options - Coverage inputs, build manifest files and change flag.
 * @returns The reused place, or undefined when a rebuild is needed.
 */
async function reuseCoverageResultAsync({
	buildManifestPath,
	files,
	fileSystem,
	hasChanges,
	previousManifest,
}: CoverageInputs & {
	files: Record<string, BuildManifestFileRecord>;
	hasChanges: boolean;
}): Promise<BakedCoveragePlace | undefined> {
	if (hasChanges || previousManifest?.placeFilePath === undefined) {
		return undefined;
	}

	const { buildId, placeFilePath } = previousManifest;
	// A manifest from before `PLACE_DIR` points into the shadow.
	if (path.normalize(placeFilePath) !== COVERAGE_PLACE_FILE) {
		return undefined;
	}

	const reuse = priorPlaceIsReusable({ buildManifestPath, fileSystem, placeFilePath });
	if (!reuse.reusable) {
		return undefined;
	}

	// Nothing was built, but the gate that decided so re-hashed the cached
	// place, so this phase still carries what the decision cost.
	process.stderr.write(`Reusing cached coverage place (built ${previousManifest.generatedAt})\n`);

	return {
		buildId,
		// Reuse the hash `readBuildManifest` already computed; only a
		// pre-BuildManifest cache (no recorded place) falls back to hashing.
		coveragePlace: reuse.coveragePlace ?? {
			hash: await hashFileAsync(placeFilePath, fileSystem),
			path: placeFilePath,
		},
		files,
		manifest: previousManifest,
		placeFile: placeFilePath,
		rebuilt: false,
	};
}

/**
 * Everything the place build and the bundle split both read.
 * @param options - Process runner, code roots, config, inputs, shadow and stub
 *   mounts.
 * @returns Place build options.
 */
function toBuildOptions({
	childProcess,
	codeRoots,
	config,
	inputs,
	shadow,
	stubMounts,
}: {
	childProcess: ChildProcessRunner;
	codeRoots: ReadonlyArray<PosixRoot> | undefined;
	config: ResolvedConfig;
	inputs: CoverageInputs;
	shadow: ShadowRootsResult;
	stubMounts: Array<StubMount>;
}): BuildCoveragePlaceOptions {
	return {
		childProcess,
		codeRoots,
		fileSystem: inputs.fileSystem,
		packageDirectory: config.rootDir,
		rojoProjectPath: inputs.rojoProjectPath,
		shadow,
		stubMounts,
	};
}

function runBake(
	bake: ShadowBake | undefined,
	narrowed: CoverageInputs["narrowed"],
): { hasBakeChanges: boolean; stubMounts: Array<StubMount> } {
	if (bake === undefined) {
		return { hasBakeChanges: false, stubMounts: [] };
	}

	const layout = createShadowLayout(SHADOW_DIR, narrowed);
	return { hasBakeChanges: bake.run(layout), stubMounts: bake.stubMounts(layout) };
}
