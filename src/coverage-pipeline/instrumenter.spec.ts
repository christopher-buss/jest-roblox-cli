import { loadLuauParser } from "@isentinel/luau-ast/parser";

import { type } from "arktype";
import process from "node:process";
import { describe, expect, it, vi } from "vitest";

import { clockTimingCollector } from "#test/mocks/clock-timing-collector.ts";
import { copyIgnoreMatcher } from "#test/mocks/coverage-copy-ignore.ts";
import type { MemoryFileSystem, MemoryVolume } from "#test/mocks/memory-file-system.ts";
import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { posixPath, posixRoot } from "#test/mocks/posix-path.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { nodeInstrumenter } from "./instrumenter.ts";

const LUAU_ROOT = posixRoot("/luau-root");

const DEFAULT_FILES = { "init.luau": "local x = 1\n" } satisfies Record<string, string>;

function callInstrumentWithDefaults(fileSystem: FileSystem) {
	return { files: nodeInstrumenter({ fileSystem, luauRoot: LUAU_ROOT, shadowDir: "/shadow" }) };
}

/**
 * Read back the `__cov_file_key` literal baked into an instrumented file.
 *
 * @param volume - The shadow the instrumenter wrote into.
 * @param fileKey - The manifest key whose twin to read.
 * @returns The quoted literal, or undefined when absent.
 */
function readEmbeddedFileKey(volume: MemoryVolume, fileKey: string): string | undefined {
	const relativePath = fileKey.slice("/luau-root/".length);
	const instrumented = volume.readFileSync(`/shadow/${relativePath}`, "utf-8").toString();
	return /local __cov_file_key = ("(?:[^"\\]|\\.)*")/.exec(instrumented)?.[1];
}

/**
 * A volume holding source files; instrumentation parses them in process.
 *
 * @param options - The files, and the root they hang off.
 * @returns Memory file system holding the files.
 */
function setupFilesystem({
	files = DEFAULT_FILES,
	luauRoot = "/luau-root",
}: {
	files?: Record<string, string>;
	luauRoot?: string;
} = {}): MemoryFileSystem {
	return createMemoryFileSystem(
		Object.fromEntries(
			Object.entries(files).map(([relativePath, source]) => {
				return [`${luauRoot}/${relativePath}`, source];
			}),
		),
		process.cwd(),
	);
}

