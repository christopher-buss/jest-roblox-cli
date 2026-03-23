import { fromPartial } from "@total-typescript/shoehorn";

import { vol } from "memfs";
import * as cp from "node:child_process";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { instrument, instrumentRoot } from "./instrumenter.ts";

vi.mock<typeof import("node:os")>(import("node:os"), async (importOriginal) => {
	const actual = await importOriginal();
	return { ...actual, tmpdir: vi.fn<() => string>(() => "/tmp") };
});
vi.mock<typeof import("node:child_process")>(import("node:child_process"));

// @ts-expect-error -- memfs factory doesn't match node:fs overload signatures
vi.mock<typeof import("node:fs")>(import("node:fs"), async () => {
	const memfs = await vi.importActual<typeof import("memfs")>("memfs");
	return { ...memfs.fs, default: memfs.fs };
});

const EMPTY_AST = {
	kind: "stat",
	location: { begincolumn: 1, beginline: 1, endcolumn: 1, endline: 1 },
	statements: [],
	tag: "block",
};

const DEFAULT_FILES: Record<string, unknown> = { "init.luau": EMPTY_AST };

function callInstrumentWithDefaults() {
	return instrument({
		astOutputDirectory: "/tmp/asts",
		luauRoot: "/luau-root",
		manifestPath: "/manifest.json",
		parseScript: "mock.luau",
		shadowDir: "/shadow",
	});
}

/**
 * Seed memfs with source + AST files and configure lute mock.
 * Returns the file list that lute would return.
 */
function setupFilesystem(
	options: {
		astOutputDirectory?: string;
		files?: Record<string, unknown>;
		luauRoot?: string;
	} = {},
): void {
	const {
		astOutputDirectory = "/tmp/asts",
		files = DEFAULT_FILES,
		luauRoot = "/luau-root",
	} = options;

	onTestFinished(() => {
		vol.reset();
	});

	const fileNames = Object.keys(files);

	// Seed source files
	for (const relativePath of fileNames) {
		const sourcePath = `${luauRoot}/${relativePath}`;
		const directory = sourcePath.substring(0, sourcePath.lastIndexOf("/"));
		vol.mkdirSync(directory, { recursive: true });
		vol.writeFileSync(sourcePath, "local x = 1\n");
	}

	// Seed AST JSON files
	vol.mkdirSync(astOutputDirectory, { recursive: true });
	for (const [relativePath, ast] of Object.entries(files)) {
		const astPath = `${astOutputDirectory}/${relativePath}.json`;
		const directory = astPath.substring(0, astPath.lastIndexOf("/"));
		vol.mkdirSync(directory, { recursive: true });
		vol.writeFileSync(astPath, JSON.stringify(ast)!);
	}

	// Lute returns the file list
	vi.mocked(cp.execFileSync).mockReturnValue(JSON.stringify(fileNames));
}

describe(instrumentRoot, () => {
	describe("when skipFiles is provided", () => {
		it("should skip files listed in skipFiles", () => {
			expect.assertions(2);

			setupFilesystem({
				files: {
					"init.luau": EMPTY_AST,
					"shared/player.luau": EMPTY_AST,
				},
			});

			const files = instrumentRoot({
				astOutputDirectory: "/tmp/asts",
				luauRoot: "/luau-root",
				parseScript: "mock.luau",
				shadowDir: "/shadow",
				skipFiles: new Set(["shared/player.luau"]),
			});

			const keys = Object.keys(files);

			expect(keys).toContain("/luau-root/init.luau");
			expect(keys).not.toContain("/luau-root/shared/player.luau");
		});
	});

	describe("when the file list includes snapshot files", () => {
		it("should exclude .snap.luau files from instrumentation", () => {
			expect.assertions(2);

			setupFilesystem({
				files: {
					"__snapshots__/Button.spec.snap.luau": EMPTY_AST,
					"init.luau": EMPTY_AST,
				},
			});

			const files = instrumentRoot({
				astOutputDirectory: "/tmp/asts",
				luauRoot: "/luau-root",
				parseScript: "mock.luau",
				shadowDir: "/shadow",
			});

			const keys = Object.keys(files);

			expect(keys).toContain("/luau-root/init.luau");
			expect(keys).not.toContain("/luau-root/__snapshots__/Button.spec.snap.luau");
		});
	});

	describe("when instrumenting a single root", () => {
		it("should return file records without writing a manifest", () => {
			expect.assertions(2);

			setupFilesystem();

			const files = instrumentRoot({
				astOutputDirectory: "/tmp/asts",
				luauRoot: "/luau-root",
				parseScript: "mock.luau",
				shadowDir: "/shadow",
			});

			expect(Object.keys(files)).toStrictEqual(["/luau-root/init.luau"]);
			expect(vol.existsSync("/shadow/manifest.json")).toBeFalse();
		});
	});
});

