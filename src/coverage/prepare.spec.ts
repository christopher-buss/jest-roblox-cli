import { fromAny } from "@total-typescript/shoehorn";

import { vol } from "memfs";
import * as crypto from "node:crypto";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import type { ResolvedConfig } from "../config/schema.ts";
import { DEFAULT_CONFIG } from "../config/schema.ts";
import { INSTRUMENTER_VERSION } from "./instrumenter.ts";
import {
	collectLuauRootsFromRojo,
	discoverInstrumentableFiles,
	prepareCoverage,
	resolveLuauRoots,
} from "./prepare.ts";
import type { RojoProject } from "./rojo-rewriter.ts";
import type {
	CoverageManifest,
	InstrumentedFileRecord,
	NonInstrumentedFileRecord,
} from "./types.ts";

vi.mock(import("node:fs"), async () => {
	const memfs = await vi.importActual<typeof import("memfs")>("memfs");
	return fromAny({ ...memfs.fs, cpSync: memfs.vol.cpSync.bind(memfs.vol), default: memfs.fs });
});
vi.mock(import("./instrumenter"));
vi.mock(import("./rojo-builder"));
vi.mock(import("get-tsconfig"));

const ROJO_PROJECT = {
	name: "test",
	tree: {
		$className: "DataModel",
		ReplicatedStorage: {
			$path: "out-tsc/test/client",
		},
	},
};

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
	return {
		...DEFAULT_CONFIG,
		collectCoverage: true,
		rootDir: "/project",
		...overrides,
	};
}

async function setupMocks(options: { outDir?: string } = {}) {
	onTestFinished(() => {
		vol.reset();
	});
	const { outDir } = options;

	const { getTsconfig } = await import("get-tsconfig");
	vi.mocked(getTsconfig).mockReturnValue(
		outDir !== undefined
			? ({
					config: { compilerOptions: { outDir } },
					path: "/project/tsconfig.json",
				} as NonNullable<ReturnType<typeof getTsconfig>>)
			: null,
	);

	const { instrumentRoot } = await import("./instrumenter");
	vi.mocked(instrumentRoot).mockReturnValue({});

	const { buildWithRojo } = await import("./rojo-builder");
	vi.mocked(buildWithRojo).mockReturnValue(undefined);

	return { buildWithRojo, instrumentRoot };
}

function seedFilesystem(options: { luauRoot?: string; rojoProject?: string } = {}) {
	const { luauRoot = "out-tsc/test", rojoProject = "/project/default.project.json" } = options;
	vol.mkdirSync("/project", { recursive: true });
	vol.mkdirSync(luauRoot, { recursive: true });
	vol.writeFileSync(`${luauRoot}/init.luau`, "local x = 1");
	vol.writeFileSync(rojoProject, JSON.stringify(ROJO_PROJECT));
}

