import { fromAny } from "@total-typescript/shoehorn";

import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { CoverageManifest } from "../coverage-pipeline/manifest.ts";
import type { WorkspacePackageCoverage } from "../coverage-pipeline/workspace-prepare.ts";
import { emitWorkspaceBuildManifests } from "../coverage-pipeline/workspace-prepare.ts";
import { NOOP_RUN_PROGRESS } from "../progress/reporter.ts";
import { buildPlace } from "../staging/place-builder.ts";
import type { PackageDescriptor } from "../staging/synthesizer.ts";
import type { TimingCollector } from "../timing/orchestration-collector.ts";
import { prepareWorkspaceCoverageMap } from "./coverage-attach.ts";
import { stageWorkspacePlace } from "./place-staging.ts";
import { stageWorkspaceStubs } from "./stub-staging.ts";

vi.mock(import("../coverage-pipeline/workspace-prepare.ts"));
vi.mock(import("../staging/place-builder.ts"));
vi.mock(import("./coverage-attach.ts"));
vi.mock(import("./stub-staging.ts"));

describe(stageWorkspacePlace, () => {
	it("should build the shared place with stable cache paths and publish its manifests", () => {
		expect.assertions(5);

		vi.resetAllMocks();

		const cacheDirectory = path.resolve("/cache");
		const coverage = fromAny<WorkspacePackageCoverage, unknown>({
			coverageRoots: [{ shadowDir: path.resolve("/cache/shadow") }],
			manifest: fromAny<CoverageManifest, unknown>({ files: {} }),
		});
		const coverageByPackage = new Map([["@scope/package", coverage]]);
		vi.mocked(prepareWorkspaceCoverageMap).mockReturnValue(coverageByPackage);
		vi.mocked(stageWorkspaceStubs).mockReturnValue([
			fromAny<PackageDescriptor, unknown>({
				name: "package",
				packageDirectory: "/package",
				rojoProjectPath: "/package/default.project.json",
			}),
		]);
		const artifact = { hash: "place-hash", path: "built-place.rbxl" };
		vi.mocked(buildPlace).mockReturnValue(artifact);
		const profile = vi.fn<(label: string, callback: () => typeof artifact) => typeof artifact>(
			(_label, callback) => callback(),
		);
		const timing = fromAny<TimingCollector, unknown>({ profile, progress: NOOP_RUN_PROGRESS });
		vi.spyOn(Date, "now")
			.mockReturnValueOnce(100)
			.mockReturnValueOnce(130)
			.mockReturnValueOnce(150)
			.mockReturnValueOnce(210);

		const result = stageWorkspacePlace({
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
		expect(profile).toHaveBeenCalledWith("rojoBuild", expect.any(Function));
		expect(buildPlace).toHaveBeenCalledWith({
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
				manifests: [coverage.manifest],
				shadowRoots: ["shadow"],
			},
		});
		expect(emitWorkspaceBuildManifests).toHaveBeenCalledWith([coverage], artifact);
		expect(prepareWorkspaceCoverageMap).toHaveBeenCalledOnce();
	});
});
