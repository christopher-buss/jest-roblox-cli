import { fromAny } from "@total-typescript/shoehorn";

import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import type { FileSystem } from "../utils/file-system.ts";
import type { TsconfigReader } from "./tsconfig-mappings.ts";
import {
	createTsconfigMappingCache,
	isLuauProject,
	resolveAllTsconfigMappings,
	resolveTsconfigDirectories,
} from "./tsconfig-mappings.ts";

// cspell:ignore xtsconfig
const collator = new Intl.Collator("en");

/**
 * A reader recording what it was asked for, for a case that asserts on that.
 * @returns A mock reader that finds no tsconfig.
 */
function createReader(): ReturnType<typeof vi.fn<TsconfigReader>> {
	return vi.fn<TsconfigReader>(() => null);
}

function readingVolume(fileSystem: FileSystem): TsconfigReader {
	return fromAny((searchPath: string, configName = "tsconfig.json") => {
		const filePath = path.join(path.resolve(searchPath), configName);
		try {
			return {
				config: JSON.parse(fileSystem.readFileSync(filePath, "utf-8")),
				path: filePath,
			};
		} catch {
			return null;
		}
	});
}

function resolveFromVolume(
	files: Record<string, string>,
): ReturnType<typeof resolveAllTsconfigMappings> {
	const { fileSystem, volume } = createMemoryFileSystem();
	volume.mkdirSync(path.resolve("/project"), { recursive: true });
	for (const [name, content] of Object.entries(files)) {
		volume.writeFileSync(path.join(path.resolve("/project"), name), content);
	}

	return resolveAllTsconfigMappings({
		fileSystem,
		projectRoot: "/project",
		tsconfigReader: readingVolume(fileSystem),
	});
}

function tsconfig(compilerOptions: unknown): string {
	return JSON.stringify({ compilerOptions });
}