describe(prepareCoverage, () => {
	describe("when resolving luauRoots", () => {
		it("should use config.luauRoots when provided", async () => {
			expect.assertions(1);

			seedFilesystem();
			const { instrumentRoot } = await setupMocks();
			const config = makeConfig({ luauRoots: ["out-tsc/test"] });

			prepareCoverage(config);

			expect(instrumentRoot).toHaveBeenCalledWith(
				expect.objectContaining({ luauRoot: "out-tsc/test" }),
			);
		});

		it("should auto-detect luauRoots from tsconfig outDir", async () => {
			expect.assertions(1);

			seedFilesystem({ luauRoot: "out" });
			const { instrumentRoot } = await setupMocks({ outDir: "out" });
			const config = makeConfig();

			prepareCoverage(config);

			expect(instrumentRoot).toHaveBeenCalledWith(
				expect.objectContaining({ luauRoot: "out" }),
			);
		});

		it("should throw when luauRoots contains an absolute path", async () => {
			expect.assertions(1);

			seedFilesystem({ luauRoot: "/abs/out" });
			await setupMocks();
			const config = makeConfig({ luauRoots: ["/abs/out"] });

			expect(() => prepareCoverage(config)).toThrow(/luauRoots must be relative paths/);
		});

		it("should throw when luauRoots is not provided and tsconfig has no outDir", async () => {
			expect.assertions(1);

			seedFilesystem();
			await setupMocks();
			const config = makeConfig();

			expect(() => prepareCoverage(config)).toThrow(/Could not determine luauRoots/);
		});
	});

	describe("when preparing the shadow directory", () => {
		it("should wipe and recreate the shadow directory on each run", async () => {
			expect.assertions(2);

			seedFilesystem();
			vol.mkdirSync(".jest-roblox-coverage/stale", { recursive: true });
			vol.writeFileSync(".jest-roblox-coverage/stale/old.txt", "stale");

			await setupMocks();
			const config = makeConfig({ luauRoots: ["out-tsc/test"] });

			prepareCoverage(config);

			expect(vol.existsSync(".jest-roblox-coverage/stale/old.txt")).toBeFalse();
			expect(vol.existsSync(".jest-roblox-coverage")).toBeTrue();
		});

		it("should copy each root tree to the shadow directory", async () => {
			expect.assertions(1);

			seedFilesystem();
			await setupMocks();
			const config = makeConfig({ luauRoots: ["out-tsc/test"] });

			prepareCoverage(config);

			expect(vol.readFileSync(".jest-roblox-coverage/out-tsc/test/init.luau", "utf-8")).toBe(
				"local x = 1",
			);
		});
	});

	describe("when rewriting and building the Rojo project", () => {
		it("should rewrite the Rojo project and invoke rojo build", async () => {
			expect.assertions(2);

			seedFilesystem();
			const { buildWithRojo } = await setupMocks();
			const config = makeConfig({ luauRoots: ["out-tsc/test"] });

			prepareCoverage(config);

			expect(vol.existsSync(".jest-roblox-coverage/default.project.json")).toBeTrue();
			expect(buildWithRojo).toHaveBeenCalledWith(
				expect.stringContaining(".jest-roblox-coverage"),
				expect.stringContaining("game.rbxl"),
			);
		});

		it("should use config.rojoProject when provided", async () => {
			expect.assertions(1);

			seedFilesystem({ rojoProject: "/custom.project.json" });
			await setupMocks();
			const config = makeConfig({
				luauRoots: ["out-tsc/test"],
				rojoProject: "/custom.project.json",
			});

			prepareCoverage(config);

			expect(vol.existsSync(".jest-roblox-coverage/custom.project.json")).toBeTrue();
		});

		it("should auto-detect the Rojo project when not configured", async () => {
			expect.assertions(1);

			seedFilesystem();
			await setupMocks();
			const config = makeConfig({ luauRoots: ["out-tsc/test"] });

			prepareCoverage(config);

			expect(vol.existsSync(".jest-roblox-coverage/default.project.json")).toBeTrue();
		});

		it("should find a non-default .project.json via directory listing", async () => {
			expect.assertions(1);

			seedFilesystem({ rojoProject: "/project/game.project.json" });
			await setupMocks();
			const config = makeConfig({ luauRoots: ["out-tsc/test"] });

			prepareCoverage(config);

			expect(vol.existsSync(".jest-roblox-coverage/game.project.json")).toBeTrue();
		});

		it("should throw when Rojo project has valid JSON but invalid schema", async () => {
			expect.assertions(1);

			seedFilesystem();
			vol.writeFileSync("/project/default.project.json", JSON.stringify({ invalid: true }));
			await setupMocks();
			const config = makeConfig({ luauRoots: ["out-tsc/test"] });

			expect(() => prepareCoverage(config)).toThrow(/Malformed Rojo project JSON/);
		});

		it("should throw when no Rojo project is found", async () => {
			expect.assertions(1);

			vol.mkdirSync("/project", { recursive: true });
			vol.mkdirSync("out-tsc/test", { recursive: true });
			await setupMocks();
			const config = makeConfig({ luauRoots: ["out-tsc/test"] });

			expect(() => prepareCoverage(config)).toThrow(/No Rojo project found/);
		});
	});

	describe("when computing projectRelocation", () => {
		it("should pass projectRelocation to rewriteRojoProject based on project file location", async () => {
			expect.assertions(2);

			const projectWithExternal = {
				name: "test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: {
						$path: "out-tsc/test/client",
					},
					ServerScriptService: {
						$path: "include",
					},
				},
			};

			// Use rootDir "." so rojo project is at ./default.project.json
			// and coverage dir is .jest-roblox-coverage/ — both relative
			vol.mkdirSync(".", { recursive: true });
			vol.mkdirSync("out-tsc/test", { recursive: true });
			vol.writeFileSync("out-tsc/test/init.luau", "local x = 1");
			vol.writeFileSync("default.project.json", JSON.stringify(projectWithExternal));

			await setupMocks();
			const config = makeConfig({ luauRoots: ["out-tsc/test"], rootDir: "." });

			prepareCoverage(config);

			const written: Record<string, unknown> = JSON.parse(
				vol.readFileSync(".jest-roblox-coverage/default.project.json", "utf-8") as string,
			) as Record<string, unknown>;
			const tree = written["tree"] as Record<string, Record<string, string>>;

			// Matching path: stripped shadow prefix (relative to relocated
			// project)
			expect(tree["ReplicatedStorage"]!["$path"]).toBe("out-tsc/test/client");
			// Non-matching path: rebased with ".." to reach original project dir
			expect(tree["ServerScriptService"]!["$path"]).toBe("../include");
		});
	});

	describe("when Rojo project has nested project references", () => {
		it("should resolve nested .project.json refs before rewriting paths", async () => {
			expect.assertions(1);

			const developmentProject = {
				name: "development",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: {
						"uuid-generator": {
							$path: "default.project.json",
						},
					},
				},
			};
			const defaultProject = {
				name: "uuid-generator",
				tree: {
					$className: "Folder",
					$path: "src",
				},
			};

			vol.mkdirSync("/project", { recursive: true });
			vol.mkdirSync("src", { recursive: true });
			vol.writeFileSync("src/init.luau", "local x = 1");
			vol.writeFileSync(
				"/project/development.project.json",
				JSON.stringify(developmentProject),
			);
			vol.writeFileSync("/project/default.project.json", JSON.stringify(defaultProject));

			await setupMocks();
			const config = makeConfig({
				luauRoots: ["src"],
				rojoProject: "/project/development.project.json",
			});

			prepareCoverage(config);

			const written: Record<string, unknown> = JSON.parse(
				vol.readFileSync(
					".jest-roblox-coverage/development.project.json",
					"utf-8",
				) as string,
			) as Record<string, unknown>;
			const tree = written["tree"] as Record<string, Record<string, Record<string, string>>>;

			// The nested $path: "default.project.json" is resolved to $path:
			// "src". "src" is already relative to the shadow directory, so no
			// rewrite needed.
			expect(tree["ReplicatedStorage"]!["uuid-generator"]!["$path"]).toBe("src");
		});
	});

	describe("when returning results", () => {
		it("should return the manifest and placeFile path", async () => {
			expect.assertions(2);

			seedFilesystem();
			await setupMocks();
			const config = makeConfig({ luauRoots: ["out-tsc/test"] });

			const result = prepareCoverage(config);

			expect(result.manifest.luauRoots).toStrictEqual(["out-tsc/test"]);
			expect(result.placeFile).toContain("game.rbxl");
		});
	});

	describe("when running in incremental mode", () => {
		function sha256(content: string): string {
			return crypto.createHash("sha256").update(content).digest("hex");
		}

		function makeFileRecord(
			overrides: Partial<InstrumentedFileRecord> & { key: string },
		): InstrumentedFileRecord {
			return {
				branchCount: 0,
				coverageMapPath: overrides.key.replace(/\.luau$/, ".cov-map.json"),
				functionCount: 0,
				instrumentedLuauPath: `.jest-roblox-coverage/${overrides.key}`,
				originalLuauPath: overrides.key,
				sourceHash: sha256("local x = 1"),
				sourceMapPath: `${overrides.key}.map`,
				statementCount: 0,
				...overrides,
			};
		}

		function seedPreviousManifest(manifest: CoverageManifest) {
			vol.mkdirSync(".jest-roblox-coverage", { recursive: true });
			vol.writeFileSync(".jest-roblox-coverage/manifest.json", JSON.stringify(manifest));
		}

		function seedIncrementalScenario(
			options: {
				fileContents?: Record<string, string>;
				previousFiles?: Record<string, InstrumentedFileRecord>;
				previousInstrumenterVersion?: number;
				previousNonInstrumentedFiles?: Record<string, NonInstrumentedFileRecord>;
				previousPlaceFilePath?: string;
			} = {},
		) {
			const {
				fileContents = { "out-tsc/test/init.luau": "local x = 1" },
				previousFiles = {
					"out-tsc/test/init.luau": makeFileRecord({
						key: "out-tsc/test/init.luau",
					}),
				},
				previousInstrumenterVersion = INSTRUMENTER_VERSION,
				previousNonInstrumentedFiles = {},
				previousPlaceFilePath = ".jest-roblox-coverage/game.rbxl",
			} = options;

			seedFilesystem();

			// Seed source files with specified content
			for (const [filePath, content] of Object.entries(fileContents)) {
				const directory = filePath.substring(0, filePath.lastIndexOf("/"));
				vol.mkdirSync(directory, { recursive: true });
				vol.writeFileSync(filePath, content);
			}

			// Seed shadow dir with "instrumented" files
			for (const record of Object.values(previousFiles)) {
				const shadowPath = record.instrumentedLuauPath;
				const directory = shadowPath.substring(0, shadowPath.lastIndexOf("/"));
				vol.mkdirSync(directory, { recursive: true });
				vol.writeFileSync(shadowPath, "-- instrumented");
				// Also seed cov-map sidecar
				vol.writeFileSync(record.coverageMapPath, "{}");
			}

			// Seed shadow dir with non-instrumented files
			for (const record of Object.values(previousNonInstrumentedFiles)) {
				const directory = record.shadowPath.substring(
					0,
					record.shadowPath.lastIndexOf("/"),
				);
				vol.mkdirSync(directory, { recursive: true });
				vol.writeFileSync(record.shadowPath, "-- old spec content");
			}

			// Seed previous place file
			if (previousPlaceFilePath) {
				vol.writeFileSync(previousPlaceFilePath, "RBXL");
			}

			seedPreviousManifest({
				files: previousFiles,
				generatedAt: new Date().toISOString(),
				instrumenterVersion: previousInstrumenterVersion,
				luauRoots: ["out-tsc/test"],
				nonInstrumentedFiles: previousNonInstrumentedFiles,
				placeFilePath: previousPlaceFilePath,
				shadowDir: ".jest-roblox-coverage",
				version: 1,
			});
		}

		it("should store sourceHash in each file record", async () => {
			expect.assertions(1);

			seedFilesystem();
			const { instrumentRoot } = await setupMocks();
			vi.mocked(instrumentRoot).mockImplementation((options) => {
				return {
					[`${options.luauRoot}/init.luau`]: makeFileRecord({
						key: `${options.luauRoot}/init.luau`,
					}),
				};
			});
			const config = makeConfig({ luauRoots: ["out-tsc/test"] });

			const result = prepareCoverage(config);

			const record = Object.values(result.manifest.files)[0];

			expect(record!.sourceHash).toMatch(/^[a-f0-9]{64}$/);
		});

		it("should include instrumenterVersion in manifest", async () => {
			expect.assertions(1);

			seedFilesystem();
			await setupMocks();
			const config = makeConfig({ luauRoots: ["out-tsc/test"] });

			const result = prepareCoverage(config);

			expect(result.manifest.instrumenterVersion).toBe(INSTRUMENTER_VERSION);
		});

		it("should include placeFilePath in manifest", async () => {
			expect.assertions(1);

			seedFilesystem();
			await setupMocks();
			const config = makeConfig({ luauRoots: ["out-tsc/test"] });

			const result = prepareCoverage(config);

			expect(result.manifest.placeFilePath).toContain("game.rbxl");
		});

		it("should carry forward records for unchanged files without calling instrumentRoot", async () => {
			expect.assertions(2);

			const { instrumentRoot } = await setupMocks();

			seedIncrementalScenario();

			const config = makeConfig({ luauRoots: ["out-tsc/test"] });

			const result = prepareCoverage(config);

			// Full cache hit — instrumentRoot skipped entirely
			expect(instrumentRoot).not.toHaveBeenCalled();
			// Unchanged record carried forward
			expect(result.manifest.files["out-tsc/test/init.luau"]).toBeDefined();
		});

		it("should re-instrument files whose source hash changed", async () => {
			expect.assertions(1);

			const { instrumentRoot } = await setupMocks();
			const updatedRecord = makeFileRecord({
				key: "out-tsc/test/init.luau",
				sourceHash: sha256("local x = 2"),
			});
			vi.mocked(instrumentRoot).mockReturnValue({
				"out-tsc/test/init.luau": updatedRecord,
			});

			seedIncrementalScenario({
				fileContents: { "out-tsc/test/init.luau": "local x = 2" },
			});

			const config = makeConfig({ luauRoots: ["out-tsc/test"] });

			prepareCoverage(config);

			expect(instrumentRoot).toHaveBeenCalledWith(
				expect.objectContaining({
					skipFiles: new Set(),
				}),
			);
		});

		it("should instrument new files not in previous manifest", async () => {
			expect.assertions(1);

			const { instrumentRoot } = await setupMocks();
			vi.mocked(instrumentRoot).mockReturnValue({
				"out-tsc/test/new.luau": makeFileRecord({
					key: "out-tsc/test/new.luau",
				}),
			});

			seedIncrementalScenario();
			// Add a new source file
			vol.writeFileSync("out-tsc/test/new.luau", "local y = 1");

			const config = makeConfig({ luauRoots: ["out-tsc/test"] });

			prepareCoverage(config);

			// init.luau is unchanged → skipped; new.luau is new → not skipped
			expect(instrumentRoot).toHaveBeenCalledWith(
				expect.objectContaining({
					skipFiles: new Set(["init.luau"]),
				}),
			);
		});

		it("should remove deleted files from shadow dir and manifest", async () => {
			expect.assertions(2);

			const deletedRecord = makeFileRecord({
				key: "out-tsc/test/deleted.luau",
				coverageMapPath: ".jest-roblox-coverage/out-tsc/test/deleted.cov-map.json",
				instrumentedLuauPath: ".jest-roblox-coverage/out-tsc/test/deleted.luau",
			});

			const { instrumentRoot } = await setupMocks();
			vi.mocked(instrumentRoot).mockReturnValue({});

			seedIncrementalScenario({
				fileContents: {
					"out-tsc/test/deleted.luau": "local y = 1",
					"out-tsc/test/init.luau": "local x = 1",
				},
				previousFiles: {
					"out-tsc/test/deleted.luau": deletedRecord,
					"out-tsc/test/init.luau": makeFileRecord({
						key: "out-tsc/test/init.luau",
					}),
				},
			});
			// Remove the source file (simulating deletion after previous run)
			vol.unlinkSync("out-tsc/test/deleted.luau");

			const config = makeConfig({ luauRoots: ["out-tsc/test"] });

			const result = prepareCoverage(config);

			expect(result.manifest.files["out-tsc/test/deleted.luau"]).toBeUndefined();
			expect(vol.existsSync(".jest-roblox-coverage/out-tsc/test/deleted.luau")).toBeFalse();
		});

		it("should handle cleanup when shadow files are already missing", async () => {
			expect.assertions(1);

			const deletedRecord = makeFileRecord({
				key: "out-tsc/test/deleted.luau",
				coverageMapPath: ".jest-roblox-coverage/out-tsc/test/deleted.cov-map.json",
				instrumentedLuauPath: ".jest-roblox-coverage/out-tsc/test/deleted.luau",
			});

			const { instrumentRoot } = await setupMocks();
			vi.mocked(instrumentRoot).mockReturnValue({});

			seedIncrementalScenario({
				fileContents: {
					"out-tsc/test/deleted.luau": "local y = 1",
					"out-tsc/test/init.luau": "local x = 1",
				},
				previousFiles: {
					"out-tsc/test/deleted.luau": deletedRecord,
					"out-tsc/test/init.luau": makeFileRecord({
						key: "out-tsc/test/init.luau",
					}),
				},
			});
			// Remove source AND shadow files (simulating prior partial cleanup)
			vol.unlinkSync("out-tsc/test/deleted.luau");
			vol.unlinkSync(".jest-roblox-coverage/out-tsc/test/deleted.luau");
			vol.unlinkSync(".jest-roblox-coverage/out-tsc/test/deleted.cov-map.json");

			const config = makeConfig({ luauRoots: ["out-tsc/test"] });

			const result = prepareCoverage(config);

			expect(result.manifest.files["out-tsc/test/deleted.luau"]).toBeUndefined();
		});

		it("should skip rojo build and instrumentRoot when no files changed", async () => {
			expect.assertions(3);

			const { buildWithRojo, instrumentRoot } = await setupMocks();

			seedIncrementalScenario();

			const config = makeConfig({ luauRoots: ["out-tsc/test"] });

			const result = prepareCoverage(config);

			expect(instrumentRoot).not.toHaveBeenCalled();
			expect(buildWithRojo).not.toHaveBeenCalled();
			expect(result.placeFile).toBe(".jest-roblox-coverage/game.rbxl");
		});

		it("should call instrumentRoot when a new file appears on disk", async () => {
			expect.assertions(1);

			const { instrumentRoot } = await setupMocks();

			seedIncrementalScenario();

			// Add a new file that wasn't in the previous manifest
			vol.writeFileSync("out-tsc/test/new-module.luau", "local y = 2");

			const config = makeConfig({ luauRoots: ["out-tsc/test"] });

			prepareCoverage(config);

			expect(instrumentRoot).toHaveBeenCalledOnce();
		});

		it("should call instrumentRoot when a file is deleted", async () => {
			expect.assertions(1);

			const { instrumentRoot } = await setupMocks();

			seedIncrementalScenario({
				fileContents: {
					"out-tsc/test/a.luau": "local a = 1",
					"out-tsc/test/b.luau": "local b = 1",
				},
				previousFiles: {
					"out-tsc/test/a.luau": makeFileRecord({
						key: "out-tsc/test/a.luau",
						sourceHash: sha256("local a = 1"),
					}),
					"out-tsc/test/b.luau": makeFileRecord({
						key: "out-tsc/test/b.luau",
						sourceHash: sha256("local b = 1"),
					}),
				},
			});

			// Delete one source file
			vol.unlinkSync("out-tsc/test/b.luau");

			const config = makeConfig({ luauRoots: ["out-tsc/test"] });

			prepareCoverage(config);

			expect(instrumentRoot).toHaveBeenCalledOnce();
		});

		it("should still rebuild rojo when only non-instrumented file changed", async () => {
			expect.assertions(2);

			const { buildWithRojo, instrumentRoot } = await setupMocks();

			const specRecord: NonInstrumentedFileRecord = {
				shadowPath: ".jest-roblox-coverage/out-tsc/test/init.spec.luau",
				sourceHash: sha256("-- old spec"),
				sourcePath: "out-tsc/test/init.spec.luau",
			};

			seedIncrementalScenario({
				previousNonInstrumentedFiles: { "out-tsc/test/init.spec.luau": specRecord },
			});

			// Write a changed spec file
			vol.writeFileSync("out-tsc/test/init.spec.luau", "-- new spec");

			const config = makeConfig({ luauRoots: ["out-tsc/test"] });

			prepareCoverage(config);

			expect(instrumentRoot).not.toHaveBeenCalled();
			expect(buildWithRojo).toHaveBeenCalledOnce();
		});

		it("should wipe and re-instrument all when cache is disabled", async () => {
			expect.assertions(1);

			const { instrumentRoot } = await setupMocks();

			seedIncrementalScenario();

			const config = makeConfig({
				cache: false,
				luauRoots: ["out-tsc/test"],
			});

			prepareCoverage(config);

			const callArgs = vi.mocked(instrumentRoot).mock.calls[0]![0];

			expect(callArgs.skipFiles).toBeUndefined();
		});

		it("should wipe shadow directory when cache is disabled", async () => {
			expect.assertions(2);

			const { instrumentRoot } = await setupMocks();
			vi.mocked(instrumentRoot).mockReturnValue({});

			seedIncrementalScenario();
			vol.writeFileSync(".jest-roblox-coverage/stale.txt", "stale");

			const config = makeConfig({
				cache: false,
				luauRoots: ["out-tsc/test"],
			});

			prepareCoverage(config);

			expect(vol.existsSync(".jest-roblox-coverage/stale.txt")).toBeFalse();
			expect(vol.existsSync(".jest-roblox-coverage")).toBeTrue();
		});

		it("should handle luauRoots change between runs", async () => {
			expect.assertions(1);

			const { instrumentRoot } = await setupMocks();
			vi.mocked(instrumentRoot).mockReturnValue({});

			// Previous manifest only has out-tsc/test
			seedIncrementalScenario();

			// Seed filesystem for the new additional root
			vol.mkdirSync("packages/core/out", { recursive: true });
			vol.writeFileSync("packages/core/out/init.luau", "local z = 1");

			// Call with an expanded set of roots
			const config = makeConfig({
				luauRoots: ["out-tsc/test", "packages/core/out"],
			});

			prepareCoverage(config);

			// Existing root: full cache hit — instrumentRoot not called for it
			// New root: no previous records, so instrumentRoot called
			expect(vi.mocked(instrumentRoot)).toHaveBeenCalledExactlyOnceWith(
				expect.objectContaining({
					luauRoot: "packages/core/out",
					skipFiles: new Set(),
				}),
			);
		});

		it("should fall back to full instrumentation when manifest JSON is malformed", async () => {
			expect.assertions(1);

			const { instrumentRoot } = await setupMocks();

			seedFilesystem();
			vol.mkdirSync(".jest-roblox-coverage", { recursive: true });
			vol.writeFileSync(".jest-roblox-coverage/manifest.json", "not valid json{{{");

			const config = makeConfig({ luauRoots: ["out-tsc/test"] });

			prepareCoverage(config);

			const callArgs = vi.mocked(instrumentRoot).mock.calls[0]![0];

			expect(callArgs.skipFiles).toBeUndefined();
		});

		it("should re-instrument all when instrumenterVersion differs", async () => {
			expect.assertions(1);

			const { instrumentRoot } = await setupMocks();

			seedIncrementalScenario({
				previousInstrumenterVersion: INSTRUMENTER_VERSION - 1,
			});

			const config = makeConfig({ luauRoots: ["out-tsc/test"] });

			prepareCoverage(config);

			const callArgs = vi.mocked(instrumentRoot).mock.calls[0]![0];

			expect(callArgs.skipFiles).toBeUndefined();
		});

		it("should re-instrument all when manifest file record lacks sourceHash", async () => {
			expect.assertions(1);

			const { instrumentRoot } = await setupMocks();

			seedFilesystem();
			vol.mkdirSync("out-tsc/test", { recursive: true });
			vol.writeFileSync("out-tsc/test/init.luau", "local x = 1");

			vol.mkdirSync(".jest-roblox-coverage", { recursive: true });
			vol.writeFileSync(
				".jest-roblox-coverage/manifest.json",
				JSON.stringify({
					files: {
						"out-tsc/test/init.luau": { key: "out-tsc/test/init.luau" },
					},
					generatedAt: new Date().toISOString(),
					instrumenterVersion: INSTRUMENTER_VERSION,
					luauRoots: ["out-tsc/test"],
					shadowDir: ".jest-roblox-coverage",
					version: 1,
				}),
			);

			const config = makeConfig({ luauRoots: ["out-tsc/test"] });

			prepareCoverage(config);

			const callArgs = vi.mocked(instrumentRoot).mock.calls[0]![0];

			expect(callArgs.skipFiles).toBeUndefined();
		});

		it("should handle incremental mode across multiple luauRoots", async () => {
			expect.assertions(1);

			const { instrumentRoot } = await setupMocks();
			vi.mocked(instrumentRoot).mockReturnValue({});

			// Seed multi-root scenario
			vol.mkdirSync("/project", { recursive: true });
			vol.mkdirSync("packages/core/out", { recursive: true });
			vol.mkdirSync("packages/utils/out", { recursive: true });
			vol.writeFileSync("packages/core/out/init.luau", "local a = 1");
			vol.writeFileSync("packages/utils/out/init.luau", "local b = 2");
			vol.writeFileSync("/project/default.project.json", JSON.stringify(ROJO_PROJECT));

			const coreRecord = makeFileRecord({
				key: "packages/core/out/init.luau",
				coverageMapPath: ".jest-roblox-coverage/packages/core/out/init.cov-map.json",
				instrumentedLuauPath: ".jest-roblox-coverage/packages/core/out/init.luau",
				sourceHash: sha256("local a = 1"),
			});
			const utilsRecord = makeFileRecord({
				key: "packages/utils/out/init.luau",
				coverageMapPath: ".jest-roblox-coverage/packages/utils/out/init.cov-map.json",
				instrumentedLuauPath: ".jest-roblox-coverage/packages/utils/out/init.luau",
				sourceHash: sha256("local b = 2"),
			});

			// Seed shadow files
			for (const record of [coreRecord, utilsRecord]) {
				const directory = record.instrumentedLuauPath.substring(
					0,
					record.instrumentedLuauPath.lastIndexOf("/"),
				);
				vol.mkdirSync(directory, { recursive: true });
				vol.writeFileSync(record.instrumentedLuauPath, "-- instrumented");
				vol.writeFileSync(record.coverageMapPath, "{}");
			}

			vol.writeFileSync(".jest-roblox-coverage/game.rbxl", "RBXL");

			seedPreviousManifest({
				files: {
					"packages/core/out/init.luau": coreRecord,
					"packages/utils/out/init.luau": utilsRecord,
				},
				generatedAt: new Date().toISOString(),
				instrumenterVersion: INSTRUMENTER_VERSION,
				luauRoots: ["packages/core/out", "packages/utils/out"],
				nonInstrumentedFiles: {},
				placeFilePath: ".jest-roblox-coverage/game.rbxl",
				shadowDir: ".jest-roblox-coverage",
				version: 1,
			});

			const config = makeConfig({
				luauRoots: ["packages/core/out", "packages/utils/out"],
			});

			prepareCoverage(config);

			// Both roots fully cached — instrumentRoot not called
			expect(instrumentRoot).not.toHaveBeenCalled();
		});

		it("should force rebuild when beforeBuild returns true on incremental run", async () => {
			expect.assertions(1);

			const { buildWithRojo, instrumentRoot } = await setupMocks();
			vi.mocked(instrumentRoot).mockReturnValue({});

			seedIncrementalScenario();

			const config = makeConfig({ luauRoots: ["out-tsc/test"] });
			const beforeBuild = vi.fn<(shadowDirectory: string) => boolean>().mockReturnValue(true);

			prepareCoverage(config, beforeBuild);

			expect(buildWithRojo).toHaveBeenCalledWith(expect.any(String), expect.any(String));
		});

		it("should not force rebuild when beforeBuild returns false on incremental run", async () => {
			expect.assertions(1);

			const { buildWithRojo, instrumentRoot } = await setupMocks();
			vi.mocked(instrumentRoot).mockReturnValue({});

			seedIncrementalScenario();

			const config = makeConfig({ luauRoots: ["out-tsc/test"] });
			const beforeBuild = vi
				.fn<(shadowDirectory: string) => boolean>()
				.mockReturnValue(false);

			prepareCoverage(config, beforeBuild);

			expect(buildWithRojo).not.toHaveBeenCalled();
		});

		describe("when syncing non-instrumented files", () => {
			it("should copy spec files to shadow dir on first run", async () => {
				expect.assertions(1);

				seedFilesystem();
				vol.writeFileSync("out-tsc/test/init.spec.luau", "-- test code");
				await setupMocks();
				const config = makeConfig({ luauRoots: ["out-tsc/test"] });

				prepareCoverage(config);

				expect(
					vol.readFileSync(".jest-roblox-coverage/out-tsc/test/init.spec.luau", "utf-8"),
				).toBe("-- test code");
			});

			it("should update changed spec files during incremental run", async () => {
				expect.assertions(1);

				const specRecord: NonInstrumentedFileRecord = {
					shadowPath: ".jest-roblox-coverage/out-tsc/test/init.spec.luau",
					sourceHash: sha256("-- old test"),
					sourcePath: "out-tsc/test/init.spec.luau",
				};

				const { instrumentRoot } = await setupMocks();
				vi.mocked(instrumentRoot).mockReturnValue({});

				seedIncrementalScenario({
					fileContents: {
						"out-tsc/test/init.luau": "local x = 1",
						"out-tsc/test/init.spec.luau": "-- new test",
					},
					previousNonInstrumentedFiles: {
						"out-tsc/test/init.spec.luau": specRecord,
					},
				});

				const config = makeConfig({ luauRoots: ["out-tsc/test"] });

				prepareCoverage(config);

				expect(
					vol.readFileSync(".jest-roblox-coverage/out-tsc/test/init.spec.luau", "utf-8"),
				).toBe("-- new test");
			});

			it("should skip unchanged spec files during incremental run", async () => {
				expect.assertions(1);

				const specContent = "-- unchanged test";
				const specRecord: NonInstrumentedFileRecord = {
					shadowPath: ".jest-roblox-coverage/out-tsc/test/init.spec.luau",
					sourceHash: sha256(specContent),
					sourcePath: "out-tsc/test/init.spec.luau",
				};

				const { instrumentRoot } = await setupMocks();
				vi.mocked(instrumentRoot).mockReturnValue({});

				seedIncrementalScenario({
					fileContents: {
						"out-tsc/test/init.luau": "local x = 1",
						"out-tsc/test/init.spec.luau": specContent,
					},
					previousNonInstrumentedFiles: {
						"out-tsc/test/init.spec.luau": specRecord,
					},
				});

				const config = makeConfig({ luauRoots: ["out-tsc/test"] });

				const result = prepareCoverage(config);

				expect(
					result.manifest.nonInstrumentedFiles["out-tsc/test/init.spec.luau"]?.sourceHash,
				).toBe(sha256(specContent));
			});

			it("should detect deleted spec files and clean up shadow copies", async () => {
				expect.assertions(2);

				const specRecord: NonInstrumentedFileRecord = {
					shadowPath: ".jest-roblox-coverage/out-tsc/test/deleted.spec.luau",
					sourceHash: sha256("-- deleted test"),
					sourcePath: "out-tsc/test/deleted.spec.luau",
				};

				const { instrumentRoot } = await setupMocks();
				vi.mocked(instrumentRoot).mockReturnValue({});

				seedIncrementalScenario({
					previousNonInstrumentedFiles: {
						"out-tsc/test/deleted.spec.luau": specRecord,
					},
				});
				// Source file doesn't exist (not in fileContents), but shadow was
				// seeded

				const config = makeConfig({ luauRoots: ["out-tsc/test"] });

				const result = prepareCoverage(config);

				expect(
					result.manifest.nonInstrumentedFiles["out-tsc/test/deleted.spec.luau"],
				).toBeUndefined();
				expect(
					vol.existsSync(".jest-roblox-coverage/out-tsc/test/deleted.spec.luau"),
				).toBeFalse();
			});

			it("should set changed=true when spec file changes (triggers rojo rebuild)", async () => {
				expect.assertions(1);

				const specRecord: NonInstrumentedFileRecord = {
					shadowPath: ".jest-roblox-coverage/out-tsc/test/init.spec.luau",
					sourceHash: sha256("-- old test"),
					sourcePath: "out-tsc/test/init.spec.luau",
				};

				const { buildWithRojo, instrumentRoot } = await setupMocks();
				vi.mocked(instrumentRoot).mockReturnValue({});

				seedIncrementalScenario({
					fileContents: {
						"out-tsc/test/init.luau": "local x = 1",
						"out-tsc/test/init.spec.luau": "-- new test",
					},
					previousNonInstrumentedFiles: {
						"out-tsc/test/init.spec.luau": specRecord,
					},
				});

				const config = makeConfig({ luauRoots: ["out-tsc/test"] });

				prepareCoverage(config);

				expect(buildWithRojo).toHaveBeenCalledWith(expect.any(String), expect.any(String));
			});

			it("should track non-instrumented files in manifest", async () => {
				expect.assertions(2);

				seedFilesystem();
				vol.writeFileSync("out-tsc/test/init.spec.luau", "-- test code");
				await setupMocks();
				const config = makeConfig({ luauRoots: ["out-tsc/test"] });

				const result = prepareCoverage(config);

				const record = result.manifest.nonInstrumentedFiles["out-tsc/test/init.spec.luau"];

				expect(record).toBeDefined();
				expect(record?.sourceHash).toBe(sha256("-- test code"));
			});

			it("should force cold rebuild when previous manifest lacks nonInstrumentedFiles", async () => {
				expect.assertions(1);

				const { instrumentRoot } = await setupMocks();

				seedFilesystem();
				vol.mkdirSync("out-tsc/test", { recursive: true });
				vol.writeFileSync("out-tsc/test/init.luau", "local x = 1");

				// Seed a manifest WITHOUT nonInstrumentedFiles
				vol.mkdirSync(".jest-roblox-coverage", { recursive: true });
				vol.writeFileSync(
					".jest-roblox-coverage/manifest.json",
					JSON.stringify({
						files: {
							"out-tsc/test/init.luau": makeFileRecord({
								key: "out-tsc/test/init.luau",
							}),
						},
						generatedAt: new Date().toISOString(),
						instrumenterVersion: INSTRUMENTER_VERSION,
						luauRoots: ["out-tsc/test"],
						shadowDir: ".jest-roblox-coverage",
						version: 1,
					}),
				);

				const config = makeConfig({ luauRoots: ["out-tsc/test"] });

				prepareCoverage(config);

				// Should NOT use incremental (no skipFiles)
				const callArgs = vi.mocked(instrumentRoot).mock.calls[0]![0];

				expect(callArgs.skipFiles).toBeUndefined();
			});

			it("should handle cleanup when spec shadow files are already missing", async () => {
				expect.assertions(1);

				const specRecord: NonInstrumentedFileRecord = {
					shadowPath: ".jest-roblox-coverage/out-tsc/test/gone.spec.luau",
					sourceHash: sha256("-- gone"),
					sourcePath: "out-tsc/test/gone.spec.luau",
				};

				const { instrumentRoot } = await setupMocks();
				vi.mocked(instrumentRoot).mockReturnValue({});

				seedIncrementalScenario({
					previousNonInstrumentedFiles: {
						"out-tsc/test/gone.spec.luau": specRecord,
					},
				});
				// Remove shadow file (simulating prior partial cleanup)
				vol.unlinkSync(".jest-roblox-coverage/out-tsc/test/gone.spec.luau");

				const config = makeConfig({ luauRoots: ["out-tsc/test"] });

				const result = prepareCoverage(config);

				expect(
					result.manifest.nonInstrumentedFiles["out-tsc/test/gone.spec.luau"],
				).toBeUndefined();
			});

			it("should discover spec files in subdirectories", async () => {
				expect.assertions(1);

				seedFilesystem();
				vol.mkdirSync("out-tsc/test/sub", { recursive: true });
				vol.writeFileSync("out-tsc/test/sub/deep.spec.luau", "-- deep test");
				await setupMocks();
				const config = makeConfig({ luauRoots: ["out-tsc/test"] });

				const result = prepareCoverage(config);

				expect(
					result.manifest.nonInstrumentedFiles["out-tsc/test/sub/deep.spec.luau"],
				).toBeDefined();
			});

			it("should not prune non-instrumented files from other roots", async () => {
				expect.assertions(1);

				const { instrumentRoot } = await setupMocks();
				vi.mocked(instrumentRoot).mockReturnValue({});

				// Multi-root: previous manifest has a spec in packages/core/out
				vol.mkdirSync("/project", { recursive: true });
				vol.mkdirSync("packages/core/out", { recursive: true });
				vol.mkdirSync("packages/utils/out", { recursive: true });
				vol.writeFileSync("packages/core/out/init.luau", "local a = 1");
				vol.writeFileSync("packages/core/out/init.spec.luau", "-- core spec");
				vol.writeFileSync("packages/utils/out/init.luau", "local b = 2");
				vol.writeFileSync("/project/default.project.json", JSON.stringify(ROJO_PROJECT));

				const coreRecord = makeFileRecord({
					key: "packages/core/out/init.luau",
					coverageMapPath: ".jest-roblox-coverage/packages/core/out/init.cov-map.json",
					instrumentedLuauPath: ".jest-roblox-coverage/packages/core/out/init.luau",
					sourceHash: sha256("local a = 1"),
				});
				const utilsRecord = makeFileRecord({
					key: "packages/utils/out/init.luau",
					coverageMapPath: ".jest-roblox-coverage/packages/utils/out/init.cov-map.json",
					instrumentedLuauPath: ".jest-roblox-coverage/packages/utils/out/init.luau",
					sourceHash: sha256("local b = 2"),
				});

				const coreSpecRecord: NonInstrumentedFileRecord = {
					shadowPath: ".jest-roblox-coverage/packages/core/out/init.spec.luau",
					sourceHash: sha256("-- core spec"),
					sourcePath: "packages/core/out/init.spec.luau",
				};

				for (const record of [coreRecord, utilsRecord]) {
					const directory = record.instrumentedLuauPath.substring(
						0,
						record.instrumentedLuauPath.lastIndexOf("/"),
					);
					vol.mkdirSync(directory, { recursive: true });
					vol.writeFileSync(record.instrumentedLuauPath, "-- instrumented");
					vol.writeFileSync(record.coverageMapPath, "{}");
				}

				vol.mkdirSync(".jest-roblox-coverage/packages/core/out", { recursive: true });
				vol.writeFileSync(coreSpecRecord.shadowPath, "-- core spec");
				vol.writeFileSync(".jest-roblox-coverage/game.rbxl", "RBXL");

				seedPreviousManifest({
					files: {
						"packages/core/out/init.luau": coreRecord,
						"packages/utils/out/init.luau": utilsRecord,
					},
					generatedAt: new Date().toISOString(),
					instrumenterVersion: INSTRUMENTER_VERSION,
					luauRoots: ["packages/core/out", "packages/utils/out"],
					nonInstrumentedFiles: {
						"packages/core/out/init.spec.luau": coreSpecRecord,
					},
					placeFilePath: ".jest-roblox-coverage/game.rbxl",
					shadowDir: ".jest-roblox-coverage",
					version: 1,
				});

				const config = makeConfig({
					luauRoots: ["packages/core/out", "packages/utils/out"],
				});

				const result = prepareCoverage(config);

				// Core spec should still be tracked (not pruned by utils root
				// processing)
				expect(
					result.manifest.nonInstrumentedFiles["packages/core/out/init.spec.luau"],
				).toBeDefined();
			});

			it("should skip node_modules and dot directories when discovering spec files", async () => {
				expect.assertions(2);

				seedFilesystem();
				vol.mkdirSync("out-tsc/test/node_modules", { recursive: true });
				vol.writeFileSync("out-tsc/test/node_modules/mod.spec.luau", "-- ignored");
				vol.mkdirSync("out-tsc/test/.hidden", { recursive: true });
				vol.writeFileSync("out-tsc/test/.hidden/secret.spec.luau", "-- ignored");
				await setupMocks();
				const config = makeConfig({ luauRoots: ["out-tsc/test"] });

				const result = prepareCoverage(config);

				expect(
					result.manifest.nonInstrumentedFiles["out-tsc/test/node_modules/mod.spec.luau"],
				).toBeUndefined();
				expect(
					result.manifest.nonInstrumentedFiles["out-tsc/test/.hidden/secret.spec.luau"],
				).toBeUndefined();
			});

			it("should handle file rename across categories (source to spec)", async () => {
				expect.assertions(2);

				const { instrumentRoot } = await setupMocks();
				vi.mocked(instrumentRoot).mockReturnValue({});

				// Previous manifest has init.luau as instrumented source
				// Now the file has been renamed to init.spec.luau
				seedIncrementalScenario({
					fileContents: {
						"out-tsc/test/helper.spec.luau": "-- was a source file",
						"out-tsc/test/init.luau": "local x = 1",
					},
				});

				const config = makeConfig({ luauRoots: ["out-tsc/test"] });

				const result = prepareCoverage(config);

				// New spec file should be tracked as non-instrumented
				expect(
					result.manifest.nonInstrumentedFiles["out-tsc/test/helper.spec.luau"],
				).toBeDefined();
				// Source file should still be in instrumented files (carried
				// forward)
				expect(result.manifest.files["out-tsc/test/init.luau"]).toBeDefined();
			});
		});
	});

	describe("when beforeBuild callback is provided", () => {
		it("should call beforeBuild with shadow directory path", async () => {
			expect.assertions(2);

			seedFilesystem();
			const { buildWithRojo } = await setupMocks();
			const config = makeConfig({ luauRoots: ["out-tsc/test"] });
			const beforeBuild = vi
				.fn<(shadowDirectory: string) => boolean>()
				.mockReturnValue(false);

			prepareCoverage(config, beforeBuild);

			expect(beforeBuild).toHaveBeenCalledWith(".jest-roblox-coverage");
			expect(buildWithRojo).toHaveBeenCalledWith(expect.any(String), expect.any(String));
		});

		it("should skip callback when not provided", async () => {
			expect.assertions(1);

			seedFilesystem();
			const { buildWithRojo } = await setupMocks();
			const config = makeConfig({ luauRoots: ["out-tsc/test"] });

			prepareCoverage(config);

			expect(buildWithRojo).toHaveBeenCalledWith(expect.any(String), expect.any(String));
		});
	});

	describe("when using multiple roots", () => {
		it("should instrument each root separately", async () => {
			expect.assertions(2);

			vol.mkdirSync("/project", { recursive: true });
			vol.mkdirSync("packages/core/out", { recursive: true });
			vol.mkdirSync("packages/test-utils/out", { recursive: true });
			vol.writeFileSync("packages/core/out/init.luau", "local a = 1");
			vol.writeFileSync("packages/test-utils/out/init.luau", "local b = 2");
			vol.writeFileSync("/project/default.project.json", JSON.stringify(ROJO_PROJECT));

			const { instrumentRoot } = await setupMocks();
			const config = makeConfig({
				luauRoots: ["packages/core/out", "packages/test-utils/out"],
			});

			prepareCoverage(config);

			expect(instrumentRoot).toHaveBeenCalledWith(
				expect.objectContaining({ luauRoot: "packages/core/out" }),
			);
			expect(instrumentRoot).toHaveBeenCalledWith(
				expect.objectContaining({ luauRoot: "packages/test-utils/out" }),
			);
		});

		it("should copy each root to its own shadow directory", async () => {
			expect.assertions(2);

			vol.mkdirSync("/project", { recursive: true });
			vol.mkdirSync("packages/core/out", { recursive: true });
			vol.mkdirSync("packages/test-utils/out", { recursive: true });
			vol.writeFileSync("packages/core/out/init.luau", "local a = 1");
			vol.writeFileSync("packages/test-utils/out/init.luau", "local b = 2");
			vol.writeFileSync("/project/default.project.json", JSON.stringify(ROJO_PROJECT));

			await setupMocks();
			const config = makeConfig({
				luauRoots: ["packages/core/out", "packages/test-utils/out"],
			});

			prepareCoverage(config);

			expect(
				vol.readFileSync(".jest-roblox-coverage/packages/core/out/init.luau", "utf-8"),
			).toBe("local a = 1");
			expect(
				vol.readFileSync(
					".jest-roblox-coverage/packages/test-utils/out/init.luau",
					"utf-8",
				),
			).toBe("local b = 2");
		});

		it("should write a single manifest with all roots", async () => {
			expect.assertions(1);

			vol.mkdirSync("/project", { recursive: true });
			vol.mkdirSync("packages/core/out", { recursive: true });
			vol.mkdirSync("packages/test-utils/out", { recursive: true });
			vol.writeFileSync("packages/core/out/init.luau", "local a = 1");
			vol.writeFileSync("packages/test-utils/out/init.luau", "local b = 2");
			vol.writeFileSync("/project/default.project.json", JSON.stringify(ROJO_PROJECT));

			await setupMocks();
			const config = makeConfig({
				luauRoots: ["packages/core/out", "packages/test-utils/out"],
			});

			const result = prepareCoverage(config);

			expect(result.manifest.luauRoots).toStrictEqual([
				"packages/core/out",
				"packages/test-utils/out",
			]);
		});
	});
});

