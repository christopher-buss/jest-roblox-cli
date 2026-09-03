// Artifact contract: BuildManifest + CoverageManifest schemas, validating
// readers, the canonical file-hash helper, and the shared read/write
// primitives (versioned-manifest parse, atomic write). Consumed by
// mutation-tester and other downstream artifact readers (e.g. the standalone
// `flux` package).
//
// This barrel has a deliberately clean import graph (no `.luau` modules), so the
// `source`-condition entry can re-export it for workspace typecheck without
// dragging in the CLI's Luau-importing modules.
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