describe(instrument, () => {
	describe("when processing files from lute", () => {
		it("should create file records for each entry in the file list", () => {
			expect.assertions(3);

			setupFilesystem({
				files: {
					"init.luau": EMPTY_AST,
					"shared/player.luau": EMPTY_AST,
				},
			});

			const result = instrument({
				astOutputDirectory: "/tmp/asts",
				luauRoot: "/luau-root",
				manifestPath: "/manifest.json",
				parseScript: "mock.luau",
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
				files: { "shared/player.luau": EMPTY_AST },
			});

			instrument({
				astOutputDirectory: "/tmp/asts",
				luauRoot: "/luau-root",
				manifestPath: "/manifest.json",
				parseScript: "mock.luau",
				shadowDir: "/shadow",
			});

			expect(vol.existsSync("/shadow/shared/player.luau")).toBeTrue();
		});

		it("should emit manifest JSON with correct top-level fields", () => {
			expect.assertions(3);

			setupFilesystem();

			const result = instrument({
				astOutputDirectory: "/tmp/asts",
				luauRoot: "/luau-root",
				manifestPath: "/manifest.json",
				parseScript: "mock.luau",
				shadowDir: "/shadow",
			});

			expect(result.version).toBe(1);
			expect(result.shadowDir).toBeDefined();
			expect(result.generatedAt).toBeDefined();
		});

		it("should include sourceHash in each file record", () => {
			expect.assertions(1);

			setupFilesystem();

			const result = instrument({
				astOutputDirectory: "/tmp/asts",
				luauRoot: "/luau-root",
				manifestPath: "/manifest.json",
				parseScript: "mock.luau",
				shadowDir: "/shadow",
			});

			const record = result.files["/luau-root/init.luau"];

			expect(record?.sourceHash).toMatch(/^[a-f0-9]{64}$/);
		});

		it("should include instrumenterVersion in manifest", () => {
			expect.assertions(1);

			setupFilesystem();

			const result = instrument({
				astOutputDirectory: "/tmp/asts",
				luauRoot: "/luau-root",
				manifestPath: "/manifest.json",
				parseScript: "mock.luau",
				shadowDir: "/shadow",
			});

			expect(result.instrumenterVersion).toBe(2);
		});

		it("should emit manifest file records with correct metadata", () => {
			expect.assertions(3);

			const astWithStatement = {
				kind: "stat",
				location: { begincolumn: 1, beginline: 1, endcolumn: 12, endline: 1 },
				statements: [
					{
						kind: "stat",
						location: { begincolumn: 1, beginline: 1, endcolumn: 12, endline: 1 },
						tag: "local",
						values: [],
						variables: [],
					},
				],
				tag: "block",
			};

			setupFilesystem({ files: { "init.luau": astWithStatement } });

			const result = instrument({
				astOutputDirectory: "/tmp/asts",
				luauRoot: "/luau-root",
				manifestPath: "/manifest.json",
				parseScript: "mock.luau",
				shadowDir: "/shadow",
			});

			expect(result.files["/luau-root/init.luau"]).toBeDefined();
			expect(result.files["/luau-root/init.luau"]?.statementCount).toBe(1);
			expect(result.files["/luau-root/init.luau"]?.key).toBe("/luau-root/init.luau");
		});

		it("should write covmap sidecar for each file", () => {
			expect.assertions(2);

			setupFilesystem({
				files: {
					"init.luau": EMPTY_AST,
					"shared/player.luau": EMPTY_AST,
				},
			});

			instrument({
				astOutputDirectory: "/tmp/asts",
				luauRoot: "/luau-root",
				manifestPath: "/manifest.json",
				parseScript: "mock.luau",
				shadowDir: "/shadow",
			});

			expect(vol.existsSync("/shadow/init.cov-map.json")).toBeTrue();
			expect(vol.existsSync("/shadow/shared/player.cov-map.json")).toBeTrue();
		});
	});

	describe("when normalizing paths", () => {
		it("should normalize paths to POSIX format", () => {
			expect.assertions(3);

			setupFilesystem({ files: { "shared/player.luau": EMPTY_AST } });

			const result = instrument({
				astOutputDirectory: "/tmp/asts",
				luauRoot: "/luau-root",
				manifestPath: "/manifest.json",
				parseScript: "mock.luau",
				shadowDir: "/shadow",
			});

			for (const key of Object.keys(result.files)) {
				expect(key).not.toContain("\\");
			}

			const record = result.files["/luau-root/shared/player.luau"];

			expect(record?.originalLuauPath).not.toContain("\\");
			expect(record?.instrumentedLuauPath).not.toContain("\\");
		});
	});

	describe("when resolving the parse script path", () => {
		it("should write parse-ast.luau to a temp directory when parseScript is not provided", () => {
			expect.assertions(1);

			setupFilesystem();

			instrument({
				astOutputDirectory: "/tmp/asts",
				luauRoot: "/luau-root",
				manifestPath: "/manifest.json",
				shadowDir: "/shadow",
			});

			const allFiles = vol.toJSON();
			const parseAstFiles = Object.keys(allFiles).filter((filePath) => {
				return filePath.includes("parse-ast.luau");
			});

			expect(parseAstFiles).toHaveLength(1);
		});

		it("should reuse the cached script path on subsequent calls", () => {
			expect.assertions(1);

			setupFilesystem();

			// First call: creates temp dir + parse-ast.luau
			instrument({
				astOutputDirectory: "/tmp/asts",
				luauRoot: "/luau-root",
				manifestPath: "/manifest.json",
				shadowDir: "/shadow",
			});

			const filesAfterFirst = vol.toJSON();
			const temporaryDirectories = Object.keys(filesAfterFirst).filter((filePath) => {
				return filePath.includes("jest-roblox-instrument-");
			});

			// Second call: should reuse the same temp dir
			instrument({
				astOutputDirectory: "/tmp/asts",
				luauRoot: "/luau-root",
				manifestPath: "/manifest.json",
				shadowDir: "/shadow",
			});

			const filesAfterSecond = vol.toJSON();
			const temporaryDirectoriesAfter = Object.keys(filesAfterSecond).filter((filePath) => {
				return filePath.includes("jest-roblox-instrument-");
			});

			expect(temporaryDirectoriesAfter).toStrictEqual(temporaryDirectories);
		});
	});

	describe("when lute is not available", () => {
		it("should throw a friendly error when lute is not found on PATH", () => {
			expect.assertions(1);

			setupFilesystem();

			const enoentError = Object.assign(new Error("spawn lute ENOENT"), {
				code: "ENOENT",
			});
			vi.mocked(cp.execFileSync).mockImplementation(() => {
				throw enoentError;
			});

			expect(() => {
				instrument({
					astOutputDirectory: "/tmp/asts",
					luauRoot: "/luau-root",
					manifestPath: "/manifest.json",
					parseScript: "mock.luau",
					shadowDir: "/shadow",
				});
			}).toThrowWithMessage(
				Error,
				"lute is required for instrumentation but was not found on PATH",
			);
		});

		it("should throw a contextual error for other lute failures", () => {
			expect.assertions(2);

			setupFilesystem();

			const originalError = new Error("lute exited with code 1");
			vi.mocked(cp.execFileSync).mockImplementation(() => {
				throw originalError;
			});

			expect(callInstrumentWithDefaults).toThrowWithMessage(
				Error,
				"Failed to parse Luau files",
			);
			expect(callInstrumentWithDefaults).toThrow(
				expect.objectContaining(fromPartial({ cause: originalError })),
			);
		});
	});

	describe("when the file list is invalid", () => {
		it("should throw when lute returns invalid JSON", () => {
			expect.assertions(1);

			setupFilesystem();
			vi.mocked(cp.execFileSync).mockReturnValue("not json {{{");

			expect(() => {
				instrument({
					astOutputDirectory: "/tmp/asts",
					luauRoot: "/luau-root",
					manifestPath: "/manifest.json",
					parseScript: "mock.luau",
					shadowDir: "/shadow",
				});
			}).toThrowWithMessage(Error, "Failed to parse file list from lute");
		});

		it("should throw when lute returns a non-array", () => {
			expect.assertions(1);

			setupFilesystem();
			vi.mocked(cp.execFileSync).mockReturnValue('{"not": "array"}');

			expect(() => {
				instrument({
					astOutputDirectory: "/tmp/asts",
					luauRoot: "/luau-root",
					manifestPath: "/manifest.json",
					parseScript: "mock.luau",
					shadowDir: "/shadow",
				});
			}).toThrowWithMessage(Error, "Expected file list array from lute");
		});
	});

	describe("when emitting luauRoots in the manifest", () => {
		it("should include luauRoots array with the single root", () => {
			expect.assertions(1);

			setupFilesystem();

			const result = instrument({
				astOutputDirectory: "/tmp/asts",
				luauRoot: "/luau-root",
				manifestPath: "/manifest.json",
				parseScript: "mock.luau",
				shadowDir: "/shadow",
			});

			expect(result.luauRoots).toStrictEqual(["/luau-root"]);
		});
	});

	describe("when astOutputDirectory is not provided", () => {
		it("should fall back to a temporary directory for AST output", () => {
			expect.assertions(1);

			onTestFinished(() => {
				vol.reset();
			});
			vol.mkdirSync("/tmp", { recursive: true });
			vol.mkdirSync("/luau-root", { recursive: true });
			vi.mocked(cp.execFileSync).mockReturnValue("[]");

			const files = instrumentRoot({
				luauRoot: "/luau-root",
				parseScript: "mock.luau",
				shadowDir: "/shadow",
			});

			expect(files).toBeEmpty();
		});
	});

	describe("when creating the AST output directory", () => {
		it("should create the AST output directory before calling lute", () => {
			expect.assertions(1);

			setupFilesystem();

			instrument({
				astOutputDirectory: "/tmp/asts",
				luauRoot: "/luau-root",
				manifestPath: "/manifest.json",
				parseScript: "mock.luau",
				shadowDir: "/shadow",
			});

			expect(vol.existsSync("/tmp/asts")).toBeTrue();
		});

		it("should throw contextual error when per-file AST read fails", () => {
			expect.assertions(2);

			// Seed init.luau but NOT missing.luau's AST JSON
			setupFilesystem({
				files: { "init.luau": EMPTY_AST },
			});

			// Override lute to claim missing.luau also exists
			vi.mocked(cp.execFileSync).mockReturnValue(
				JSON.stringify(["init.luau", "missing.luau"]),
			);

			// Seed the source file for missing.luau (but no AST JSON)
			vol.mkdirSync("/luau-root", { recursive: true });
			vol.writeFileSync("/luau-root/missing.luau", "local y = 2\n");

			expect(callInstrumentWithDefaults).toThrowWithMessage(
				Error,
				"Failed to read AST for missing.luau",
			);
			expect(callInstrumentWithDefaults).toThrow(
				expect.objectContaining(fromPartial<Error>({ cause: expect.any(Error) })),
			);
		});

		it("should pass the AST output directory to lute", () => {
			expect.assertions(1);

			setupFilesystem();

			instrument({
				astOutputDirectory: "/tmp/asts",
				luauRoot: "/luau-root",
				manifestPath: "/manifest.json",
				parseScript: "mock.luau",
				shadowDir: "/shadow",
			});

			const luteCall = vi.mocked(cp.execFileSync).mock.calls[0];
			const luteArguments = luteCall?.[1] as Array<string>;

			expect(luteArguments).toContain("/tmp/asts");
		});
	});
});
