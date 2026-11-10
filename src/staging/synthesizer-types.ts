import type { Except } from "type-fest";

import type { PathRedirect } from "./path-redirect.ts";

/** A generated `jest.config` stub and where it mounts. */
export interface StubMount {
	/** Absolute path of the stub file. */
	absStubPath: string;
	/** Slash-joined DataModel path of the node that receives the stub. */
	dataModelPath: string;
}

/** One package to synthesize into the place. */
export interface PackageDescriptor {
	/** Staging name under `ServerStorage.__pkg_stage`. */
	name: string;
	/** `$path` entries inside a redirect's `from` read its `to` instead. */
	redirects?: ReadonlyArray<PathRedirect> | undefined;
	/** The package's rojo project file. */
	rojoProjectPath: string;
	/** Mounts to demote so a redirect below them can apply. */
	spine?: ReadonlyArray<PathRedirect> | undefined;
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
