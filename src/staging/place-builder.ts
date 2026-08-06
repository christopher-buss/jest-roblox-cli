import * as fs from "node:fs";
import * as path from "node:path";

import type { BuildManifestArtifact } from "../coverage-pipeline/build-manifest.ts";
import { hashFile } from "../utils/hash.ts";
import { buildWithRojo } from "../utils/rojo-builder.ts";
import { relativizeProjectPaths } from "./relativize-paths.ts";
import type { PackageDescriptor } from "./synthesizer.ts";
import { synthesize } from "./synthesizer.ts";

export interface BuildPlaceOptions {
	/**
	 * Force `ServerScriptService.LoadStringEnabled = true` on the built place.
	 * Used by studio-cli's Clean Place, whose Run-mode runner gates on
	 * LoadString. Forwarded verbatim to {@link synthesize}.
	 */
	loadStringEnabled?: boolean | undefined;
	packages: Array<PackageDescriptor>;
	placeFile: string;
	projectFile: string;
	wrap?: boolean | undefined;
}

/**
 * Synthesize a rojo project for `packages`, write it to `projectFile`, build
 * the `.rbxl` at `placeFile`, and hash the result into a
 * `BuildManifestArtifact`. The single seam every place build routes through: a
 * Clean Place and a Coverage-Instrumented Place differ only in whether the
 * descriptors carry `coverageRoots`.
 */
export function buildPlace({
	loadStringEnabled,
	packages,
	placeFile,
	projectFile,
	wrap,
}: BuildPlaceOptions): BuildManifestArtifact {
	// Relative `$path`s, written last: rojo matches `globIgnorePaths` against the
	// path as the project expresses it, so absolute ones would leave the ignore
	// list inert.
	const projectJson = relativizeProjectPaths(
		synthesize({ loadStringEnabled, packages, wrap }),
		path.dirname(projectFile),
	);
	fs.mkdirSync(path.dirname(projectFile), { recursive: true });
	fs.writeFileSync(projectFile, projectJson);
	// `rojo build -o` fails if the output directory is missing, so ensure it
	// exists for every caller rather than relying on each one to pre-create it.
	fs.mkdirSync(path.dirname(placeFile), { recursive: true });
	buildWithRojo(projectFile, placeFile);

	return { hash: hashFile(placeFile), path: placeFile };
}
