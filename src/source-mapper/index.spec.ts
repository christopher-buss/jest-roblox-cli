import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { createMemoryFileSystem } from "../../test/mocks/memory-file-system.ts";
import type { SourceMapSegment } from "../../test/mocks/source-map.ts";
import { buildSourceMap } from "../../test/mocks/source-map.ts";
import { formatSourceSnippet } from "../formatters/formatter.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import type { SourceMapper } from "./index.ts";
import { combineSourceMappers, createSourceMapper, getSourceSnippet } from "./index.ts";

/** The rojo tree every roblox-ts case below maps through. */
const SHARED_PROJECT = { name: "test", tree: { ReplicatedStorage: { $path: "out/shared" } } };

/** The tsconfig mapping that pairs with {@link SHARED_PROJECT}. */
const SHARED_MAPPINGS = [{ outDir: "out", rootDir: "src" }];

/** Where a frame in `out/shared/test.luau` says its TypeScript lives. */
const SHARED_SOURCE = "../src/shared/test.ts";

/** That same source as an absolute path, which is what a location reports. */
const SHARED_SOURCE_PATH = normalizeWindowsPath(path.resolve("out/shared", SHARED_SOURCE));

/**
 * A volume seeded relative to the working directory, because a rojo `$path`
 * and a tsconfig `outDir` are both relative and the resolver joins onto them.
 *
 * @param files - What the run should find on disk.
 */
function seedProject(files: Record<string, string>): FileSystem {
	return createMemoryFileSystem(files).fileSystem;
}

/**
 * The map beside `out/shared/test.luau`, resolving the generated lines given.
 *
 * @param segments - Which generated lines map to which source lines.
 * @param sourceContent - The source text to embed, when the case needs one.
 */
function sharedMap(
	segments: ReadonlyArray<SourceMapSegment>,
	sourceContent?: string,
): Record<string, string> {
	return {
		"out/shared/test.luau.map": buildSourceMap({
			file: "test.luau",
			segments,
			source: SHARED_SOURCE,
			...(sourceContent === undefined ? {} : { sourceContent }),
		}),
	};
}

/** One generated line mapped to one source line, both at column 0. */
function lineToLine(generatedLine: number, sourceLine: number): SourceMapSegment {
	return { generatedColumn: 0, generatedLine, sourceColumn: 0, sourceLine };
}

