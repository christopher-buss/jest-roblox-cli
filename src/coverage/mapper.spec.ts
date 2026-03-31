/* cspell:words jridgewell */
import { fromPartial } from "@total-typescript/shoehorn";

import { describe, expect, it, vi } from "vitest";

import { mapCoverageToTypeScript } from "./mapper.ts";
import type { CoverageManifest, CoverageMap, RawCoverageData } from "./types.ts";

const { mockOriginalPositionFor, mockReadFileSync, MockTraceMap } = vi.hoisted(() => {
	// eslint-disable-next-line ts/no-extraneous-class -- mock constructor for TraceMap
	class MockTraceMapClass {}

	return {
		mockOriginalPositionFor:
			vi.fn<(map: unknown, position: { column: number; line: number }) => unknown>(),
		mockReadFileSync: vi.fn<(path: string, encoding: string) => string>(),
		MockTraceMap: MockTraceMapClass,
	};
});

vi.mock(import("node:fs"), async (importOriginal) => {
	return fromPartial({
		...(await importOriginal()),
		readFileSync: mockReadFileSync,
	});
});

vi.mock(import("@jridgewell/trace-mapping"), async (importOriginal) => {
	return {
		...(await importOriginal()),
		originalPositionFor: mockOriginalPositionFor,
		TraceMap: MockTraceMap,
	} as unknown as typeof import("@jridgewell/trace-mapping");
});

function createManifest(files: CoverageManifest["files"] = {}): CoverageManifest {
	return {
		files,
		generatedAt: "2026-01-01T00:00:00.000Z",
		instrumenterVersion: 1,
		luauRoots: ["out"],
		nonInstrumentedFiles: {},
		shadowDir: ".jest-roblox-coverage/out",
		version: 1,
	};
}

function createCoverageMap(
	statementMap: CoverageMap["statementMap"] = {},
	functionMap?: CoverageMap["functionMap"],
	branchMap?: CoverageMap["branchMap"],
): CoverageMap {
	return {
		statementMap,
		...(functionMap !== undefined && { functionMap }),
		...(branchMap !== undefined && { branchMap }),
	};
}

function setupFs(fileContents: Record<string, string>): void {
	mockReadFileSync.mockImplementation((filePath: string) => {
		const contents = fileContents[filePath];
		if (contents === undefined) {
			throw new Error(`ENOENT: no such file: ${filePath}`);
		}

		return contents;
	});
}

function setupSourceMapMappings(
	mappings: Record<string, { column: number; line: number; source: string }>,
): void {
	mockOriginalPositionFor.mockImplementation(
		(_map: unknown, position: { column: number; line: number }) => {
			const key = `${String(position.line)}:${String(position.column)}`;
			const mapping = mappings[key];
			if (mapping === undefined) {
				return { name: null, column: null, line: null, source: null };
			}

			return {
				name: null,
				column: mapping.column,
				line: mapping.line,
				source: mapping.source,
			};
		},
	);
}

function createManifestFiles() {
	return {
		"shared/player.luau": {
			key: "shared/player.luau",
			coverageMapPath: "out/shared/player.luau.cov-map.json",
			instrumentedLuauPath: ".jest-roblox-coverage/out/shared/player.luau",
			originalLuauPath: "out/shared/player.luau",
			sourceHash: "abc123",
			sourceMapPath: "out/shared/player.luau.map",
			statementCount: 1,
		},
	};
}