describe(nodeInstrumenter, () => {
	// Cross-machine join-key guard. The per-file key recorded in the manifest
	// MUST be byte-identical to the `__cov_file_key` literal baked into the
	// instrumented preamble — the runtime bumps
	// `_G.__jest_roblox_cov[__cov_file_key]` with that exact literal, so the
	// manifest key, the preamble key, and the harvested hit-table key are one
	// string. If a refactor let the two writers (manifest record vs preamble)
	// diverge, coverage would silently map to the wrong source lines across the
	// build/run machine boundary with no type error to catch it.
	describe("cross-machine join key", () => {
		it("should bake the manifest file key verbatim into the instrumented preamble", () => {
			expect.assertions(2);

			const { fileSystem, volume } = setupFilesystem({
				files: { "init.luau": "local x = 1\n", "shared/player.luau": "local y = 2\n" },
			});

			const files = nodeInstrumenter({
				fileSystem,
				luauRoot: LUAU_ROOT,
				shadowDir: "/shadow",
			});
			const keys = Object.keys(files);

			// The manifest record keys on `key`; the preamble embeds the same
			// literal (JSON string encoding matches the preamble's escape rules
			// for these path keys).
			expect(Object.values(files).map((record) => record.key)).toStrictEqual(keys);
			expect(keys.map((key) => readEmbeddedFileKey(volume, key))).toStrictEqual(
				keys.map((key) => JSON.stringify(key)),
			);
		});
	});

	// The shadow tree carries no `.luau.map`: `coverageCopyIgnorePatterns`
	// leaves them behind because every reader opens the one in `outDir`. This
	// pins the coverage half of that — the stack mapper's half holds because a
	// coverage run swaps only `placeFile`, never `rojoProject`.
	it("should record each source map against the source root, not the shadow", () => {
		expect.assertions(1);

		const { fileSystem } = setupFilesystem({ files: { "init.luau": "local x = 1\n" } });

		const files = nodeInstrumenter({ fileSystem, luauRoot: LUAU_ROOT, shadowDir: "/shadow" });

		expect(Object.values(files).map((record) => record.sourceMapPath)).toStrictEqual([
			"/luau-root/init.luau.map",
		]);
	});

	// The walk writes each file name relative to the root, then this function
	// reads those names back from the disk. If the root keeps a leading `./`,
	// each name loses two characters and the read fails with an ENOENT for a
	// file that does not exist.
	it("should instrument a root written with a ./ prefix", () => {
		expect.assertions(1);

		const { fileSystem } = setupFilesystem({
			files: { "shared/player.luau": "local x = 1\n" },
			luauRoot: "out",
		});

		const files = nodeInstrumenter({
			fileSystem,
			luauRoot: posixRoot("./out"),
			shadowDir: "/shadow",
		});

		expect(Object.keys(files)).toStrictEqual(["out/shared/player.luau"]);
	});

	describe("when copy-ignored paths are provided", () => {
		it("should never instrument a path the shadow will not carry", () => {
			expect.assertions(1);

			const { fileSystem } = setupFilesystem({
				files: { "init.luau": "local x = 1\n", "vendor/dep.luau": "local y = 2\n" },
			});

			const files = nodeInstrumenter({
				fileSystem,
				isCopyIgnored: copyIgnoreMatcher(["vendor", "vendor/**"]),
				luauRoot: LUAU_ROOT,
				shadowDir: "/shadow",
			});

			expect(Object.keys(files)).toStrictEqual(["/luau-root/init.luau"]);
		});
	});

	describe("when skipFiles is provided", () => {
		it("should skip files listed in skipFiles", () => {
			expect.assertions(2);

			const { fileSystem } = setupFilesystem({
				files: { "init.luau": "local x = 1\n", "shared/player.luau": "local y = 2\n" },
			});

			const files = nodeInstrumenter({
				fileSystem,
				luauRoot: LUAU_ROOT,
				shadowDir: "/shadow",
				skipFiles: new Set(["shared/player.luau"]),
			});

			const keys = Object.keys(files);

			expect(keys).toContain("/luau-root/init.luau");
			expect(keys).not.toContain("/luau-root/shared/player.luau");
		});

		it("should not parse a skipped file at all", () => {
			expect.assertions(1);

			// The skipped file does not even parse — proven by it being
			// syntactically invalid without failing the run.
			const { fileSystem } = setupFilesystem({
				files: { "broken.luau": "local = = =\n", "init.luau": "local x = 1\n" },
			});

			const files = nodeInstrumenter({
				fileSystem,
				luauRoot: LUAU_ROOT,
				shadowDir: "/shadow",
				skipFiles: new Set(["broken.luau"]),
			});

			expect(Object.keys(files)).toStrictEqual(["/luau-root/init.luau"]);
		});
	});

	it("should throw a contextual error for an unparseable file", () => {
		expect.assertions(1);

		const { fileSystem } = setupFilesystem({ files: { "init.luau": "local =\nlocal =\n" } });

		expect(() => {
			nodeInstrumenter({
				fileSystem,
				luauRoot: LUAU_ROOT,
				shadowDir: "/shadow",
			});
		}).toThrowWithMessage(
			Error,
			"Failed to parse init.luau: " +
				"Expected identifier when parsing variable name, got '='; " +
				"Expected identifier when parsing expression, got 'local'; " +
				"Expected identifier when parsing variable name, got '='; " +
				"Expected identifier when parsing expression, got <eof>",
		);
	});

	describe("when the root includes spec, test, and snapshot files", () => {
		it("should exclude them from instrumentation", () => {
			expect.assertions(1);

			const { fileSystem } = setupFilesystem({
				files: {
					"__snapshots__/Button.spec.snap.luau": "return {}\n",
					"button.spec.luau": "return {}\n",
					"button.test.luau": "return {}\n",
					"init.luau": "local x = 1\n",
				},
			});

			const files = nodeInstrumenter({
				fileSystem,
				luauRoot: LUAU_ROOT,
				shadowDir: "/shadow",
			});

			expect(Object.keys(files)).toStrictEqual(["/luau-root/init.luau"]);
		});
	});

	// A root holds far more files than directories, so creating the output
	// directory per file spends a recursive stat/mkdir chain to make something
	// the previous sibling already made — thousands of them over a real root.
	describe("when several files share a shadow directory", () => {
		it("should create each directory once for the twin, not once per file", () => {
			expect.assertions(3);

			const { fileSystem, volume } = setupFilesystem({
				files: {
					"init.luau": "local x = 1\n",
					"shared/a.luau": "local a = 1\n",
					"shared/b.luau": "local b = 2\n",
					"shared/deep/c.luau": "local c = 3\n",
				},
			});

			const mkdirSpy = vi.spyOn(fileSystem, "mkdirSync");
			const statSpy = vi.spyOn(fileSystem, "statSync");

			nodeInstrumenter({
				fileSystem,
				luauRoot: LUAU_ROOT,
				shadowDir: "/shadow",
			});

			// Two sources land here, and only the first is this cache's to
			// elide: one call per directory for the twin, plus one call per
			// file from the `atomicWrite` under `writeCoverageMap`, which
			// makes its own parent for every sidecar. So `/shadow/shared`
			// holds two files and appears three times, not four.
			//
			// Sorted, not walk-ordered: the counts are the claim, and pinning
			// the order would tie this to the directory walk instead.
			// Normalized because the target is a host `path.join`, so it
			// carries backslashes on Windows and forward slashes elsewhere.
			const directories = mkdirSpy.mock.calls.map(([directory]) => {
				return posixPath(String(directory));
			});

			expect(directories.toSorted()).toStrictEqual([
				"/shadow",
				"/shadow",
				"/shadow/shared",
				"/shadow/shared",
				"/shadow/shared",
				"/shadow/shared/deep",
				"/shadow/shared/deep",
			]);

			const shadowDirectories = new Set(["/shadow", "/shadow/shared", "/shadow/shared/deep"]);
			const directoryStats = statSpy.mock.calls
				.map(([directory]) => posixPath(String(directory)))
				.filter((directory) => shadowDirectories.has(directory));

			expect(directoryStats.toSorted()).toStrictEqual([
				"/shadow",
				"/shadow/shared",
				"/shadow/shared/deep",
			]);
			// Every file still landed, so the skipped calls really were repeats.
			expect(
				["init", "shared/a", "shared/b", "shared/deep/c"].map((name) => {
					return volume.existsSync(`/shadow/${name}.luau`);
				}),
			).toStrictEqual([true, true, true, true]);
		});
	});

	describe("when instrumenting a single root", () => {
		it("should return file records without writing a manifest", () => {
			expect.assertions(2);

			const { fileSystem, volume } = setupFilesystem();

			const files = nodeInstrumenter({
				fileSystem,
				luauRoot: LUAU_ROOT,
				shadowDir: "/shadow",
			});

			expect(Object.keys(files)).toStrictEqual(["/luau-root/init.luau"]);
			expect(volume.existsSync("/shadow/manifest.json")).toBeFalse();
		});
	});

	describe("when a timing profiler is supplied", () => {
		it("should record every step of the per-file pass", () => {
			expect.assertions(1);

			const { fileSystem } = setupFilesystem();

			const phases: Array<string> = [];
			const collector = clockTimingCollector();
			const timing = {
				...collector,
				profile: ((name, func) => {
					phases.push(name);
					return collector.profile(name, func);
				}) satisfies typeof collector.profile,
			};

			nodeInstrumenter({
				fileSystem,
				luauRoot: LUAU_ROOT,
				shadowDir: "/shadow",
				timing,
			});

			expect(phases).toStrictEqual([
				"discover-files",
				"read-source",
				"parse-ast",
				"collect-coverage",
				"probe-insert",
				"map-build",
				"write-shadow",
			]);
		});
	});

	describe("when the shadow holds an entry of the wrong type", () => {
		// Neither clash reaches the mirror walk's `createShadowDirectory`:
		// `prepareShadowRoot` instruments before it mirrors, so the
		// instrumenter is the pass that has to survive both.
		it("should replace a directory sitting on a twin's own path", () => {
			expect.assertions(1);

			const { fileSystem, volume } = setupFilesystem();
			volume.mkdirSync("/shadow/init.luau", { recursive: true });
			volume.writeFileSync("/shadow/init.luau/stale.luau", "-- stale");

			nodeInstrumenter({ fileSystem, luauRoot: LUAU_ROOT, shadowDir: "/shadow" });

			expect(volume.readFileSync("/shadow/init.luau", "utf-8")).toContain("__cov_file_key");
		});

		it("should replace a file sitting on a directory above a twin", () => {
			expect.assertions(1);

			const { fileSystem, volume } = setupFilesystem({
				files: { "nested/init.luau": "local x = 1\n" },
			});
			volume.mkdirSync("/shadow", { recursive: true });
			volume.writeFileSync("/shadow/nested", "-- stale");

			nodeInstrumenter({ fileSystem, luauRoot: LUAU_ROOT, shadowDir: "/shadow" });

			expect(volume.readFileSync("/shadow/nested/init.luau", "utf-8")).toContain(
				"__cov_file_key",
			);
		});
	});
});

