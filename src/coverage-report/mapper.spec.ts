import { createMemoryFileSystem } from "@isentinel/dev-vitest-utils";
import { fromAny, fromPartial } from "@total-typescript/shoehorn";

import { describe, it, type TestContext } from "vitest";

import { createCoverageMap, span } from "#test/helpers/unit/coverage-spec-mapper.ts";
import type { CoverageMapFile, FileLocation } from "#test/helpers/unit/coverage-spec-mapper.ts";
import { MANIFEST_VERSION } from "#test/helpers/unit/coverage-versions.ts";
import { buildSourceMap } from "#test/helpers/unit/source-map.ts";
import type { RawCoverageData } from "../coverage-data/coverage-types.ts";
import type { CoverageManifest } from "../coverage-data/manifest.ts";
import type { FileSystem } from "../utils/file-system.ts";
import type { PositionResolver } from "./mapper-types.ts";
import { mapCoverageToTypeScript } from "./mapper.ts";

type GeneratedPosition = Parameters<PositionResolver>[0];
type OriginalPosition = ReturnType<PositionResolver>;

function positionSplitByColumn(position: GeneratedPosition): OriginalPosition {
	return position.column === 0
		? { column: 0, line: 3, source: "src/a.ts" }
		: { column: 25, line: 3, source: "src/b.ts" };
}

function positionSplitByLine(position: GeneratedPosition): OriginalPosition {
	return position.line === 3
		? { column: 0, line: 2, source: "src/a.ts" }
		: { column: 0, line: 4, source: "src/b.ts" };
}

function resolverWithoutEndpoint(unmappedEndpoint: "end" | "start"): PositionResolver {
	return (position) => {
		const isStart = position.column === 0;
		if ((unmappedEndpoint === "start") === isStart) {
			return { column: null, line: null, source: null };
		}

		return playerTs(3, 5);
	};
}

function createManifest(files: CoverageManifest["files"] = {}): CoverageManifest {
	return {
		buildId: "test-build-id",
		files,
		generatedAt: "2026-01-01T00:00:00.000Z",
		instrumenterVersion: 1,
		luauRoots: ["out"],
		nonInstrumentedFiles: {},
		shadowDir: ".jest-roblox/coverage/out",
		version: MANIFEST_VERSION,
	};
}

function setupFs(fileContents: Record<string, string>): FileSystem {
	return createMemoryFileSystem(fileContents).fileSystem;
}

function resolverFromMappings(
	mappings: Record<string, { column: number; line: number; source: string }>,
): PositionResolver {
	return (position) => {
		const key = `${String(position.line)}:${String(position.column)}`;
		const mapping = mappings[key];
		if (mapping === undefined) {
			return { column: null, line: null, source: null };
		}

		return {
			column: mapping.column,
			line: mapping.line,
			source: mapping.source,
		};
	};
}

function createManifestFiles(statementCount: number) {
	return {
		"shared/player.luau": {
			key: "shared/player.luau",
			coverageMapPath: "out/shared/player.luau.cov-map.json",
			instrumentedLuauPath: ".jest-roblox/coverage/out/shared/player.luau",
			originalLuauPath: "out/shared/player.luau",
			sourceHash: "abc123",
			sourceMapPath: "out/shared/player.luau.map",
			statementCount,
		},
	};
}

const PLAYER_LINE_5 = {
	"5:0": playerTs(3, 0),
	"5:19": playerTs(3, 25),
};

function playerTs(line: number, column: number): { column: number; line: number; source: string } {
	return { column, line, source: "src/shared/player.ts" };
}

function malformedSidecar(
	expect: TestContext["expect"],
): ReturnType<typeof expect.objectContaining> {
	return expect.objectContaining<Record<string, unknown>>({
		coverageMapPath: expect.any(String),
		message: expect.stringContaining("is malformed or invalid"),
	});
}

function functionLocation(): FileLocation {
	return { end: { column: 4, line: 8 }, start: { column: 1, line: 5 } };
}

function playerFs(coverageMap: CoverageMapFile): FileSystem {
	return setupFs({
		"out/shared/player.luau.cov-map.json": JSON.stringify(coverageMap),
		"out/shared/player.luau.map": '{"version":3}',
	});
}

function mapPlayer({
	coverageData,
	fileSystem,
	resolvePosition = resolverFromMappings({}),
	statementCount = 1,
}: {
	coverageData: RawCoverageData;
	fileSystem: FileSystem;
	resolvePosition?: PositionResolver;
	statementCount?: number;
}): ReturnType<typeof mapCoverageToTypeScript> {
	return mapCoverageToTypeScript({
		coverageData,
		fileSystem,
		manifest: createManifest(createManifestFiles(statementCount)),
		traceMapFactory: () => resolvePosition,
	});
}

function mergedStatementEnd({
	coverageMap,
	mappings,
}: {
	coverageMap: CoverageMapFile;
	mappings: Parameters<typeof resolverFromMappings>[0];
}): unknown {
	const result = mapPlayer({
		coverageData: { "shared/player.luau": { s: { "0": 1, "1": 1 } } },
		fileSystem: playerFs(coverageMap),
		resolvePosition: resolverFromMappings(mappings),
		statementCount: 2,
	});

	return result.files["src/shared/player.ts"]!.statementMap["0"]!.end;
}

function mapPlayerBranch({
	hits,
	locations,
	resolvePosition,
}: {
	hits: Array<number> | undefined;
	locations: Array<FileLocation>;
	resolvePosition: PositionResolver;
}): ReturnType<typeof mapCoverageToTypeScript> {
	const coverageMap = createCoverageMap({}, { branchMap: { "1": { locations, type: "if" } } });

	return mapPlayer({
		coverageData: {
			"shared/player.luau": hits === undefined ? { s: {} } : { b: { "1": hits }, s: {} },
		},
		fileSystem: playerFs(coverageMap),
		resolvePosition,
	});
}

