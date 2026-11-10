import assert from "node:assert";
import * as crypto from "node:crypto";
import * as path from "node:path";
import process from "node:process";

import { pickCoverageSettings } from "../config/coverage-settings.ts";
import type { ResolvedConfig } from "../config/resolved-config.ts";
import { requireRojoProject } from "../config/rojo-project.ts";
import { toBuildManifestFiles } from "../coverage-data/build-manifest.ts";
import type { BuildManifestProject, CoverageArtifacts } from "../coverage-data/build-manifest.ts";
import { resolveCoverageLayout } from "../coverage-data/coverage-layout.ts";
import type { CoverageManifest } from "../coverage-data/manifest.ts";
import { writeManifest } from "../coverage-data/manifest.ts";
import { createCopyIgnoreMatcher } from "../instrument/discover-files.ts";
import type { InstrumentUniverse } from "../instrument/instrument-universe.ts";
import { createInstrumentUniverse } from "../instrument/instrument-universe.ts";
import type { Instrumenter } from "../instrument/instrumenter.ts";
import { nodeInstrumenter } from "../instrument/instrumenter.ts";
import { NOOP_RUN_PROGRESS } from "../progress/run-progress.ts";
import { tryComputeRojoInputsHashAsync } from "../staging/rojo-inputs.ts";
import { buildStagedPlaceAsync } from "../staging/staged-place.ts";
import type { TimingCollector } from "../timing/orchestration-collector.ts";
import { NOOP_TIMING_COLLECTOR } from "../timing/orchestration-collector.ts";
import type { TsconfigReader } from "../tsconfig/tsconfig-mappings.ts";
import type { ChildProcessRunner } from "../utils/child-process.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { WORK_DIRECTORY } from "../utils/work-directory.ts";
import { toPathRedirects } from "./coverage-root.ts";
import { narrowConfiguredRoots } from "./luau-roots.ts";
import type {
	CoverageInputs,
	InstrumentedCoverage,
	PrepareCoverageResult,
} from "./prepare-types.ts";
import { createCoverageManifest, prepareShadowTree } from "./shadow-tree.ts";
import { createShadowLayout } from "./spine.ts";
import type { ShadowBake } from "./spine.ts";

const INPUT_DIGEST_PATH = `${WORK_DIRECTORY}/input-digests`;

/** Injectable seams and run inputs for {@link prepareCoverageAsync}. */
export interface PrepareCoverageOptions {
	/** What this run writes into the shadow before the place is built. */
	bake?: ShadowBake | undefined;
	/** What launches rojo for the place build. */
	childProcess: ChildProcessRunner;
	/** Effective include globs; defaults to `collectCoverageFrom`. */
	coverageInclude?: Array<string> | undefined;
	/** Where the shadow is built. Defaults to the real filesystem. */
	fileSystem: FileSystem;
	/** What writes the instrumented twins. Defaults to the real one. */
	instrumenter?: Instrumenter | undefined;
	/** Universe to instrument; resolved from the config when omitted. */
	instrumentUniverse?: InstrumentUniverse | undefined;
	/** The run's timing collector. */
	timing?: TimingCollector | undefined;
	/** How a tsconfig is read. Defaults to the real one. */
	tsconfigReader: TsconfigReader;
}

interface CoverageInputSources {
	config: ResolvedConfig;
	coverageInclude: Array<string> | undefined;
	fileSystem: FileSystem;
	instrumentUniverse: InstrumentUniverse | undefined;
	tsconfigReader: TsconfigReader;
}

type BakedCoveragePlace = Pick<
	PrepareCoverageResult,
	"buildId" | "coveragePlace" | "files" | "manifest" | "placeFile" | "rebuilt"
>;

interface BakeCoveragePlaceOptions {
	bake: ShadowBake | undefined;
	childProcess: ChildProcessRunner;
	config: ResolvedConfig;
	instrumented: InstrumentedCoverage;
	timing: TimingCollector;
}

