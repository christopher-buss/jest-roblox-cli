import * as path from "node:path";
import { setTimeout as delayAsync } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";

import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { MANIFEST_VERSION } from "../coverage-pipeline/manifest.ts";
import { computePlaceInputsKeyAsync } from "./place-reuse.ts";

function stageInputs() {
	const root = path.resolve("place-reuse-loop");
	const projectFile = path.join(root, "synthesized.project.json");
	const projectJson = JSON.stringify({
		name: "synthesized",
		tree: { $className: "DataModel", ReplicatedStorage: { $path: "src" } },
	});
	const { fileSystem } = createMemoryFileSystem({
		[path.join(root, "src/a.luau")]: 'return "a"\n',
		[path.join(root, "src/b.luau")]: 'return "b"\n',
		[path.join(root, "src/c.luau")]: 'return "c"\n',
		[projectFile]: projectJson,
	});
	const readFile = fileSystem.promises.readFile.bind(fileSystem.promises);
	vi.spyOn(fileSystem.promises, "readFile").mockImplementation(async (...args) => {
		await delayAsync(0);
		return readFile(...args);
	});
	return { fileSystem, projectFile, projectJson };
}

describe(computePlaceInputsKeyAsync, () => {
	it("should reach the event loop while it fingerprints the build inputs", async () => {
		expect.assertions(2);

		const { fileSystem, projectFile, projectJson } = stageInputs();
		let wasEventLoopReached = false;
		setTimeout(() => {
			wasEventLoopReached = true;
		}, 0);
		const key = await computePlaceInputsKeyAsync({
			digestCacheFile: path.join(path.dirname(projectFile), "input-digests"),
			fileSystem,
			manifests: [],
			projectFile,
			projectJson,
			shadowRoots: [],
			stagingVersions: [MANIFEST_VERSION],
		});

		expect(key).toBeTypeOf("string");
		expect(wasEventLoopReached).toBeTrue();
	});
});
