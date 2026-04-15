import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { formatSourceSnippet } from "../formatters/formatter.ts";
import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import type { SourceMapper } from "./index.ts";
import { combineSourceMappers, createSourceMapper, getSourceSnippet } from "./index.ts";
import { getSourceContent, mapFromSourceMap } from "./v3-mapper.ts";

vi.mock(import("node:fs"));
vi.mock(import("./v3-mapper"));

describe(createSourceMapper, () => {
	it("should map failure message using V3 sourcemap", () => {
		expect.assertions(1);

		const rojoProject = {
			name: "test",
			tree: {
				ReplicatedStorage: {
					$path: "out/shared",
				},
			},
		};

		const resolvedTsPath = normalizeWindowsPath(
			path.resolve("out/shared", "../src/shared/test.ts"),
		);

		vi.mocked(mapFromSourceMap).mockReturnValue({
			column: 0,
			line: 2,
			source: "../src/shared/test.ts",
		});
		vi.mocked(fs.existsSync).mockReturnValue(true);
		vi.mocked(fs.readFileSync).mockReturnValue("line1\nprint('error here')\nline3");

		const mapper = createSourceMapper({
			mappings: [{ outDir: "out", rootDir: "src" }],
			rojoProject,
		});

		const input = `Error: test failed
[string "ReplicatedStorage.test"]:2`;

		const result = mapper.mapFailureMessage(input);

		expect(result).toContain(`${resolvedTsPath}:2`);
	});

	it("should keep original frame when path cannot be resolved", () => {
		expect.assertions(1);

		const rojoProject = {
			name: "test",
			tree: {
				ReplicatedStorage: {
					$path: "out/shared",
				},
			},
		};

		vi.mocked(fs.existsSync).mockReturnValue(false);

		const mapper = createSourceMapper({
			mappings: [{ outDir: "out", rootDir: "src" }],
			rojoProject,
		});

		const input = `Error: test failed
[string "ServerStorage.unknown"]:5`;

		const result = mapper.mapFailureMessage(input);

		expect(result).toContain('[string "ServerStorage.unknown"]:5');
	});

	it("should snapshot mapped failure message", () => {
		expect.assertions(1);

		const rojoProject = {
			name: "test",
			tree: {
				ReplicatedStorage: {
					$path: "out/shared",
				},
			},
		};

		const resolvedTsPath = normalizeWindowsPath(
			path.resolve("out/shared", "../src/shared/test.ts"),
		);

		vi.mocked(mapFromSourceMap).mockReturnValue({
			column: 0,
			line: 5,
			source: "../src/shared/test.ts",
		});
		vi.mocked(fs.existsSync).mockReturnValue(true);
		vi.mocked(fs.readFileSync).mockReturnValue(
			'line1\nline2\nline3\nline4\nexpect(value).toBe("hello")\nline6',
		);

		const mapper = createSourceMapper({
			mappings: [{ outDir: "out", rootDir: "src" }],
			rojoProject,
		});

		const input = `expect(received).toBe(expected)

Expected: "hello"
Received: "world"
[string "ReplicatedStorage.test"]:10`;

		const result = mapper.mapFailureMessage(input).replaceAll(resolvedTsPath, "<mapped>");

		expect(result).toMatchInlineSnapshot(`
			"expect(received).toBe(expected)

			Expected: "hello"
			Received: "world"
			<mapped>:5"
		`);
	});

	it("should resolve test file path by converting slashes to dots", () => {
		expect.assertions(1);

		const rojoProject = {
			name: "test",
			tree: {
				ReplicatedStorage: {
					$path: "out/shared",
				},
			},
		};

		vi.mocked(fs.existsSync).mockReturnValue(true);

		const mapper = createSourceMapper({
			mappings: [{ outDir: "out", rootDir: "src" }],
			rojoProject,
		});

		const result = mapper.resolveTestFilePath("/ReplicatedStorage/test.spec");

		// Path resolver maps DataModel → filesystem relative path
		expect(result).toBe("src/shared/test.spec.ts");
	});

	it("should return locations from mapFailureWithLocations", () => {
		expect.assertions(3);

		const rojoProject = {
			name: "test",
			tree: {
				ReplicatedStorage: {
					$path: "out/shared",
				},
			},
		};

		vi.mocked(mapFromSourceMap).mockReturnValue({
			column: 0,
			line: 5,
			source: "../src/shared/test.ts",
		});
		vi.mocked(fs.existsSync).mockReturnValue(true);
		vi.mocked(fs.readFileSync).mockReturnValue(
			"line1\nline2\nline3\nline4\nexpect(x).toBe(1)\nline6",
		);

		const mapper = createSourceMapper({
			mappings: [{ outDir: "out", rootDir: "src" }],
			rojoProject,
		});

		const input = `Error: test failed
[string "ReplicatedStorage.test"]:10`;

		const result = mapper.mapFailureWithLocations(input);

		expect(result.locations).toHaveLength(1);
		expect(result.locations[0]!.tsLine).toBe(5);
		expect(result.locations[0]!.luauLine).toBe(10);
	});

	it("should replace DataModel path with Luau path when sourcemap has no mapping", () => {
		expect.assertions(2);

		const rojoProject = {
			name: "test",
			tree: {
				ReplicatedStorage: {
					$path: "out/shared",
				},
			},
		};

		vi.mocked(mapFromSourceMap).mockReturnValue(undefined);

		const mapper = createSourceMapper({
			mappings: [{ outDir: "out", rootDir: "src" }],
			rojoProject,
		});

		const input = `Error: test failed
[string "ReplicatedStorage.test"]:5`;

		const result = mapper.mapFailureMessage(input);

		expect(result).not.toContain('[string "ReplicatedStorage.test"]:5');
		expect(result).toContain("out/shared/test.luau:5");
	});

	it("should skip unresolvable frames in mapFailureWithLocations", () => {
		expect.assertions(2);

		const rojoProject = {
			name: "test",
			tree: {
				ReplicatedStorage: {
					$path: "out/shared",
				},
			},
		};

		vi.mocked(fs.existsSync).mockReturnValue(false);

		const mapper = createSourceMapper({
			mappings: [{ outDir: "out", rootDir: "src" }],
			rojoProject,
		});

		const input = `Error: test failed
[string "ServerStorage.unknown"]:5`;

		const result = mapper.mapFailureWithLocations(input);

		expect(result.locations).toBeEmpty();
		expect(result.message).toContain('[string "ServerStorage.unknown"]:5');
	});

	it("should emit Luau-only location when no tsconfig (outDir/rootDir undefined)", () => {
		expect.assertions(4);

		const rojoProject = {
			name: "test",
			tree: {
				ReplicatedStorage: {
					lib: { $path: "lib" },
				},
			},
		};

		vi.mocked(fs.existsSync).mockReturnValue(true);

		const mapper = createSourceMapper({
			mappings: [],
			rojoProject,
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

		const rojoProject = {
			name: "test",
			tree: {
				ReplicatedStorage: {
					lib: { $path: "lib" },
				},
			},
		};

		vi.mocked(fs.existsSync).mockReturnValue(true);

		const mapper = createSourceMapper({
			mappings: [],
			rojoProject,
		});

		const input = `Error: test failed
[string "ReplicatedStorage.lib.test.spec"]:5`;

		const result = mapper.mapFailureWithLocations(input);

		expect(result.message).not.toContain('[string "ReplicatedStorage.lib.test.spec"]:5');
	});

	it("should return location without column when source file missing", () => {
		expect.assertions(2);

		const rojoProject = {
			name: "test",
			tree: {
				ReplicatedStorage: {
					$path: "out/shared",
				},
			},
		};

		vi.mocked(mapFromSourceMap).mockReturnValue({
			column: 0,
			line: 5,
			source: "../src/shared/test.ts",
		});
		vi.mocked(getSourceContent).mockReturnValue(null);
		vi.mocked(fs.existsSync).mockReturnValue(false);

		const mapper = createSourceMapper({
			mappings: [{ outDir: "out", rootDir: "src" }],
			rojoProject,
		});

		const input = `Error: test failed
[string "ReplicatedStorage.test"]:10`;

		const result = mapper.mapFailureWithLocations(input);

		expect(result.locations[0]!.tsColumn).toBeUndefined();
		expect(result.locations[0]!.sourceContent).toBeUndefined();
	});

	it("should handle source line beyond file bounds", () => {
		expect.assertions(1);

		const rojoProject = {
			name: "test",
			tree: {
				ReplicatedStorage: {
					$path: "out/shared",
				},
			},
		};

		vi.mocked(mapFromSourceMap).mockReturnValue({
			column: 0,
			line: 999,
			source: "../src/shared/test.ts",
		});
		vi.mocked(getSourceContent).mockReturnValue(null);
		vi.mocked(fs.existsSync).mockReturnValue(true);
		vi.mocked(fs.readFileSync).mockReturnValue("line1\nline2\nline3");

		const mapper = createSourceMapper({
			mappings: [{ outDir: "out", rootDir: "src" }],
			rojoProject,
		});

		const input = `Error: test failed
[string "ReplicatedStorage.test"]:10`;

		const result = mapper.mapFailureWithLocations(input);

		expect(result.locations[0]!.tsLine).toBe(999);
	});

	it("should only push the first luau-only frame as a location", () => {
		expect.assertions(2);

		const rojoProject = {
			name: "test",
			tree: {
				ReplicatedStorage: {
					$path: "out/shared",
				},
			},
		};

		vi.mocked(mapFromSourceMap).mockReturnValue(undefined);

		const mapper = createSourceMapper({
			mappings: [{ outDir: "out", rootDir: "src" }],
			rojoProject,
		});

		const input = `Error: test failed
[string "ReplicatedStorage.test"]:5
[string "ReplicatedStorage.test"]:10`;

		const result = mapper.mapFailureWithLocations(input);

		expect(result.locations).toHaveLength(1);
		expect(result.locations[0]).toMatchObject({ luauLine: 5 });
	});

	it("should return luau-only location when source map is unavailable", () => {
		expect.assertions(3);

		const rojoProject = {
			name: "test",
			tree: {
				ReplicatedStorage: {
					$path: "out/shared",
				},
			},
		};

		vi.mocked(mapFromSourceMap).mockReturnValue(undefined);

		const mapper = createSourceMapper({
			mappings: [{ outDir: "out", rootDir: "src" }],
			rojoProject,
		});

		const input = `Error: test failed
[string "ReplicatedStorage.test"]:5`;

		const result = mapper.mapFailureWithLocations(input);

		expect(result.locations).toHaveLength(1);
		expect(result.locations[0]).toMatchObject({ luauLine: 5 });
		expect(result.message).toContain("out/shared/test.luau:5");
	});
});

describe(combineSourceMappers, () => {
	function makeStub(tag: string): SourceMapper {
		return {
			mapFailureMessage: (message) => message.replace(tag, `${tag}_TS`),
			mapFailureWithLocations: (message) => {
				return {
					locations: [{ luauLine: 1, luauPath: `${tag}.luau`, tsPath: `${tag}.ts` }],
					message: message.replace(tag, `${tag}_TS`),
				};
			},
			resolveTestFilePath: (file) => (file === `${tag}.spec` ? `${tag}.spec.ts` : undefined),
		};
	}

	it("should return undefined when given no mappers", () => {
		expect.assertions(1);

		expect(combineSourceMappers([])).toBeUndefined();
	});

	it("should return the only mapper unchanged when given one", () => {
		expect.assertions(1);

		const mapper = makeStub("A");

		expect(combineSourceMappers([mapper])).toBe(mapper);
	});

	it("should chain mapFailureMessage through every child", () => {
		expect.assertions(1);

		const composite = combineSourceMappers([makeStub("A"), makeStub("B")]);

		expect(composite?.mapFailureMessage("A B")).toBe("A_TS B_TS");
	});

	it("should accumulate locations from mapFailureWithLocations across children", () => {
		expect.assertions(2);

		const composite = combineSourceMappers([makeStub("A"), makeStub("B")]);
		const result = composite?.mapFailureWithLocations("A B");

		expect(result?.locations).toHaveLength(2);
		expect(result?.message).toBe("A_TS B_TS");
	});

	it("should return the first resolveTestFilePath hit", () => {
		expect.assertions(2);

		const composite = combineSourceMappers([makeStub("A"), makeStub("B")]);

		expect(composite?.resolveTestFilePath("B.spec")).toBe("B.spec.ts");
		expect(composite?.resolveTestFilePath("missing")).toBeUndefined();
	});
});

describe(getSourceSnippet, () => {
	it("should return snippet with context lines", () => {
		expect.assertions(3);

		const fileContent = `line 1
line 2
line 3
line 4
line 5`;

		vi.mocked(fs.existsSync).mockReturnValue(true);
		vi.mocked(fs.readFileSync).mockReturnValue(fileContent);

		const snippet = getSourceSnippet({ context: 1, filePath: "test.ts", line: 3 });

		expect(snippet).toBeDefined();
		expect(snippet?.failureLine).toBe(3);
		expect(snippet?.lines).toHaveLength(3);
	});

	it("should include column if provided", () => {
		expect.assertions(2);

		const fileContent = `line 1
  expect(true).toBe(false)
line 3`;

		vi.mocked(fs.existsSync).mockReturnValue(true);
		vi.mocked(fs.readFileSync).mockReturnValue(fileContent);

		const snippet = getSourceSnippet({ column: 10, context: 1, filePath: "test.ts", line: 2 });

		expect(snippet).toBeDefined();
		expect(snippet?.column).toBe(10);
	});

	it("should return undefined when file does not exist", () => {
		expect.assertions(1);

		vi.mocked(fs.existsSync).mockReturnValue(false);

		const snippet = getSourceSnippet({ filePath: "nonexistent.ts", line: 1 });

		expect(snippet).toBeUndefined();
	});

	it("should handle lines at start of file", () => {
		expect.assertions(2);

		const fileContent = `line 1
line 2
line 3`;

		vi.mocked(fs.existsSync).mockReturnValue(true);
		vi.mocked(fs.readFileSync).mockReturnValue(fileContent);

		const snippet = getSourceSnippet({ filePath: "test.ts", line: 1 });

		expect(snippet).toBeDefined();
		expect(snippet?.lines[0]?.num).toBe(1);
	});

	it("should snapshot rendered snippet with context", () => {
		expect.assertions(1);

		const fileContent = `import { expect } from "vitest";
describe("math", () => {
  it("should add", () => {
    expect(2 + 2).toBe(5);
  });
});`;

		vi.mocked(fs.existsSync).mockReturnValue(true);
		vi.mocked(fs.readFileSync).mockReturnValue(fileContent);

		const snippet = getSourceSnippet({ context: 2, filePath: "math.spec.ts", line: 4 });

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

		const sourceContent = "line1\nline2\nline3";

		const snippet = getSourceSnippet({
			context: 1,
			filePath: "nonexistent.ts",
			line: 2,
			sourceContent,
		});

		expect(snippet).toBeDefined();
		expect(snippet?.lines).toHaveLength(3);
	});

	it("should handle out-of-bounds line in getSourceSnippet", () => {
		expect.assertions(2);

		const sourceContent = "line1\nline2\nline3";

		const snippet = getSourceSnippet({
			filePath: "test.ts",
			line: 100,
			sourceContent,
		});

		expect(snippet).toBeDefined();
		expect(snippet?.failureLine).toBe(100);
	});

	it("should compute column from expect line when not provided", () => {
		expect.assertions(2);

		const fileContent = `describe("test", () => {
  expect(2 + 2).toBe(5);
});`;

		vi.mocked(fs.existsSync).mockReturnValue(true);
		vi.mocked(fs.readFileSync).mockReturnValue(fileContent);

		const snippet = getSourceSnippet({ context: 1, filePath: "test.ts", line: 2 });

		expect(snippet).toBeDefined();
		// '  expect(2 + 2).toBe' -> 'toBe' starts at col 17 (1-indexed)
		expect(snippet?.column).toBe(17);
	});
});