describe("nodeInstrumenter output", () => {
	describe("when processing discovered files", () => {
		it("should create file records for each discovered file", () => {
			expect.assertions(3);

			const { fileSystem } = setupFilesystem({
				files: { "init.luau": "local x = 1\n", "shared/player.luau": "local y = 2\n" },
			});

			const result = callInstrumentWithDefaults(fileSystem);

			const keys = Object.keys(result.files);

			expect(keys).toContain("/luau-root/init.luau");
			expect(keys).toContain("/luau-root/shared/player.luau");
			expect(keys).toHaveLength(2);
		});
	});

	describe("when writing output", () => {
		it("should write instrumented files to shadowDir preserving structure", () => {
			expect.assertions(1);

			const { fileSystem, volume } = setupFilesystem({
				files: { "shared/player.luau": "local y = 2\n" },
			});

			callInstrumentWithDefaults(fileSystem);

			expect(volume.existsSync("/shadow/shared/player.luau")).toBeTrue();
		});

		it("should include sourceHash in each file record", () => {
			expect.assertions(1);

			const { fileSystem } = setupFilesystem();

			const result = callInstrumentWithDefaults(fileSystem);

			const record = result.files["/luau-root/init.luau"];

			expect(record!.sourceHash).toMatch(/^[a-f0-9]{64}$/);
		});

		it("should emit manifest file records with correct metadata", () => {
			expect.assertions(3);

			const { fileSystem } = setupFilesystem({ files: { "init.luau": "local x = 1\n" } });

			const result = callInstrumentWithDefaults(fileSystem);

			expect(result.files["/luau-root/init.luau"]).toBeDefined();
			expect(result.files["/luau-root/init.luau"]!.statementCount).toBe(1);
			expect(result.files["/luau-root/init.luau"]!.key).toBe("/luau-root/init.luau");
		});

		it("should write covmap sidecar for each file", () => {
			expect.assertions(2);

			const { fileSystem, volume } = setupFilesystem({
				files: { "init.luau": "local x = 1\n", "shared/player.luau": "local y = 2\n" },
			});

			callInstrumentWithDefaults(fileSystem);

			expect(volume.existsSync("/shadow/init.cov-map.json")).toBeTrue();
			expect(volume.existsSync("/shadow/shared/player.cov-map.json")).toBeTrue();
		});

		// Regression: roblox-ts emits `.lua` (not `.luau`) for its vendor
		// runtime (`include/RuntimeLib.lua`). A regex that only stripped
		// `.luau$` left the cov-map path identical to the instrumented source
		// path, so the JSON write clobbered the Lua text — every `require`
		// through RuntimeLib then failed at load.
		it("should write covmap sidecar without clobbering .lua source", () => {
			expect.assertions(2);

			const { fileSystem, volume } = setupFilesystem({
				files: { "RuntimeLib.lua": "local x = 1\n" },
			});

			callInstrumentWithDefaults(fileSystem);

			expect(volume.existsSync("/shadow/RuntimeLib.cov-map.json")).toBeTrue();
			expect(volume.readFileSync("/shadow/RuntimeLib.lua", "utf-8")).not.toStartWith("{");
		});
	});

	describe("when normalizing paths", () => {
		it("should normalize paths to POSIX format", () => {
			expect.assertions(3);

			const { fileSystem } = setupFilesystem({
				files: { "shared/player.luau": "local y = 2\n" },
			});

			const result = callInstrumentWithDefaults(fileSystem);

			for (const key of Object.keys(result.files)) {
				expect(key).not.toContain("\\");
			}

			const record = result.files["/luau-root/shared/player.luau"];

			expect(record!.originalLuauPath).not.toContain("\\");
			expect(record!.instrumentedLuauPath).not.toContain("\\");
		});
	});
});

