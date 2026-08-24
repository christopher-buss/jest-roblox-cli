import { fromAny } from "@total-typescript/shoehorn";

import { vol } from "memfs";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { createTimingCollector } from "../timing/orchestration-collector.ts";
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
	return /^local __cov_file_key = (.+)$/m.exec(instrumented)?.[1];
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
		it("should record the parse-ast, probe-insert, and map-build sub-phases", () => {
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
				"[TIMING] parse-ast: 0ms",
				"[TIMING] probe-insert: 0ms",
				"[TIMING] map-build: 0ms",
				"[TIMING] TOTAL (host): 0ms",
			]);
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

			expect(result.instrumenterVersion).toBe(4);
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