describe(resolveLuauRoots, () => {
	describe("when config.luauRoots is provided", () => {
		it("should return the explicit array", async () => {
			expect.assertions(1);

			await setupMocks();
			const config = makeConfig({
				luauRoots: ["packages/core/out", "packages/test-utils/out"],
			});

			expect(resolveLuauRoots(config)).toStrictEqual([
				"packages/core/out",
				"packages/test-utils/out",
			]);
		});
	});

	describe("when auto-detecting from Rojo project", () => {
		it("should collect roots from $path entries containing .luau files", async () => {
			expect.assertions(1);

			const multiRootProject = {
				name: "test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: {
						$path: "packages/core/out",
					},
					ServerScriptService: {
						$path: "packages/test-utils/out",
					},
				},
			};

			vol.mkdirSync("/project", { recursive: true });
			vol.mkdirSync("packages/core/out", { recursive: true });
			vol.mkdirSync("packages/test-utils/out", { recursive: true });
			vol.writeFileSync("packages/core/out/init.luau", "");
			vol.writeFileSync("packages/test-utils/out/init.luau", "");
			vol.writeFileSync("/project/default.project.json", JSON.stringify(multiRootProject));

			await setupMocks();
			const config = makeConfig();

			const roots = resolveLuauRoots(config);

			expect(roots).toStrictEqual(["packages/core/out", "packages/test-utils/out"]);
		});

		it("should skip $path entries that do not exist on disk", async () => {
			expect.assertions(1);

			const projectWithMissing = {
				name: "test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: {
						$path: "packages/core/out",
					},
					ServerScriptService: {
						$path: "packages/missing/out",
					},
				},
			};

			vol.mkdirSync("/project", { recursive: true });
			vol.mkdirSync("packages/core/out", { recursive: true });
			vol.writeFileSync("packages/core/out/init.luau", "");
			vol.writeFileSync("/project/default.project.json", JSON.stringify(projectWithMissing));

			await setupMocks();
			const config = makeConfig();

			expect(resolveLuauRoots(config)).toStrictEqual(["packages/core/out"]);
		});

		it("should skip $path entries that contain no .luau files", async () => {
			expect.assertions(1);

			const projectWithEmpty = {
				name: "test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: {
						$path: "packages/core/out",
					},
					ServerScriptService: {
						$path: "packages/empty/out",
					},
				},
			};

			vol.mkdirSync("/project", { recursive: true });
			vol.mkdirSync("packages/core/out", { recursive: true });
			vol.mkdirSync("packages/empty/out", { recursive: true });
			vol.writeFileSync("packages/core/out/init.luau", "");
			vol.writeFileSync("packages/empty/out/readme.txt", "no luau here");
			vol.writeFileSync("/project/default.project.json", JSON.stringify(projectWithEmpty));

			await setupMocks();
			const config = makeConfig();

			expect(resolveLuauRoots(config)).toStrictEqual(["packages/core/out"]);
		});

		it("should apply coveragePathIgnorePatterns to filter roots", async () => {
			expect.assertions(1);

			const projectWithSync = {
				name: "test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: {
						$path: "packages/core/out",
					},
					StarterPlayer: {
						$path: "rojo-sync/rbxts",
					},
				},
			};

			vol.mkdirSync("/project", { recursive: true });
			vol.mkdirSync("packages/core/out", { recursive: true });
			vol.mkdirSync("rojo-sync/rbxts", { recursive: true });
			vol.writeFileSync("packages/core/out/init.luau", "");
			vol.writeFileSync("rojo-sync/rbxts/init.luau", "");
			vol.writeFileSync("/project/default.project.json", JSON.stringify(projectWithSync));

			await setupMocks();
			const config = makeConfig({
				coveragePathIgnorePatterns: [
					...DEFAULT_CONFIG.coveragePathIgnorePatterns,
					"rojo-sync",
				],
			});

			expect(resolveLuauRoots(config)).toStrictEqual(["packages/core/out"]);
		});
	});

	describe("when Rojo project JSON is malformed", () => {
		it("should throw with a descriptive error", async () => {
			expect.assertions(1);

			vol.mkdirSync("/project", { recursive: true });
			vol.writeFileSync("/project/default.project.json", "{ not valid json");

			await setupMocks();
			const config = makeConfig();

			expect(() => resolveLuauRoots(config)).toThrowWithMessage(
				Error,
				/Malformed Rojo project JSON/,
			);
		});
	});

	describe("when falling back to tsconfig outDir", () => {
		it("should use tsconfig outDir when no roots found", async () => {
			expect.assertions(1);

			seedFilesystem();
			await setupMocks({ outDir: "out-tsc/test" });
			const config = makeConfig();

			expect(resolveLuauRoots(config)).toStrictEqual(["out-tsc/test"]);
		});

		it("should fall through to tsconfig when no Rojo project exists", async () => {
			expect.assertions(1);

			vol.mkdirSync("/project", { recursive: true });
			await setupMocks({ outDir: "out" });
			const config = makeConfig();

			expect(resolveLuauRoots(config)).toStrictEqual(["out"]);
		});
	});
});

