import * as path from "node:path";
import process from "node:process";

import { WORK_DIRECTORY } from "../utils/work-directory.ts";
import { BUILD_MANIFEST_FILE } from "./build-manifest.ts";

const SHADOW_DIR = `${WORK_DIRECTORY}/coverage`;
/** Outside the shadow, so a cold wipe keeps the place. */
const PLACE_DIR = `${WORK_DIRECTORY}/place`;

/** Where one run's coverage artifacts live. */
export interface CoverageLayout {
	/** The Build Manifest beside the Coverage Manifest. */
	buildManifestPath: string;
	/** The Coverage Manifest. */
	manifestPath: string;
	/** Where the place and its synthesized project are written. */
	placeDirectory: string;
	/** The instrumented place. */
	placeFile: string;
	/** Joined onto a `rootDir`-relative path to name it: empty at the cwd. */
	rootPrefix: string;
	/** The instrumented shadow tree. */
	shadowRoot: string;
}

/**
 * Resolves the coverage artifact paths of a run.
 * @param rootDirectory - The run's `rootDir`.
 * @returns The layout under `rootDir`.
 */
export function resolveCoverageLayout(rootDirectory: string): CoverageLayout {
	const rootPrefix =
		path.relative(process.cwd(), rootDirectory) === "" ? "" : path.resolve(rootDirectory);
	const shadowRoot = path.join(rootPrefix, SHADOW_DIR);
	const placeDirectory = path.join(rootPrefix, PLACE_DIR);
	return {
		buildManifestPath: path.join(shadowRoot, BUILD_MANIFEST_FILE),
		manifestPath: path.join(shadowRoot, "coverage-manifest.json"),
		placeDirectory,
		placeFile: path.join(placeDirectory, "game.rbxl"),
		rootPrefix,
		shadowRoot,
	};
}
