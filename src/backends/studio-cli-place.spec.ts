import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { createResolvedConfig } from "#test/mocks/resolved-config.ts";
import type { ResolvedConfig } from "../config/schema.ts";
import type { BuildManifestArtifact } from "../coverage-pipeline/build-manifest.ts";
import type { BuildPlaceOptions } from "../staging/place-builder.ts";
import type { ProjectJob } from "./interface.ts";
import { prepareRunPlaceAsync } from "./studio-cli-place.ts";

const WORK_DIRECTORY = path.join(path.resolve("/repo"), ".jest-roblox", "studio-cli");

function job(overrides: Partial<ResolvedConfig> = {}): ProjectJob {
	return {
		config: {
			...createResolvedConfig(),
			backend: "studio-cli",
			rojoProject: "default.project.json",
			rootDir: "/repo",
			...overrides,
		},
		displayName: "alpha",
		testFiles: ["alpha/test.spec.ts"],
	};
}

async function prepareAsync(jobs: Array<ProjectJob>) {
	const { fileSystem } = createMemoryFileSystem();
	const buildPlaceAsync = vi.fn<(options: BuildPlaceOptions) => Promise<BuildManifestArtifact>>(
		async (options) => ({ hash: "hash", path: options.placeFile }),
	);
	const place = await prepareRunPlaceAsync({ buildPlaceAsync, fileSystem, jobs });
	return { buildPlaceAsync, place };
}

describe(prepareRunPlaceAsync, () => {
	it("should build a Clean Place with LoadStringEnabled from the rojo project", async () => {
		expect.assertions(5);

		const { buildPlaceAsync, place } = await prepareAsync([job()]);
		const built = buildPlaceAsync.mock.calls[0]![0];

		expect(built.loadStringEnabled).toBeTrue();
		expect(built.wrap).toBeFalse();
		expect(built.packages[0]!.rojoProjectPath).toContain("default.project.json");
		expect(place).toStrictEqual({
			isWorkspace: false,
			placeFile: path.join(WORK_DIRECTORY, "place.rbxl"),
			workDirectory: WORK_DIRECTORY,
		});
		expect(built.placeFile).toBe(place.placeFile);
	});

	it("should open the coverage-instrumented place instead of building a Clean Place", async () => {
		expect.assertions(2);

		const { buildPlaceAsync, place } = await prepareAsync([
			job({ collectCoverage: true, placeFile: ".jest-roblox/coverage/game.rbxl" }),
		]);

		expect(place.placeFile).toBe(path.resolve("/repo", ".jest-roblox/coverage/game.rbxl"));
		expect(buildPlaceAsync).not.toHaveBeenCalled();
	});

	it("should run a workspace config against the pre-built mega-place without building its own", async () => {
		expect.assertions(3);

		const { buildPlaceAsync, place } = await prepareAsync([
			{
				...job({ placeFile: "/repo/.jest-roblox/workspace/synthesized.rbxl" }),
				pkg: "@scope/a",
			},
		]);

		expect(buildPlaceAsync).not.toHaveBeenCalled();
		expect(place.isWorkspace).toBeTrue();
		expect(place.placeFile).toContain("synthesized.rbxl");
	});
});
