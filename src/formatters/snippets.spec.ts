import * as path from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";

import { createTaggedStyles } from "#test/mocks/format-tagged-styles.ts";
import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import type { MappedLocation } from "../source-mapper/index.ts";
import type { FailureLocation } from "./failure-model.ts";
import { resolveSourceSnippets } from "./snippets.ts";

function resolve(
	mappedLocations: Array<MappedLocation>,
	overrides: Partial<Parameters<typeof resolveSourceSnippets>[0]> = {},
): Array<string> {
	return resolveSourceSnippets({
		hasSnapshotDiff: false,
		showLuau: false,
		sources: mappedLocations.map((location) => ({ kind: "mapped", location })),
		styles: createTaggedStyles(),
		...overrides,
	});
}

function makeSourceFile(extension: "luau" | "ts", content = "return true\n") {
	const filePath = path.resolve(`example.${extension}`);
	const { fileSystem } = createMemoryFileSystem({ [filePath]: content });
	return { filePath, fileSystem };
}

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

		expect(
			resolve([], { sources: [messageSource({ line: 5, path: "missing.ts" })] }),
		).toStrictEqual([]);
	});

	it("should put one blank line before a fallback snippet", () => {
		expect.assertions(1);

		const { filePath, fileSystem } = makeSourceFile("ts", "throw new Error();\n");
		const relativePath = path.relative(process.cwd(), filePath);

		expect(
			resolve([], {
				fileSystem,
				sources: [messageSource({ line: 1, path: relativePath })],
			})[0],
		).toBe("");
	});

	it("should skip snapshot lookup when the file is unavailable", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();

		expect(
			resolve([], { filePath: "src/example.ts", fileSystem, hasSnapshotDiff: true }),
		).toStrictEqual([]);
	});

	it("should not fall back to the snapshot call when a mapped source is unavailable", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({
			"src/example.ts": "const value = 1;\nexpect(value).toMatchSnapshot();",
		});

		expect(
			resolve([{ luauLine: 1, luauPath: "missing.luau" }], {
				filePath: "src/example.ts",
				fileSystem,
				hasSnapshotDiff: true,
			}),
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

function messageSource(location: FailureLocation): { kind: "message"; location: FailureLocation } {
	return { kind: "message", location };
}