describe("nodeInstrumenter on a luau project", () => {
	it("should instrument the source module and leave its spec alone", () => {
		expect.assertions(3);

		const { fileSystem, volume } = setupFilesystem({
			files: {
				"example.luau": [
					"local module = {}",
					"",
					"function module.greet(): string",
					'\treturn "hello"',
					"end",
					"",
					"return module",
					"",
				].join("\n"),
				"example.spec.luau": "return nil",
			},
		});

		const files = nodeInstrumenter({ fileSystem, luauRoot: LUAU_ROOT, shadowDir: "/shadow" });
		const records = Object.values(files);

		expect(Object.keys(files)).toStrictEqual(["/luau-root/example.luau"]);
		expect(
			records.every((record) => volume.existsSync(record.instrumentedLuauPath)),
		).toBeTrue();
		expect(records.every((record) => volume.existsSync(record.coverageMapPath))).toBeTrue();
	});
});

const luauParser = loadLuauParser();

const coverageMapShape = type({ "branchMap?": { "[string]": { locations: "unknown[]" } } });

function instrumentSource(source: string) {
	const { fileSystem, volume } = setupFilesystem({ files: { "module.luau": source } });
	const record = Object.values(
		nodeInstrumenter({ fileSystem, luauRoot: LUAU_ROOT, shadowDir: "/shadow" }),
	)[0]!;

	const coverageMap = coverageMapShape.assert(
		JSON.parse(volume.readFileSync(record.coverageMapPath, "utf-8").toString()),
	);
	const instrumented = volume.readFileSync(record.instrumentedLuauPath, "utf-8").toString();
	const parsed = luauParser.parse(instrumented);

	return {
		branchArmCounts: Object.values(coverageMap.branchMap ?? {}).map((branch) => {
			return branch.locations.length;
		}),
		instrumented,
		parseFailure: parsed.ok ? undefined : parsed.errors.join("; "),
	};
}

