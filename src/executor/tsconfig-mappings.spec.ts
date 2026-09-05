import { fromAny } from "@total-typescript/shoehorn";

import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createMemoryFileSystem } from "../../test/mocks/memory-file-system.ts";
import type { TsconfigReader } from "./tsconfig-mappings.ts";
import {
	createTsconfigMappingCache,
	isLuauProject,
	readTsconfigMapping,
	resolveAllTsconfigMappings,
	resolveTsconfigDirectories,
} from "./tsconfig-mappings.ts";

// cspell:ignore xtsconfig
const collator = new Intl.Collator("en");

/**
 * A reader recording what it was asked for, for a case that asserts on that.
 */
function createReader(): ReturnType<typeof vi.fn<TsconfigReader>> {
	return vi.fn<TsconfigReader>(() => null);
}

describe(isLuauProject, () => {
	it("should require no TypeScript source files and no tsconfig mappings", () => {
		expect.assertions(4);

		expect(isLuauProject(["src/main.luau"], [])).toBeTrue();
		expect(isLuauProject(["src/main.ts"], [])).toBeFalse();
		expect(isLuauProject(["src/main.tsx"], [])).toBeFalse();
		expect(isLuauProject(["src/main.luau"], [{ outDir: "out", rootDir: "src" }])).toBeFalse();
	});
});

describe(createTsconfigMappingCache, () => {
	it("should create an empty independent cache", () => {
		expect.assertions(3);

		const first = createTsconfigMappingCache();
		const second = createTsconfigMappingCache();
		first.set("project", [{ outDir: "out", rootDir: "src" }]);

		expect(first).toBeInstanceOf(Map);
		expect(second).not.toBe(first);
		expect(second).toStrictEqual(new Map());
	});
});

describe(readTsconfigMapping, () => {
	it("should treat empty rootDirs as absent", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		volume.fromJSON({
			"/project/tsconfig.json": JSON.stringify({
				compilerOptions: { outDir: "out-test", rootDir: "test", rootDirs: [] },
			}),
		});

		expect(readTsconfigMapping("/project/tsconfig.json", fileSystem)).toStrictEqual({
			outDir: "out-test",
			rootDir: "test",
		});
	});

	it("should find the common ancestor when one rootDir contains another", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		volume.fromJSON({
			"/project/tsconfig.json": JSON.stringify({
				compilerOptions: {
					outDir: "out",
					rootDirs: ["packages/core", "packages/core/test"],
				},
			}),
		});

		expect(readTsconfigMapping("/project/tsconfig.json", fileSystem)).toStrictEqual({
			outDir: "out",
			rootDir: "packages/core",
		});
	});
});

describe(resolveAllTsconfigMappings, () => {
	it("should scan only tsconfig JSON files, deduplicate mappings, sort longest first, and cache", () => {
		expect.assertions(3);

		const { fileSystem, volume } = createMemoryFileSystem();
		const getTsconfig = createReader();

		volume.fromJSON({
			"/project/tsconfig.json": "{}",
			"/project/tsconfig.json.bak": "{}",
			"/project/tsconfig.lib.json": "{}",
			"/project/xtsconfig.json": "{}",
		});
		const outputDirectories = new Map([
			["tsconfig.json", "out"],
			["tsconfig.lib.json", "out/generated"],
		]);
		getTsconfig.mockImplementation((_root, filename) => {
			return fromAny({
				config: {
					compilerOptions: { outDir: outputDirectories.get(filename!), rootDir: "src" },
				},
			});
		});
		const cache = createTsconfigMappingCache();

		const first = resolveAllTsconfigMappings("/project", cache, fileSystem, getTsconfig);
		const second = resolveAllTsconfigMappings("/project", cache, fileSystem, getTsconfig);

		expect(first).toStrictEqual([
			{ outDir: "out/generated", rootDir: "src" },
			{ outDir: "out", rootDir: "src" },
		]);
		expect(second).toBe(first);
		expect(
			getTsconfig.mock.calls
				.map((call) => call[1])
				.toSorted((left, right) => collator.compare(left!, right!)),
		).toStrictEqual(["tsconfig.json", "tsconfig.lib.json"]);
	});
});

describe(resolveTsconfigDirectories, () => {
	it("should reject a tsconfig in a sibling directory with the same path prefix", () => {
		expect.assertions(1);

		const getTsconfig = createReader();
		getTsconfig.mockReturnValue(
			fromAny({
				config: { compilerOptions: { outDir: "out", rootDir: "src" } },
				path: path.resolve("/project-sibling/tsconfig.lib.json"),
			}),
		);

		expect(resolveTsconfigDirectories("/project", getTsconfig)).toStrictEqual({
			outDir: undefined,
			rootDir: undefined,
		});
	});
});