describe(createSourceMapper, () => {
	it("should map failure message using V3 sourcemap", () => {
		expect.assertions(1);

		const fileSystem = seedProject({
			...sharedMap([lineToLine(2, 2)]),
			[SHARED_SOURCE_PATH]: "line1\nprint('error here')\nline3",
		});

		const mapper = createSourceMapper({
			fileSystem,
			mappings: SHARED_MAPPINGS,
			rojoProject: SHARED_PROJECT,
		});

		const input = `Error: test failed
[string "ReplicatedStorage.test"]:2`;

		expect(mapper.mapFailureWithLocations(input).message).toContain(`${SHARED_SOURCE_PATH}:2`);
	});

	it("should look up the sourcemap under outDir when rootDir is '.' (rootDirs project)", () => {
		expect.assertions(1);

		// A `rootDirs: ["src", "test"]` tsconfig collapses rootDir to ".". The
		// spec compiles to `out-test/src/...` and mounts under `server-tests`.
		// The frame must resolve its sourcemap from the outDir-anchored Luau
		// path, not a bare `src/...` path that has no `.luau.map` beside it —
		// which is why the map is seeded there and nowhere else.
		const generated = "out-test/src/server/modules/ecs/context.spec.luau";
		const source = "../../../../../src/server/modules/ecs/context.spec.ts";
		const sourcePath = normalizeWindowsPath(path.resolve(path.dirname(generated), source));
		const fileSystem = seedProject({
			[`${generated}.map`]: buildSourceMap({
				file: "context.spec.luau",
				segments: [lineToLine(20, 3)],
				source,
			}),
			[sourcePath]: "line1\nexpect(x).toBe(1)\nline3",
		});

		const mapper = createSourceMapper({
			fileSystem,
			mappings: [{ outDir: "out-test", rootDir: "." }],
			rojoProject: {
				name: "test",
				tree: {
					ServerScriptService: { "server-tests": { $path: "out-test/src/server" } },
				},
			},
		});

		const input = `Error: test failed
[string "ServerScriptService.server-tests.modules.ecs.context.spec"]:20`;

		expect(mapper.mapFailureWithLocations(input).message).toContain(`${sourcePath}:3`);
	});

	it("should snapshot mapped failure message", () => {
		expect.assertions(1);

		const fileSystem = seedProject({
			...sharedMap([lineToLine(10, 5)]),
			[SHARED_SOURCE_PATH]: 'line1\nline2\nline3\nline4\nexpect(value).toBe("hello")\nline6',
		});

		const mapper = createSourceMapper({
			fileSystem,
			mappings: SHARED_MAPPINGS,
			rojoProject: SHARED_PROJECT,
		});

		const input = `expect(received).toBe(expected)

Expected: "hello"
Received: "world"
[string "ReplicatedStorage.test"]:10`;

		const result = mapper
			.mapFailureWithLocations(input)
			.message.replaceAll(SHARED_SOURCE_PATH, "<mapped>");

		expect(result).toMatchInlineSnapshot(`
			"expect(received).toBe(expected)

			Expected: "hello"
			Received: "world"
			<mapped>:5"
		`);
	});

	it("should resolve test file path by converting slashes to dots", () => {
		expect.assertions(1);

		const mapper = createSourceMapper({
			fileSystem: seedProject({}),
			mappings: SHARED_MAPPINGS,
			rojoProject: SHARED_PROJECT,
		});

		// Path resolver maps DataModel → filesystem relative path
		expect(mapper.resolveTestFilePath("/ReplicatedStorage/test.spec")).toBe(
			"src/shared/test.spec.ts",
		);
	});

	it("should map no test file line for a path outside the rojo tree", () => {
		expect.assertions(1);

		const mapper = createSourceMapper({
			fileSystem: seedProject({}),
			mappings: SHARED_MAPPINGS,
			rojoProject: SHARED_PROJECT,
		});

		expect(mapper.mapTestFileLine("/Workspace/test.spec", 4)).toBeUndefined();
	});

	it("should return locations from mapFailureWithLocations", () => {
		expect.assertions(3);

		const fileSystem = seedProject({
			...sharedMap([lineToLine(10, 5)]),
			[SHARED_SOURCE_PATH]: "line1\nline2\nline3\nline4\nexpect(x).toBe(1)\nline6",
		});

		const mapper = createSourceMapper({
			fileSystem,
			mappings: SHARED_MAPPINGS,
			rojoProject: SHARED_PROJECT,
		});

		const input = `Error: test failed
[string "ReplicatedStorage.test"]:10`;

		const result = mapper.mapFailureWithLocations(input);

		expect(result.locations).toHaveLength(1);
		expect(result.locations[0]!.tsLine).toBe(5);
		expect(result.locations[0]!.luauLine).toBe(10);
	});

	it("should skip unresolvable frames in mapFailureWithLocations", () => {
		expect.assertions(2);

		const mapper = createSourceMapper({
			fileSystem: seedProject({}),
			mappings: SHARED_MAPPINGS,
			rojoProject: SHARED_PROJECT,
		});

		const input = `Error: test failed
[string "ServerStorage.unknown"]:5`;

		const result = mapper.mapFailureWithLocations(input);

		expect(result.locations).toBeEmpty();
		expect(result.message).toContain('[string "ServerStorage.unknown"]:5');
	});

	it("should emit Luau-only location when no tsconfig (outDir/rootDir undefined)", () => {
		expect.assertions(4);

		const mapper = createSourceMapper({
			fileSystem: seedProject({ "lib/test.spec.luau": "-- test" }),
			mappings: [],
			rojoProject: { name: "test", tree: { ReplicatedStorage: { lib: { $path: "lib" } } } },
		});

		const input = `Error: test failed
[string "ReplicatedStorage.lib.test.spec"]:5`;

		const result = mapper.mapFailureWithLocations(input);

		expect(result.locations).toHaveLength(1);
		expect(result.locations[0]!.luauLine).toBe(5);
		expect(result.locations[0]!.luauPath).toContain("test.spec");
		expect(result.locations[0]!.tsPath).toBeUndefined();
	});

	it("should replace DataModel path with Luau file path for Luau-only frames", () => {
		expect.assertions(1);

		const mapper = createSourceMapper({
			fileSystem: seedProject({ "lib/test.spec.luau": "-- test" }),
			mappings: [],
			rojoProject: { name: "test", tree: { ReplicatedStorage: { lib: { $path: "lib" } } } },
		});

		const input = `Error: test failed
[string "ReplicatedStorage.lib.test.spec"]:5`;

		expect(mapper.mapFailureWithLocations(input).message).not.toContain(
			'[string "ReplicatedStorage.lib.test.spec"]:5',
		);
	});

	it("should return location without column when source file missing", () => {
		expect.assertions(2);

		const mapper = createSourceMapper({
			fileSystem: seedProject(sharedMap([lineToLine(10, 5)])),
			mappings: SHARED_MAPPINGS,
			rojoProject: SHARED_PROJECT,
		});

		const input = `Error: test failed
[string "ReplicatedStorage.test"]:10`;

		const result = mapper.mapFailureWithLocations(input);

		expect(result.locations[0]!.tsColumn).toBeUndefined();
		expect(result.locations[0]!.sourceContent).toBeUndefined();
	});

	it("should handle source line beyond file bounds", () => {
		expect.assertions(1);

		const fileSystem = seedProject({
			...sharedMap([lineToLine(10, 999)]),
			[SHARED_SOURCE_PATH]: "line1\nline2\nline3",
		});

		const mapper = createSourceMapper({
			fileSystem,
			mappings: SHARED_MAPPINGS,
			rojoProject: SHARED_PROJECT,
		});

		const input = `Error: test failed
[string "ReplicatedStorage.test"]:10`;

		expect(mapper.mapFailureWithLocations(input).locations[0]!.tsLine).toBe(999);
	});

	it("should only push the first luau-only frame as a location", () => {
		expect.assertions(2);

		const mapper = createSourceMapper({
			fileSystem: seedProject({}),
			mappings: SHARED_MAPPINGS,
			rojoProject: SHARED_PROJECT,
		});

		const input = `Error: test failed
[string "ReplicatedStorage.test"]:5
[string "ReplicatedStorage.test"]:10`;

		const result = mapper.mapFailureWithLocations(input);

		expect(result.locations).toHaveLength(1);
		expect(result.locations[0]).toMatchObject({ luauLine: 5 });
	});

	it("should return luau-only location when source map is unavailable", () => {
		expect.assertions(4);

		const mapper = createSourceMapper({
			fileSystem: seedProject({}),
			mappings: SHARED_MAPPINGS,
			rojoProject: SHARED_PROJECT,
		});

		const input = `Error: test failed
[string "ReplicatedStorage.test"]:5`;

		const result = mapper.mapFailureWithLocations(input);

		expect(result.locations).toHaveLength(1);
		expect(result.locations[0]).toMatchObject({ luauLine: 5 });
		expect(result.message).not.toContain('[string "ReplicatedStorage.test"]:5');
		expect(result.message).toContain("out/shared/test.luau:5");
	});
});

