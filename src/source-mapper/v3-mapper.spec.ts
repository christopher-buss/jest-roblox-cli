import { describe, expect, it, vi } from "vitest";

import { createMemoryFileSystem } from "../../test/mocks/memory-file-system.ts";
import { createV3Mapper } from "./v3-mapper.ts";

/** A map with one segment on line 1 and one on line 2. */
// cspell:ignore AACA
const TWO_LINE_MAP = JSON.stringify({
	file: "output.luau",
	mappings: "AAAA;AACA",
	sources: ["../src/input.ts"],
	version: 3,
});

/** A map with a single segment on line 1, at generated column 0. */
const ONE_LINE_MAP = JSON.stringify({
	file: "output.luau",
	mappings: "AAAA",
	sources: ["../src/input.ts"],
	version: 3,
});

describe(createV3Mapper, () => {
	it("should return undefined when no map file sits beside the generated file", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();

		expect(createV3Mapper(fileSystem).mapFromSourceMap("output.luau", 1)).toBeUndefined();
	});

	it("should return the mapped position from a valid V3 sourcemap", () => {
		expect.assertions(3);

		const { fileSystem } = createMemoryFileSystem({ "/output.luau.map": TWO_LINE_MAP });

		const result = createV3Mapper(fileSystem).mapFromSourceMap("/output.luau", 1);

		expect(result).toBeDefined();
		expect(result!.source).toBe("../src/input.ts");
		expect(result!.line).toBe(1);
	});

	it("should return undefined for a line the map says nothing about", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({ "/output.luau.map": ONE_LINE_MAP });

		expect(createV3Mapper(fileSystem).mapFromSourceMap("/output.luau", 99)).toBeUndefined();
	});

	it("should parse a sourcemap once however many lookups it answers", () => {
		expect.assertions(2);

		const { fileSystem } = createMemoryFileSystem({ "/cached.luau.map": ONE_LINE_MAP });
		const readFile = vi.spyOn(fileSystem, "readFileSync");
		const exists = vi.spyOn(fileSystem, "existsSync");
		const mapper = createV3Mapper(fileSystem);

		mapper.mapFromSourceMap("/cached.luau", 1);
		mapper.mapFromSourceMap("/cached.luau", 1);

		expect(readFile).toHaveBeenCalledOnce();
		expect(exists).toHaveBeenCalledOnce();
	});

	// Two mappers must not share a parse cache: one spec file's reads would
	// otherwise answer the next file's lookups under a shared worker.
	it("should keep each mapper's parse cache to itself", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({ "/cached.luau.map": ONE_LINE_MAP });
		createV3Mapper(fileSystem).mapFromSourceMap("/cached.luau", 1);
		const readFile = vi.spyOn(fileSystem, "readFileSync");

		createV3Mapper(fileSystem).mapFromSourceMap("/cached.luau", 1);

		expect(readFile).toHaveBeenCalledOnce();
	});

	it("should return undefined for source content when the map file is missing", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();

		expect(
			createV3Mapper(fileSystem).getSourceContent("missing.luau", "source.ts"),
		).toBeUndefined();
	});

	it("should return the embedded source content for a mapped source", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({
			"/output.luau.map": JSON.stringify({
				file: "output.luau",
				mappings: "AAAA",
				sources: ["../src/input.ts"],
				sourcesContent: ["const value = 1;"],
				version: 3,
			}),
		});

		expect(createV3Mapper(fileSystem).getSourceContent("/output.luau", "../src/input.ts")).toBe(
			"const value = 1;",
		);
	});

	it("should return null when the map embeds no content for the source", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({ "/output.luau.map": ONE_LINE_MAP });

		expect(
			createV3Mapper(fileSystem).getSourceContent("/output.luau", "../src/input.ts"),
		).toBeNull();
	});

	it("should find the first mapping on an indented line a column-0 lookup misses", () => {
		expect.assertions(2);

		// cspell:ignore IAAA
		// One segment on line 1 at generated column 4 (`IAAA`), as a
		// tab-indented `it(` call compiles to.
		const { fileSystem } = createMemoryFileSystem({
			"/output.luau.map": JSON.stringify({
				file: "output.luau",
				mappings: "IAAA",
				sources: ["../src/input.ts"],
				version: 3,
			}),
		});
		const mapper = createV3Mapper(fileSystem);

		expect(mapper.mapFromSourceMap("/output.luau", 1, 0)).toBeUndefined();
		expect(mapper.mapLineStart("/output.luau", 1)).toMatchObject({
			line: 1,
			source: "../src/input.ts",
		});
	});

	it("should return no line start when the line has no mapping", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({ "/output.luau.map": ONE_LINE_MAP });

		expect(createV3Mapper(fileSystem).mapLineStart("/output.luau", 3)).toBeUndefined();
	});

	it("should return no line start when no map file exists", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();

		expect(createV3Mapper(fileSystem).mapLineStart("output.luau", 1)).toBeUndefined();
	});
});
