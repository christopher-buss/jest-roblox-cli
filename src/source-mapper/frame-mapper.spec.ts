import { fromAny } from "@total-typescript/shoehorn";

import { vol } from "memfs";
import * as path from "node:path";
import { assert, describe, expect, it, vi } from "vitest";

import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import { createFrameMapper } from "./frame-mapper.ts";
import type { PathResolver } from "./path-resolver.ts";
import { getSourceContent, mapFromSourceMap } from "./v3-mapper.ts";

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
