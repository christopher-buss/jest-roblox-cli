import { fromAny } from "@total-typescript/shoehorn";

import { vol } from "memfs";
import * as fs from "node:fs";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { createTimingCollector } from "../timing/orchestration-collector.ts";
import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import { createCopyIgnoreMatcher } from "./discover-files.ts";
import { instrument, instrumentRoot } from "./instrumenter.ts";
import { MANIFEST_VERSION } from "./manifest.ts";

vi.mock(import("node:fs"), async () => {
	const memfs = await vi.importActual<typeof import("memfs")>("memfs");
	return fromAny({ ...memfs.fs, default: memfs.fs });
});

const DEFAULT_FILES = { "init.luau": "local x = 1\n" } satisfies Record<string, string>;

function callInstrumentWithDefaults() {
	return instrument({
		luauRoot: "/luau-root",
		manifestPath: "/manifest.json",
		shadowDir: "/shadow",
	});
}

/** Reads back the `__cov_file_key` literal baked into an instrumented file. */
function readEmbeddedFileKey(fileKey: string): string | undefined {
	const relativePath = fileKey.slice("/luau-root/".length);
	const instrumented = vol.readFileSync(`/shadow/${relativePath}`, "utf-8").toString();
	return /local __cov_file_key = ("(?:[^"\\]|\\.)*")/.exec(instrumented)?.[1];
}

/** Seed memfs with source files; instrumentation parses them in process. */
function setupFilesystem({
	files = DEFAULT_FILES,
	luauRoot = "/luau-root",
}: {
	files?: Record<string, string>;
	luauRoot?: string;
} = {}): void {
	onTestFinished(() => {
		vol.reset();
	});

	for (const [relativePath, source] of Object.entries(files)) {
		const sourcePath = `${luauRoot}/${relativePath}`;
		const directory = sourcePath.slice(0, sourcePath.lastIndexOf("/"));
		vol.mkdirSync(directory, { recursive: true });
		vol.writeFileSync(sourcePath, source);
	}
}

