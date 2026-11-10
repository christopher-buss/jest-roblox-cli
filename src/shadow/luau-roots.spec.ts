import type { RojoProject } from "@isentinel/rojo-utils";

import * as path from "node:path";
import process from "node:process";
import { assert, describe, expect, it, vi } from "vitest";

import {
	makeConfig,
	PROJECT_DIR,
	readingOutDirectory,
	seedFilesystem,
} from "#test/mocks/coverage-spec-prepare-seed.ts";
import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { posixRoot } from "#test/mocks/posix-path.ts";
import { createResolvedConfig } from "#test/mocks/resolved-config.ts";
import type { ResolvedConfig } from "../config/resolved-config.ts";
import type { TsconfigReader } from "../tsconfig/tsconfig-mappings.ts";
import type { FileSystem } from "../utils/file-system.ts";
import type { PosixRoot } from "../utils/normalize-windows-path.ts";
import { resolveLuauRoots } from "./luau-roots.ts";

/** What every case that never reaches the tsconfig fallback hands in. */
const noTsconfig = readingOutDirectory();

describe(resolveLuauRoots, () => {
	it("should honor explicit roots when the configured Rojo project is malformed", () => {
		expect.assertions(1);

		const { fileSystem, volume } = seedFilesystem();
		volume.writeFileSync(path.join(PROJECT_DIR, "default.project.json"), "invalid json");
		const config = makeConfig({ luauRoots: ["out"] });

		expect(resolveLuauRoots({ config, fileSystem, tsconfigReader: noTsconfig })).toStrictEqual(
			["out"].map(posixRoot),
		);
	});

	it("should fall back to tsconfig outDir when the configured project is absent", async () => {
		expect.assertions(1);

		const { fileSystem } = seedFilesystem();
		const config = makeConfig({ rojoProject: "absent.project.json" });

		expect(
			resolveLuauRoots({ config, fileSystem, tsconfigReader: readingOutDirectory("out") }),
		).toStrictEqual(["out"].map(posixRoot));
	});

	it("should throw when the Rojo project has an invalid schema", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = seedFilesystem();
		volume.writeFileSync(
			path.join(PROJECT_DIR, "default.project.json"),
			JSON.stringify({ invalid: true }),
		);
		const config = makeConfig();

		expect(() => {
			return resolveLuauRoots({
				config,
				fileSystem,
				tsconfigReader: readingOutDirectory("out"),
			});
		}).toThrow(/Invalid Rojo project/);
	});

	it("should throw when the Rojo project is invalid and luauRoots is empty", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = seedFilesystem();
		volume.writeFileSync(
			path.join(PROJECT_DIR, "default.project.json"),
			JSON.stringify({ invalid: true }),
		);
		const config = makeConfig({ luauRoots: [] });

		expect(() => {
			return resolveLuauRoots({
				config,
				fileSystem,
				tsconfigReader: readingOutDirectory("out"),
			});
		}).toThrow(/Invalid Rojo project/);
	});

	/**
	 * The roots as plain strings, so an assertion can name literals.
	 * @param fileSystem - File system the roots are resolved on.
	 * @param options - Config and tsconfig reader.
	 * @returns The resolved roots.
	 */
	function rootsOf(
		fileSystem: FileSystem,
		{
			config,
			tsconfigReader = noTsconfig,
		}: { config: ResolvedConfig; tsconfigReader?: TsconfigReader },
	): Array<string> {
		return resolveLuauRoots({ config, fileSystem, tsconfigReader });
	}

	describe("when config.luauRoots is provided", () => {
		it("should return the explicit array", async () => {
			expect.assertions(1);

			const { fileSystem } = createMemoryFileSystem();

			const config = makeConfig({
				luauRoots: ["packages/core/out", "packages/test-utils/out"],
			});

			expect(rootsOf(fileSystem, { config })).toStrictEqual([
				"packages/core/out",
				"packages/test-utils/out",
			]);
		});

		// Canonical is not the same as unique: left as two entries, one
		// directory is instrumented and mirrored into the same shadow twice.
		it("should reduce two spellings of one root to one entry", async () => {
			expect.assertions(1);

			const { fileSystem } = createMemoryFileSystem();

			const config = makeConfig({ luauRoots: ["out", "out/./", "./out"] });

			expect(rootsOf(fileSystem, { config })).toStrictEqual(["out"]);
		});
	});

	describe("when auto-detecting from Rojo project", () => {
		it("should collect roots from $path entries containing .luau files", async () => {
			expect.assertions(1);

			const { fileSystem, volume } = createMemoryFileSystem();

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

			volume.mkdirSync(PROJECT_DIR, { recursive: true });
			volume.mkdirSync(path.join(PROJECT_DIR, "packages/core/out"), { recursive: true });
			volume.mkdirSync(path.join(PROJECT_DIR, "packages/test-utils/out"), {
				recursive: true,
			});
			volume.writeFileSync(path.join(PROJECT_DIR, "packages/core/out/init.luau"), "");
			volume.writeFileSync(path.join(PROJECT_DIR, "packages/test-utils/out/init.luau"), "");
			volume.writeFileSync(
				path.join(PROJECT_DIR, "default.project.json"),
				JSON.stringify(multiRootProject),
			);

			const config = makeConfig();

			const roots = rootsOf(fileSystem, { config });

			expect(roots).toStrictEqual(["packages/core/out", "packages/test-utils/out"]);
		});

		it("should auto-detect when luauRoots is an empty array", async () => {
			expect.assertions(1);

			const { fileSystem, volume } = createMemoryFileSystem();

			const project = {
				name: "test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: {
						$path: "packages/core/out",
					},
				},
			};

			volume.mkdirSync(PROJECT_DIR, { recursive: true });
			volume.mkdirSync(path.join(PROJECT_DIR, "packages/core/out"), { recursive: true });
			volume.writeFileSync(path.join(PROJECT_DIR, "packages/core/out/init.luau"), "");
			volume.writeFileSync(
				path.join(PROJECT_DIR, "default.project.json"),
				JSON.stringify(project),
			);

			// An empty array names no roots, which is not the same as choosing
			// them: the run walks the rojo project rather than instrumenting
			// nothing.
			const config = makeConfig({ luauRoots: [] });

			expect(rootsOf(fileSystem, { config })).toStrictEqual(["packages/core/out"]);
		});

		it("should skip $path entries that do not exist on disk", async () => {
			expect.assertions(1);

			const { fileSystem, volume } = createMemoryFileSystem();

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

			volume.mkdirSync(PROJECT_DIR, { recursive: true });
			volume.mkdirSync(path.join(PROJECT_DIR, "packages/core/out"), { recursive: true });
			volume.writeFileSync(path.join(PROJECT_DIR, "packages/core/out/init.luau"), "");
			volume.writeFileSync(
				path.join(PROJECT_DIR, "default.project.json"),
				JSON.stringify(projectWithMissing),
			);

			const config = makeConfig();

			expect(rootsOf(fileSystem, { config })).toStrictEqual(["packages/core/out"]);
		});

		it("should skip $path entries that contain no .luau files", async () => {
			expect.assertions(1);

			const { fileSystem, volume } = createMemoryFileSystem();

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

			volume.mkdirSync(PROJECT_DIR, { recursive: true });
			volume.mkdirSync(path.join(PROJECT_DIR, "packages/core/out"), { recursive: true });
			volume.mkdirSync(path.join(PROJECT_DIR, "packages/empty/out"), { recursive: true });
			volume.writeFileSync(path.join(PROJECT_DIR, "packages/core/out/init.luau"), "");
			volume.writeFileSync(
				path.join(PROJECT_DIR, "packages/empty/out/readme.txt"),
				"no luau here",
			);
			volume.writeFileSync(
				path.join(PROJECT_DIR, "default.project.json"),
				JSON.stringify(projectWithEmpty),
			);

			const config = makeConfig();

			expect(rootsOf(fileSystem, { config })).toStrictEqual(["packages/core/out"]);
		});

		it("should resolve nested .project.json refs before collecting roots", async () => {
			expect.assertions(1);

			const { fileSystem, volume } = createMemoryFileSystem();

			const parentProject = {
				name: "test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: {
						Client: { $path: "client.project.json" },
					},
				},
			};
			const clientProject = {
				name: "client",
				tree: {
					$className: "Folder",
					Systems: { $path: "src/Client/Systems" },
				},
			};

			volume.mkdirSync(PROJECT_DIR, { recursive: true });
			volume.mkdirSync(path.join(PROJECT_DIR, "src/Client/Systems"), { recursive: true });
			volume.writeFileSync(
				path.join(PROJECT_DIR, "src/Client/Systems/FriendsController.luau"),
				"",
			);
			volume.writeFileSync(
				path.join(PROJECT_DIR, "default.project.json"),
				JSON.stringify(parentProject),
			);
			volume.writeFileSync(
				path.join(PROJECT_DIR, "client.project.json"),
				JSON.stringify(clientProject),
			);

			const config = makeConfig();

			expect(rootsOf(fileSystem, { config })).toStrictEqual(["src/Client/Systems"]);
		});

		it("should apply coveragePathIgnorePatterns to filter roots", async () => {
			expect.assertions(1);

			const { fileSystem, volume } = createMemoryFileSystem();

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

			volume.mkdirSync(PROJECT_DIR, { recursive: true });
			volume.mkdirSync(path.join(PROJECT_DIR, "packages/core/out"), { recursive: true });
			volume.mkdirSync(path.join(PROJECT_DIR, "rojo-sync/rbxts"), { recursive: true });
			volume.writeFileSync(path.join(PROJECT_DIR, "packages/core/out/init.luau"), "");
			volume.writeFileSync(path.join(PROJECT_DIR, "rojo-sync/rbxts/init.luau"), "");
			volume.writeFileSync(
				path.join(PROJECT_DIR, "default.project.json"),
				JSON.stringify(projectWithSync),
			);

			const config = makeConfig({
				coveragePathIgnorePatterns: [
					...createResolvedConfig().coveragePathIgnorePatterns,
					"rojo-sync",
				],
			});

			expect(rootsOf(fileSystem, { config })).toStrictEqual(["packages/core/out"]);
		});
	});

	describe("when Rojo project JSON is malformed", () => {
		it("should throw with a descriptive error", async () => {
			expect.assertions(2);

			const { fileSystem, volume } = createMemoryFileSystem();

			volume.mkdirSync(PROJECT_DIR, { recursive: true });
			volume.writeFileSync(
				path.join(PROJECT_DIR, "default.project.json"),
				"{ not valid json",
			);

			const config = makeConfig();

			let caught: unknown;
			try {
				rootsOf(fileSystem, { config });
			} catch (err) {
				caught = err;
			}

			assert(caught instanceof Error);

			expect(caught.cause).toBeInstanceOf(Error);
			expect(caught.message).toContain("Failed to parse Rojo project");
		});
	});

	describe("when falling back to tsconfig outDir", () => {
		it("should use tsconfig outDir when no roots found", async () => {
			expect.assertions(1);

			const { fileSystem } = seedFilesystem();
			const tsconfigReader = readingOutDirectory("out-tsc/test");
			const config = makeConfig();

			expect(rootsOf(fileSystem, { config, tsconfigReader })).toStrictEqual(["out-tsc/test"]);
		});

		it("should normalize a tsconfig outDir written with a ./ prefix", async () => {
			expect.assertions(1);

			const { fileSystem } = seedFilesystem();
			const tsconfigReader = readingOutDirectory("./out");
			const config = makeConfig();

			expect(rootsOf(fileSystem, { config, tsconfigReader })).toStrictEqual(["out"]);
		});

		it("should fall through to tsconfig when no Rojo project exists", async () => {
			expect.assertions(1);

			const { fileSystem, volume } = createMemoryFileSystem();

			volume.mkdirSync(PROJECT_DIR, { recursive: true });
			const tsconfigReader = readingOutDirectory("out");
			const config = makeConfig();

			expect(rootsOf(fileSystem, { config, tsconfigReader })).toStrictEqual(["out"]);
		});
	});
});

