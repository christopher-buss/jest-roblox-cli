import { fromAny } from "@total-typescript/shoehorn";

import * as path from "node:path";
import { assert, describe, expect, it, vi } from "vitest";

import { createMemoryFileSystem } from "../../test/mocks/memory-file-system.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import type { FrameMapperContext } from "./frame-mapper.ts";
import { createFrameMapper, createLineMapper } from "./frame-mapper.ts";
import type { PathResolver } from "./path-resolver.ts";
import type { V3Mapper } from "./v3-mapper.ts";

/** A resolver that always answers with a roblox-ts mapping for `filePath`. */
function resolvingTo(filePath: string): PathResolver {
	return fromAny({
		resolve: () => ({ filePath, mapping: { outDir: "out", rootDir: "src" } }),
	});
}

/**
 * A context whose source-map reader answers exactly what the test says, so a
 * frame's path chain is exercised without a `.map` file behind it.
 *
 * @param parts - The resolver, the source-map answers, and the filesystem a
 *   disk read would reach.
 */
function contextWith(parts: {
	fileSystem?: FileSystem;
	pathResolver: PathResolver;
	v3Mapper?: Partial<V3Mapper>;
}): FrameMapperContext {
	return {
		fileSystem: parts.fileSystem ?? createMemoryFileSystem().fileSystem,
		pathResolver: parts.pathResolver,
		v3Mapper: {
			getSourceContent: vi.fn<V3Mapper["getSourceContent"]>(() => {}),
			mapFromSourceMap: vi.fn<V3Mapper["mapFromSourceMap"]>(() => {}),
			mapLineStart: vi.fn<V3Mapper["mapLineStart"]>(() => {}),
			...parts.v3Mapper,
		},
	};
}

describe(createFrameMapper, () => {
	it("should map an exact TypeScript source location with embedded content", () => {
		expect.assertions(3);

		const resolve = vi.fn<PathResolver["resolve"]>(() => {
			return fromAny({
				filePath: "src/example.ts",
				mapping: { outDir: "out", rootDir: "src" },
			});
		});
		const context = contextWith({
			pathResolver: fromAny({ resolve }),
			v3Mapper: {
				getSourceContent: vi.fn<V3Mapper["getSourceContent"]>(
					() => "const value = 1;\nexpect(value).toBe(1);",
				),
				mapFromSourceMap: vi.fn<V3Mapper["mapFromSourceMap"]>(() => {
					return {
						column: 4,
						line: 2,
						source: "../src/example.ts",
					};
				}),
			},
		});

		const result = createFrameMapper(context)({
			column: 7,
			dataModelPath: "ReplicatedStorage.example",
			line: 12,
		});

		expect(resolve).toHaveBeenCalledExactlyOnceWith("ReplicatedStorage.example");
		expect(context.v3Mapper.mapFromSourceMap).toHaveBeenCalledExactlyOnceWith(
			"out/example.luau",
			12,
			7,
		);
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

		const resolvedSourcePath = normalizeWindowsPath(path.resolve("out", "../src/example.ts"));
		const { fileSystem } = createMemoryFileSystem({
			[resolvedSourcePath]: "expect(value).toBe(1);",
		});
		const mapper = createFrameMapper(
			contextWith({
				fileSystem,
				pathResolver: resolvingTo("src/example.ts"),
				v3Mapper: {
					getSourceContent: vi.fn<V3Mapper["getSourceContent"]>(() => null),
					mapFromSourceMap: vi.fn<V3Mapper["mapFromSourceMap"]>(() => {
						return {
							column: 0,
							line: 1,
							source: "../src/example.ts",
						};
					}),
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

		const context = contextWith({
			pathResolver: resolvingTo("src/m.spec.ts"),
			v3Mapper: {
				mapLineStart: vi.fn<V3Mapper["mapLineStart"]>(() => {
					return {
						column: 0,
						line: 3,
						source: "../src/m.spec.ts",
					};
				}),
			},
		});

		expect(createLineMapper(context)("ReplicatedStorage.m.spec", 10)).toBe(3);
		expect(context.v3Mapper.mapLineStart).toHaveBeenCalledWith("out/m.spec.luau", 10);
	});

	it("should keep the Luau line for a file with no TypeScript origin", () => {
		expect.assertions(1);

		const mapLine = createLineMapper(
			contextWith({
				pathResolver: fromAny({ resolve: () => ({ filePath: "out/m.spec.luau" }) }),
			}),
		);

		expect(mapLine("ReplicatedStorage.m.spec", 10)).toBe(10);
	});

	it("should return undefined when the path does not resolve", () => {
		expect.assertions(1);

		const mapLine = createLineMapper(
			contextWith({ pathResolver: fromAny({ resolve: () => {} }) }),
		);

		expect(mapLine("ReplicatedStorage.missing", 10)).toBeUndefined();
	});

	it("should return undefined when the source map has nothing on the line", () => {
		expect.assertions(1);

		const mapLine = createLineMapper(
			contextWith({ pathResolver: resolvingTo("src/m.spec.ts") }),
		);

		expect(mapLine("ReplicatedStorage.m.spec", 10)).toBeUndefined();
	});
});