describe(collectLuauRootsFromRojo, () => {
	describe("when collecting paths from nested tree nodes", () => {
		it("should find $path values in deeply nested nodes", async () => {
			expect.assertions(1);

			const project: RojoProject = {
				name: "test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: {
						core: {
							$path: "packages/core/out",
						},
						utils: {
							$path: "packages/test-utils/out",
						},
					},
				},
			};

			vol.mkdirSync("packages/core/out", { recursive: true });
			vol.mkdirSync("packages/test-utils/out", { recursive: true });
			vol.writeFileSync("packages/core/out/init.luau", "");
			vol.writeFileSync("packages/test-utils/out/init.luau", "");

			await setupMocks();
			const config = makeConfig();

			expect(collectLuauRootsFromRojo(project, config)).toStrictEqual([
				"packages/core/out",
				"packages/test-utils/out",
			]);
		});
	});

	describe("when $path points to a .luau file instead of a directory", () => {
		it("should exclude single-file paths from roots", async () => {
			expect.assertions(1);

			const project: RojoProject = {
				name: "test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: {
						config: {
							$path: "packages/core/jest.config.luau",
						},
						src: {
							$path: "packages/core/out",
						},
					},
				},
			};

			vol.mkdirSync("packages/core/out", { recursive: true });
			vol.writeFileSync("packages/core/out/init.luau", "");
			vol.writeFileSync("packages/core/jest.config.luau", "return {}");

			await setupMocks();
			const config = makeConfig();

			expect(collectLuauRootsFromRojo(project, config)).toStrictEqual(["packages/core/out"]);
		});
	});

	describe("when .luau files are in subdirectories", () => {
		it("should detect .luau files recursively", async () => {
			expect.assertions(1);

			const project: RojoProject = {
				name: "test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: {
						$path: "packages/core/out",
					},
				},
			};

			vol.mkdirSync("packages/core/out/nested", { recursive: true });
			vol.writeFileSync("packages/core/out/nested/module.luau", "");

			await setupMocks();
			const config = makeConfig();

			expect(collectLuauRootsFromRojo(project, config)).toStrictEqual(["packages/core/out"]);
		});
	});

	describe("when filtering node_modules paths", () => {
		it("should exclude paths matching default coveragePathIgnorePatterns", async () => {
			expect.assertions(1);

			const project: RojoProject = {
				name: "test",
				tree: {
					$className: "DataModel",
					Packages: {
						$path: "node_modules/@rbxts",
					},
					ReplicatedStorage: {
						$path: "packages/core/out",
					},
				},
			};

			vol.mkdirSync("packages/core/out", { recursive: true });
			vol.mkdirSync("node_modules/@rbxts", { recursive: true });
			vol.writeFileSync("packages/core/out/init.luau", "");
			vol.writeFileSync("node_modules/@rbxts/init.luau", "");

			await setupMocks();
			const config = makeConfig();

			expect(collectLuauRootsFromRojo(project, config)).toStrictEqual(["packages/core/out"]);
		});
	});
});

