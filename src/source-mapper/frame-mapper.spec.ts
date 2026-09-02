import { fromAny } from "@total-typescript/shoehorn";

import { vol } from "memfs";
import * as path from "node:path";
import { assert, describe, expect, it, vi } from "vitest";

import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import { createFrameMapper, createLineMapper } from "./frame-mapper.ts";
import type { PathResolver } from "./path-resolver.ts";
import { getSourceContent, mapFromSourceMap, mapLineStart } from "./v3-mapper.ts";

vi.mock(import("node:fs"), async () => {
	const memfs = await import("memfs");
	return fromAny({ ...memfs.fs, default: memfs.fs });
});
vi.mock(import("./v3-mapper.ts"));

describe(createFrameMapper, () => {
	it("should map an exact TypeScript source location with embedded content", () => {
		expect.assertions(3);

		vol.reset();

		const resolve = vi.fn<PathResolver["resolve"]>(() => {
			return fromAny({
				filePath: "src/example.ts",
				mapping: { outDir: "out", rootDir: "src" },
			});
		});
		vi.mocked(mapFromSourceMap).mockReturnValue({
			column: 4,
			line: 2,
			source: "../src/example.ts",
		});
		vi.mocked(getSourceContent).mockReturnValue("const value = 1;\nexpect(value).toBe(1);");

		const result = createFrameMapper(fromAny({ resolve }))({
			column: 7,
			dataModelPath: "ReplicatedStorage.example",
			line: 12,
		});

		expect(resolve).toHaveBeenCalledExactlyOnceWith("ReplicatedStorage.example");
		expect(mapFromSourceMap).toHaveBeenCalledExactlyOnceWith("out/example.luau", 12, 7);
		expect(result).toStrictEqual({
			luauPath: "out/example.luau",
			source: {
				column: 15,
				line: 2,
				path: normalizeWindowsPath(path.resolve("out", "../src/example.ts")),
				sourceContent: "const value = 1;\nexpect(value).toBe(1);",
			},
		});
	});

	it("should read source from disk only when the source map has no embedded content", () => {
		expect.assertions(1);

		vol.reset();

		const resolvedSourcePath = normalizeWindowsPath(path.resolve("out", "../src/example.ts"));
		vol.fromJSON({ [resolvedSourcePath]: "expect(value).toBe(1);" });
		vi.mocked(mapFromSourceMap).mockReturnValue({
			column: 0,
			line: 1,
			source: "../src/example.ts",
		});
		vi.mocked(getSourceContent).mockReturnValue(null);
		const mapper = createFrameMapper(
			fromAny({
				resolve: () => {
					return {
						filePath: "src/example.ts",
						mapping: { outDir: "out", rootDir: "src" },
					};
				},
			}),
		);

		const result = mapper({ dataModelPath: "ReplicatedStorage.example", line: 12 });
		assert(result !== undefined);

		expect(result.source).toStrictEqual({
			column: 15,
			line: 1,
			path: resolvedSourcePath,
			sourceContent: undefined,
		});
	});
});

describe(createLineMapper, () => {
	it("should map a Luau line through the first mapping on that line of the compiled file", () => {
		expect.assertions(2);

		vi.mocked(mapLineStart).mockReturnValue({ column: 0, line: 3, source: "../src/m.spec.ts" });
		const mapLine = createLineMapper(
			fromAny({
				resolve: () => {
					return {
						filePath: "src/m.spec.ts",
						mapping: { outDir: "out", rootDir: "src" },
					};
				},
			}),
		);

		expect(mapLine("ReplicatedStorage.m.spec", 10)).toBe(3);
		expect(mapLineStart).toHaveBeenCalledWith("out/m.spec.luau", 10);
	});

	it("should keep the Luau line for a file with no TypeScript origin", () => {
		expect.assertions(1);

		const mapLine = createLineMapper(
			fromAny({ resolve: () => ({ filePath: "out/m.spec.luau" }) }),
		);

		expect(mapLine("ReplicatedStorage.m.spec", 10)).toBe(10);
	});

	it("should return undefined when the path does not resolve", () => {
		expect.assertions(1);

		const mapLine = createLineMapper(fromAny({ resolve: () => {} }));

		expect(mapLine("ReplicatedStorage.missing", 10)).toBeUndefined();
	});

	it("should return undefined when the source map has nothing on the line", () => {
		expect.assertions(1);

		vi.mocked(mapLineStart).mockReturnValue(undefined);
		const mapLine = createLineMapper(
			fromAny({
				resolve: () => {
					return {
						filePath: "src/m.spec.ts",
						mapping: { outDir: "out", rootDir: "src" },
					};
				},
			}),
		);

		expect(mapLine("ReplicatedStorage.m.spec", 10)).toBeUndefined();
	});
});
