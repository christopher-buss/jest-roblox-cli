import * as path from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";

import { createTaggedStyles } from "#test/mocks/format-tagged-styles.ts";
import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import type { MappedLocation } from "../source-mapper/index.ts";
import { parseSourceLocation, resolveSourceSnippets } from "./snippets.ts";

function resolve(
	mappedLocations: Array<MappedLocation>,
	overrides: Partial<Parameters<typeof resolveSourceSnippets>[0]> = {},
): Array<string> {
	return resolveSourceSnippets({
		hasSnapshotDiff: false,
		mappedLocations,
		message: "failure",
		showLuau: false,
		styles: createTaggedStyles(),
		useColor: false,
		...overrides,
	});
}

function makeSourceFile(extension: "luau" | "ts", content = "return true\n") {
	const filePath = path.resolve(`example.${extension}`);
	const { fileSystem } = createMemoryFileSystem({ [filePath]: content });
	return { filePath, fileSystem };
}

describe(parseSourceLocation, () => {
	it("should parse supported source extensions with optional columns", () => {
		expect.assertions(1);

		expect([
			parseSourceLocation("at src/a.ts:25:12"),
			parseSourceLocation("at src/b.tsx:2"),
			parseSourceLocation("at src/c.lua:3:4"),
			parseSourceLocation("at src/d.luau:5"),
			parseSourceLocation("at src/e.js:6:7"),
		]).toStrictEqual([
			{ column: 12, line: 25, path: "src/a.ts" },
			{ column: undefined, line: 2, path: "src/b.tsx" },
			{ column: 4, line: 3, path: "src/c.lua" },
			{ column: undefined, line: 5, path: "src/d.luau" },
			undefined,
		]);
	});
});

describe(resolveSourceSnippets, () => {
	it("should return no mapped snippet when the mapped source is unavailable", () => {
		expect.assertions(2);

		expect(
			resolve([{ luauLine: 1, luauPath: "missing.luau", tsLine: 5, tsPath: "missing.ts" }]),
		).toStrictEqual([]);
		expect(resolve([{ luauLine: 5, luauPath: "missing.luau" }])).toStrictEqual([]);
	});

	it("should put one blank line before a mapped TypeScript or Luau snippet", () => {
		expect.assertions(3);

		const { filePath: luauPath, fileSystem } = makeSourceFile("luau");
		const ts = resolve(
			[
				{
					luauLine: 1,
					luauPath,
					sourceContent: "throw new Error();\n",
					tsLine: 1,
					tsPath: "src/example.ts",
				},
			],
			{ fileSystem },
		);
		const luau = resolve([{ luauLine: 1, luauPath }], { fileSystem });

		expect(ts).toHaveLength(2);
		expect(ts[0]).toBe("");
		expect(luau[0]).toBe("");
	});

	it("should append Luau only when requested for a mapped TypeScript location", () => {
		expect.assertions(2);

		const { filePath: luauPath, fileSystem } = makeSourceFile("luau");
		const mappedLocations = [
			{
				luauLine: 1,
				luauPath,
				sourceContent: "throw new Error();\n",
				tsLine: 1,
				tsPath: "src/example.ts",
			},
		];

		expect(resolve(mappedLocations, { fileSystem })).toHaveLength(2);
		expect(resolve(mappedLocations, { fileSystem, showLuau: true })).toHaveLength(4);
	});

	it("should return no fallback snippet when its source is unavailable", () => {
		expect.assertions(1);

		expect(resolve([], { message: "at missing.ts:5" })).toStrictEqual([]);
	});

	it("should put one blank line before a fallback snippet", () => {
		expect.assertions(1);

		const { filePath, fileSystem } = makeSourceFile("ts", "throw new Error();\n");
		const relativePath = path.relative(process.cwd(), filePath);

		expect(resolve([], { fileSystem, message: `at ${relativePath}:1` })[0]).toBe("");
	});

	it("should skip snapshot lookup when the file is unavailable", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();

		expect(
			resolve([], { filePath: "src/example.ts", fileSystem, hasSnapshotDiff: true }),
		).toStrictEqual([]);
	});

	it("should require exactly one snapshot call", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({
			"src/example.ts": "expect(a).toMatchSnapshot();\nexpect(b).toMatchSnapshot();",
		});

		expect(
			resolve([], { filePath: "src/example.ts", fileSystem, hasSnapshotDiff: true }),
		).toStrictEqual([]);
	});

	it("should preserve styles and color choice for a snapshot-call snippet", () => {
		expect.assertions(2);

		const { fileSystem } = createMemoryFileSystem({
			"src/example.ts": "const value = 1;\nexpect(value).toMatchSnapshot();",
		});
		const snippets = resolve([], {
			filePath: "src/example.ts",
			fileSystem,
			hasSnapshotDiff: true,
		});

		expect(snippets[0]).toBe("");
		expect(snippets[1]).toContain("<location> ❯ src/example.ts:2");
	});
});

describe(parseSourceLocation, () => {
	it("should parse .luau file location", () => {
		expect.assertions(2);

		const result = parseSourceLocation("path/test.luau:25");

		expect(result!.path).toBe("path/test.luau");
		expect(result!.line).toBe(25);
	});

	it("should parse .lua file location with column", () => {
		expect.assertions(3);

		const result = parseSourceLocation("path/test.lua:10:5");

		expect(result!.path).toBe("path/test.lua");
		expect(result!.line).toBe(10);
		expect(result!.column).toBe(5);
	});
});