/**
 * Project the coverage result down to the record an entry point emits.
 * @param result - Prepared coverage.
 * @param projects - Projects the build manifest lists.
 * @returns Coverage artifacts record.
 */
export function toCoverageArtifacts(
	result: PrepareCoverageResult,
	projects: Array<BuildManifestProject>,
): CoverageArtifacts {
	return {
		buildId: result.buildId,
		coveragePlace: result.coveragePlace,
		files: result.files,
		generatedAt: result.manifest.generatedAt,
		projects,
		rebuilt: result.rebuilt,
	};
}

/**
 * Instrument the configured Luau roots into the shadow and bake or reuse the
 * coverage place.
 * @param config - Resolved run config.
 * @param options - Injectable seams and run inputs.
 * @returns The place, manifest and timings for the instrument and staging
 *   phases.
 */
export async function prepareCoverageAsync(
	config: ResolvedConfig,
	{
		bake,
		childProcess,
		coverageInclude,
		fileSystem,
		instrumenter = nodeInstrumenter,
		instrumentUniverse,
		timing = NOOP_TIMING_COLLECTOR,
		tsconfigReader,
	}: PrepareCoverageOptions,
): Promise<PrepareCoverageResult> {
	const { elapsedMs: instrumentMs, value: instrumented } = await timing.profileTimedAsync(
		"instrumentSources",
		async () => {
			const sources = {
				config,
				coverageInclude,
				fileSystem,
				instrumentUniverse,
				tsconfigReader,
			};
			return instrumentAsync(sources, { bake, instrumenter, timing });
		},
	);

	const { elapsedMs: stagingMs, value: baked } = await timing.profileTimedAsync(
		"bakeCoveragePlace",
		async () => bakeCoveragePlaceAsync({ bake, childProcess, config, instrumented, timing }),
	);

	return { ...baked, instrumentMs, stagingMs };
}

async function resolveRojoInputsHashAsync({
	config,
	fileSystem,
	luauRoots,
	rojoProjectPath,
}: {
	config: ResolvedConfig;
	fileSystem: FileSystem;
	luauRoots: Array<string>;
	rojoProjectPath: string;
}): Promise<string | undefined> {
	return tryComputeRojoInputsHashAsync({
		digestCacheFile: path.join(config.rootDir, INPUT_DIGEST_PATH),
		fileSystem,
		luauRoots,
		rojoProjectPath,
		rootDirectory: config.rootDir,
	});
}

function resolveUniverse({
	config,
	coverageInclude,
	fileSystem,
}: {
	config: ResolvedConfig;
	coverageInclude: Array<string> | undefined;
	fileSystem: FileSystem;
}): InstrumentUniverse | undefined {
	return createInstrumentUniverse(
		{
			ignore: config.coveragePathIgnorePatterns,
			include: coverageInclude ?? config.collectCoverageFrom,
			rootDir: config.rootDir,
		},
		fileSystem,
	);
}

async function resolveCoverageInputsAsync({
	config,
	coverageInclude,
	fileSystem,
	instrumentUniverse,
	tsconfigReader,
}: CoverageInputSources): Promise<CoverageInputs> {
	const rojoProjectPath = requireRojoProject(config);
	const isCopyIgnored = createCopyIgnoreMatcher(config.coverageCopyIgnorePatterns);
	const universe = instrumentUniverse ?? resolveUniverse({ config, coverageInclude, fileSystem });
	const rootSources = {
		config,
		fileSystem,
		isCopyIgnored,
		rojoProjectPath,
		tsconfigReader,
		universe,
	};
	const narrowed = narrowConfiguredRoots(rootSources);
	const luauRoots = narrowed.flatMap((entry) => entry.roots);
	const hash = await resolveRojoInputsHashAsync({ ...rootSources, luauRoots });

	return {
		fileSystem,
		layout: resolveCoverageLayout(config.rootDir),
		narrowed,
		rojoInputsHash: hash,
		rojoProjectPath,
		universe,
	};
}