describe(instrumentRoot, () => {
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

			setupFilesystem({
				files: { "init.luau": "local x = 1\n", "shared/player.luau": "local y = 2\n" },
			});

			const files = instrumentRoot({
				luauRoot: "/luau-root",
				shadowDir: "/shadow",
			});
			const keys = Object.keys(files);

			// The manifest record keys on `key`; the preamble embeds the same
			// literal (JSON string encoding matches the preamble's escape rules
			// for these path keys).
			expect(Object.values(files).map((record) => record.key)).toStrictEqual(keys);
			expect(keys.map(readEmbeddedFileKey)).toStrictEqual(
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

		setupFilesystem({ files: { "init.luau": "local x = 1\n" } });

		const files = instrumentRoot({ luauRoot: "/luau-root", shadowDir: "/shadow" });

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

		setupFilesystem({ files: { "shared/player.luau": "local x = 1\n" }, luauRoot: "out" });

		const files = instrumentRoot({ luauRoot: "./out", shadowDir: "/shadow" });

		expect(Object.keys(files)).toStrictEqual(["out/shared/player.luau"]);
	});

	describe("when copy-ignored paths are provided", () => {
		it("should never instrument a path the shadow will not carry", () => {
			expect.assertions(1);

			setupFilesystem({
				files: { "init.luau": "local x = 1\n", "vendor/dep.luau": "local y = 2\n" },
			});

			const files = instrumentRoot({
				isCopyIgnored: createCopyIgnoreMatcher(["vendor", "vendor/**"]),
				luauRoot: "/luau-root",
				shadowDir: "/shadow",
			});

			expect(Object.keys(files)).toStrictEqual(["/luau-root/init.luau"]);
		});
	});

	describe("when skipFiles is provided", () => {
		it("should skip files listed in skipFiles", () => {
			expect.assertions(2);

			setupFilesystem({
				files: { "init.luau": "local x = 1\n", "shared/player.luau": "local y = 2\n" },
			});

			const files = instrumentRoot({
				luauRoot: "/luau-root",
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
			setupFilesystem({
				files: { "broken.luau": "local = = =\n", "init.luau": "local x = 1\n" },
			});

			const files = instrumentRoot({
				luauRoot: "/luau-root",
				shadowDir: "/shadow",
				skipFiles: new Set(["broken.luau"]),
			});

			expect(Object.keys(files)).toStrictEqual(["/luau-root/init.luau"]);
		});
	});

	it("should throw a contextual error for an unparseable file", () => {
		expect.assertions(1);

		setupFilesystem({ files: { "init.luau": "local = = =\n" } });

		expect(() => {
			instrumentRoot({
				luauRoot: "/luau-root",
				shadowDir: "/shadow",
			});
		}).toThrowWithMessage(Error, /Failed to parse init\.luau/);
	});

	describe("when the root includes spec, test, and snapshot files", () => {
		it("should exclude them from instrumentation", () => {
			expect.assertions(1);

			setupFilesystem({
				files: {
					"__snapshots__/Button.spec.snap.luau": "return {}\n",
					"button.spec.luau": "return {}\n",
					"button.test.luau": "return {}\n",
					"init.luau": "local x = 1\n",
				},
			});

			const files = instrumentRoot({
				luauRoot: "/luau-root",
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
			expect.assertions(2);

			setupFilesystem({
				files: {
					"init.luau": "local x = 1\n",
					"shared/a.luau": "local a = 1\n",
					"shared/b.luau": "local b = 2\n",
					"shared/deep/c.luau": "local c = 3\n",
				},
			});

			const mkdirSpy = vi.spyOn(fs, "mkdirSync");

			instrumentRoot({
				luauRoot: "/luau-root",
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
				return normalizeWindowsPath(String(directory));
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
			// Every file still landed, so the skipped calls really were repeats.
			expect(
				["init", "shared/a", "shared/b", "shared/deep/c"].map((name) => {
					return vol.existsSync(`/shadow/${name}.luau`);
				}),
			).toStrictEqual([true, true, true, true]);
		});
	});

	describe("when instrumenting a single root", () => {
		it("should return file records without writing a manifest", () => {
			expect.assertions(2);

			setupFilesystem();

			const files = instrumentRoot({
				luauRoot: "/luau-root",
				shadowDir: "/shadow",
			});

			expect(Object.keys(files)).toStrictEqual(["/luau-root/init.luau"]);
			expect(vol.existsSync("/shadow/manifest.json")).toBeFalse();
		});
	});

	describe("when a timing profiler is supplied", () => {
		it("should record every step of the per-file pass", () => {
			expect.assertions(1);

			setupFilesystem();

			const lines: Array<string> = [];
			const timing = createTimingCollector({
				clock: { now: () => 0 },
				enabled: true,
				sink: (line) => {
					lines.push(line);
				},
			});

			instrumentRoot({
				luauRoot: "/luau-root",
				shadowDir: "/shadow",
				timing,
			});
			timing.flushTimingReport();

			expect(lines).toStrictEqual([
				// No enclosing phase here, so each sub-phase is its own root:
				// it announces itself and reports as it closes.
				"[TIMING] discover-files: start",
				"[TIMING] discover-files: 0ms",
				"[TIMING] read-source: start",
				"[TIMING] read-source: 0ms",
				"[TIMING] parse-ast: start",
				"[TIMING] parse-ast: 0ms",
				"[TIMING] collect-coverage: start",
				"[TIMING] collect-coverage: 0ms",
				"[TIMING] probe-insert: start",
				"[TIMING] probe-insert: 0ms",
				"[TIMING] map-build: start",
				"[TIMING] map-build: 0ms",
				"[TIMING] write-shadow: start",
				"[TIMING] write-shadow: 0ms",
				"[TIMING] TOTAL (host): 0ms",
			]);
		});
	});

	describe("when the shadow holds an entry of the wrong type", () => {
		// Neither clash reaches the mirror walk's `createShadowDirectory`:
		// `prepareShadowRoot` instruments before it mirrors, so the
		// instrumenter is the pass that has to survive both.
		it("should replace a directory sitting on a twin's own path", () => {
			expect.assertions(1);

			setupFilesystem();
			vol.mkdirSync("/shadow/init.luau", { recursive: true });
			vol.writeFileSync("/shadow/init.luau/stale.luau", "-- stale");

			instrumentRoot({ luauRoot: "/luau-root", shadowDir: "/shadow" });

			expect(vol.readFileSync("/shadow/init.luau", "utf-8")).toContain("__cov_file_key");
		});

		it("should replace a file sitting on a directory above a twin", () => {
			expect.assertions(1);

			setupFilesystem({ files: { "nested/init.luau": "local x = 1\n" } });
			vol.mkdirSync("/shadow", { recursive: true });
			vol.writeFileSync("/shadow/nested", "-- stale");

			instrumentRoot({ luauRoot: "/luau-root", shadowDir: "/shadow" });

			expect(vol.readFileSync("/shadow/nested/init.luau", "utf-8")).toContain(
				"__cov_file_key",
			);
		});
	});
});

describe(instrument, () => {
	describe("when processing discovered files", () => {
		it("should create file records for each discovered file", () => {
			expect.assertions(3);

			setupFilesystem({
				files: { "init.luau": "local x = 1\n", "shared/player.luau": "local y = 2\n" },
			});

			const result = instrument({
				luauRoot: "/luau-root",
				manifestPath: "/manifest.json",
				shadowDir: "/shadow",
			});

			const keys = Object.keys(result.files);

			expect(keys).toContain("/luau-root/init.luau");
			expect(keys).toContain("/luau-root/shared/player.luau");
			expect(keys).toHaveLength(2);
		});
	});

	describe("when writing output", () => {
		it("should write instrumented files to shadowDir preserving structure", () => {
			expect.assertions(1);

			setupFilesystem({
				files: { "shared/player.luau": "local y = 2\n" },
			});

			callInstrumentWithDefaults();

			expect(vol.existsSync("/shadow/shared/player.luau")).toBeTrue();
		});

		it("should emit manifest JSON with correct top-level fields", () => {
			expect.assertions(3);

			setupFilesystem();

			const result = callInstrumentWithDefaults();

			expect(result.version).toBe(MANIFEST_VERSION);
			expect(result.shadowDir).toBeDefined();
			expect(result.generatedAt).toBeDefined();
		});

		it("should include sourceHash in each file record", () => {
			expect.assertions(1);

			setupFilesystem();

			const result = callInstrumentWithDefaults();

			const record = result.files["/luau-root/init.luau"];

			expect(record!.sourceHash).toMatch(/^[a-f0-9]{64}$/);
		});

		it("should include instrumenterVersion in manifest", () => {
			expect.assertions(1);

			setupFilesystem();

			const result = callInstrumentWithDefaults();

			expect(result.instrumenterVersion).toBe(5);
		});

		it("should emit manifest file records with correct metadata", () => {
			expect.assertions(3);

			setupFilesystem({ files: { "init.luau": "local x = 1\n" } });

			const result = callInstrumentWithDefaults();

			expect(result.files["/luau-root/init.luau"]).toBeDefined();
			expect(result.files["/luau-root/init.luau"]!.statementCount).toBe(1);
			expect(result.files["/luau-root/init.luau"]!.key).toBe("/luau-root/init.luau");
		});

		it("should write covmap sidecar for each file", () => {
			expect.assertions(2);

			setupFilesystem({
				files: { "init.luau": "local x = 1\n", "shared/player.luau": "local y = 2\n" },
			});

			callInstrumentWithDefaults();

			expect(vol.existsSync("/shadow/init.cov-map.json")).toBeTrue();
			expect(vol.existsSync("/shadow/shared/player.cov-map.json")).toBeTrue();
		});

		// Regression: roblox-ts emits `.lua` (not `.luau`) for its vendor
		// runtime (`include/RuntimeLib.lua`). A regex that only stripped
		// `.luau$` left the cov-map path identical to the instrumented source
		// path, so the JSON write clobbered the Lua text — every `require`
		// through RuntimeLib then failed at load.
		it("should write covmap sidecar without clobbering .lua source", () => {
			expect.assertions(2);

			setupFilesystem({
				files: { "RuntimeLib.lua": "local x = 1\n" },
			});

			callInstrumentWithDefaults();

			expect(vol.existsSync("/shadow/RuntimeLib.cov-map.json")).toBeTrue();
			expect(vol.readFileSync("/shadow/RuntimeLib.lua", "utf-8")).not.toStartWith("{");
		});
	});

	describe("when normalizing paths", () => {
		it("should normalize paths to POSIX format", () => {
			expect.assertions(3);

			setupFilesystem({ files: { "shared/player.luau": "local y = 2\n" } });

			const result = callInstrumentWithDefaults();

			for (const key of Object.keys(result.files)) {
				expect(key).not.toContain("\\");
			}

			const record = result.files["/luau-root/shared/player.luau"];

			expect(record!.originalLuauPath).not.toContain("\\");
			expect(record!.instrumentedLuauPath).not.toContain("\\");
		});
	});

	describe("when emitting luauRoots in the manifest", () => {
		it("should include luauRoots array with the single root", () => {
			expect.assertions(1);

			setupFilesystem();

			const result = callInstrumentWithDefaults();

			expect(result.luauRoots).toStrictEqual(["/luau-root"]);
		});
	});
});
