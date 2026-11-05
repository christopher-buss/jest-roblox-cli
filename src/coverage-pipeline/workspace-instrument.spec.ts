import * as path from "node:path";
import process from "node:process";
import { describe, expect, it, vi } from "vitest";

import { clockTimingCollector } from "#test/mocks/clock-timing-collector.ts";
import { copyIgnoreMatcher } from "#test/mocks/coverage-copy-ignore.ts";
import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { posixPath, posixRoot } from "#test/mocks/posix-path.ts";
import type { Instrumenter } from "./instrumenter.ts";
import { instrumentPackage } from "./workspace-instrument.ts";
import type { PackageIgnore } from "./workspace-prepare-types.ts";

const PACKAGE_DIRECTORY = path.resolve("/repo/packages/foo");
const PROJECT_PATH = path.join(PACKAGE_DIRECTORY, "test.project.json");
const SHADOW_ROOT = path.resolve("/repo/.shadow/foo");

function noIgnore(): PackageIgnore {
	return {
		copyDigest: "none",
		copyMatcher: copyIgnoreMatcher([]),
		matcher: () => false,
		patterns: [],
	};
}

function seedPackage() {
	const memory = createMemoryFileSystem();
	memory.volume.fromJSON({
		[path.join(PACKAGE_DIRECTORY, "out/init.luau")]: "local x = 1",
		[PROJECT_PATH]: JSON.stringify({
			name: "foo",
			tree: { $className: "DataModel", ReplicatedStorage: { $path: "out" } },
		}),
	});
	return memory;
}

describe(instrumentPackage, () => {
	it("should instrument each narrowed root into the package's shadow tree", () => {
		expect.assertions(2);

		const { fileSystem } = seedPackage();
		const instrumenter = vi.fn<Instrumenter>().mockReturnValue({});

		const result = instrumentPackage({
			descriptor: {
				name: "foo",
				packageDirectory: PACKAGE_DIRECTORY,
				rojoProjectPath: PROJECT_PATH,
			},
			fileSystem,
			ignore: noIgnore(),
			instrumenter,
			manifestPath: path.join(SHADOW_ROOT, "coverage-manifest.json"),
			packageShadowRoot: SHADOW_ROOT,
			timing: clockTimingCollector(),
			universe: undefined,
		});

		expect(result.coverageRoots).toStrictEqual([
			{
				luauRoot: posixRoot("out"),
				shadowDir: posixPath(path.join(SHADOW_ROOT, "out")),
			},
		]);
		expect(instrumenter).toHaveBeenCalledOnce();
	});

	it("should name the workspace manifest when its cache is discarded", () => {
		expect.assertions(1);

		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const { fileSystem, volume } = seedPackage();
		const manifestPath = path.join(SHADOW_ROOT, "coverage-manifest.json");
		volume.mkdirSync(SHADOW_ROOT, { recursive: true });
		volume.writeFileSync(manifestPath, "{not json");

		instrumentPackage({
			descriptor: {
				name: "foo",
				packageDirectory: PACKAGE_DIRECTORY,
				rojoProjectPath: PROJECT_PATH,
			},
			fileSystem,
			ignore: noIgnore(),
			instrumenter: vi.fn<Instrumenter>().mockReturnValue({}),
			manifestPath,
			packageShadowRoot: SHADOW_ROOT,
			timing: clockTimingCollector(),
			universe: undefined,
		});

		expect(stderr).toHaveBeenCalledWith(
			expect.stringContaining("Warning: Workspace coverage manifest is malformed JSON"),
		);
	});
});