describe(discoverInstrumentableFiles, () => {
	function setup() {
		onTestFinished(() => {
			vol.reset();
		});
	}

	it("should discover .luau files", () => {
		expect.assertions(1);

		setup();
		vol.mkdirSync("out/shared", { recursive: true });
		vol.writeFileSync("out/init.luau", "");
		vol.writeFileSync("out/shared/player.luau", "");

		const result = discoverInstrumentableFiles("out");

		expect(result).toStrictEqual(new Set(["init.luau", "shared/player.luau"]));
	});

	it("should exclude spec, test, and snap files", () => {
		expect.assertions(1);

		setup();
		vol.mkdirSync("out", { recursive: true });
		vol.writeFileSync("out/init.luau", "");
		vol.writeFileSync("out/init.spec.luau", "");
		vol.writeFileSync("out/init.test.luau", "");
		vol.writeFileSync("out/init.snap.luau", "");
		vol.writeFileSync("out/init.spec.lua", "");
		vol.writeFileSync("out/init.test.lua", "");
		vol.writeFileSync("out/init.snap.lua", "");

		const result = discoverInstrumentableFiles("out");

		expect(result).toStrictEqual(new Set(["init.luau"]));
	});

	it("should skip node_modules and dot directories", () => {
		expect.assertions(1);

		setup();
		vol.mkdirSync("out/node_modules", { recursive: true });
		vol.mkdirSync("out/.hidden", { recursive: true });
		vol.mkdirSync("out/.jest-roblox-coverage", { recursive: true });
		vol.writeFileSync("out/node_modules/vendor.luau", "");
		vol.writeFileSync("out/.hidden/secret.luau", "");
		vol.writeFileSync("out/.jest-roblox-coverage/cached.luau", "");

		const result = discoverInstrumentableFiles("out");

		expect(result).toStrictEqual(new Set());
	});

	it("should include .lua files", () => {
		expect.assertions(1);

		setup();
		vol.mkdirSync("out", { recursive: true });
		vol.writeFileSync("out/init.lua", "");

		const result = discoverInstrumentableFiles("out");

		expect(result).toStrictEqual(new Set(["init.lua"]));
	});

	it("should return empty set for empty directory", () => {
		expect.assertions(1);

		setup();
		vol.mkdirSync("out", { recursive: true });

		const result = discoverInstrumentableFiles("out");

		expect(result).toStrictEqual(new Set());
	});
});
