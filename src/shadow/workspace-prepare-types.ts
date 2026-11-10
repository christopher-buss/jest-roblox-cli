import type { CoverageSettings } from "../config/coverage-settings.ts";
import type { CopyIgnoreMatcher } from "../instrument/discover-files.ts";

/** One workspace package, as root discovery and synthesis read it. */
export interface WorkspacePackageDescriptor {
	/** Package name. */
	name: string;
	/** Per-package `luauRoots`; empty or undefined walks the rojo tree. */
	luauRoots?: Array<string> | undefined;
	/** Directory the package's roots are relative to. */
	packageDirectory: string;
	/** The package's rojo project file. */
	rojoProjectPath: string;
}

/** One package to instrument, with its resolved coverage settings. */
export type WorkspaceCoveragePackage = CoverageSettings & WorkspacePackageDescriptor;

/** A package's compiled coverage-ignore and copy-ignore gates. */
export interface PackageIgnore {
	/** The `coverageCopyIgnorePatterns` gate. */
	copyMatcher: CopyIgnoreMatcher;
	/** Returns `true` for a path the coverage ignore patterns exclude. */
	matcher: (filePath: string) => boolean;
}