describe("resolveDisplayPath", () => {
	it("should rewrite init to index for unmapped Luau path in roblox-ts project", () => {
		expect.assertions(1);

		const mapper = createSourceMapper({
			fileSystem: seedProject({}),
			mappings: SHARED_MAPPINGS,
			rojoProject: {
				name: "test",
				tree: { ReplicatedStorage: { "flux:tests": { $path: "out-test" } } },
			},
		});

		expect(mapper.resolveDisplayPath("/ReplicatedStorage/flux:tests/init.spec")).toBe(
			"out-test/index.spec.luau",
		);
	});

	it("should rewrite init to index for unresolvable raw path in roblox-ts project", () => {
		expect.assertions(1);

		const mapper = createSourceMapper({
			fileSystem: seedProject({}),
			mappings: SHARED_MAPPINGS,
			rojoProject: SHARED_PROJECT,
		});

		expect(mapper.resolveDisplayPath("src/init.spec")).toBe("src/index.spec");
	});

	it("should leave init untouched in pure-Luau project", () => {
		expect.assertions(1);

		const mapper = createSourceMapper({
			fileSystem: seedProject({}),
			mappings: [],
			rojoProject: SHARED_PROJECT,
		});

		expect(mapper.resolveDisplayPath("src/init.spec")).toBe("src/init.spec");
	});

	it("should be idempotent for already-resolved TS path", () => {
		expect.assertions(1);

		const mapper = createSourceMapper({
			fileSystem: seedProject({}),
			mappings: SHARED_MAPPINGS,
			rojoProject: SHARED_PROJECT,
		});

		expect(mapper.resolveDisplayPath("src/shared/index.spec.ts")).toBe(
			"src/shared/index.spec.ts",
		);
	});
});

