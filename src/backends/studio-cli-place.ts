import * as path from "node:path";

import { resolvePlaceFilePath } from "../config/schema.ts";
import type { BuildManifestArtifact } from "../coverage-pipeline/build-manifest.ts";
import { findRojoProject } from "../coverage-pipeline/luau-roots.ts";
import type { BuildPlaceOptions } from "../staging/place-builder.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { isWorkspaceRun, type ProjectJob } from "./interface.ts";
import type { RunPlace } from "./studio-cli-bootstrap.ts";

type PlaceBuilder = (options: BuildPlaceOptions) => Promise<BuildManifestArtifact>;

const BACKEND_NAME = "studio-cli";
const WORK_DIR = path.join(".jest-roblox", BACKEND_NAME);
const PLACE_FILE = "place.rbxl";
const PLACE_PROJECT_FILE = "place.project.json";

/**
 * Resolve the place Studio opens for this run and the scratch directory its
 * bootstrap/output files live in, creating both as needed.
 *
 * @param options - Place builder, file system, and the run's jobs.
 * @returns The place file, work directory, and whether the run is a workspace
 *   run.
 */
export async function prepareRunPlaceAsync({
	buildPlaceAsync,
	fileSystem,
	jobs,
}: {
	readonly buildPlaceAsync: PlaceBuilder;
	readonly fileSystem: FileSystem;
	readonly jobs: Array<ProjectJob>;
}): Promise<RunPlace> {
	// jobs[0] is the per-run knob source (rootDir, rojoProject, timeout).
	// oxlint-disable-next-line typescript/no-non-null-assertion -- assertSerialJobs checked length
	const primary = jobs[0]!;

	const rootDirectory = path.resolve(primary.config.rootDir);
	const workDirectory = path.join(rootDirectory, WORK_DIR);
	fileSystem.mkdirSync(workDirectory, { recursive: true });

	// Which place studio-cli drives, by run shape:
	// - workspace: the synthesized mega-place the workspace runner already
	//   built (with the `__pkg_stage` staging the materializer clones from);
	// - coverage: the Coverage-Instrumented Place `prepareCoverage` built and
	//   recorded in `config.placeFile` — a Clean Place here drops the
	//   instrumentation and reports 0% for every file;
	// - normal: a freshly built Clean Place.
	// Only the normal path builds here; the others reuse `config.placeFile`,
	// already built with LoadStringEnabled so the Run-mode gate passes.
	const isWorkspace = isWorkspaceRun(jobs);
	if (isWorkspace) {
		return {
			isWorkspace,
			placeFile: path.resolve(primary.config.placeFile),
			workDirectory,
		};
	}

	if (primary.config.collectCoverage) {
		return { isWorkspace, placeFile: resolvePlaceFilePath(primary.config), workDirectory };
	}

	return {
		isWorkspace,
		placeFile: await buildCleanPlaceAsync({
			buildPlaceAsync,
			primary,
			rootDirectory,
			workDirectory,
		}),
		workDirectory,
	};
}

/**
 * Build the Clean Place for a normal (non-coverage) run and return its
 * path. `loadStringEnabled` is forced on so the Run-mode runner's
 * LoadString gate passes. Coverage runs skip this and open the instrumented
 * place instead.
 *
 * @param options - Place builder, primary job, root and work directories.
 * @returns The place file path.
 */
async function buildCleanPlaceAsync({
	buildPlaceAsync,
	primary,
	rootDirectory,
	workDirectory,
}: {
	readonly buildPlaceAsync: PlaceBuilder;
	readonly primary: ProjectJob;
	readonly rootDirectory: string;
	readonly workDirectory: string;
}): Promise<string> {
	const placeFile = path.join(workDirectory, PLACE_FILE);
	await buildPlaceAsync({
		loadStringEnabled: true,
		packages: [
			{
				packageDirectory: rootDirectory,
				rojoProjectPath: path.resolve(findRojoProject(primary.config)),
			},
		],
		placeFile,
		projectFile: path.join(workDirectory, PLACE_PROJECT_FILE),
		wrap: false,
	});

	return placeFile;
}