describe("rojo mount detection", () => {
	function rootsFromRojo({
		config,
		fileSystem,
		project,
		rojoDirectory,
	}: {
		config: ResolvedConfig;
		fileSystem: FileSystem;
		project: RojoProject;
		rojoDirectory: string;
	}): Array<string> {
		const rojoProject = path.posix.join(rojoDirectory, "detect.project.json");
		fileSystem.writeFileSync(rojoProject, JSON.stringify(project));
		return resolveLuauRoots({
			config: { ...config, rojoProject },
			fileSystem,
			tsconfigReader: noTsconfig,
		});
	}

	// Every case here sites the project at `rootDir`, which is the common
	// shape: the frame a root is written in and the frame a `$path` resolves
	// in are then the same directory.
	const rojoDirectory = PROJECT_DIR;

	describe("when collecting paths from nested tree nodes", () => {
		it("should find $path values in deeply nested nodes", async () => {
			expect.assertions(1);

			const { fileSystem, volume } = createMemoryFileSystem();

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

			volume.mkdirSync(path.join(PROJECT_DIR, "packages/core/out"), { recursive: true });
			volume.mkdirSync(path.join(PROJECT_DIR, "packages/test-utils/out"), {
				recursive: true,
			});
			volume.writeFileSync(path.join(PROJECT_DIR, "packages/core/out/init.luau"), "");
			volume.writeFileSync(path.join(PROJECT_DIR, "packages/test-utils/out/init.luau"), "");

			const config = makeConfig();

			expect(rootsFromRojo({ config, fileSystem, project, rojoDirectory })).toStrictEqual([
				"packages/core/out",
				"packages/test-utils/out",
			]);
		});
	});

	describe("when $path points to a .luau file instead of a directory", () => {
		it("should exclude single-file paths from roots", async () => {
			expect.assertions(1);

			const { fileSystem, volume } = createMemoryFileSystem();

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

			volume.mkdirSync(path.join(PROJECT_DIR, "packages/core/out"), { recursive: true });
			volume.writeFileSync(path.join(PROJECT_DIR, "packages/core/out/init.luau"), "");
			volume.writeFileSync(
				path.join(PROJECT_DIR, "packages/core/jest.config.luau"),
				"return {}",
			);

			const config = makeConfig();

			expect(rootsFromRojo({ config, fileSystem, project, rojoDirectory })).toStrictEqual([
				"packages/core/out",
			]);
		});
	});

	describe("when .luau files are in subdirectories", () => {
		it("should detect .luau files nested beside a non-luau sibling", async () => {
			expect.assertions(1);

			const { fileSystem, volume } = createMemoryFileSystem();

			const project: RojoProject = {
				name: "test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: {
						$path: "packages/core/out",
					},
				},
			};

			volume.mkdirSync(path.join(PROJECT_DIR, "packages/core/out/nested"), {
				recursive: true,
			});
			volume.writeFileSync(
				path.join(PROJECT_DIR, "packages/core/out/nested/module.luau"),
				"",
			);
			// A loose non-luau file beside the tree: one entry that is not luau
			// does not cost the mount its coverage.
			volume.writeFileSync(path.join(PROJECT_DIR, "packages/core/out/readme.txt"), "");

			const config = makeConfig();

			expect(rootsFromRojo({ config, fileSystem, project, rojoDirectory })).toStrictEqual([
				"packages/core/out",
			]);
		});
	});

	describe("when filtering node_modules paths", () => {
		it("should exclude paths matching default coveragePathIgnorePatterns", async () => {
			expect.assertions(1);

			const { fileSystem, volume } = createMemoryFileSystem();

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

			volume.mkdirSync(path.join(PROJECT_DIR, "packages/core/out"), { recursive: true });
			volume.mkdirSync(path.join(PROJECT_DIR, "node_modules/@rbxts"), { recursive: true });
			volume.writeFileSync(path.join(PROJECT_DIR, "packages/core/out/init.luau"), "");
			volume.writeFileSync(path.join(PROJECT_DIR, "node_modules/@rbxts/init.luau"), "");

			const config = makeConfig();

			expect(rootsFromRojo({ config, fileSystem, project, rojoDirectory })).toStrictEqual([
				"packages/core/out",
			]);
		});
	});

	// The mount is judged on where it lands, not on how it is spelled: the
	// shadow mirrors a tree under `rootDir` and the manifest keys the report
	// reads are written from there, so a mount elsewhere in the rojo tree has
	// no root to be — however it is written.
	describe("when a $path is resolved against rootDir", () => {
		it.for([
			{
				mount: path.join(PROJECT_DIR, "vendor/out"),
				roots: ["vendor/out", "packages/core/out"],
				shape: "an absolute mount inside rootDir",
			},
			{
				mount: "/external/out",
				roots: ["packages/core/out"],
				shape: "an absolute mount outside rootDir",
			},
			{
				mount: "../outside/out",
				roots: ["packages/core/out"],
				shape: "a relative mount that escapes rootDir",
			},
			{ mount: ".", roots: ["packages/core/out"], shape: "a mount naming rootDir itself" },
		])("should answer $roots for $shape", async ({ mount, roots }) => {
			expect.assertions(1);

			const { fileSystem, volume } = createMemoryFileSystem();

			const project: RojoProject = {
				name: "test",
				tree: {
					$className: "DataModel",
					Mounted: {
						$path: mount,
					},
					ReplicatedStorage: {
						$path: "packages/core/out",
					},
				},
			};

			// Seeded wherever the mount lands, so each row turns on where the
			// directory is rather than on whether it is there at all.
			for (const directory of [
				path.join(PROJECT_DIR, "packages/core/out"),
				path.resolve(rojoDirectory, mount),
			]) {
				volume.mkdirSync(directory, { recursive: true });
				volume.writeFileSync(`${directory}/init.luau`, "");
			}

			const config = makeConfig();

			expect(rootsFromRojo({ config, fileSystem, project, rojoDirectory })).toStrictEqual(
				roots,
			);
		});

		it("should keep a mount when the rojo directory is relative", async () => {
			expect.assertions(1);

			const { fileSystem, volume } = createMemoryFileSystem();

			const project: RojoProject = {
				name: "test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: { $path: "out" },
				},
			};

			// Rooted at the invocation directory, which is what `rootDir` is in a
			// real single-mode run.
			volume.mkdirSync(path.join(process.cwd(), "out"), { recursive: true });
			volume.writeFileSync(path.join(process.cwd(), "out/init.luau"), "");

			// `path.dirname("default.project.json")` is `"."`, which is what a
			// project named relative to the cwd hands down. A mount joined onto
			// that is relative too, and nothing relative is ever inside the
			// absolute frame — so the project would report no roots at all and
			// fall back to the tsconfig `outDir`.
			const config = makeConfig({ rootDir: process.cwd() });

			expect(
				rootsFromRojo({ config, fileSystem, project, rojoDirectory: "." }),
			).toStrictEqual(["out"]);
		});

		it("should keep a mount when rootDir is a filesystem root", async () => {
			expect.assertions(1);

			const { fileSystem, volume } = createMemoryFileSystem();

			const project: RojoProject = {
				name: "test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: {
						$path: "out",
					},
				},
			};

			volume.mkdirSync("/out", { recursive: true });
			volume.writeFileSync("/out/init.luau", "");

			// The one frame that carries a trailing separator, so a containment
			// test reading it verbatim weighs every child against `//` and keeps
			// none. Written as the volume writes it: the frame and the rojo
			// directory name one directory, and only a host-dependent read of
			// "absolute" could make `/` and `C:/` meet.
			const config = makeConfig({ rootDir: "/" });

			expect(
				rootsFromRojo({ config, fileSystem, project, rojoDirectory: "/" }),
			).toStrictEqual(["out"]);
		});

		it("should state a subdirectory project's mount in the rootDir frame", async () => {
			expect.assertions(1);

			const { fileSystem, volume } = createMemoryFileSystem();

			const project: RojoProject = {
				name: "test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: {
						$path: "out",
					},
				},
			};

			volume.mkdirSync(path.join(PROJECT_DIR, "sub/out"), { recursive: true });
			volume.writeFileSync(path.join(PROJECT_DIR, "sub/out/init.luau"), "");

			const config = makeConfig();

			// The only layout where the two frames are different directories:
			// rojo reads `out` against the project beside it, and the root is
			// written from `rootDir`, so the same mount is `sub/out` there.
			expect(
				rootsFromRojo({
					config,
					fileSystem,
					project,
					rojoDirectory: path.join(PROJECT_DIR, "sub"),
				}),
			).toStrictEqual(["sub/out"]);
		});

		it("should take one root for a $path mounted twice", async () => {
			expect.assertions(2);

			const { fileSystem, volume } = createMemoryFileSystem();

			const project: RojoProject = {
				name: "test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: {
						$path: "packages/core/out",
					},
					ServerScriptService: {
						$path: "packages/core/out",
					},
				},
			};

			volume.mkdirSync(path.join(PROJECT_DIR, "packages/core/out"), { recursive: true });
			volume.writeFileSync(path.join(PROJECT_DIR, "packages/core/out/init.luau"), "");
			const statSync = vi.spyOn(fileSystem, "statSync");

			const config = makeConfig();

			expect(rootsFromRojo({ config, fileSystem, project, rojoDirectory })).toStrictEqual([
				"packages/core/out",
			]);
			expect(
				statSync.mock.calls.filter(([target]) => {
					return (
						path.resolve(String(target)) ===
						path.resolve(path.join(PROJECT_DIR, "packages/core/out"))
					);
				}),
			).toHaveLength(1);
		});
	});
});