describe(combineSourceMappers, () => {
	function makeStub(tag: string): SourceMapper {
		return {
			mapFailureWithLocations: (message) => {
				return {
					locations: [{ luauLine: 1, luauPath: `${tag}.luau`, tsPath: `${tag}.ts` }],
					message: message.replace(tag, () => `${tag}_TS`),
				};
			},
			mapTestFileLine: (file, line) => (file === `${tag}.spec` ? line + 100 : undefined),
			resolveDisplayPath: (file) => (file === `${tag}.spec` ? `${tag}.spec.ts` : file),
			resolveTestFilePath: (file) => (file === `${tag}.spec` ? `${tag}.spec.ts` : undefined),
		};
	}

	it("should return undefined when given no mappers", () => {
		expect.assertions(1);

		expect(combineSourceMappers([])).toBeUndefined();
	});

	it("should map a test file line through the child that owns the file", () => {
		expect.assertions(2);

		const composite = combineSourceMappers([makeStub("A"), makeStub("B")]);

		expect(composite!.mapTestFileLine("B.spec", 7)).toBe(107);
		expect(composite!.mapTestFileLine("missing", 7)).toBeUndefined();
	});

	it("should return the only mapper unchanged when given one", () => {
		expect.assertions(1);

		const mapper = makeStub("A");

		expect(combineSourceMappers([mapper])).toBe(mapper);
	});

	it("should accumulate locations and chain the message across children", () => {
		expect.assertions(2);

		const composite = combineSourceMappers([makeStub("A"), makeStub("B")]);
		const result = composite!.mapFailureWithLocations("A B");

		expect(result.locations).toHaveLength(2);
		expect(result.message).toBe("A_TS B_TS");
	});

	it("should return the first resolveTestFilePath hit", () => {
		expect.assertions(2);

		const composite = combineSourceMappers([makeStub("A"), makeStub("B")]);

		expect(composite!.resolveTestFilePath("B.spec")).toBe("B.spec.ts");
		expect(composite!.resolveTestFilePath("missing")).toBeUndefined();
	});

	it("should return the first resolveDisplayPath hit and fall back otherwise", () => {
		expect.assertions(2);

		const composite = combineSourceMappers([makeStub("A"), makeStub("B")]);

		expect(composite!.resolveDisplayPath("B.spec")).toBe("B.spec.ts");
		expect(composite!.resolveDisplayPath("missing")).toBe("missing");
	});

	it("should not let a non-owning roblox-ts child rewrite another project's path", () => {
		expect.assertions(1);

		const fileSystem = seedProject({ "lib/init.spec.luau": "-- test" });
		const robloxTs = createSourceMapper({
			fileSystem,
			mappings: SHARED_MAPPINGS,
			rojoProject: { name: "ts", tree: { ReplicatedStorage: { $path: "out/shared" } } },
		});
		const luauOnly = createSourceMapper({
			fileSystem,
			mappings: [],
			rojoProject: { name: "luau", tree: { ServerStorage: { lib: { $path: "lib" } } } },
		});

		const composite = combineSourceMappers([robloxTs, luauOnly]);

		// Path belongs to the pure-Luau project (`lib/init.spec.luau` is the real
		// on-disk file). The roblox-ts mapper cannot resolve it, so the combiner
		// must NOT apply init→index just because the rewrite changes the string.
		expect(composite!.resolveDisplayPath("/ServerStorage/lib/init.spec")).toBe(
			"lib/init.spec.luau",
		);
	});
});

