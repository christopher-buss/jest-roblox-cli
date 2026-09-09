import * as fs from "node:fs";
import * as path from "node:path";
import process from "node:process";
import color from "tinyrainbow";
import { describe, expect, it, onTestFinished } from "vitest";

import { createMemoryFileSystem } from "../../test/mocks/memory-file-system.ts";
import type { MappedLocation, SourceSnippet } from "../source-mapper/index.ts";
import { createTaggedStyles } from "./__fixtures__/tagged-styles.ts";
import { formatSourceSnippet, parseSourceLocation, resolveSourceSnippets } from "./snippets.ts";

function makeTemporarySource(extension: "luau" | "ts", content = "return true\n"): string {
	const directory = fs.mkdtempSync(path.join(process.cwd(), "snippet-contract-"));
	const filePath = path.join(directory, `example.${extension}`);
	fs.writeFileSync(filePath, content);
	onTestFinished(() => {
		fs.rmSync(directory, { force: true, recursive: true });
	});
	return filePath;
}

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

describe(formatSourceSnippet, () => {
	it("should enable color by default", () => {
		expect.assertions(1);

		const output = formatSourceSnippet(
			{ failureLine: 1, lines: [{ content: "return nil", num: 1 }] },
			"src/example.luau",
		);

		expect(output).toContain(color.cyan(" ❯ src/example.luau:1"));
	});

	it("should render padding, tabs, syntax, language, and the caret exactly", () => {
		expect.assertions(2);

		const snippet: SourceSnippet = {
			column: 6,
			failureLine: 10,
			lines: [
				{ content: "\tlocal value = true", num: 9 },
				{ content: "\treturn value", num: 10 },
				{ content: "end", num: 11 },
			],
		};

		expect(
			formatSourceSnippet(snippet, "src/example.luau", {
				language: "Luau",
				useColor: false,
			}),
		).toMatchSnapshot("plain");
		expect(
			formatSourceSnippet(snippet, "src/example.luau", {
				language: "Luau",
				useColor: true,
			}),
		).toMatchSnapshot("colored");
	});

	it("should omit the column, caret, and language when they are unavailable", () => {
		expect.assertions(1);

		expect(
			formatSourceSnippet(
				{ failureLine: 1, lines: [{ content: "return nil", num: 1 }] },
				"src/example.luau",
				{ useColor: false },
			),
		).toBe(" ❯ src/example.luau:1\n\t1| return nil");
	});

	it("should advance tabs to the next tab stop", () => {
		expect.assertions(1);

		expect(
			formatSourceSnippet(
				{ failureLine: 1, lines: [{ content: "a\tb", num: 1 }] },
				"src/example.luau",
				{ useColor: false },
			),
		).toBe(" ❯ src/example.luau:1\n\t1| a   b");
	});
});

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

		const luauPath = makeTemporarySource("luau");
		const ts = resolve([
			{
				luauLine: 1,
				luauPath,
				sourceContent: "throw new Error();\n",
				tsLine: 1,
				tsPath: "src/example.ts",
			},
		]);
		const luau = resolve([{ luauLine: 1, luauPath }]);

		expect(ts).toHaveLength(2);
		expect(ts[0]).toBe("");
		expect(luau[0]).toBe("");
	});

	it("should append Luau only when requested for a mapped TypeScript location", () => {
		expect.assertions(2);

		const luauPath = makeTemporarySource("luau");
		const mappedLocations = [
			{
				luauLine: 1,
				luauPath,
				sourceContent: "throw new Error();\n",
				tsLine: 1,
				tsPath: "src/example.ts",
			},
		];

		expect(resolve(mappedLocations)).toHaveLength(2);
		expect(resolve(mappedLocations, { showLuau: true })).toHaveLength(4);
	});

	it("should return no fallback snippet when its source is unavailable", () => {
		expect.assertions(1);

		expect(resolve([], { message: "at missing.ts:5" })).toStrictEqual([]);
	});

	it("should put one blank line before a fallback snippet", () => {
		expect.assertions(1);

		const filePath = makeTemporarySource("ts", "throw new Error();\n");
		const relativePath = path.relative(process.cwd(), filePath);

		expect(resolve([], { message: `at ${relativePath}:1` })[0]).toBe("");
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
			"src/example.ts": "expect(value).toMatchSnapshot();",
		});
		const snippets = resolve([], {
			filePath: "src/example.ts",
			fileSystem,
			hasSnapshotDiff: true,
		});

		expect(snippets[0]).toBe("");
		expect(snippets[1]).toContain("<location> ❯ src/example.ts:1");
	});
});