describe(mapCoverageToTypeScript, () => {
	describe("with a single mapped statement", () => {
		it("should map Luau statement to TypeScript location", ({ expect }) => {
			expect.assertions(4);

			const coverageMap = createCoverageMap({
				"0": span(5, 1, 20),
			});

			const fileSystem = playerFs(coverageMap);

			const resolvePosition = resolverFromMappings({
				...PLAYER_LINE_5,
			});

			const coverageData: RawCoverageData = {
				"shared/player.luau": { s: { "0": 3 } },
			};

			const result = mapPlayer({ coverageData, fileSystem, resolvePosition });

			expect(result.files["src/shared/player.ts"]).toBeDefined();

			const file = result.files["src/shared/player.ts"];

			expect(file!.path).toBe("src/shared/player.ts");
			expect(file!.statementMap["0"]).toStrictEqual(span(3, 0, 25));
			expect(file!.s["0"]).toBe(3);
		});
	});

	describe("with no injected trace-map factory", () => {
		it("should resolve positions through the real source map on disk", ({ expect }) => {
			expect.assertions(2);

			const coverageMap = createCoverageMap({
				"0": span(5, 1, 20),
			});

			const fileSystem = setupFs({
				"out/shared/player.luau.cov-map.json": JSON.stringify(coverageMap),
				"out/shared/player.luau.map": buildSourceMap({
					file: "player.luau",
					segments: [
						{ generatedColumn: 0, generatedLine: 5, sourceColumn: 0, sourceLine: 3 },
						{ generatedColumn: 19, generatedLine: 5, sourceColumn: 25, sourceLine: 3 },
					],
					source: "src/shared/player.ts",
				}),
			});

			const result = mapCoverageToTypeScript({
				coverageData: { "shared/player.luau": { s: { "0": 3 } } },
				fileSystem,
				manifest: createManifest(createManifestFiles(1)),
			});

			const file = result.files["src/shared/player.ts"];

			expect(file!.statementMap["0"]).toStrictEqual(span(3, 0, 25));
			expect(file!.s["0"]).toBe(3);
		});

		it("should throw when the source map does not parse", ({ expect }) => {
			expect.assertions(1);

			const fileSystem = setupFs({
				"out/shared/player.luau.cov-map.json": JSON.stringify(
					createCoverageMap({ "0": span(5, 1, 20) }),
				),
				"out/shared/player.luau.map": "not a source map",
			});

			expect(() => {
				mapCoverageToTypeScript({
					coverageData: { "shared/player.luau": { s: { "0": 3 } } },
					fileSystem,
					manifest: createManifest(createManifestFiles(1)),
				});
			}).toThrow(
				expect.objectContaining<Record<string, unknown>>({
					cause: expect.any(SyntaxError),
					message:
						"Source map at out/shared/player.luau.map is malformed (re-run with `--coverage`)",
				}),
			);
		});
	});

	describe("with source-map-relative paths", () => {
		it("should resolve ../  paths relative to source map location", ({ expect }) => {
			expect.assertions(2);

			// roblox-ts source maps produce paths relative to the .lua.map file,
			// e.g., ../../../packages/src/player.ts from
			// out/packages/src/player.lua.map. The mapper should resolve these to
			// cwd-relative paths so that collectCoverageFrom glob patterns can
			// match them.
			const coverageMap = createCoverageMap({
				"0": span(5, 1, 20),
			});

			const fileSystem = setupFs({
				"out/packages/src/player.luau.cov-map.json": JSON.stringify(coverageMap),
				"out/packages/src/player.luau.map": '{"version":3}',
			});

			const resolvePosition = resolverFromMappings({
				"5:0": { column: 0, line: 3, source: "../../../packages/src/player.ts" },
				"5:19": { column: 25, line: 3, source: "../../../packages/src/player.ts" },
			});

			const manifest = createManifest({
				"out/packages/src/player.luau": {
					key: "out/packages/src/player.luau",
					coverageMapPath: "out/packages/src/player.luau.cov-map.json",
					instrumentedLuauPath: ".jest-roblox/coverage/out/packages/src/player.luau",
					originalLuauPath: "out/packages/src/player.luau",
					sourceHash: "abc123",
					sourceMapPath: "out/packages/src/player.luau.map",
					statementCount: 1,
				},
			});

			const coverageData: RawCoverageData = {
				"out/packages/src/player.luau": { s: { "0": 3 } },
			};

			const result = mapCoverageToTypeScript({
				coverageData,
				fileSystem,
				manifest,
				traceMapFactory: () => resolvePosition,
			});

			// Should resolve to cwd-relative path, not raw source map relative
			// path
			expect(result.files["packages/src/player.ts"]).toBeDefined();
			expect(result.files["../../../packages/src/player.ts"]).toBeUndefined();
		});

		it("should normalize Windows backslash paths from source maps", ({ expect }) => {
			expect.assertions(2);

			// roblox-ts on Windows produces source maps with backslash paths
			// like ..\\src\\player.ts instead of ../src/player.ts
			const coverageMap = createCoverageMap({
				"0": span(5, 1, 20),
			});

			const fileSystem = setupFs({
				"out/player.luau.cov-map.json": JSON.stringify(coverageMap),
				"out/player.luau.map": '{"version":3}',
			});

			const resolvePosition = resolverFromMappings({
				"5:0": { column: 0, line: 3, source: "..\\src\\player.ts" },
				"5:19": { column: 25, line: 3, source: "..\\src\\player.ts" },
			});

			const manifest = createManifest({
				"out/player.luau": {
					key: "out/player.luau",
					coverageMapPath: "out/player.luau.cov-map.json",
					instrumentedLuauPath: ".jest-roblox/coverage/out/player.luau",
					originalLuauPath: "out/player.luau",
					sourceHash: "abc123",
					sourceMapPath: "out/player.luau.map",
					statementCount: 1,
				},
			});

			const coverageData: RawCoverageData = {
				"out/player.luau": { s: { "0": 3 } },
			};

			const result = mapCoverageToTypeScript({
				coverageData,
				fileSystem,
				manifest,
				traceMapFactory: () => resolvePosition,
			});

			expect(result.files["src/player.ts"]).toBeDefined();
			expect(result.files["..\\src\\player.ts"]).toBeUndefined();
		});
	});

	describe("with unmapped statements", () => {
		it("should skip statements that have no source map mapping", ({ expect }) => {
			expect.assertions(2);

			const coverageMap = createCoverageMap({
				"0": span(1, 1, 10),
				"1": span(5, 1, 20),
			});

			const fileSystem = playerFs(coverageMap);

			const resolvePosition = resolverFromMappings({
				...PLAYER_LINE_5,
			});

			const coverageData: RawCoverageData = {
				"shared/player.luau": { s: { "0": 1, "1": 5 } },
			};

			const result = mapPlayer({
				coverageData,
				fileSystem,
				resolvePosition,
				statementCount: 2,
			});

			const file = result.files["src/shared/player.ts"];

			expect(Object.keys(file!.statementMap)).toHaveLength(1);
			expect(file!.s["0"]).toBe(5);
		});
	});

	describe("with duplicate TS spans", () => {
		it("should coalesce multiple Luau statements mapping to same TS location", ({ expect }) => {
			expect.assertions(3);

			const coverageMap = createCoverageMap({
				"0": span(3, 1, 15),
				"1": span(7, 1, 20),
			});

			const fileSystem = playerFs(coverageMap);

			const resolvePosition = resolverFromMappings({
				"3:0": playerTs(2, 0),
				"3:14": playerTs(2, 20),
				"7:0": playerTs(2, 0),
				"7:19": playerTs(2, 25),
			});

			const coverageData: RawCoverageData = {
				"shared/player.luau": { s: { "0": 3, "1": 7 } },
			};

			const result = mapPlayer({
				coverageData,
				fileSystem,
				resolvePosition,
				statementCount: 2,
			});

			const file = result.files["src/shared/player.ts"];

			expect(Object.keys(file!.statementMap)).toHaveLength(1);
			expect(file!.s["0"]).toBe(10);
			expect(file!.statementMap["0"]).toStrictEqual(span(2, 0, 25));
		});

		it("should keep existing end when it has higher column on the same line", ({ expect }) => {
			expect.assertions(1);

			// Two Luau stmts map to same TS start, same end line
			// First has HIGHER end column than second → existing end is kept
			const coverageMap = createCoverageMap({
				"0": span(3, 1, 20),
				"1": span(7, 1, 10),
			});

			const end = mergedStatementEnd({
				coverageMap,
				mappings: {
					"3:0": playerTs(2, 0),
					"3:19": playerTs(2, 25),
					"7:0": playerTs(2, 0),
					"7:9": playerTs(2, 5),
				},
			});

			// First stmt end col 25 > second stmt end col 5, same line →
			// existing wins
			expect(end).toStrictEqual({ column: 25, line: 2 });
		});
	});

	describe("with missing statement hit count", () => {
		it("should default hit count to zero when statement ID is absent from raw data", ({
			expect,
		}) => {
			expect.assertions(1);

			const coverageMap = createCoverageMap({
				"0": span(5, 1, 20),
			});

			const fileSystem = playerFs(coverageMap);

			const resolvePosition = resolverFromMappings({
				...PLAYER_LINE_5,
			});

			// Statement "0" is not in the s record
			const coverageData: RawCoverageData = {
				"shared/player.luau": { s: {} },
			};

			const result = mapPlayer({ coverageData, fileSystem, resolvePosition });

			const file = result.files["src/shared/player.ts"];

			expect(file!.s["0"]).toBe(0);
		});
	});

	describe("with empty coverage data", () => {
		it("should return empty result for no coverage entries", ({ expect }) => {
			expect.assertions(1);

			const { fileSystem } = createMemoryFileSystem();

			const result = mapCoverageToTypeScript({
				coverageData: {},
				fileSystem,
				manifest: createManifest(),
				traceMapFactory: () => resolverFromMappings({}),
			});

			expect(result.files).toBeEmptyObject();
		});
	});

	describe("with an instrumented file that has no coverage data", () => {
		it("should report the untested file with zero hits", ({ expect }) => {
			expect.assertions(2);

			const coverageMap = createCoverageMap({
				"0": span(5, 1, 20),
			});

			const fileSystem = playerFs(coverageMap);

			const resolvePosition = resolverFromMappings({
				...PLAYER_LINE_5,
			});

			// Instrumented (in the manifest) but never required by a test, so it
			// is absent from the runtime hit map.
			const result = mapPlayer({ coverageData: {}, fileSystem, resolvePosition });

			const file = result.files["src/shared/player.ts"];

			expect(file).toBeDefined();
			expect(file!.s["0"]).toBe(0);
		});
	});

	describe("with unreadable coverage map", () => {
		it("should skip files when coverage map is missing on disk", ({ expect }) => {
			expect.assertions(1);

			const { fileSystem } = createMemoryFileSystem();

			const result = mapPlayer({
				coverageData: { "shared/player.luau": { s: { "0": 1 } } },
				fileSystem,
			});

			expect(result.files).toBeEmptyObject();
		});

		it("should throw CoverageMapMalformedError when coverage map file exists but is malformed", ({
			expect,
		}) => {
			expect.assertions(3);

			const fileSystem = setupFs({
				"out/shared/player.luau.cov-map.json": "not valid json",
			});

			let thrown: unknown;
			try {
				mapPlayer({
					coverageData: { "shared/player.luau": { s: { "0": 1 } } },
					fileSystem,
				});
			} catch (err) {
				thrown = err;
			}

			expect(thrown).toHaveProperty("coverageMapPath", expect.any(String));
			expect(thrown).toHaveProperty(
				"message",
				expect.stringContaining("re-run with `--coverage`"),
			);
			expect(thrown).toMatchObject({
				coverageMapPath: "out/shared/player.luau.cov-map.json",
			});
		});

		it("should rethrow a source map read failure other than a missing file", ({ expect }) => {
			expect.assertions(1);

			const fileSystem = setupFs({
				"out/shared/player.luau.cov-map.json": JSON.stringify(
					createCoverageMap({ "0": span(5, 1, 20) }),
				),
				"out/shared/player.luau.map/nested.json": "{}",
			});

			expect(() => {
				mapPlayer({
					coverageData: { "shared/player.luau": { s: { "0": 1 } } },
					fileSystem,
				});
			}).toThrow(expect.objectContaining({ code: "EISDIR" }));
		});
	});

	describe("with start and end mapping to different sources", () => {
		it("should drop statements where start and end map to different TS files", ({ expect }) => {
			expect.assertions(1);

			const coverageMap = createCoverageMap({
				"0": span(5, 1, 20),
			});

			const fileSystem = playerFs(coverageMap);

			const resolvePosition = positionSplitByColumn;

			const result = mapPlayer({
				coverageData: { "shared/player.luau": { s: { "0": 1 } } },
				fileSystem,
				resolvePosition,
			});

			expect(result.files).toBeEmptyObject();
		});

		it.for(["start", "end"] as const)(
			"should drop a statement when its %s endpoint has no source",
			(unmappedEndpoint, { expect }) => {
				expect.assertions(1);

				const coverageMap = createCoverageMap({
					"0": span(5, 1, 20),
				});
				const fileSystem = playerFs(coverageMap);
				const resolvePosition = resolverWithoutEndpoint(unmappedEndpoint);

				const result = mapPlayer({
					coverageData: { "shared/player.luau": { s: { "0": 1 } } },
					fileSystem,
					resolvePosition,
				});

				expect(result.files).toBeEmptyObject();
			},
		);
	});

	describe("with missing manifest record", () => {
		it("should skip files not in manifest", ({ expect }) => {
			expect.assertions(1);

			const coverageData: RawCoverageData = {
				"shared/unknown.luau": { s: { "0": 1 } },
			};

			const { fileSystem } = createMemoryFileSystem();

			const result = mapCoverageToTypeScript({
				coverageData,
				fileSystem,
				manifest: createManifest(),
				traceMapFactory: () => resolverFromMappings({}),
			});

			expect(result.files).toBeEmptyObject();
		});
	});

	describe("with function coverage", () => {
		it("should map Luau function to TypeScript location", ({ expect }) => {
			expect.assertions(4);

			const coverageMap: CoverageMapFile = {
				functionMap: {
					"1": {
						name: "greet",
						location: functionLocation(),
					},
				},
				statementMap: {},
			};

			const fileSystem = playerFs(coverageMap);

			const resolvePosition = resolverFromMappings({
				"5:0": playerTs(3, 0),
				"8:3": playerTs(6, 10),
			});

			const coverageData: RawCoverageData = {
				"shared/player.luau": { f: { "1": 7 }, s: {} },
			};

			const result = mapPlayer({ coverageData, fileSystem, resolvePosition });

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

		it("should default function hit count to zero when not in raw data", ({ expect }) => {
			expect.assertions(1);

			const coverageMap: CoverageMapFile = {
				functionMap: {
					"1": {
						name: "foo",
						location: functionLocation(),
					},
				},
				statementMap: {},
			};

			const fileSystem = playerFs(coverageMap);

			const resolvePosition = resolverFromMappings({
				"5:0": playerTs(3, 0),
				"8:3": playerTs(6, 10),
			});

			const coverageData: RawCoverageData = {
				"shared/player.luau": { s: {} },
			};

			const result = mapPlayer({ coverageData, fileSystem, resolvePosition });

			const file = result.files["src/shared/player.ts"]!;

			expect(file.f["0"]).toBe(0);
		});

		it("should map multiple functions to the same TypeScript file", ({ expect }) => {
			expect.assertions(2);

			const coverageMap: CoverageMapFile = {
				functionMap: {
					"1": {
						name: "greet",
						location: functionLocation(),
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

			const fileSystem = playerFs(coverageMap);

			const resolvePosition = resolverFromMappings({
				"5:0": playerTs(3, 0),
				"8:3": playerTs(6, 10),
				"12:0": playerTs(10, 0),
				"15:3": playerTs(13, 10),
			});

			const coverageData: RawCoverageData = {
				"shared/player.luau": { f: { "1": 2, "2": 5 }, s: {} },
			};

			const result = mapPlayer({ coverageData, fileSystem, resolvePosition });

			const file = result.files["src/shared/player.ts"]!;

			expect(Object.keys(file.fnMap)).toHaveLength(2);
			expect(file.f["1"]).toBe(5);
		});

		it("should throw when a functionMap entry fails schema validation", ({ expect }) => {
			expect.assertions(1);

			// "1" is missing required "name" field; whole-sidecar schema fails.
			const coverageMap = createCoverageMap(
				{},
				{
					functionMap: {
						"1": fromPartial({
							location: functionLocation(),
						}),
					},
				},
			);

			const fileSystem = playerFs(coverageMap);

			const coverageData: RawCoverageData = {
				"shared/player.luau": { f: { "1": 5 }, s: {} },
			};

			expect(() => {
				mapPlayer({ coverageData, fileSystem });
			}).toThrow(malformedSidecar(expect));
		});

		it("should drop unmapped function when no statements provide a fallback path", ({
			expect,
		}) => {
			expect.assertions(1);

			const coverageMap: CoverageMapFile = {
				functionMap: {
					"1": {
						name: "add",
						location: functionLocation(),
					},
				},
				statementMap: {},
			};

			const fileSystem = playerFs(coverageMap);

			// Only start has a mapping; end (line 8) returns null source,
			// so function can't be mapped, and no statements resolved a
			// TS path to fall back to
			const resolvePosition = resolverFromMappings({
				"5:0": playerTs(3, 0),
			});

			const coverageData: RawCoverageData = {
				"shared/player.luau": { f: { "1": 4 }, s: {} },
			};

			const result = mapPlayer({ coverageData, fileSystem, resolvePosition });

			expect(result.files).toBeEmptyObject();
		});

		it("should include unmapped function with line-1 synthetic location when statements resolve a TS path", ({
			expect,
		}) => {
			expect.assertions(4);

			const coverageMap = createCoverageMap(
				{
					"0": span(5, 1, 20),
				},
				{
					functionMap: {
						"1": {
							name: "unmappable",
							location: span(99, 1, 4),
						},
					},
				},
			);

			const fileSystem = playerFs(coverageMap);

			// Statement maps, but function location (line 99) does not
			const resolvePosition = resolverFromMappings({
				...PLAYER_LINE_5,
			});

			const coverageData: RawCoverageData = {
				"shared/player.luau": { f: { "1": 0 }, s: { "0": 1 } },
			};

			const result = mapPlayer({ coverageData, fileSystem, resolvePosition });

			const file = result.files["src/shared/player.ts"]!;

			expect(file).toBeDefined();
			expect(file.f["0"]).toBe(0);
			expect(file.fnMap["0"]!.name).toBe("unmappable");
			expect(file.fnMap["0"]!.loc).toStrictEqual(span(1, 0, 0));
		});

		it("should append unmapped function alongside mapped function in same file", ({
			expect,
		}) => {
			expect.assertions(3);

			const coverageMap = createCoverageMap(
				{
					"0": span(5, 1, 20),
				},
				{
					functionMap: {
						"1": {
							name: "mapped",
							location: functionLocation(),
						},
						"2": {
							name: "unmapped",
							location: span(99, 1, 4),
						},
					},
				},
			);

			const fileSystem = playerFs(coverageMap);

			const resolvePosition = resolverFromMappings({
				...PLAYER_LINE_5,
				"8:3": playerTs(6, 10),
			});

			const coverageData: RawCoverageData = {
				"shared/player.luau": { f: { "1": 5, "2": 0 }, s: { "0": 1 } },
			};

			const result = mapPlayer({ coverageData, fileSystem, resolvePosition });

			const file = result.files["src/shared/player.ts"]!;

			expect(Object.keys(file.fnMap)).toHaveLength(2);
			expect(file.f["0"]).toBe(5);
			expect(file.f["1"]).toBe(0);
		});

		it("should assign unmapped function to first resolved TS path when statements map to multiple files", ({
			expect,
		}) => {
			expect.assertions(1);

			const coverageMap = createCoverageMap(
				{
					"0": span(5, 1, 20),
					"1": span(10, 1, 20),
				},
				{
					functionMap: {
						"1": {
							name: "unmappable",
							location: span(99, 1, 4),
						},
					},
				},
			);

			const fileSystem = playerFs(coverageMap);

			// Statements map to two different TS files
			const resolvePosition = resolverFromMappings({
				"5:0": { column: 0, line: 3, source: "src/shared/a.ts" },
				"5:19": { column: 25, line: 3, source: "src/shared/a.ts" },
				"10:0": { column: 0, line: 3, source: "src/shared/b.ts" },
				"10:19": { column: 25, line: 3, source: "src/shared/b.ts" },
			});

			const coverageData: RawCoverageData = {
				"shared/player.luau": { f: { "1": 0 }, s: { "0": 1, "1": 1 } },
			};

			const result = mapPlayer({ coverageData, fileSystem, resolvePosition });

			// Function lands in one of the two TS files (first resolved)
			const aFile = result.files["src/shared/a.ts"];
			const bFile = result.files["src/shared/b.ts"];
			const funcInA = Object.keys(aFile!.fnMap).length;
			const funcInB = Object.keys(bFile!.fnMap).length;

			expect(funcInA + funcInB).toBe(1);
		});

		it("should drop unmapped function when no statements resolve a TS path", ({ expect }) => {
			expect.assertions(1);

			const coverageMap = createCoverageMap(
				{},
				{
					functionMap: {
						"1": {
							name: "unmappable",
							location: span(99, 1, 4),
						},
					},
				},
			);

			const fileSystem = playerFs(coverageMap);

			// No mappings at all; no TS path can be inferred
			const resolvePosition = resolverFromMappings({});

			const coverageData: RawCoverageData = {
				"shared/player.luau": { f: { "1": 3 }, s: {} },
			};

			const result = mapPlayer({ coverageData, fileSystem, resolvePosition });

			expect(result.files).toBeEmptyObject();
		});
	});

	describe("with invalid coverage map schema", () => {
		it("should throw when coverage map fails top-level schema validation", ({ expect }) => {
			expect.assertions(1);

			// Missing required "statementMap" field
			const fileSystem = setupFs({
				"out/shared/player.luau.cov-map.json": JSON.stringify({ invalid: true }),
				"out/shared/player.luau.map": '{"version":3}',
			});

			const coverageData: RawCoverageData = {
				"shared/player.luau": { s: { "0": 1 } },
			};

			expect(() => {
				mapPlayer({ coverageData, fileSystem });
			}).toThrow(malformedSidecar(expect));
		});
	});

	describe("with coalescence across different lines", () => {
		it("should pick the later end position when coalescing statements on different lines", ({
			expect,
		}) => {
			expect.assertions(2);

			// Two Luau statements map to the same TS start but different end
			// lines
			const coverageMap = createCoverageMap({
				"0": span(3, 1, 15),
				"1": span(7, 1, 10),
			});

			const fileSystem = playerFs(coverageMap);

			// Both map to the same TS start (line 2, col 0) but different ends
			const resolvePosition = resolverFromMappings({
				"3:0": playerTs(2, 0),
				"3:14": playerTs(3, 10),
				"7:0": playerTs(2, 0),
				"7:9": playerTs(5, 5),
			});

			const coverageData: RawCoverageData = {
				"shared/player.luau": { s: { "0": 2, "1": 4 } },
			};

			const result = mapPlayer({
				coverageData,
				fileSystem,
				resolvePosition,
				statementCount: 2,
			});

			const file = result.files["src/shared/player.ts"];

			// Coalesced: hit count summed, end is the later position (line 5 >
			// line 3)
			expect(file!.s["0"]).toBe(6);
			expect(file!.statementMap["0"]!.end).toStrictEqual({ column: 5, line: 5 });
		});

		it("should pick the earlier end position's line when first statement ends later", ({
			expect,
		}) => {
			expect.assertions(1);

			const coverageMap = createCoverageMap({
				"0": {
					end: { column: 15, line: 7 },
					start: { column: 1, line: 3 },
				},
				"1": span(5, 1, 10),
			});

			// Both map to the same TS start but first ends on a later line
			const end = mergedStatementEnd({
				coverageMap,
				mappings: {
					"3:0": playerTs(2, 0),
					"5:0": playerTs(2, 0),
					"5:9": playerTs(3, 5),
					"7:14": playerTs(6, 10),
				},
			});

			// First statement's end (line 6) > second's end (line 3), so line 6
			// wins
			expect(end).toStrictEqual({ column: 10, line: 6 });
		});
	});

	describe("with branch coverage", () => {
		it("should map branch arms to TypeScript locations", ({ expect }) => {
			expect.assertions(5);

			const coverageMap = createCoverageMap(
				{},
				{
					branchMap: {
						"1": {
							locations: [span(3, 4, 10), span(5, 1, 10), span(7, 1, 10)],
							type: "if",
						},
					},
				},
			);

			const fileSystem = playerFs(coverageMap);

			const resolvePosition = resolverFromMappings({
				"3:3": playerTs(2, 2),
				"3:9": playerTs(2, 15),
				"5:0": playerTs(4, 0),
				"5:9": playerTs(4, 15),
				"7:0": playerTs(6, 0),
				"7:9": playerTs(6, 15),
			});

			const coverageData: RawCoverageData = {
				"shared/player.luau": { b: { "1": [3, 0, 2] }, s: {} },
			};

			const result = mapPlayer({ coverageData, fileSystem, resolvePosition });

			const file = result.files["src/shared/player.ts"]!;

			expect(file).toBeDefined();
			expect(file.branchMap["0"]).toStrictEqual({
				loc: { end: { column: 15, line: 6 }, start: { column: 2, line: 2 } },
				locations: [span(2, 2, 15), span(4, 0, 15), span(6, 0, 15)],
				type: "if",
			});
			expect(file.b["0"]).toStrictEqual([3, 0, 2]);
			expect(Object.keys(file.branchMap)).toHaveLength(1);
			expect(Object.keys(file.b)).toHaveLength(1);
		});

		it("should map multiple branches to the same TypeScript file", ({ expect }) => {
			expect.assertions(2);

			const coverageMap = createCoverageMap(
				{},
				{
					branchMap: {
						"1": {
							locations: [span(3, 1, 10), span(5, 1, 10)],
							type: "if",
						},
						"2": {
							locations: [span(10, 1, 10), span(12, 1, 10)],
							type: "if",
						},
					},
				},
			);

			const fileSystem = playerFs(coverageMap);

			const resolvePosition = resolverFromMappings({
				"3:0": playerTs(2, 0),
				"3:9": playerTs(2, 15),
				"5:0": playerTs(4, 0),
				"5:9": playerTs(4, 15),
				"10:0": playerTs(8, 0),
				"10:9": playerTs(8, 15),
				"12:0": playerTs(10, 0),
				"12:9": playerTs(10, 15),
			});

			const coverageData: RawCoverageData = {
				"shared/player.luau": { b: { "1": [1, 0], "2": [0, 2] }, s: {} },
			};

			const result = mapPlayer({ coverageData, fileSystem, resolvePosition });

			const file = result.files["src/shared/player.ts"]!;

			expect(Object.keys(file.branchMap)).toHaveLength(2);
			expect(file.b["1"]).toStrictEqual([0, 2]);
		});

		it("should default branch arm hit counts to zero when not in raw data", ({ expect }) => {
			expect.assertions(1);

			// No "b" field in raw coverage
			const result = mapPlayerBranch({
				hits: undefined,
				locations: [span(3, 1, 10), span(5, 1, 10)],
				resolvePosition: resolverFromMappings({
					"3:0": playerTs(2, 0),
					"3:9": playerTs(2, 15),
					"5:0": playerTs(4, 0),
					"5:9": playerTs(4, 15),
				}),
			});

			expect(result.files["src/shared/player.ts"]!.b["0"]).toStrictEqual([0, 0]);
		});

		it("should throw when a branch arm span fails schema validation", ({ expect }) => {
			expect.assertions(1);

			const coverageMap = createCoverageMap(
				{},
				{
					branchMap: {
						"1": {
							locations: [fromAny({ notASpan: true })],
							type: "if",
						},
					},
				},
			);

			const fileSystem = playerFs(coverageMap);

			const coverageData: RawCoverageData = {
				"shared/player.luau": { b: { "1": [1] }, s: {} },
			};

			expect(() => {
				mapPlayer({ coverageData, fileSystem });
			}).toThrow(malformedSidecar(expect));
		});

		it("should skip branch when end position has no source mapping", ({ expect }) => {
			expect.assertions(1);

			const coverageMap = createCoverageMap(
				{},
				{
					branchMap: {
						"1": {
							locations: [
								{ end: { column: 4, line: 9 }, start: { column: 1, line: 7 } },
								{ end: { column: 4, line: 9 }, start: { column: 1, line: 8 } },
							],
							type: "if",
						},
					},
				},
			);

			const fileSystem = playerFs(coverageMap);

			// Only start positions have mappings; end (line 9) returns null
			const resolvePosition = resolverFromMappings({
				"7:0": playerTs(6, 0),
				"8:0": playerTs(6, 0),
			});

			const coverageData: RawCoverageData = {
				"shared/player.luau": { b: { "1": [3, 0] }, s: {} },
			};

			const result = mapPlayer({ coverageData, fileSystem, resolvePosition });

			expect(result.files).toBeEmptyObject();
		});

		it("should skip branch entries when source map cannot resolve an arm location", ({
			expect,
		}) => {
			expect.assertions(1);

			// No mappings: originalPositionFor returns null source
			const result = mapPlayerBranch({
				hits: [1],
				locations: [span(99, 1, 10)],
				resolvePosition: resolverFromMappings({}),
			});

			expect(result.files).toBeEmptyObject();
		});

		it("should skip branch entries when arms map to different source files", ({ expect }) => {
			expect.assertions(1);

			const result = mapPlayerBranch({
				hits: [1, 0],
				locations: [span(3, 1, 10), span(5, 1, 10)],
				resolvePosition: positionSplitByLine,
			});

			expect(result.files).toBeEmptyObject();
		});

		it("should skip branch entries with empty locations array", ({ expect }) => {
			expect.assertions(1);

			const result = mapPlayerBranch({
				hits: [],
				locations: [],
				resolvePosition: resolverFromMappings({}),
			});

			expect(result.files).toBeEmptyObject();
		});

		it("should skip branch when all arm locations map to null source", ({ expect }) => {
			expect.assertions(1);

			const result = mapPlayerBranch({
				hits: [1],
				locations: [span(3, 1, 10)],
				resolvePosition: resolverFromMappings({}),
			});

			expect(result.files).toBeEmptyObject();
		});

		it("should throw when branchEntrySchema validation fails on a branchMap entry", ({
			expect,
		}) => {
			expect.assertions(1);

			// branchEntrySchema requires "locations" (array) and "type" (string)
			// Providing a missing "type" field makes it invalid
			const rawCoverageMap = {
				branchMap: {
					"1": {
						locations: [span(3, 1, 10)],
						// "type" field intentionally omitted
					},
				},
				statementMap: {},
			};

			const fileSystem = playerFs(fromAny(rawCoverageMap));

			const coverageData: RawCoverageData = {
				"shared/player.luau": { b: { "1": [1] }, s: {} },
			};

			expect(() => {
				mapPlayer({ coverageData, fileSystem });
			}).toThrow(malformedSidecar(expect));
		});

		it("should map branch with implicit else arm using zero-width location", ({ expect }) => {
			expect.assertions(3);

			// Simulates an if-without-else where the instrumenter adds an
			// implicit else arm with a zero-width span at the if-keyword position
			const coverageMap = createCoverageMap(
				{},
				{
					branchMap: {
						"1": {
							locations: [span(3, 1, 10), span(5, 1, 1)],
							type: "if",
						},
					},
				},
			);

			const fileSystem = playerFs(coverageMap);

			// Both arms map to the same TS source file
			const resolvePosition = resolverFromMappings({
				"3:0": playerTs(2, 0),
				"3:9": playerTs(2, 15),
				"5:0": playerTs(4, 0),
			});

			const coverageData: RawCoverageData = {
				"shared/player.luau": { b: { "1": [3, 0] }, s: {} },
			};

			const result = mapPlayer({ coverageData, fileSystem, resolvePosition });

			const file = result.files["src/shared/player.ts"]!;

			expect(file).toBeDefined();
			expect(file.b["0"]).toStrictEqual([3, 0]);
			expect(file.branchMap["0"]!.locations).toHaveLength(2);
		});

		it("should keep arms that share a start when neither arm is zero-width", ({ expect }) => {
			expect.assertions(1);

			const coverageMap = createCoverageMap(
				{},
				{
					branchMap: {
						"1": {
							locations: [
								{ end: { column: 1, line: 4 }, start: { column: 1, line: 3 } },
								span(5, 1, 10),
							],
							type: "if",
						},
					},
				},
			);
			const fileSystem = playerFs(coverageMap);
			const resolvePosition = resolverFromMappings({
				"3:0": playerTs(2, 0),
				"4:0": playerTs(3, 0),
				"5:0": playerTs(2, 0),
				"5:9": playerTs(2, 10),
			});

			const result = mapPlayer({
				coverageData: { "shared/player.luau": { b: { "1": [2, 3] }, s: {} } },
				fileSystem,
				resolvePosition,
			});

			expect(result.files["src/shared/player.ts"]!.b["0"]).toStrictEqual([2, 3]);
		});

		it("should keep a zero-width arm beside an arm at another column", ({ expect }) => {
			expect.assertions(1);

			const coverageMap = createCoverageMap(
				{},
				{
					branchMap: {
						"1": {
							locations: [span(3, 1, 10), span(5, 1, 1)],
							type: "if",
						},
					},
				},
			);
			const fileSystem = playerFs(coverageMap);
			const resolvePosition = resolverFromMappings({
				"3:0": playerTs(2, 5),
				"3:9": playerTs(2, 10),
				"5:0": playerTs(2, 0),
			});

			const result = mapPlayer({
				coverageData: { "shared/player.luau": { b: { "1": [2, 0] }, s: {} } },
				fileSystem,
				resolvePosition,
			});

			expect(result.files["src/shared/player.ts"]!.b["0"]).toStrictEqual([2, 0]);
		});

		it("should keep a single-line else-less statement if", ({ expect }) => {
			expect.assertions(1);

			const coverageMap = createCoverageMap(
				{},
				{
					branchMap: {
						"1": {
							locations: [
								{ end: { column: 2, line: 5 }, start: { column: 11, line: 3 } },
								span(3, 2, 2),
							],
							type: "if",
						},
					},
				},
			);
			const fileSystem = playerFs(coverageMap);
			const resolvePosition = resolverFromMappings({
				"3:1": playerTs(2, 1),
				"3:10": playerTs(2, 1),
				"5:1": playerTs(2, 16),
			});

			const result = mapPlayer({
				coverageData: { "shared/player.luau": { b: { "1": [1, 2] }, s: {} } },
				fileSystem,
				resolvePosition,
			});

			expect(result.files["src/shared/player.ts"]!.b["0"]).toStrictEqual([1, 2]);
		});

		it("should keep a multi-line else-less statement if", ({ expect }) => {
			expect.assertions(1);

			const result = mapPlayerBranch({
				hits: [1, 2],
				locations: [
					{ end: { column: 2, line: 10 }, start: { column: 11, line: 8 } },
					span(8, 2, 2),
				],
				resolvePosition: resolverFromMappings({
					"8:1": playerTs(7, 1),
					"8:10": playerTs(7, 1),
					"10:1": playerTs(9, 1),
				}),
			});

			expect(result.files["src/shared/player.ts"]!.b["0"]).toStrictEqual([1, 2]);
		});

		it("should keep a branch whose later arm starts elsewhere but ends at the first arm's start", ({
			expect,
		}) => {
			expect.assertions(1);

			const result = mapPlayerBranch({
				hits: [1, 2],
				locations: [span(3, 2, 2), span(5, 1, 2)],
				resolvePosition: resolverFromMappings({
					"3:1": playerTs(2, 1),
					"5:0": playerTs(2, 0),
					"5:1": playerTs(2, 1),
				}),
			});

			expect(result.files["src/shared/player.ts"]!.b["0"]).toStrictEqual([1, 2]);
		});

		it("should drop phantom branch whose arms all collapse to one point", ({ expect }) => {
			expect.assertions(1);

			const result = mapPlayerBranch({
				hits: [10, 0],
				locations: [
					{ end: { column: 4, line: 13 }, start: { column: 40, line: 10 } },
					span(10, 2, 2),
				],
				resolvePosition: resolverFromMappings({
					"10:1": playerTs(2, 1),
					"10:39": playerTs(2, 1),
					"13:3": playerTs(2, 1),
				}),
			});

			expect(result.files).toBeEmptyObject();
		});

		it("should retain statement coverage when a phantom branch is dropped", ({ expect }) => {
			expect.assertions(3);

			// Dropping the phantom must filter only the branch entry, not silence
			// other coverage for the same file.
			const coverageMap = createCoverageMap(
				{
					"0": span(7, 1, 10),
				},
				{
					branchMap: {
						"1": {
							locations: [
								{ end: { column: 4, line: 13 }, start: { column: 40, line: 10 } },
								span(10, 2, 2),
							],
							type: "if",
						},
					},
				},
			);

			const fileSystem = playerFs(coverageMap);

			const resolvePosition = resolverFromMappings({
				"7:0": playerTs(3, 0),
				"7:9": playerTs(3, 25),
				"10:1": playerTs(2, 1),
				"10:39": playerTs(2, 1),
				"13:3": playerTs(2, 1),
			});

			const coverageData: RawCoverageData = {
				"shared/player.luau": { b: { "1": [10, 0] }, s: { "0": 5 } },
			};

			const result = mapPlayer({ coverageData, fileSystem, resolvePosition });

			const file = result.files["src/shared/player.ts"];

			expect(file).toBeDefined();
			expect(file!.s["0"]).toBe(5);
			expect(file!.branchMap).toStrictEqual({});
		});

		it("should keep a collapsing expr-if branch (a real ternary is not a phantom)", ({
			expect,
		}) => {
			expect.assertions(2);

			// A one-line ternary compiles to a Luau if-expression with one
			// column-0 source-map segment, so every arm snaps to the same TS
			// position, like a phantom. An expr-if is a real branch; the phantom
			// signature applies only to statement `if`s (type "if").
			const coverageMap = createCoverageMap(
				{},
				{
					branchMap: {
						"1": {
							locations: [span(3, 1, 5), span(3, 9, 13)],
							type: "expr-if",
						},
					},
				},
			);

			const fileSystem = playerFs(coverageMap);

			// One segment on line 3 → every column snaps to the same TS position.
			const resolvePosition = resolverFromMappings({
				"3:0": playerTs(2, 0),
				"3:4": playerTs(2, 0),
				"3:8": playerTs(2, 0),
				"3:12": playerTs(2, 0),
			});

			const coverageData: RawCoverageData = {
				"shared/player.luau": { b: { "1": [4, 6] }, s: {} },
			};

			const result = mapPlayer({ coverageData, fileSystem, resolvePosition });

			const file = result.files["src/shared/player.ts"];

			expect(file).toBeDefined();
			expect(file!.b["0"]).toStrictEqual([4, 6]);
		});
	});

	describe("with native Luau files (no source map)", () => {
		it("should report an untested native Luau file with zero hits", ({ expect }) => {
			expect.assertions(2);

			const coverageMap = createCoverageMap({
				"0": {
					end: { column: 20, line: 3 },
					start: { column: 1, line: 1 },
				},
			});

			// Only cov-map exists; no .luau.map source map (native Luau).
			const fileSystem = setupFs({
				"out/shared/player.luau.cov-map.json": JSON.stringify(coverageMap),
			});

			// Instrumented but never required by a test → absent from hit map.
			const result = mapPlayer({ coverageData: {}, fileSystem });

			const file = result.files["shared/player.luau"];

			expect(file).toBeDefined();
			expect(file!.s["0"]).toBe(0);
		});

		it("should merge coverage from duplicate keys into existing pending entries", ({
			expect,
		}) => {
			expect.assertions(3);

			const coverageMap = createCoverageMap(
				{
					"0": span(1, 1, 10),
				},
				{
					branchMap: {
						"0": {
							locations: [span(7, 1, 10), span(9, 1, 10)],
							type: "if",
						},
					},
					functionMap: {
						"0": {
							name: "greet",
							location: {
								end: { column: 4, line: 5 },
								start: { column: 1, line: 3 },
							},
						},
					},
				},
			);

			const fileSystem = setupFs({
				"out/shared/player.luau.cov-map.json": JSON.stringify(coverageMap),
			});

			// Create manifest with two different keys pointing to the same file
			const baseFile = createManifestFiles(1)["shared/player.luau"];
			const manifest = createManifest({
				"shared/player-alias.luau": {
					...baseFile,
					key: baseFile.key,
				},
				"shared/player.luau": baseFile,
			});

			// Process both entries; second hits "already initialized" branches
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

			const result = mapCoverageToTypeScript({
				coverageData: combinedCoverage,
				fileSystem,
				manifest,
				traceMapFactory: () => resolverFromMappings({}),
			});

			const file = result.files["shared/player.luau"]!;

			// Both entries contributed; second hit the "already initialized"
			// branch
			expect(file).toBeDefined();
			expect(Object.keys(file.fnMap)).not.toBeEmpty();
			expect(Object.keys(file.branchMap)).not.toBeEmpty();
		});
	});
});