async function instrumentAsync(
	sources: CoverageInputSources,
	{
		bake,
		instrumenter,
		timing,
	}: { bake: ShadowBake | undefined; instrumenter: Instrumenter; timing: TimingCollector },
): Promise<InstrumentedCoverage> {
	const inputs = await resolveCoverageInputsAsync(sources);
	const shadow = prepareShadowTree({
		fileSystem: sources.fileSystem,
		instrumenter,
		isBakeOwned: bake?.isBakeOwned,
		manifestLabel: "Previous coverage manifest",
		manifestPath: inputs.layout.manifestPath,
		narrowed: inputs.narrowed,
		settings: pickCoverageSettings(sources.config),
		shadowRoot: inputs.layout.shadowRoot,
		sourcePrefix: inputs.layout.rootPrefix,
		timing,
		universe: inputs.universe,
	});
	return { inputs, shadow };
}

function coverageBuildManifest(
	{ inputs, shadow }: InstrumentedCoverage,
	rebuilt: boolean,
): CoverageManifest {
	if (!rebuilt) {
		const previous = shadow.previousManifest;
		assert(previous !== undefined);
		process.stderr.write(`Reusing cached coverage place (built ${previous.generatedAt})\n`);
		return previous;
	}

	return createCoverageManifest(shadow, {
		buildId: crypto.randomUUID(),
		placeFilePath: inputs.layout.placeFile,
		rojoInputsHash: inputs.rojoInputsHash,
	});
}

async function stageCoveragePlaceAsync({
	bake,
	childProcess,
	config,
	instrumented: { inputs, shadow },
	timing,
}: BakeCoveragePlaceOptions): ReturnType<typeof buildStagedPlaceAsync> {
	const { fileSystem, layout } = inputs;
	const shadowLayout = createShadowLayout(layout.shadowRoot, inputs.narrowed);
	const hasBakeChanges = bake?.run(shadowLayout) ?? false;
	const hasRojoDrift =
		inputs.rojoInputsHash !== undefined &&
		shadow.previousManifest?.rojoInputsHash !== inputs.rojoInputsHash;
	const descriptor = {
		redirects: toPathRedirects(path.resolve(config.rootDir), shadow.coverageRoots),
		rojoProjectPath: path.resolve(inputs.rojoProjectPath),
		spine: toPathRedirects(path.resolve(config.rootDir), shadow.coverageSpine),
		stubMounts: bake?.stubMounts(shadowLayout),
	};
	return buildStagedPlaceAsync({
		cacheDirectory: layout.placeDirectory,
		childProcess,
		fileSystem,
		packages: [descriptor],
		placeFile: layout.placeFile,
		progress: NOOP_RUN_PROGRESS,
		reuse: {
			forceRebuild: !shadow.isIncremental || shadow.changed || hasBakeChanges || hasRojoDrift,
		},
		timing,
		wrap: false,
	});
}

/**
 * Bake stubs and build through the shared staging orchestrator.
 * @param options - Bake hook, process runner, config, shadow and profiler.
 * @returns The staged place and its coverage identity.
 */
async function bakeCoveragePlaceAsync(
	options: BakeCoveragePlaceOptions,
): Promise<BakedCoveragePlace> {
	const { inputs, shadow } = options.instrumented;
	const built = await stageCoveragePlaceAsync(options);
	const manifest = coverageBuildManifest(options.instrumented, built.rebuilt);
	writeManifest({
		filePath: inputs.layout.manifestPath,
		fileSystem: inputs.fileSystem,
		manifest,
	});
	return {
		buildId: manifest.buildId,
		coveragePlace: built.artifact,
		files: toBuildManifestFiles(shadow.files),
		manifest,
		placeFile: inputs.layout.placeFile,
		rebuilt: built.rebuilt,
	};
}
