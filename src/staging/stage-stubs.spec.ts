import { createMemoryFileSystem } from "@isentinel/dev-vitest-utils";

import * as path from "node:path";
import { describe, it } from "vitest";

import { recordingTimingCollector } from "#test/helpers/unit/workspace-timing-recorder.ts";
import { stageProjectStubs, stubCacheRoot } from "./stage-stubs.ts";

describe(stageProjectStubs, () => {
	it("should clean, then generate, under one span each for every package", ({ expect }) => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();
		const { collector, paths } = recordingTimingCollector();

		stageProjectStubs({
			fileSystem,
			packages: [
				{ cacheRoot: "/a/cache", label: "a", projects: [], rootDirectory: "/a" },
				{ cacheRoot: "/b/cache", projects: [], rootDirectory: "/b" },
			],
			timing: collector,
		});

		expect(paths).toStrictEqual(["cleanLeftoverStubs", "generateProjectStubs"]);
	});
});

describe(stubCacheRoot, () => {
	it("should put the stub cache under the run's work directory", ({ expect }) => {
		expect.assertions(1);

		expect(stubCacheRoot("/repo")).toBe(path.resolve("/repo", ".jest-roblox", "cache"));
	});
});
