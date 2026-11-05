import type { Except } from "type-fest";

import type { CoverageRoot } from "../coverage-pipeline/redirect-path.ts";
import type { WorkspacePackageDescriptor } from "../coverage-pipeline/workspace-prepare-types.ts";

/** A generated `jest.config` stub and where it mounts. */
export interface StubMount {
	/** Absolute path of the stub file. */
	absStubPath: string;
	/** Slash-joined DataModel path of the node that receives the stub. */
	dataModelPath: string;
}

/**
 * One package to synthesize into the place. The coverage settings it shares
 * with {@link WorkspacePackageDescriptor} are forwarded to
 * `prepareWorkspaceCoverage`; synthesis does not read them.
 */
export interface PackageDescriptor extends WorkspacePackageDescriptor {
	/** Staging name under `ServerStorage.__pkg_stage`. */
	name: string;
	/**
	 * When set, $path entries that fall inside any listed `luauRoot` are
	 * redirected to the corresponding `shadowDir` so the synthesized place
	 * picks up instrumented sources for this package only. Packages without
	 * `coverageRoots` use their original $path entries unchanged.
	 */
	coverageRoots?: Array<CoverageRoot> | undefined;
	/**
	 * The directories between each `coverageRoots` entry and the `$path` mount
	 * above it, mapped to the shadow's copy of that directory's own loose
	 * files. A mount named here is demoted: its `$path` moves to the spine copy
	 * and every directory beneath it becomes an explicit child, so the coverage
	 * root can be swapped without the mount above serving the originals.
	 */
	coverageSpine?: Array<CoverageRoot> | undefined;
	/** `jest.config` stubs to mount into the package's tree. */
	stubMounts?: Array<StubMount> | undefined;
}

/** {@link PackageDescriptor} without a staging name. */
export type UnwrappedPackageDescriptor = Except<PackageDescriptor, "name">;

/** One package emitted at the project root without a staging name. */
export interface UnwrappedPackageSynthesisInput {
	/** The packages to emit. */
	packages: Array<UnwrappedPackageDescriptor>;
	/** Selects the unwrapped layout. */
	wrap: false;
}

/** Packages to synthesize, wrapped or unwrapped. */
export type PackageSynthesisInput = UnwrappedPackageSynthesisInput | WrappedPackageSynthesisInput;

/** Packages staged below `ServerStorage.__pkg_stage.<name>`. */
interface WrappedPackageSynthesisInput {
	packages: Array<PackageDescriptor>;
	wrap?: true | undefined;
}

// Re-exported rather than restated: synthesis and the redirect read the same
// pairing, and two copies drift apart the moment one gains a field.
export { type CoverageRoot } from "../coverage-pipeline/redirect-path.ts";