describe(mapCoverageToTypeScript, () => {
	describe("with a single mapped statement", () => {
		it("should map Luau statement to TypeScript location", () => {
			expect.assertions(4);

			const coverageMap = createCoverageMap({
				"0": {
					end: { column: 20, line: 5 },
					start: { column: 1, line: 5 },
				},
			});

			setupFs({
				"out/shared/player.luau.cov-map.json": JSON.stringify(coverageMap),
				"out/shared/player.luau.map": '{"version":3}',
			});

			setupSourceMapMappings({
				"5:0": { column: 0, line: 3, source: "src/shared/player.ts" },
				"5:19": { column: 25, line: 3, source: "src/shared/player.ts" },
			});

			const coverageData: RawCoverageData = {
				"shared/player.luau": { s: { "0": 3 } },
			};

			const result = mapCoverageToTypeScript(
				coverageData,
				createManifest(createManifestFiles()),
			);

			expect(result.files["src/shared/player.ts"]).toBeDefined();

			const file = result.files["src/shared/player.ts"];

			expect(file?.path).toBe("src/shared/player.ts");
			expect(file?.statementMap["0"]).toStrictEqual({
				end: { column: 25, line: 3 },
				start: { column: 0, line: 3 },
			});
			expect(file?.s["0"]).toBe(3);
		});
	});

	describe("with source-map-relative paths", () => {
		it("should resolve ../  paths relative to source map location", () => {
			expect.assertions(2);

			// roblox-ts source maps produce paths relative to the .lua.map file,
			// e.g., ../../../packages/src/player.ts from
			// out/packages/src/player.lua.map. The mapper should resolve these to
			// cwd-relative paths so that collectCoverageFrom glob patterns can
			// match them.
			const coverageMap = createCoverageMap({
				"0": {
					end: { column: 20, line: 5 },
					start: { column: 1, line: 5 },
				},
			});

			setupFs({
				"out/packages/src/player.luau.cov-map.json": JSON.stringify(coverageMap),
				"out/packages/src/player.luau.map": '{"version":3}',
			});

			setupSourceMapMappings({
				"5:0": { column: 0, line: 3, source: "../../../packages/src/player.ts" },
				"5:19": { column: 25, line: 3, source: "../../../packages/src/player.ts" },
			});

			const manifest = createManifest({
				"out/packages/src/player.luau": {
					key: "out/packages/src/player.luau",
					coverageMapPath: "out/packages/src/player.luau.cov-map.json",
					instrumentedLuauPath: ".jest-roblox-coverage/out/packages/src/player.luau",
					originalLuauPath: "out/packages/src/player.luau",
					sourceHash: "abc123",
					sourceMapPath: "out/packages/src/player.luau.map",
					statementCount: 1,
				},
			});

			const coverageData: RawCoverageData = {
				"out/packages/src/player.luau": { s: { "0": 3 } },
			};

			const result = mapCoverageToTypeScript(coverageData, manifest);

			// Should resolve to cwd-relative path, not raw source map relative
			// path
			expect(result.files["packages/src/player.ts"]).toBeDefined();
			expect(result.files["../../../packages/src/player.ts"]).toBeUndefined();
		});

		it("should normalize Windows backslash paths from source maps", () => {
			expect.assertions(2);

			// roblox-ts on Windows produces source maps with backslash paths
			// like ..\\src\\player.ts instead of ../src/player.ts
			const coverageMap = createCoverageMap({
				"0": {
					end: { column: 20, line: 5 },
					start: { column: 1, line: 5 },
				},
			});

			setupFs({
				"out/player.luau.cov-map.json": JSON.stringify(coverageMap),
				"out/player.luau.map": '{"version":3}',
			});

			setupSourceMapMappings({
				"5:0": { column: 0, line: 3, source: "..\\src\\player.ts" },
				"5:19": { column: 25, line: 3, source: "..\\src\\player.ts" },
			});

			const manifest = createManifest({
				"out/player.luau": {
					key: "out/player.luau",
					coverageMapPath: "out/player.luau.cov-map.json",
					instrumentedLuauPath: ".jest-roblox-coverage/out/player.luau",
					originalLuauPath: "out/player.luau",
					sourceHash: "abc123",
					sourceMapPath: "out/player.luau.map",
					statementCount: 1,
				},
			});

			const coverageData: RawCoverageData = {
				"out/player.luau": { s: { "0": 3 } },
			};

			const result = mapCoverageToTypeScript(coverageData, manifest);

			expect(result.files["src/player.ts"]).toBeDefined();
			expect(result.files["..\\src\\player.ts"]).toBeUndefined();
		});
	});

	describe("with unmapped statements", () => {
		it("should skip statements that have no source map mapping", () => {
			expect.assertions(2);

			const coverageMap = createCoverageMap({
				"0": {
					end: { column: 10, line: 1 },
					start: { column: 1, line: 1 },
				},
				"1": {
					end: { column: 20, line: 5 },
					start: { column: 1, line: 5 },
				},
			});

			setupFs({
				"out/shared/player.luau.cov-map.json": JSON.stringify(coverageMap),
				"out/shared/player.luau.map": '{"version":3}',
			});

			setupSourceMapMappings({
				"5:0": { column: 0, line: 3, source: "src/shared/player.ts" },
				"5:19": { column: 25, line: 3, source: "src/shared/player.ts" },
			});

			const coverageData: RawCoverageData = {
				"shared/player.luau": { s: { "0": 1, "1": 5 } },
			};

			const result = mapCoverageToTypeScript(
				coverageData,
				createManifest({
					...createManifestFiles(),
					"shared/player.luau": {
						...createManifestFiles()["shared/player.luau"],
						statementCount: 2,
					},
				}),
			);

			const file = result.files["src/shared/player.ts"];

			expect(Object.keys(file?.statementMap ?? {})).toHaveLength(1);
			expect(file?.s["0"]).toBe(5);
		});
	});

	describe("with duplicate TS spans", () => {
		it("should coalesce multiple Luau statements mapping to same TS location", () => {
			expect.assertions(3);

			const coverageMap = createCoverageMap({
				"0": {
					end: { column: 15, line: 3 },
					start: { column: 1, line: 3 },
				},
				"1": {
					end: { column: 20, line: 7 },
					start: { column: 1, line: 7 },
				},
			});

			setupFs({
				"out/shared/player.luau.cov-map.json": JSON.stringify(coverageMap),
				"out/shared/player.luau.map": '{"version":3}',
			});

			setupSourceMapMappings({
				"3:0": { column: 0, line: 2, source: "src/shared/player.ts" },
				"3:14": { column: 20, line: 2, source: "src/shared/player.ts" },
				"7:0": { column: 0, line: 2, source: "src/shared/player.ts" },
				"7:19": { column: 25, line: 2, source: "src/shared/player.ts" },
			});

			const coverageData: RawCoverageData = {
				"shared/player.luau": { s: { "0": 3, "1": 7 } },
			};

			const result = mapCoverageToTypeScript(
				coverageData,
				createManifest({
					...createManifestFiles(),
					"shared/player.luau": {
						...createManifestFiles()["shared/player.luau"],
						statementCount: 2,
					},
				}),
			);

			const file = result.files["src/shared/player.ts"];

			expect(Object.keys(file?.statementMap ?? {})).toHaveLength(1);
			expect(file?.s["0"]).toBe(10);
			expect(file?.statementMap["0"]).toStrictEqual({
				end: { column: 25, line: 2 },
				start: { column: 0, line: 2 },
			});
		});

		it("should keep existing end when it has higher column on the same line", () => {
			expect.assertions(1);

			// Two Luau stmts map to same TS start, same end line
			// First has HIGHER end column than second → existing end is kept
			const coverageMap = createCoverageMap({
				"0": {
					end: { column: 20, line: 3 },
					start: { column: 1, line: 3 },
				},
				"1": {
					end: { column: 10, line: 7 },
					start: { column: 1, line: 7 },
				},
			});

			setupFs({
				"out/shared/player.luau.cov-map.json": JSON.stringify(coverageMap),
				"out/shared/player.luau.map": '{"version":3}',
			});

			setupSourceMapMappings({
				"3:0": { column: 0, line: 2, source: "src/shared/player.ts" },
				"3:19": { column: 25, line: 2, source: "src/shared/player.ts" },
				"7:0": { column: 0, line: 2, source: "src/shared/player.ts" },
				"7:9": { column: 5, line: 2, source: "src/shared/player.ts" },
			});

			const coverageData: RawCoverageData = {
				"shared/player.luau": { s: { "0": 1, "1": 1 } },
			};

			const result = mapCoverageToTypeScript(
				coverageData,
				createManifest({
					...createManifestFiles(),
					"shared/player.luau": {
						...createManifestFiles()["shared/player.luau"],
						statementCount: 2,
					},
				}),
			);

			const file = result.files["src/shared/player.ts"];

			// First stmt end col 25 > second stmt end col 5, same line →
			// existing wins
			expect(file?.statementMap["0"]?.end).toStrictEqual({ column: 25, line: 2 });
		});
	});

	describe("with missing statement hit count", () => {
		it("should default hit count to zero when statement ID is absent from raw data", () => {
			expect.assertions(1);

			const coverageMap = createCoverageMap({
				"0": {
					end: { column: 20, line: 5 },
					start: { column: 1, line: 5 },
				},
			});

			setupFs({
				"out/shared/player.luau.cov-map.json": JSON.stringify(coverageMap),
				"out/shared/player.luau.map": '{"version":3}',
			});

			setupSourceMapMappings({
				"5:0": { column: 0, line: 3, source: "src/shared/player.ts" },
				"5:19": { column: 25, line: 3, source: "src/shared/player.ts" },
			});

			// Statement "0" is not in the s record
			const coverageData: RawCoverageData = {
				"shared/player.luau": { s: {} },
			};

			const result = mapCoverageToTypeScript(
				coverageData,
				createManifest(createManifestFiles()),
			);

			const file = result.files["src/shared/player.ts"];

			expect(file?.s["0"]).toBe(0);
		});
	});

	describe("with empty coverage data", () => {
		it("should return empty result for no coverage entries", () => {
			expect.assertions(1);

			const result = mapCoverageToTypeScript({}, createManifest());

			expect(result.files).toBeEmptyObject();
		});
	});

	describe("with unreadable coverage map", () => {
		it("should skip files when coverage map cannot be read", () => {
			expect.assertions(1);

			mockReadFileSync.mockImplementation(() => {
				throw new Error("ENOENT");
			});

			const result = mapCoverageToTypeScript(
				{ "shared/player.luau": { s: { "0": 1 } } },
				createManifest(createManifestFiles()),
			);

			expect(result.files).toBeEmptyObject();
		});
	});

	describe("with start and end mapping to different sources", () => {
		it("should drop statements where start and end map to different TS files", () => {
			expect.assertions(1);

			const coverageMap = createCoverageMap({
				"0": {
					end: { column: 20, line: 5 },
					start: { column: 1, line: 5 },
				},
			});

			setupFs({
				"out/shared/player.luau.cov-map.json": JSON.stringify(coverageMap),
				"out/shared/player.luau.map": '{"version":3}',
			});

			mockOriginalPositionFor.mockImplementation(
				(_map: unknown, position: { column: number; line: number }) => {
					// start maps to a.ts, end maps to b.ts
					if (position.column === 0) {
						return { name: null, column: 0, line: 3, source: "src/a.ts" };
					}

					return { name: null, column: 25, line: 3, source: "src/b.ts" };
				},
			);

			const result = mapCoverageToTypeScript(
				{ "shared/player.luau": { s: { "0": 1 } } },
				createManifest(createManifestFiles()),
			);

			expect(result.files).toBeEmptyObject();
		});
	});

	describe("with missing manifest record", () => {
		it("should skip files not in manifest", () => {
			expect.assertions(1);

			const coverageData: RawCoverageData = {
				"shared/unknown.luau": { s: { "0": 1 } },
			};

			const result = mapCoverageToTypeScript(coverageData, createManifest());

			expect(result.files).toBeEmptyObject();
		});
	});

	describe("with function coverage", () => {
		it("should map Luau function to TypeScript location", () => {
			expect.assertions(4);

			const coverageMap: CoverageMap = {
				functionMap: {
					"1": {
						name: "greet",
						location: {
							end: { column: 4, line: 8 },
							start: { column: 1, line: 5 },
						},
					},
				},
				statementMap: {},
			};

			setupFs({
				"out/shared/player.luau.cov-map.json": JSON.stringify(coverageMap),
				"out/shared/player.luau.map": '{"version":3}',
			});

			setupSourceMapMappings({
				"5:0": { column: 0, line: 3, source: "src/shared/player.ts" },
				"8:3": { column: 10, line: 6, source: "src/shared/player.ts" },
			});

			const coverageData: RawCoverageData = {
				"shared/player.luau": { f: { "1": 7 }, s: {} },
			};

			const result = mapCoverageToTypeScript(
				coverageData,
				createManifest(createManifestFiles()),
			);

			const file = result.files["src/shared/player.ts"]!;

			expect(file).toBeDefined();
			expect(file.fnMap["0"]).toStrictEqual({
				name: "greet",
				loc: {
					end: { column: 10, line: 6 },
					start: { column: 0, line: 3 },
				},
			});
			expect(file.f["0"]).toBe(7);
			expect(Object.keys(file.fnMap)).toHaveLength(1);
		});

		it("should default function hit count to zero when not in raw data", () => {
			expect.assertions(1);

			const coverageMap: CoverageMap = {
				functionMap: {
					"1": {
						name: "foo",
						location: {
							end: { column: 4, line: 8 },
							start: { column: 1, line: 5 },
						},
					},
				},
				statementMap: {},
			};

			setupFs({
				"out/shared/player.luau.cov-map.json": JSON.stringify(coverageMap),
				"out/shared/player.luau.map": '{"version":3}',
			});

			setupSourceMapMappings({
				"5:0": { column: 0, line: 3, source: "src/shared/player.ts" },
				"8:3": { column: 10, line: 6, source: "src/shared/player.ts" },
			});

			const coverageData: RawCoverageData = {
				"shared/player.luau": { s: {} },
			};

			const result = mapCoverageToTypeScript(
				coverageData,
				createManifest(createManifestFiles()),
			);

			const file = result.files["src/shared/player.ts"]!;

			expect(file.f["0"]).toBe(0);
		});

		it("should map multiple functions to the same TypeScript file", () => {
			expect.assertions(2);

			const coverageMap: CoverageMap = {
				functionMap: {
					"1": {
						name: "greet",
						location: {
							end: { column: 4, line: 8 },
							start: { column: 1, line: 5 },
						},
					},
					"2": {
						name: "farewell",
						location: {
							end: { column: 4, line: 15 },
							start: { column: 1, line: 12 },
						},
					},
				},
				statementMap: {},
			};

			setupFs({
				"out/shared/player.luau.cov-map.json": JSON.stringify(coverageMap),
				"out/shared/player.luau.map": '{"version":3}',
			});

			setupSourceMapMappings({
				"5:0": { column: 0, line: 3, source: "src/shared/player.ts" },
				"8:3": { column: 10, line: 6, source: "src/shared/player.ts" },
				"12:0": { column: 0, line: 10, source: "src/shared/player.ts" },
				"15:3": { column: 10, line: 13, source: "src/shared/player.ts" },
			});

			const coverageData: RawCoverageData = {
				"shared/player.luau": { f: { "1": 2, "2": 5 }, s: {} },
			};

			const result = mapCoverageToTypeScript(
				coverageData,
				createManifest(createManifestFiles()),
			);

			const file = result.files["src/shared/player.ts"]!;

			expect(Object.keys(file.fnMap)).toHaveLength(2);
			expect(file.f["1"]).toBe(5);
		});

		it("should skip statement entries with invalid span data in statementMap", () => {
			expect.assertions(1);

			// "0" has an invalid span (missing end), "1" is valid — only "1"
			// should appear
			const coverageMap = createCoverageMap({
				"0": { notASpan: true } as unknown as CoverageMap["statementMap"][string],
				"1": {
					end: { column: 20, line: 5 },
					start: { column: 1, line: 5 },
				},
			});

			setupFs({
				"out/shared/player.luau.cov-map.json": JSON.stringify(coverageMap),
				"out/shared/player.luau.map": '{"version":3}',
			});

			setupSourceMapMappings({
				"5:0": { column: 0, line: 3, source: "src/shared/player.ts" },
				"5:19": { column: 25, line: 3, source: "src/shared/player.ts" },
			});

			const coverageData: RawCoverageData = {
				"shared/player.luau": { s: { "0": 9, "1": 2 } },
			};

			const result = mapCoverageToTypeScript(
				coverageData,
				createManifest({
					...createManifestFiles(),
					"shared/player.luau": {
						...createManifestFiles()["shared/player.luau"],
						statementCount: 2,
					},
				}),
			);

			expect(
				Object.keys(result.files["src/shared/player.ts"]?.statementMap ?? {}),
			).toHaveLength(1);
		});

		it("should skip function entries with invalid schema in functionMap", () => {
			expect.assertions(1);

			// "1" is missing required "name" field — should be skipped entirely
			const coverageMap = createCoverageMap(
				{},
				{
					"1": {
						location: { end: { column: 4, line: 8 }, start: { column: 1, line: 5 } },
					} as unknown as NonNullable<CoverageMap["functionMap"]>[string],
				},
			);

			setupFs({
				"out/shared/player.luau.cov-map.json": JSON.stringify(coverageMap),
				"out/shared/player.luau.map": '{"version":3}',
			});

			setupSourceMapMappings({
				"5:0": { column: 0, line: 3, source: "src/shared/player.ts" },
				"8:3": { column: 10, line: 6, source: "src/shared/player.ts" },
			});

			const coverageData: RawCoverageData = {
				"shared/player.luau": { f: { "1": 5 }, s: {} },
			};

			const result = mapCoverageToTypeScript(
				coverageData,
				createManifest(createManifestFiles()),
			);

			expect(result.files).toBeEmptyObject();
		});

		it("should drop unmapped function when no statements provide a fallback path", () => {
			expect.assertions(1);

			const coverageMap: CoverageMap = {
				functionMap: {
					"1": {
						name: "add",
						location: {
							end: { column: 4, line: 8 },
							start: { column: 1, line: 5 },
						},
					},
				},
				statementMap: {},
			};

			setupFs({
				"out/shared/player.luau.cov-map.json": JSON.stringify(coverageMap),
				"out/shared/player.luau.map": '{"version":3}',
			});

			// Only start has a mapping; end (line 8) returns null source
			// — function can't be mapped, and no statements resolved a
			// TS path to fall back to
			setupSourceMapMappings({
				"5:0": { column: 0, line: 3, source: "src/shared/player.ts" },
			});

			const coverageData: RawCoverageData = {
				"shared/player.luau": { f: { "1": 4 }, s: {} },
			};

			const result = mapCoverageToTypeScript(
				coverageData,
				createManifest(createManifestFiles()),
			);

			expect(result.files).toBeEmptyObject();
		});

		it("should include unmapped function with line-1 synthetic location when statements resolve a TS path", () => {
			expect.assertions(4);

			const coverageMap = createCoverageMap(
				{
					"0": {
						end: { column: 20, line: 5 },
						start: { column: 1, line: 5 },
					},
				},
				{
					"1": {
						name: "unmappable",
						location: {
							end: { column: 4, line: 99 },
							start: { column: 1, line: 99 },
						},
					},
				},
			);

			setupFs({
				"out/shared/player.luau.cov-map.json": JSON.stringify(coverageMap),
				"out/shared/player.luau.map": '{"version":3}',
			});

			// Statement maps, but function location (line 99) does not
			setupSourceMapMappings({
				"5:0": { column: 0, line: 3, source: "src/shared/player.ts" },
				"5:19": { column: 25, line: 3, source: "src/shared/player.ts" },
			});

			const coverageData: RawCoverageData = {
				"shared/player.luau": { f: { "1": 0 }, s: { "0": 1 } },
			};

			const result = mapCoverageToTypeScript(
				coverageData,
				createManifest(createManifestFiles()),
			);

			const file = result.files["src/shared/player.ts"]!;

			expect(file).toBeDefined();
			expect(file.f["0"]).toBe(0);
			expect(file.fnMap["0"]?.name).toBe("unmappable");
			expect(file.fnMap["0"]?.loc).toStrictEqual({
				end: { column: 0, line: 1 },
				start: { column: 0, line: 1 },
			});
		});

		it("should append unmapped function alongside mapped function in same file", () => {
			expect.assertions(3);

			const coverageMap = createCoverageMap(
				{
					"0": {
						end: { column: 20, line: 5 },
						start: { column: 1, line: 5 },
					},
				},
				{
					"1": {
						name: "mapped",
						location: {
							end: { column: 4, line: 8 },
							start: { column: 1, line: 5 },
						},
					},
					"2": {
						name: "unmapped",
						location: {
							end: { column: 4, line: 99 },
							start: { column: 1, line: 99 },
						},
					},
				},
			);

			setupFs({
				"out/shared/player.luau.cov-map.json": JSON.stringify(coverageMap),
				"out/shared/player.luau.map": '{"version":3}',
			});

			setupSourceMapMappings({
				"5:0": { column: 0, line: 3, source: "src/shared/player.ts" },
				"5:19": { column: 25, line: 3, source: "src/shared/player.ts" },
				"8:3": { column: 10, line: 6, source: "src/shared/player.ts" },
			});

			const coverageData: RawCoverageData = {
				"shared/player.luau": { f: { "1": 5, "2": 0 }, s: { "0": 1 } },
			};

			const result = mapCoverageToTypeScript(
				coverageData,
				createManifest(createManifestFiles()),
			);

			const file = result.files["src/shared/player.ts"]!;

			expect(Object.keys(file.fnMap)).toHaveLength(2);
			expect(file.f["0"]).toBe(5);
			expect(file.f["1"]).toBe(0);
		});

		it("should assign unmapped function to first resolved TS path when statements map to multiple files", () => {
			expect.assertions(1);

			const coverageMap = createCoverageMap(
				{
					"0": {
						end: { column: 20, line: 5 },
						start: { column: 1, line: 5 },
					},
					"1": {
						end: { column: 20, line: 10 },
						start: { column: 1, line: 10 },
					},
				},
				{
					"1": {
						name: "unmappable",
						location: {
							end: { column: 4, line: 99 },
							start: { column: 1, line: 99 },
						},
					},
				},
			);

			setupFs({
				"out/shared/player.luau.cov-map.json": JSON.stringify(coverageMap),
				"out/shared/player.luau.map": '{"version":3}',
			});

			// Statements map to two different TS files
			setupSourceMapMappings({
				"5:0": { column: 0, line: 3, source: "src/shared/a.ts" },
				"5:19": { column: 25, line: 3, source: "src/shared/a.ts" },
				"10:0": { column: 0, line: 3, source: "src/shared/b.ts" },
				"10:19": { column: 25, line: 3, source: "src/shared/b.ts" },
			});

			const coverageData: RawCoverageData = {
				"shared/player.luau": { f: { "1": 0 }, s: { "0": 1, "1": 1 } },
			};

			const result = mapCoverageToTypeScript(
				coverageData,
				createManifest(createManifestFiles()),
			);

			// Function lands in one of the two TS files (first resolved)
			const aFile = result.files["src/shared/a.ts"];
			const bFile = result.files["src/shared/b.ts"];
			const funcInA = Object.keys(aFile?.fnMap ?? {}).length;
			const funcInB = Object.keys(bFile?.fnMap ?? {}).length;

			expect(funcInA + funcInB).toBe(1);
		});

		it("should drop unmapped function when no statements resolve a TS path", () => {
			expect.assertions(1);

			const coverageMap = createCoverageMap(
				{},
				{
					"1": {
						name: "unmappable",
						location: {
							end: { column: 4, line: 99 },
							start: { column: 1, line: 99 },
						},
					},
				},
			);

			setupFs({
				"out/shared/player.luau.cov-map.json": JSON.stringify(coverageMap),
				"out/shared/player.luau.map": '{"version":3}',
			});

			// No mappings at all — no TS path can be inferred
			setupSourceMapMappings({});

			const coverageData: RawCoverageData = {
				"shared/player.luau": { f: { "1": 3 }, s: {} },
			};

			const result = mapCoverageToTypeScript(
				coverageData,
				createManifest(createManifestFiles()),
			);

			expect(result.files).toBeEmptyObject();
		});
	});

	describe("with invalid coverage map schema", () => {
		it("should skip files when coverage map fails schema validation", () => {
			expect.assertions(1);

			// Missing required "statementMap" field
			setupFs({
				"out/shared/player.luau.cov-map.json": JSON.stringify({ invalid: true }),
				"out/shared/player.luau.map": '{"version":3}',
			});

			const coverageData: RawCoverageData = {
				"shared/player.luau": { s: { "0": 1 } },
			};

			const result = mapCoverageToTypeScript(
				coverageData,
				createManifest(createManifestFiles()),
			);

			expect(result.files).toBeEmptyObject();
		});
	});

	describe("with coalescence across different lines", () => {
		it("should pick the later end position when coalescing statements on different lines", () => {
			expect.assertions(2);

			// Two Luau statements map to the same TS start but different end
			// lines
			const coverageMap = createCoverageMap({
				"0": {
					end: { column: 15, line: 3 },
					start: { column: 1, line: 3 },
				},
				"1": {
					end: { column: 10, line: 7 },
					start: { column: 1, line: 7 },
				},
			});

			setupFs({
				"out/shared/player.luau.cov-map.json": JSON.stringify(coverageMap),
				"out/shared/player.luau.map": '{"version":3}',
			});

			// Both map to the same TS start (line 2, col 0) but different ends
			setupSourceMapMappings({
				"3:0": { column: 0, line: 2, source: "src/shared/player.ts" },
				"3:14": { column: 10, line: 3, source: "src/shared/player.ts" },
				"7:0": { column: 0, line: 2, source: "src/shared/player.ts" },
				"7:9": { column: 5, line: 5, source: "src/shared/player.ts" },
			});

			const coverageData: RawCoverageData = {
				"shared/player.luau": { s: { "0": 2, "1": 4 } },
			};

			const result = mapCoverageToTypeScript(
				coverageData,
				createManifest({
					...createManifestFiles(),
					"shared/player.luau": {
						...createManifestFiles()["shared/player.luau"],
						statementCount: 2,
					},
				}),
			);

			const file = result.files["src/shared/player.ts"];

			// Coalesced: hit count summed, end is the later position (line 5 >
			// line 3)
			expect(file?.s["0"]).toBe(6);
			expect(file?.statementMap["0"]?.end).toStrictEqual({ column: 5, line: 5 });
		});

		it("should pick the earlier end position's line when first statement ends later", () => {
			expect.assertions(1);

			const coverageMap = createCoverageMap({
				"0": {
					end: { column: 15, line: 7 },
					start: { column: 1, line: 3 },
				},
				"1": {
					end: { column: 10, line: 5 },
					start: { column: 1, line: 5 },
				},
			});

			setupFs({
				"out/shared/player.luau.cov-map.json": JSON.stringify(coverageMap),
				"out/shared/player.luau.map": '{"version":3}',
			});

			// Both map to the same TS start but first ends on a later line
			setupSourceMapMappings({
				"3:0": { column: 0, line: 2, source: "src/shared/player.ts" },
				"5:0": { column: 0, line: 2, source: "src/shared/player.ts" },
				"5:9": { column: 5, line: 3, source: "src/shared/player.ts" },
				"7:14": { column: 10, line: 6, source: "src/shared/player.ts" },
			});

			const coverageData: RawCoverageData = {
				"shared/player.luau": { s: { "0": 1, "1": 1 } },
			};

			const result = mapCoverageToTypeScript(
				coverageData,
				createManifest({
					...createManifestFiles(),
					"shared/player.luau": {
						...createManifestFiles()["shared/player.luau"],
						statementCount: 2,
					},
				}),
			);

			const file = result.files["src/shared/player.ts"];

			// First statement's end (line 6) > second's end (line 3), so line 6
			// wins
			expect(file?.statementMap["0"]?.end).toStrictEqual({ column: 10, line: 6 });
		});
	});

	describe("with branch coverage", () => {
		it("should map branch arms to TypeScript locations", () => {
			expect.assertions(5);

			const coverageMap = createCoverageMap({}, undefined, {
				"1": {
					locations: [
						{ end: { column: 10, line: 3 }, start: { column: 1, line: 3 } },
						{ end: { column: 10, line: 5 }, start: { column: 1, line: 5 } },
					],
					type: "if",
				},
			});

			setupFs({
				"out/shared/player.luau.cov-map.json": JSON.stringify(coverageMap),
				"out/shared/player.luau.map": '{"version":3}',
			});

			setupSourceMapMappings({
				"3:0": { column: 0, line: 2, source: "src/shared/player.ts" },
				"3:9": { column: 15, line: 2, source: "src/shared/player.ts" },
				"5:0": { column: 0, line: 4, source: "src/shared/player.ts" },
				"5:9": { column: 15, line: 4, source: "src/shared/player.ts" },
			});

			const coverageData: RawCoverageData = {
				"shared/player.luau": { b: { "1": [3, 0] }, s: {} },
			};

			const result = mapCoverageToTypeScript(
				coverageData,
				createManifest(createManifestFiles()),
			);

			const file = result.files["src/shared/player.ts"]!;

			expect(file).toBeDefined();
			expect(file.branchMap["0"]).toStrictEqual({
				loc: { end: { column: 15, line: 4 }, start: { column: 0, line: 2 } },
				locations: [
					{ end: { column: 15, line: 2 }, start: { column: 0, line: 2 } },
					{ end: { column: 15, line: 4 }, start: { column: 0, line: 4 } },
				],
				type: "if",
			});
			expect(file.b["0"]).toStrictEqual([3, 0]);
			expect(Object.keys(file.branchMap)).toHaveLength(1);
			expect(Object.keys(file.b)).toHaveLength(1);
		});

		it("should map multiple branches to the same TypeScript file", () => {
			expect.assertions(2);

			const coverageMap = createCoverageMap({}, undefined, {
				"1": {
					locations: [
						{ end: { column: 10, line: 3 }, start: { column: 1, line: 3 } },
						{ end: { column: 10, line: 5 }, start: { column: 1, line: 5 } },
					],
					type: "if",
				},
				"2": {
					locations: [
						{ end: { column: 10, line: 10 }, start: { column: 1, line: 10 } },
						{ end: { column: 10, line: 12 }, start: { column: 1, line: 12 } },
					],
					type: "if",
				},
			});

			setupFs({
				"out/shared/player.luau.cov-map.json": JSON.stringify(coverageMap),
				"out/shared/player.luau.map": '{"version":3}',
			});

			setupSourceMapMappings({
				"3:0": { column: 0, line: 2, source: "src/shared/player.ts" },
				"3:9": { column: 15, line: 2, source: "src/shared/player.ts" },
				"5:0": { column: 0, line: 4, source: "src/shared/player.ts" },
				"5:9": { column: 15, line: 4, source: "src/shared/player.ts" },
				"10:0": { column: 0, line: 8, source: "src/shared/player.ts" },
				"10:9": { column: 15, line: 8, source: "src/shared/player.ts" },
				"12:0": { column: 0, line: 10, source: "src/shared/player.ts" },
				"12:9": { column: 15, line: 10, source: "src/shared/player.ts" },
			});

			const coverageData: RawCoverageData = {
				"shared/player.luau": { b: { "1": [1, 0], "2": [0, 2] }, s: {} },
			};

			const result = mapCoverageToTypeScript(
				coverageData,
				createManifest(createManifestFiles()),
			);

			const file = result.files["src/shared/player.ts"]!;

			expect(Object.keys(file.branchMap)).toHaveLength(2);
			expect(file.b["1"]).toStrictEqual([0, 2]);
		});

		it("should default branch arm hit counts to zero when not in raw data", () => {
			expect.assertions(1);

			const coverageMap = createCoverageMap({}, undefined, {
				"1": {
					locations: [
						{ end: { column: 10, line: 3 }, start: { column: 1, line: 3 } },
						{ end: { column: 10, line: 5 }, start: { column: 1, line: 5 } },
					],
					type: "if",
				},
			});

			setupFs({
				"out/shared/player.luau.cov-map.json": JSON.stringify(coverageMap),
				"out/shared/player.luau.map": '{"version":3}',
			});

			setupSourceMapMappings({
				"3:0": { column: 0, line: 2, source: "src/shared/player.ts" },
				"3:9": { column: 15, line: 2, source: "src/shared/player.ts" },
				"5:0": { column: 0, line: 4, source: "src/shared/player.ts" },
				"5:9": { column: 15, line: 4, source: "src/shared/player.ts" },
			});

			// No "b" field in raw coverage
			const coverageData: RawCoverageData = {
				"shared/player.luau": { s: {} },
			};

			const result = mapCoverageToTypeScript(
				coverageData,
				createManifest(createManifestFiles()),
			);

			expect(result.files["src/shared/player.ts"]!.b["0"]).toStrictEqual([0, 0]);
		});

		it("should skip branch entries with invalid span in locations array", () => {
			expect.assertions(1);

			const coverageMap = createCoverageMap({}, undefined, {
				"1": {
					locations: [
						{
							notASpan: true,
						} as unknown as NonNullable<
							CoverageMap["branchMap"]
						>[string]["locations"][number],
					],
					type: "if",
				},
			});

			setupFs({
				"out/shared/player.luau.cov-map.json": JSON.stringify(coverageMap),
				"out/shared/player.luau.map": '{"version":3}',
			});

			setupSourceMapMappings({});

			const coverageData: RawCoverageData = {
				"shared/player.luau": { b: { "1": [1] }, s: {} },
			};

			const result = mapCoverageToTypeScript(
				coverageData,
				createManifest(createManifestFiles()),
			);

			expect(result.files).toBeEmptyObject();
		});

		it("should skip branch when end position has no source mapping", () => {
			expect.assertions(1);

			const coverageMap = createCoverageMap({}, undefined, {
				"1": {
					locations: [
						{ end: { column: 4, line: 9 }, start: { column: 1, line: 7 } },
						{ end: { column: 4, line: 9 }, start: { column: 1, line: 8 } },
					],
					type: "if",
				},
			});

			setupFs({
				"out/shared/player.luau.cov-map.json": JSON.stringify(coverageMap),
				"out/shared/player.luau.map": '{"version":3}',
			});

			// Only start positions have mappings; end (line 9) returns null
			setupSourceMapMappings({
				"7:0": { column: 0, line: 6, source: "src/shared/player.ts" },
				"8:0": { column: 0, line: 6, source: "src/shared/player.ts" },
			});

			const coverageData: RawCoverageData = {
				"shared/player.luau": { b: { "1": [3, 0] }, s: {} },
			};

			const result = mapCoverageToTypeScript(
				coverageData,
				createManifest(createManifestFiles()),
			);

			expect(result.files).toBeEmptyObject();
		});

		it("should skip branch entries when source map cannot resolve an arm location", () => {
			expect.assertions(1);

			const coverageMap = createCoverageMap({}, undefined, {
				"1": {
					locations: [{ end: { column: 10, line: 99 }, start: { column: 1, line: 99 } }],
					type: "if",
				},
			});

			setupFs({
				"out/shared/player.luau.cov-map.json": JSON.stringify(coverageMap),
				"out/shared/player.luau.map": '{"version":3}',
			});

			// No mappings — originalPositionFor returns null source
			setupSourceMapMappings({});

			const coverageData: RawCoverageData = {
				"shared/player.luau": { b: { "1": [1] }, s: {} },
			};

			const result = mapCoverageToTypeScript(
				coverageData,
				createManifest(createManifestFiles()),
			);

			expect(result.files).toBeEmptyObject();
		});

		it("should skip branch entries when arms map to different source files", () => {
			expect.assertions(1);

			const coverageMap = createCoverageMap({}, undefined, {
				"1": {
					locations: [
						{ end: { column: 10, line: 3 }, start: { column: 1, line: 3 } },
						{ end: { column: 10, line: 5 }, start: { column: 1, line: 5 } },
					],
					type: "if",
				},
			});

			setupFs({
				"out/shared/player.luau.cov-map.json": JSON.stringify(coverageMap),
				"out/shared/player.luau.map": '{"version":3}',
			});

			// First arm maps to a.ts, second arm maps to b.ts
			mockOriginalPositionFor.mockImplementation(
				(_map: unknown, position: { column: number; line: number }) => {
					if (position.line === 3) {
						return { name: null, column: 0, line: 2, source: "src/a.ts" };
					}

					return { name: null, column: 0, line: 4, source: "src/b.ts" };
				},
			);

			const coverageData: RawCoverageData = {
				"shared/player.luau": { b: { "1": [1, 0] }, s: {} },
			};

			const result = mapCoverageToTypeScript(
				coverageData,
				createManifest(createManifestFiles()),
			);

			expect(result.files).toBeEmptyObject();
		});

		it("should skip branch entries with empty locations array", () => {
			expect.assertions(1);

			const coverageMap = createCoverageMap({}, undefined, {
				"1": {
					locations: [],
					type: "if",
				},
			});

			setupFs({
				"out/shared/player.luau.cov-map.json": JSON.stringify(coverageMap),
				"out/shared/player.luau.map": '{"version":3}',
			});

			setupSourceMapMappings({});

			const coverageData: RawCoverageData = {
				"shared/player.luau": { b: { "1": [] }, s: {} },
			};

			const result = mapCoverageToTypeScript(
				coverageData,
				createManifest(createManifestFiles()),
			);

			expect(result.files).toBeEmptyObject();
		});

		it("should skip branch when all arm locations map to null source", () => {
			expect.assertions(1);

			const coverageMap = createCoverageMap({}, undefined, {
				"1": {
					locations: [{ end: { column: 10, line: 3 }, start: { column: 1, line: 3 } }],
					type: "if",
				},
			});

			setupFs({
				"out/shared/player.luau.cov-map.json": JSON.stringify(coverageMap),
				"out/shared/player.luau.map": '{"version":3}',
			});

			// All positions return null source — mapBranchArmLocations returns
			// undefined
			mockOriginalPositionFor.mockReturnValue({
				name: null,
				column: null,
				line: null,
				source: null,
			});

			const coverageData: RawCoverageData = {
				"shared/player.luau": { b: { "1": [1] }, s: {} },
			};

			const result = mapCoverageToTypeScript(
				coverageData,
				createManifest(createManifestFiles()),
			);

			expect(result.files).toBeEmptyObject();
		});

		it("should skip branch entries when branchEntrySchema validation fails", () => {
			expect.assertions(1);

			// branchEntrySchema requires "locations" (array) and "type" (string)
			// Providing a missing "type" field makes it invalid
			const rawCoverageMap = {
				branchMap: {
					"1": {
						locations: [
							{ end: { column: 10, line: 3 }, start: { column: 1, line: 3 } },
						],
						// "type" field intentionally omitted
					},
				},
				statementMap: {},
			};

			setupFs({
				"out/shared/player.luau.cov-map.json": JSON.stringify(rawCoverageMap),
				"out/shared/player.luau.map": '{"version":3}',
			});

			setupSourceMapMappings({
				"3:0": { column: 0, line: 2, source: "src/shared/player.ts" },
				"3:9": { column: 15, line: 2, source: "src/shared/player.ts" },
			});

			const coverageData: RawCoverageData = {
				"shared/player.luau": { b: { "1": [1] }, s: {} },
			};

			const result = mapCoverageToTypeScript(
				coverageData,
				createManifest(createManifestFiles()),
			);

			expect(result.files).toBeEmptyObject();
		});

		it("should map branch with implicit else arm using zero-width location", () => {
			expect.assertions(3);

			// Simulates an if-without-else where the instrumenter adds an
			// implicit else arm with a zero-width span at the if-keyword position
			const coverageMap = createCoverageMap({}, undefined, {
				"1": {
					locations: [
						{ end: { column: 10, line: 3 }, start: { column: 1, line: 3 } },
						{ end: { column: 1, line: 5 }, start: { column: 1, line: 5 } },
					],
					type: "if",
				},
			});

			setupFs({
				"out/shared/player.luau.cov-map.json": JSON.stringify(coverageMap),
				"out/shared/player.luau.map": '{"version":3}',
			});

			// Both arms map to the same TS source file
			setupSourceMapMappings({
				"3:0": { column: 0, line: 2, source: "src/shared/player.ts" },
				"3:9": { column: 15, line: 2, source: "src/shared/player.ts" },
				"5:0": { column: 0, line: 4, source: "src/shared/player.ts" },
			});

			const coverageData: RawCoverageData = {
				"shared/player.luau": { b: { "1": [3, 0] }, s: {} },
			};

			const result = mapCoverageToTypeScript(
				coverageData,
				createManifest(createManifestFiles()),
			);

			const file = result.files["src/shared/player.ts"]!;

			expect(file).toBeDefined();
			expect(file.b["0"]).toStrictEqual([3, 0]);
			expect(file.branchMap["0"]!.locations).toHaveLength(2);
		});
	});

	describe("with native Luau files (no source map)", () => {
		it("should report statement coverage against the original Luau path", () => {
			expect.assertions(3);

			const coverageMap = createCoverageMap({
				"0": {
					end: { column: 20, line: 3 },
					start: { column: 1, line: 1 },
				},
			});

			// Only cov-map exists — no .luau.map source map
			setupFs({
				"out/shared/player.luau.cov-map.json": JSON.stringify(coverageMap),
			});

			const coverageData: RawCoverageData = {
				"shared/player.luau": { s: { "0": 5 } },
			};

			const result = mapCoverageToTypeScript(
				coverageData,
				createManifest(createManifestFiles()),
			);

			const file = result.files["shared/player.luau"];

			expect(file).toBeDefined();
			expect(file?.s["0"]).toBe(5);
			expect(file?.statementMap["0"]).toStrictEqual({
				end: { column: 19, line: 3 },
				start: { column: 0, line: 1 },
			});
		});

		it("should passthrough function coverage for native Luau files", () => {
			expect.assertions(3);

			const coverageMap = createCoverageMap(
				{
					"0": {
						end: { column: 10, line: 1 },
						start: { column: 1, line: 1 },
					},
				},
				{
					"0": {
						name: "greet",
						location: {
							end: { column: 4, line: 5 },
							start: { column: 1, line: 3 },
						},
					},
				},
			);

			setupFs({
				"out/shared/player.luau.cov-map.json": JSON.stringify(coverageMap),
			});

			const coverageData: RawCoverageData = {
				"shared/player.luau": { f: { "0": 3 }, s: { "0": 1 } },
			};

			const result = mapCoverageToTypeScript(
				coverageData,
				createManifest(createManifestFiles()),
			);

			const file = result.files["shared/player.luau"]!;

			expect(file.fnMap["0"]?.name).toBe("greet");
			expect(file.f["0"]).toBe(3);
			expect(file.fnMap["0"]?.loc).toStrictEqual({
				end: { column: 3, line: 5 },
				start: { column: 0, line: 3 },
			});
		});

		it("should passthrough branch coverage for native Luau files", () => {
			expect.assertions(3);

			const coverageMap = createCoverageMap(
				{
					"0": {
						end: { column: 10, line: 1 },
						start: { column: 1, line: 1 },
					},
				},
				undefined,
				{
					"0": {
						locations: [
							{ end: { column: 10, line: 3 }, start: { column: 1, line: 3 } },
							{ end: { column: 10, line: 5 }, start: { column: 1, line: 5 } },
						],
						type: "if",
					},
				},
			);

			setupFs({
				"out/shared/player.luau.cov-map.json": JSON.stringify(coverageMap),
			});

			const coverageData: RawCoverageData = {
				"shared/player.luau": { b: { "0": [2, 1] }, s: { "0": 1 } },
			};

			const result = mapCoverageToTypeScript(
				coverageData,
				createManifest(createManifestFiles()),
			);

			const file = result.files["shared/player.luau"]!;

			expect(file.b["0"]).toStrictEqual([2, 1]);
			expect(file.branchMap["0"]?.type).toBe("if");
			expect(file.branchMap["0"]?.locations).toStrictEqual([
				{ end: { column: 9, line: 3 }, start: { column: 0, line: 3 } },
				{ end: { column: 9, line: 5 }, start: { column: 0, line: 5 } },
			]);
		});

		it("should skip function passthrough when functionMap is undefined", () => {
			expect.assertions(1);

			const coverageMap = createCoverageMap({
				"0": {
					end: { column: 10, line: 1 },
					start: { column: 1, line: 1 },
				},
			});

			setupFs({
				"out/shared/player.luau.cov-map.json": JSON.stringify(coverageMap),
			});

			const coverageData: RawCoverageData = {
				"shared/player.luau": { s: { "0": 1 } },
			};

			const result = mapCoverageToTypeScript(
				coverageData,
				createManifest(createManifestFiles()),
			);

			const file = result.files["shared/player.luau"]!;

			expect(file.fnMap).toBeEmptyObject();
		});

		it("should skip branch passthrough when branchMap is undefined", () => {
			expect.assertions(1);

			const coverageMap = createCoverageMap({
				"0": {
					end: { column: 10, line: 1 },
					start: { column: 1, line: 1 },
				},
			});

			setupFs({
				"out/shared/player.luau.cov-map.json": JSON.stringify(coverageMap),
			});

			const coverageData: RawCoverageData = {
				"shared/player.luau": { s: { "0": 1 } },
			};

			const result = mapCoverageToTypeScript(
				coverageData,
				createManifest(createManifestFiles()),
			);

			const file = result.files["shared/player.luau"]!;

			expect(file.branchMap).toBeEmptyObject();
		});

		it("should default function hit count to zero when not in raw data", () => {
			expect.assertions(1);

			const coverageMap = createCoverageMap(
				{
					"0": {
						end: { column: 10, line: 1 },
						start: { column: 1, line: 1 },
					},
				},
				{
					"0": {
						name: "foo",
						location: {
							end: { column: 4, line: 5 },
							start: { column: 1, line: 3 },
						},
					},
				},
			);

			setupFs({
				"out/shared/player.luau.cov-map.json": JSON.stringify(coverageMap),
			});

			const coverageData: RawCoverageData = {
				"shared/player.luau": { s: { "0": 1 } },
			};

			const result = mapCoverageToTypeScript(
				coverageData,
				createManifest(createManifestFiles()),
			);

			const file = result.files["shared/player.luau"]!;

			expect(file.f["0"]).toBe(0);
		});

		it("should default branch arm hit counts to zero when not in raw data", () => {
			expect.assertions(1);

			const coverageMap = createCoverageMap(
				{
					"0": {
						end: { column: 10, line: 1 },
						start: { column: 1, line: 1 },
					},
				},
				undefined,
				{
					"0": {
						locations: [
							{ end: { column: 10, line: 3 }, start: { column: 1, line: 3 } },
							{ end: { column: 10, line: 5 }, start: { column: 1, line: 5 } },
						],
						type: "if",
					},
				},
			);

			setupFs({
				"out/shared/player.luau.cov-map.json": JSON.stringify(coverageMap),
			});

			const coverageData: RawCoverageData = {
				"shared/player.luau": { s: { "0": 1 } },
			};

			const result = mapCoverageToTypeScript(
				coverageData,
				createManifest(createManifestFiles()),
			);

			const file = result.files["shared/player.luau"]!;

			expect(file.b["0"]).toStrictEqual([0, 0]);
		});

		it("should skip function entries with invalid schema in passthrough", () => {
			expect.assertions(1);

			const coverageMap = createCoverageMap(
				{
					"0": {
						end: { column: 10, line: 1 },
						start: { column: 1, line: 1 },
					},
				},
				{
					"0": {
						location: { end: { column: 4, line: 5 }, start: { column: 1, line: 3 } },
					} as unknown as NonNullable<CoverageMap["functionMap"]>[string],
				},
			);

			setupFs({
				"out/shared/player.luau.cov-map.json": JSON.stringify(coverageMap),
			});

			const coverageData: RawCoverageData = {
				"shared/player.luau": { f: { "0": 1 }, s: { "0": 1 } },
			};

			const result = mapCoverageToTypeScript(
				coverageData,
				createManifest(createManifestFiles()),
			);

			const file = result.files["shared/player.luau"]!;

			expect(file.fnMap).toBeEmptyObject();
		});

		it("should skip branch entries with invalid span in passthrough locations", () => {
			expect.assertions(1);

			const coverageMap = createCoverageMap(
				{
					"0": {
						end: { column: 10, line: 1 },
						start: { column: 1, line: 1 },
					},
				},
				undefined,
				{
					"0": {
						locations: [
							{
								notASpan: true,
							} as unknown as NonNullable<
								CoverageMap["branchMap"]
							>[string]["locations"][number],
						],
						type: "if",
					},
				},
			);

			setupFs({
				"out/shared/player.luau.cov-map.json": JSON.stringify(coverageMap),
			});

			const coverageData: RawCoverageData = {
				"shared/player.luau": { b: { "0": [1] }, s: { "0": 1 } },
			};

			const result = mapCoverageToTypeScript(
				coverageData,
				createManifest(createManifestFiles()),
			);

			const file = result.files["shared/player.luau"]!;

			expect(file.branchMap).toBeEmptyObject();
		});

		it("should skip branch entries with invalid branchEntrySchema in passthrough", () => {
			expect.assertions(1);

			const rawCoverageMap = {
				branchMap: {
					"0": {
						locations: [
							{ end: { column: 10, line: 3 }, start: { column: 1, line: 3 } },
						],
						// "type" field intentionally omitted
					},
				},
				statementMap: {
					"0": {
						end: { column: 10, line: 1 },
						start: { column: 1, line: 1 },
					},
				},
			};

			setupFs({
				"out/shared/player.luau.cov-map.json": JSON.stringify(rawCoverageMap),
			});

			const coverageData: RawCoverageData = {
				"shared/player.luau": { b: { "0": [1] }, s: { "0": 1 } },
			};

			const result = mapCoverageToTypeScript(
				coverageData,
				createManifest(createManifestFiles()),
			);

			const file = result.files["shared/player.luau"]!;

			expect(file.branchMap).toBeEmptyObject();
		});

		it("should default statement hit count to zero when ID is absent from raw data", () => {
			expect.assertions(1);

			const coverageMap = createCoverageMap({
				"0": {
					end: { column: 20, line: 3 },
					start: { column: 1, line: 1 },
				},
			});

			setupFs({
				"out/shared/player.luau.cov-map.json": JSON.stringify(coverageMap),
			});

			// Statement "0" is not in the s record
			const coverageData: RawCoverageData = {
				"shared/player.luau": { s: {} },
			};

			const result = mapCoverageToTypeScript(
				coverageData,
				createManifest(createManifestFiles()),
			);

			const file = result.files["shared/player.luau"]!;

			expect(file.s["0"]).toBe(0);
		});

		it("should merge coverage from duplicate keys into existing pending entries", () => {
			expect.assertions(3);

			const coverageMap = createCoverageMap(
				{
					"0": {
						end: { column: 10, line: 1 },
						start: { column: 1, line: 1 },
					},
				},
				{
					"0": {
						name: "greet",
						location: {
							end: { column: 4, line: 5 },
							start: { column: 1, line: 3 },
						},
					},
				},
				{
					"0": {
						locations: [
							{ end: { column: 10, line: 7 }, start: { column: 1, line: 7 } },
							{ end: { column: 10, line: 9 }, start: { column: 1, line: 9 } },
						],
						type: "if",
					},
				},
			);

			setupFs({
				"out/shared/player.luau.cov-map.json": JSON.stringify(coverageMap),
			});

			// Create manifest with two different keys pointing to the same file
			const baseFile = createManifestFiles()["shared/player.luau"];
			const manifest = createManifest({
				"shared/player-alias.luau": {
					...baseFile,
					key: baseFile.key,
				},
				"shared/player.luau": baseFile,
			});

			// Process both entries — second hits "already initialized" branches
			const combinedCoverage: RawCoverageData = {
				"shared/player-alias.luau": {
					b: { "0": [0, 1] },
					f: { "0": 1 },
					s: { "0": 2 },
				},
				"shared/player.luau": {
					b: { "0": [1, 0] },
					f: { "0": 2 },
					s: { "0": 3 },
				},
			};

			const result = mapCoverageToTypeScript(combinedCoverage, manifest);

			const file = result.files["shared/player.luau"]!;

			// Both entries contributed — second hit the "already initialized"
			// branch
			expect(file).toBeDefined();
			expect(Object.keys(file.fnMap)).not.toBeEmpty();
			expect(Object.keys(file.branchMap)).not.toBeEmpty();
		});

		it("should skip statement entries with invalid span in passthrough", () => {
			expect.assertions(1);

			const coverageMap = createCoverageMap({
				"0": { notASpan: true } as unknown as CoverageMap["statementMap"][string],
				"1": {
					end: { column: 20, line: 5 },
					start: { column: 1, line: 5 },
				},
			});

			setupFs({
				"out/shared/player.luau.cov-map.json": JSON.stringify(coverageMap),
			});

			const coverageData: RawCoverageData = {
				"shared/player.luau": { s: { "0": 9, "1": 2 } },
			};

			const result = mapCoverageToTypeScript(
				coverageData,
				createManifest({
					...createManifestFiles(),
					"shared/player.luau": {
						...createManifestFiles()["shared/player.luau"],
						statementCount: 2,
					},
				}),
			);

			const file = result.files["shared/player.luau"]!;

			// Only valid statement "1" should be included
			expect(Object.keys(file.statementMap)).toHaveLength(1);
		});
	});
});