describe("instrumented luau syntax", () => {
	it("should emit parseable luau for an else body holding only a comment", () => {
		expect.assertions(2);

		const result = instrumentSource(
			[
				"local value = 1",
				"if value == 1 then",
				'\tprint("one")',
				"else",
				"\t-- // nothing to do here",
				"end",
				"",
			].join("\n"),
		);

		expect(result.parseFailure).toBeUndefined();
		expect(result.branchArmCounts).toStrictEqual([2]);
	});

	it("should emit parseable luau for an if/elseif chain ending in a comment-only else", () => {
		expect.assertions(2);

		const result = instrumentSource(
			[
				"local value = 1",
				"if value == 1 then",
				'\tprint("one")',
				"elseif value == 2 then",
				'\tprint("two")',
				"elseif value == 3 then",
				'\tprint("three")',
				"else",
				"\t-- // The remaining values are not valid",
				"end",
				"",
			].join("\n"),
		);

		expect(result.parseFailure).toBeUndefined();
		expect(result.branchArmCounts).toStrictEqual([4]);
	});

	it("should emit parseable luau for an else body with nothing in it", () => {
		expect.assertions(2);

		const result = instrumentSource(
			["local value = 1", "if value == 1 then", '\tprint("one")', "else", "end", ""].join(
				"\n",
			),
		);

		expect(result.parseFailure).toBeUndefined();
		expect(result.branchArmCounts).toStrictEqual([2]);
	});

	it("should emit parseable luau for empty function and loop bodies", () => {
		expect.assertions(1);

		const result = instrumentSource(
			[
				"local function noop()",
				"end",
				"while noop() do",
				"end",
				"for index = 1, 2 do",
				"end",
				"",
			].join("\n"),
		);

		expect(result.parseFailure).toBeUndefined();
	});

	it("should keep the arm counter inside an else body that has statements", () => {
		expect.assertions(4);

		const result = instrumentSource(
			[
				"local value = 1",
				"if value == 1 then",
				'\tprint("one")',
				"else",
				'\tprint("other")',
				"end",
				"",
			].join("\n"),
		);

		expect(result.parseFailure).toBeUndefined();
		expect(result.branchArmCounts).toStrictEqual([2]);
		expect(result.instrumented).toContain(
			'__cov_b[1][2] += 1; __cov_s[4] += 1; print("other")',
		);
		// The synthesized arm belongs to an `if` with no `else` at all; emitting
		// it beside a real `else` is what produced two `else` keywords.
		expect(result.instrumented).not.toContain("else __cov_b");
	});
});
