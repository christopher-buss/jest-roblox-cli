// The package root entry re-exports this barrel, so it must not reach a `.luau`
// module.
export { atomicWrite } from "../utils/atomic-write.ts";
export type { AtomicWriteOptions } from "../utils/atomic-write.ts";
export { hashFile } from "../utils/hash.ts";
export {
	BUILD_MANIFEST_VERSION,
	buildManifestSchema,
	readBuildManifest,
} from "./build-manifest.ts";
export type {
	BuildManifest,
	BuildManifestArtifact,
	BuildManifestFileRecord,
	BuildManifestProject,
	ReadBuildManifestOptions,
	ReadBuildManifestResult,
} from "./build-manifest.ts";
export type { CoverageMap, SourceLocation } from "./coverage-map.ts";
export { parseVersionedManifest } from "./manifest-parse.ts";
export type { ParsedManifest } from "./manifest-parse.ts";
export {
	MANIFEST_VERSION,
	manifestSchema as coverageManifestSchema,
	readManifest as readCoverageManifest,
} from "./manifest.ts";
export type {
	CoverageManifest,
	InstrumentedFileRecord,
	NonInstrumentedFileRecord,
	ReadManifestResult as ReadCoverageManifestResult,
	TestLocation,
	TestRecord,
} from "./manifest.ts";
