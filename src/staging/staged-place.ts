import * as path from "node:path";

import type { BuildManifestArtifact } from "../coverage-data/build-manifest.ts";
import type { RunProgress } from "../progress/run-progress.ts";
import { describePlaceFile } from "../progress/stages.ts";
import type { TimingCollector } from "../timing/orchestration-collector.ts";
import { ROJO_BUILD_SPAN } from "../timing/span-names.ts";
import type { ChildProcessRunner } from "../utils/child-process.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { buildPlaceAsync, type PlaceReuseOptions } from "./place-builder.ts";
import type { PackageSynthesisInput } from "./synthesizer-types.ts";

/** Inputs of {@link buildStagedPlaceAsync}. */
export type StagedPlaceOptions = PackageSynthesisInput & {
	/** Directory the synthesized project and the reuse caches live in. */
	cacheDirectory: string;
	/** Runner that spawns the rojo build. */
	childProcess: ChildProcessRunner;
	/** File system to read and write through. */
	fileSystem: FileSystem;
	/** Path to write the place to. */
	placeFile: string;
	/** Stage reporter the build describes the place to. */
	progress: RunProgress;
	/** Coverage inputs the reuse key may take instead of walking the trees. */
	reuse?: Pick<PlaceReuseOptions, "forceRebuild" | "manifests" | "shadowRoots"> | undefined;
	/** Collector for the `rojoBuild` span. */
	timing: TimingCollector;
};

/**
 * Build the synthesized place, or reuse it when its inputs are unchanged.
 * @param options - Packages, place path, cache directory and seams.
 * @returns The built place and the build time.
 * @rejects When the rojo build fails.
 */
export async function buildStagedPlaceAsync({
	cacheDirectory,
	childProcess,
	fileSystem,
	placeFile,
	progress,
	reuse,
	timing,
	...synthesis
}: StagedPlaceOptions): Promise<{
	artifact: BuildManifestArtifact;
	elapsedMs: number;
	rebuilt: boolean;
}> {
	const { elapsedMs, value: result } = await timing.profileTimedAsync(
		ROJO_BUILD_SPAN,
		async () => {
			const built = await buildPlaceAsync({
				...synthesis,
				childProcess,
				fileSystem,
				loadStringEnabled: true,
				placeFile,
				projectFile: path.join(cacheDirectory, "synthesized.project.json"),
				reuse: {
					...reuse,
					cacheFile: path.join(cacheDirectory, "synthesized.place-cache.json"),
					digestCacheFile: path.join(cacheDirectory, "synthesized.input-digests"),
				},
			});
			// Must run inside the span: the stage line prints when it closes.
			progress.describe("build", describePlaceFile(placeFile, fileSystem));
			return built;
		},
	);
	return { ...result, elapsedMs };
}
