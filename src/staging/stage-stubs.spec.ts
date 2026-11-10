import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { recordingTimingCollector } from "#test/mocks/workspace-timing-recorder.ts";
import { stageProjectStubs, stubCacheRoot } from "./stage-stubs.ts";

describe(stageProjectStubs, () => {
	it("should clean, then generate, under one span each for every package", () => {
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
	it("should put the stub cache under the run's work directory", () => {
		expect.assertions(1);

		expect(stubCacheRoot("/repo")).toBe(path.resolve("/repo", ".jest-roblox", "cache"));
	});
});