describe("single-mode $path containment", () => {
	const packageDirectory = posixRoot(path.resolve("/pkg"));
	const packageProject = `${packageDirectory}/test.project.json`;

	function resolveForMount(mount: string): Array<PosixRoot> {
		const { fileSystem, volume } = createMemoryFileSystem();
		for (const directory of [
			`${packageDirectory}/out`,
			"/outside/out",
			path.resolve("../outside/out"),
		]) {
			volume.mkdirSync(directory, { recursive: true });
			volume.writeFileSync(`${directory}/init.luau`, "local x = 1");
		}

		volume.writeFileSync(
			packageProject,
			JSON.stringify({
				name: "test",
				tree: { $className: "DataModel", ReplicatedStorage: { $path: mount } },
			}),
		);

		return resolveLuauRoots({
			config: makeConfig({ rojoProject: packageProject, rootDir: packageDirectory }),
			fileSystem,
			tsconfigReader: noTsconfig,
		});
	}

	it("should keep an absolute mount inside the frame", () => {
		expect.assertions(1);

		expect(resolveForMount(`${packageDirectory}/out`)).toStrictEqual([posixRoot("out")]);
	});

	it("should find no roots for a relative mount outside the frame", () => {
		expect.assertions(1);

		expect(() => resolveForMount("../outside/out")).toThrow("Could not determine luauRoots");
	});
});