describe(isLuauProject, () => {
	it("should require no TypeScript source files and no tsconfig mappings", () => {
		expect.assertions(4);

		expect(isLuauProject(["src/main.luau"], [])).toBeTrue();
		expect(isLuauProject(["src/main.ts"], [])).toBeFalse();
		expect(isLuauProject(["src/main.tsx"], [])).toBeFalse();
		expect(isLuauProject(["src/main.luau"], [{ outDir: "out", rootDir: "src" }])).toBeFalse();
	});

	it("should treat no test files as Luau and a mixed set as not", () => {
		expect.assertions(2);

		expect(isLuauProject([], [])).toBeTrue();
		expect(isLuauProject(["a.spec.luau", "b.spec.ts"], [])).toBeFalse();
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

describe("tsconfig mapping parsing", () => {
	it("should treat empty rootDirs as absent", () => {
		expect.assertions(1);

		expect(
			resolveFromVolume({
				"tsconfig.json": tsconfig({ outDir: "out-test", rootDir: "test", rootDirs: [] }),
			}),
		).toStrictEqual([{ outDir: "out-test", rootDir: "test" }]);
	});

	it("should find the common ancestor when one rootDir contains another", () => {
		expect.assertions(1);

		expect(
			resolveFromVolume({
				"tsconfig.json": tsconfig({
					outDir: "out",
					rootDirs: ["packages/core", "packages/core/test"],
				}),
			}),
		).toStrictEqual([{ outDir: "out", rootDir: "packages/core" }]);
	});

	it("should handle rootDirs with no common prefix", () => {
		expect.assertions(1);

		expect(
			resolveFromVolume({
				"tsconfig.json": tsconfig({ outDir: "out-test", rootDirs: ["src", "test"] }),
			}),
		).toStrictEqual([{ outDir: "out-test", rootDir: "." }]);
	});

	it("should handle rootDirs with a common ancestor", () => {
		expect.assertions(1);

		expect(
			resolveFromVolume({
				"tsconfig.json": tsconfig({
					outDir: "out",
					rootDirs: ["packages/core/src", "packages/core/test"],
				}),
			}),
		).toStrictEqual([{ outDir: "out", rootDir: "packages/core" }]);
	});

	it("should default rootDir to src when omitted", () => {
		expect.assertions(1);

		expect(resolveFromVolume({ "tsconfig.json": tsconfig({ outDir: "out" }) })).toStrictEqual([
			{ outDir: "out", rootDir: "src" },
		]);
	});

	it("should yield no mapping when rootDir is null", () => {
		expect.assertions(1);

		expect(
			resolveFromVolume({ "tsconfig.json": tsconfig({ outDir: "out", rootDir: null }) }),
		).toBeEmpty();
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

		const first = resolveAllTsconfigMappings({
			cache,
			fileSystem,
			projectRoot: "/project",
			tsconfigReader: getTsconfig,
		});
		const second = resolveAllTsconfigMappings({
			cache,
			fileSystem,
			projectRoot: "/project",
			tsconfigReader: getTsconfig,
		});

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

	it("should return mappings from multiple tsconfig*.json files", () => {
		expect.assertions(2);

		const result = resolveFromVolume({
			"tsconfig.lib.json": tsconfig({ outDir: "out", rootDir: "src" }),
			"tsconfig.spec.json": tsconfig({ outDir: "out-test", rootDir: "src" }),
		});

		expect(result).toHaveLength(2);
		expect(result).toContainEqual({ outDir: "out-test", rootDir: "src" });
	});

	it("should return a single mapping when only tsconfig.json exists", () => {
		expect.assertions(1);

		expect(
			resolveFromVolume({ "tsconfig.json": tsconfig({ outDir: "out", rootDir: "src" }) }),
		).toStrictEqual([{ outDir: "out", rootDir: "src" }]);
	});

	it("should return an empty array when no tsconfigs exist", () => {
		expect.assertions(1);

		expect(resolveFromVolume({})).toBeEmpty();
	});

	it("should skip tsconfigs without compilerOptions or outDir", () => {
		expect.assertions(1);

		expect(
			resolveFromVolume({
				"tsconfig.json": JSON.stringify({ include: ["src/**/*"] }),
				"tsconfig.lib.json": tsconfig({ strict: true }),
			}),
		).toBeEmpty();
	});

	it("should return an empty array when the directory does not exist", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();

		expect(
			resolveAllTsconfigMappings({
				fileSystem,
				projectRoot: "/nonexistent/path/xyz",
				tsconfigReader: readingVolume(fileSystem),
			}),
		).toBeEmpty();
	});

	it("should answer a repeated rootDir from the cache after the file is gone", () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();
		const tsconfigPath = path.resolve("/project/tsconfig.json");
		volume.mkdirSync(path.resolve("/project"), { recursive: true });
		volume.writeFileSync(tsconfigPath, tsconfig({ outDir: "out", rootDir: "src" }));
		const options = {
			cache: createTsconfigMappingCache(),
			fileSystem,
			projectRoot: "/project",
			tsconfigReader: readingVolume(fileSystem),
		};

		const first = resolveAllTsconfigMappings(options);
		volume.rmSync(tsconfigPath);
		const second = resolveAllTsconfigMappings(options);

		expect(first).toStrictEqual([{ outDir: "out", rootDir: "src" }]);
		expect(second).toStrictEqual(first);
	});

	it("should deduplicate identical mappings across tsconfig files", () => {
		expect.assertions(1);

		expect(
			resolveFromVolume({
				"tsconfig.lib.json": tsconfig({ outDir: "out", rootDir: "src" }),
				"tsconfig.spec.json": tsconfig({ outDir: "out", rootDir: "src" }),
			}),
		).toStrictEqual([{ outDir: "out", rootDir: "src" }]);
	});

	it("should skip malformed tsconfig JSON files", () => {
		expect.assertions(1);

		expect(resolveFromVolume({ "tsconfig.json": "not json" })).toBeEmpty();
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

	it("should return undefined directories when no tsconfig exists", () => {
		expect.assertions(1);

		expect(
			resolveTsconfigDirectories("/nonexistent/project/dir", createReader()),
		).toStrictEqual({ outDir: undefined, rootDir: undefined });
	});

	it("should prefer tsconfig.lib.json over tsconfig.json", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();
		volume.mkdirSync(path.resolve("/project"), { recursive: true });
		volume.writeFileSync(
			path.resolve("/project/tsconfig.json"),
			tsconfig({ outDir: "out-tsc", rootDir: "src" }),
		);
		volume.writeFileSync(
			path.resolve("/project/tsconfig.lib.json"),
			tsconfig({ outDir: "out", rootDir: "lib" }),
		);

		expect(resolveTsconfigDirectories("/project", readingVolume(fileSystem))).toStrictEqual({
			outDir: "out",
			rootDir: "lib",
		});
	});

	it("should default outDir to out and rootDir to src when compilerOptions omits them", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();
		volume.mkdirSync(path.resolve("/project"), { recursive: true });
		volume.writeFileSync(path.resolve("/project/tsconfig.json"), tsconfig({ strict: true }));

		expect(resolveTsconfigDirectories("/project", readingVolume(fileSystem))).toStrictEqual({
			outDir: "out",
			rootDir: "src",
		});
	});
});