describe(getSourceSnippet, () => {
	it("should return snippet with context lines", () => {
		expect.assertions(3);

		const fileSystem = seedProject({ "test.ts": "line 1\nline 2\nline 3\nline 4\nline 5" });

		const snippet = getSourceSnippet({ context: 1, filePath: "test.ts", fileSystem, line: 3 });

		expect(snippet).toBeDefined();
		expect(snippet!.failureLine).toBe(3);
		expect(snippet!.lines).toHaveLength(3);
	});

	it("should include column if provided", () => {
		expect.assertions(2);

		const fileSystem = seedProject({
			"test.ts": "line 1\n  expect(true).toBe(false)\nline 3",
		});

		const snippet = getSourceSnippet({
			column: 10,
			context: 1,
			filePath: "test.ts",
			fileSystem,
			line: 2,
		});

		expect(snippet).toBeDefined();
		expect(snippet!.column).toBe(10);
	});

	it("should return undefined when file does not exist", () => {
		expect.assertions(1);

		const snippet = getSourceSnippet({
			filePath: "nonexistent.ts",
			fileSystem: seedProject({}),
			line: 1,
		});

		expect(snippet).toBeUndefined();
	});

	it("should handle lines at start of file", () => {
		expect.assertions(2);

		const fileSystem = seedProject({ "test.ts": "line 1\nline 2\nline 3" });

		const snippet = getSourceSnippet({ filePath: "test.ts", fileSystem, line: 1 });

		expect(snippet).toBeDefined();
		expect(snippet!.lines[0]!.num).toBe(1);
	});

	it("should snapshot rendered snippet with context", () => {
		expect.assertions(1);

		const fileSystem = seedProject({
			"math.spec.ts": `import { expect } from "vitest";
describe("math", () => {
  it("should add", () => {
    expect(2 + 2).toBe(5);
  });
});`,
		});

		const snippet = getSourceSnippet({
			context: 2,
			filePath: "math.spec.ts",
			fileSystem,
			line: 4,
		});

		expect(formatSourceSnippet(snippet!, "math.spec.ts", { useColor: false }))
			.toMatchInlineSnapshot(`
				" ❯ math.spec.ts:4:19
					2| describe("math", () => {
					3|   it("should add", () => {
					4|     expect(2 + 2).toBe(5);
					 |                   ^
					5|   });
					6| });"
			`);
	});

	it("should use sourceContent when provided instead of reading file", () => {
		expect.assertions(2);

		const snippet = getSourceSnippet({
			context: 1,
			filePath: "nonexistent.ts",
			fileSystem: seedProject({}),
			line: 2,
			sourceContent: "line1\nline2\nline3",
		});

		expect(snippet).toBeDefined();
		expect(snippet!.lines).toHaveLength(3);
	});

	it("should handle out-of-bounds line in getSourceSnippet", () => {
		expect.assertions(2);

		const snippet = getSourceSnippet({
			filePath: "test.ts",
			fileSystem: seedProject({}),
			line: 100,
			sourceContent: "line1\nline2\nline3",
		});

		expect(snippet).toBeDefined();
		expect(snippet!.failureLine).toBe(100);
	});

	it("should compute column from expect line when not provided", () => {
		expect.assertions(2);

		const fileSystem = seedProject({
			"test.ts": 'describe("test", () => {\n  expect(2 + 2).toBe(5);\n});',
		});

		const snippet = getSourceSnippet({ context: 1, filePath: "test.ts", fileSystem, line: 2 });

		expect(snippet).toBeDefined();
		// '  expect(2 + 2).toBe' -> 'toBe' starts at col 17 (1-indexed)
		expect(snippet!.column).toBe(17);
	});
});
