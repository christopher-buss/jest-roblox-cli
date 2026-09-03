import { fromAny } from "@total-typescript/shoehorn";

import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { fakeTimingCollector } from "../../test/mocks/fake-timing-collector.ts";
import type { CoverageManifest } from "../coverage-pipeline/manifest.ts";
import type { WorkspacePackageCoverage } from "../coverage-pipeline/workspace-prepare.ts";
import { emitWorkspaceBuildManifests } from "../coverage-pipeline/workspace-prepare.ts";
import { buildPlaceAsync } from "../staging/place-builder.ts";
import type { PackageDescriptor } from "../staging/synthesizer.ts";
import { prepareWorkspaceCoverageMap } from "./coverage-attach.ts";
import { stageWorkspacePlaceAsync } from "./place-staging.ts";
import { stageWorkspaceStubs } from "./stub-staging.ts";

vi.mock(import("../coverage-pipeline/workspace-prepare.ts"));
vi.mock(import("../staging/place-builder.ts"));
vi.mock(import("./coverage-attach.ts"));
vi.mock(import("./stub-staging.ts"));

describe(stageWorkspacePlaceAsync, () => {
	it("should build the shared place with stable cache paths and publish its manifests", async () => {
		expect.assertions(5);

		vi.resetAllMocks();

		const cacheDirectory = path.resolve("/cache");
		const coverage = fromAny<WorkspacePackageCoverage, unknown>({
			coverageRoots: [{ shadowDir: path.resolve("/cache/shadow") }],
			coverageSpine: [{ shadowDir: path.resolve("/cache/shadow-spine") }],
			manifest: fromAny<CoverageManifest, unknown>({ files: {} }),
		});
		const coverageByPackage = new Map([["@scope/package", coverage]]);
		vi.mocked(prepareWorkspaceCoverageMap).mockReturnValue({
			elapsedMs: 30,
			value: coverageByPackage,
		});
		vi.mocked(stageWorkspaceStubs).mockReturnValue({
			elapsedMs: 25,
			value: [
				fromAny<PackageDescriptor, unknown>({
					name: "package",
					packageDirectory: "/package",
					rojoProjectPath: "/package/default.project.json",
				}),
			],
		});
		const artifact = { hash: "place-hash", path: "built-place.rbxl" };
		vi.mocked(buildPlaceAsync).mockResolvedValue(artifact);
		// The two staging phases each report their own span, and the caller
		// sums them.
		const timing = fakeTimingCollector(35);

		const result = await stageWorkspacePlaceAsync({
			cacheDirectory,
			loaded: [],
			selection: fromAny({ filteredContexts: [], pending: [] }),
			timing,
			workspaceRoot: path.resolve("/workspace"),
		});

		expect(result).toStrictEqual({
			coverageByPackage,
			coverageMs: 30,
			placeFile: path.join(cacheDirectory, "synthesized.rbxl"),
			stagingMs: 60,
		});
		expect(timing.profileTimedAsync).toHaveBeenCalledWith("rojoBuild", expect.any(Function));
		expect(buildPlaceAsync).toHaveBeenCalledWith({
			packages: [
				{
					name: "package",
					packageDirectory: "/package",
					rojoProjectPath: "/package/default.project.json",
				},
			],
			placeFile: path.join(cacheDirectory, "synthesized.rbxl"),
			projectFile: path.join(cacheDirectory, "synthesized.project.json"),
			reuse: {
				cacheFile: path.join(cacheDirectory, "synthesized.place-cache.json"),
				digestCacheFile: path.join(cacheDirectory, "synthesized.input-digests"),
				manifests: [coverage.manifest],
				shadowRoots: ["shadow", "shadow-spine"],
			},
		});
		expect(emitWorkspaceBuildManifests).toHaveBeenCalledWith([coverage], artifact);
		expect(prepareWorkspaceCoverageMap).toHaveBeenCalledOnce();
	});
});
