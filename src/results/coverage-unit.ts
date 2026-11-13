import type { CoverageReporter } from "../config/config-types.ts";
import type { ResolvedConfig } from "../config/resolved-config.ts";
import type { RawCoverageData } from "../coverage-data/coverage-types.ts";
import {
	filterCoverageUniverse,
	narrowCoverageToFiles,
} from "../coverage-data/coverage-universe.ts";
import type { CoverageManifest } from "../coverage-data/manifest.ts";
import type { CoverageMapper } from "../coverage-report/mapper.ts";
import type { RunCoverage } from "./run-result-types.ts";

const EMPTY_DATA_NOTICE =
	"Warning: coverage data was empty. The Rojo project may point at uninstrumented source";
const NO_MANIFEST_NOTICE = "Warning: Coverage manifest not found, skipping TS mapping";

/** The settings one coverage report unit is mapped, filtered and gated by. */
export interface CoverageUnitSettings {
	/** Include globs, relative to `rootDir`. */
	collectCoverageFrom?: Array<string> | undefined;
	/** Absolute output directory for the file reporters. */
	coverageDirectory: string;
	/** Ignore patterns, matched against the mapped source path. */
	coveragePathIgnorePatterns?: Array<string> | undefined;
	/** Reporters that render the unit. */
	coverageReporters: Array<CoverageReporter>;
	/** Threshold the unit is gated on; absent means no gate. */
	coverageThreshold?: ResolvedConfig["coverageThreshold"] | undefined;
	/** Directory `collectCoverageFrom` is relative to. */
	rootDir: string;
}

/** Inputs of {@link toCoverageUnit}. */
export interface CoverageUnitInput {
	/**
	 * Narrows mapped coverage while instrumentation retains its full cache
	 * universe.
	 */
	changedFiles?: ReadonlyArray<string> | undefined;
	/** Raw hit counts, or `undefined` when none came back. */
	coverageData: RawCoverageData | undefined;
	/** Package name that heads the unit's report, if any. */
	label?: string | undefined;
	/** Coverage manifest the hits map through, or `undefined` when missing. */
	manifest: CoverageManifest | undefined;
	/** Maps raw hits onto source files. */
	mapCoverage: CoverageMapper;
	/** Settings of the unit. */
	settings: CoverageUnitSettings;
}

/**
 * Map one unit's hits through its manifest and filter them to its universe.
 * @param input - Hits, manifest, mapper, settings and label.
 * @returns One unit, or a notice when the hits or manifest are missing.
 */
export function toCoverageUnit({
	changedFiles,
	coverageData,
	label,
	manifest,
	mapCoverage,
	settings,
}: CoverageUnitInput): RunCoverage {
	const suffix = label === undefined ? "" : ` (${label})`;
	if (coverageData === undefined) {
		return { notice: `${EMPTY_DATA_NOTICE}${suffix}`, units: [] };
	}

	if (manifest === undefined) {
		return { notice: `${NO_MANIFEST_NOTICE}${suffix}`, units: [] };
	}

	const universe = filterCoverageUniverse(mapCoverage({ coverageData, manifest }), {
		ignore: settings.coveragePathIgnorePatterns,
		include: settings.collectCoverageFrom,
		rootDir: settings.rootDir,
	});
	return {
		units: [
			{
				coverageDirectory: settings.coverageDirectory,
				coverageThreshold: settings.coverageThreshold,
				label,
				reporters: settings.coverageReporters,
				universe:
					changedFiles === undefined
						? universe
						: narrowCoverageToFiles({ files: changedFiles, mapped: universe }),
			},
		],
	};
}
