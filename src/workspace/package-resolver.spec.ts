import * as path from "node:path";
import { assert, describe, expect, it, vi } from "vitest";

import { createMemoryFileSystem } from "../../test/mocks/memory-file-system.ts";
import type { FileSystem } from "../utils/file-system.ts";
import type { PackageInfo } from "./package-resolver.ts";
import {
	enumerateWorkspacePackages,
	excludePackages,
	listPackages,
	resolvePackages,
} from "./package-resolver.ts";

const ROOT = path.resolve("/repo");
const STATE_PATH = path.join(ROOT, "node_modules/.pnpm-workspace-state-v1.json");
const YAML_PATH = path.join(ROOT, "pnpm-workspace.yaml");
const INSTALLED_AT = Date.UTC(2026, 0, 2);
const BEFORE_INSTALL = new Date(Date.UTC(2026, 0, 1));

/**
 * A volume holding a workspace whose snapshot postdates its
 * `pnpm-workspace.yaml`.
 *
 * @param files - The checkout, as paths to contents.
 * @param projects - What pnpm recorded at its last install.
 */
function writeInstalledWorkspace(
	files: Record<string, string>,
	projects: Record<string, { name: string }>,
): FileSystem {
	const { fileSystem, volume } = createMemoryFileSystem({
		...files,
		[STATE_PATH]: JSON.stringify({ lastValidatedTimestamp: INSTALLED_AT, projects }),
		[YAML_PATH]: "packages:\n  - packages/*\n",
	});

	volume.utimesSync(YAML_PATH, BEFORE_INSTALL, BEFORE_INSTALL);
	return fileSystem;
}

/**
 * Resolve one name, for the cases that only ask about one.
 *
 * @param fileSystem - The volume to resolve against.
 * @param workspaceRoot - Where the workspace starts.
 * @param name - The package to find.
 * @param patterns - `workspace.packages` globs, when the case declares any.
 */
function resolveOne(
	fileSystem: FileSystem,
	workspaceRoot: string,
	name: string,
	patterns?: Array<string>,
): PackageInfo {
	const [info] = resolvePackages(workspaceRoot, [name], { fileSystem, patterns });
	assert(info !== undefined);
	return info;
}

describe(resolvePackages, () => {
	it("should resolve a package by exact package.json.name match", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({
			[path.join(ROOT, "packages/foo/package.json")]: '{"name":"@halcyon/foo"}',
			[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n  - packages/*\n",
		});

		expect(resolveOne(fileSystem, ROOT, "@halcyon/foo")).toStrictEqual({
			name: "@halcyon/foo",
			packageDirectory: path.join(ROOT, "packages/foo"),
		});
	});

	it("should throw with candidate names when package is not found", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({
			[path.join(ROOT, "packages/bar/package.json")]: '{"name":"@halcyon/bar"}',
			[path.join(ROOT, "packages/foo/package.json")]: '{"name":"@halcyon/foo"}',
			[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n  - packages/*\n",
		});

		expect(() => resolveOne(fileSystem, ROOT, "@halcyon/baz")).toThrowWithMessage(
			Error,
			'Package "@halcyon/baz" not found in workspace. Available: @halcyon/bar, @halcyon/foo',
		);
	});

	it("should expand multiple workspace patterns", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({
			[path.join(ROOT, "apps/web/package.json")]: '{"name":"@halcyon/web"}',
			[path.join(ROOT, "libs/core/package.json")]: '{"name":"@halcyon/core"}',
			[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n  - apps/*\n  - libs/*\n",
		});

		expect(resolveOne(fileSystem, ROOT, "@halcyon/core").packageDirectory).toBe(
			path.join(ROOT, "libs/core"),
		);
	});

	it("should resolve the workspace root when the pattern is a bare dot", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({
			[path.join(ROOT, "package.json")]: '{"name":"anime-rush"}',
			[path.join(ROOT, "packages/foo/package.json")]: '{"name":"@halcyon/foo"}',
			[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n  - .\n  - packages/*\n",
		});

		expect(resolveOne(fileSystem, ROOT, "anime-rush")).toStrictEqual({
			name: "anime-rush",
			packageDirectory: ROOT,
		});
	});

	it("should resolve a package selected by two overlapping patterns once", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({
			[path.join(ROOT, "packages/foo/package.json")]: '{"name":"@halcyon/foo"}',
			[path.join(ROOT, "pnpm-workspace.yaml")]:
				"packages:\n  - packages/*\n  - packages/foo\n",
		});

		expect(resolveOne(fileSystem, ROOT, "@halcyon/foo").packageDirectory).toBe(
			path.join(ROOT, "packages/foo"),
		);
	});

	it("should throw when two pnpm packages share a name", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({
			[path.join(ROOT, "package.json")]: '{"name":"foo"}',
			[path.join(ROOT, "packages/foo/package.json")]: '{"name":"foo"}',
			[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n  - .\n  - packages/*\n",
		});

		expect(() => resolveOne(fileSystem, ROOT, "foo")).toThrow(
			/Duplicate package name.*foo.*\. and packages\/foo/s,
		);
	});

	it("should ignore a blank pattern rather than let it select a package nobody listed", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({
			[path.join(ROOT, "libs/bar/package.json")]: '{"name":"@halcyon/bar"}',
			[path.join(ROOT, "packages/foo/package.json")]: '{"name":"@halcyon/foo"}',
			[path.join(ROOT, "pnpm-workspace.yaml")]: 'packages:\n  - "   "\n  - packages/*\n',
		});

		expect(() => resolveOne(fileSystem, ROOT, "@halcyon/bar")).toThrowWithMessage(
			Error,
			'Package "@halcyon/bar" not found in workspace. Available: @halcyon/foo',
		);
	});

	// pnpm reads the root manifest as a workspace project whether or not
	// `packages:` lists `.`, so a repo that omits it still runs its root tests.
	it("should resolve the workspace root even when packages: does not list it", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({
			[path.join(ROOT, "package.json")]: '{"name":"halcyon"}',
			[path.join(ROOT, "packages/foo/package.json")]: '{"name":"@halcyon/foo"}',
			[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n  - packages/*\n",
		});

		expect(resolveOne(fileSystem, ROOT, "halcyon")).toStrictEqual({
			name: "halcyon",
			packageDirectory: ROOT,
		});
	});

	it("should drop packages an exclusion pattern removes", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({
			[path.join(ROOT, "pnpm-workspace.yaml")]:
				"packages:\n  - tools/**/*\n  - '!tools/*/tests/*'\n",
			[path.join(ROOT, "tools/cli/package.json")]: '{"name":"@halcyon/cli"}',
			[path.join(ROOT, "tools/cli/tests/fixture/package.json")]: '{"name":"@test/fixture"}',
		});

		expect(() => resolveOne(fileSystem, ROOT, "@test/fixture")).toThrowWithMessage(
			Error,
			'Package "@test/fixture" not found in workspace. Available: @halcyon/cli',
		);
	});

	it("should apply an exclusion that reaches through a deep wildcard", () => {
		expect.assertions(2);

		const { fileSystem } = createMemoryFileSystem({
			[path.join(ROOT, "packages/foo/out-tsc/vendored/package.json")]:
				'{"name":"@halcyon/vendored"}',
			[path.join(ROOT, "packages/foo/package.json")]: '{"name":"@halcyon/foo"}',
			[path.join(ROOT, "pnpm-workspace.yaml")]:
				"packages:\n  - packages/**/*\n  - '!**/out-tsc/**'\n",
		});

		expect(resolveOne(fileSystem, ROOT, "@halcyon/foo").packageDirectory).toBe(
			path.join(ROOT, "packages/foo"),
		);
		expect(() => resolveOne(fileSystem, ROOT, "@halcyon/vendored")).toThrow(/not found/);
	});

	// Verified against pnpm 11.17 (`pnpm ls -r --depth -1`): pnpm does not trim
	// its `packages:` entries, so neither of these is an exclusion — each is a
	// positive pattern that matches nothing, and the package survives.
	it("should read a padded exclusion as a pattern that matches nothing", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({
			[path.join(ROOT, "packages/foo/package.json")]: '{"name":"@halcyon/foo"}',
			[path.join(ROOT, "pnpm-workspace.yaml")]:
				'packages:\n  - packages/*\n  - " !packages/foo "\n',
		});

		expect(resolveOne(fileSystem, ROOT, "@halcyon/foo").packageDirectory).toBe(
			path.join(ROOT, "packages/foo"),
		);
	});

	it("should read an exclamation mark followed by a space as no exclusion", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({
			[path.join(ROOT, "packages/foo/package.json")]: '{"name":"@halcyon/foo"}',
			[path.join(ROOT, "pnpm-workspace.yaml")]:
				'packages:\n  - packages/*\n  - "! packages/foo"\n',
		});

		expect(resolveOne(fileSystem, ROOT, "@halcyon/foo").packageDirectory).toBe(
			path.join(ROOT, "packages/foo"),
		);
	});

	it("should ignore a bare exclamation mark rather than let it drop the root", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({
			[path.join(ROOT, "package.json")]: '{"name":"halcyon"}',
			[path.join(ROOT, "pnpm-workspace.yaml")]: 'packages:\n  - "!"\n',
		});

		expect(resolveOne(fileSystem, ROOT, "halcyon").packageDirectory).toBe(ROOT);
	});

	it("should throw when pnpm-workspace.yaml has no packages field", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({
			[path.join(ROOT, "pnpm-workspace.yaml")]: "autoInstallPeers: true\n",
		});

		expect(() => resolveOne(fileSystem, ROOT, "@halcyon/foo")).toThrowWithMessage(
			Error,
			'Package "@halcyon/foo" not found in workspace. Available: ',
		);
	});

	it("should ignore a package.json that is not a JSON object (e.g. an array)", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({
			[path.join(ROOT, "packages/bar/package.json")]: '{"name":"@halcyon/bar"}',
			[path.join(ROOT, "packages/foo/package.json")]: "[]",
			[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n  - packages/*\n",
		});

		expect(resolveOne(fileSystem, ROOT, "@halcyon/bar").packageDirectory).toBe(
			path.join(ROOT, "packages/bar"),
		);
	});

	it("should surface the file path when a package.json is malformed JSON", () => {
		expect.assertions(2);

		const { fileSystem } = createMemoryFileSystem({
			[path.join(ROOT, "packages/foo/package.json")]: "{ not valid json",
			[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n  - packages/*\n",
		});

		let caught: unknown;
		try {
			resolveOne(fileSystem, ROOT, "@halcyon/foo");
		} catch (err) {
			caught = err;
		}

		assert(caught instanceof Error);

		expect(caught.message).toBe(
			`Failed to parse ${path.join(ROOT, "packages/foo/package.json")}.`,
		);
		expect(caught.cause).toBeInstanceOf(SyntaxError);
	});

	it("should ignore package.json files that lack a string name field", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({
			[path.join(ROOT, "packages/bar/package.json")]: '{"name":"@halcyon/bar"}',
			[path.join(ROOT, "packages/foo/package.json")]: '{"version":"1.0.0"}',
			[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n  - packages/*\n",
		});

		expect(resolveOne(fileSystem, ROOT, "@halcyon/bar").packageDirectory).toBe(
			path.join(ROOT, "packages/bar"),
		);
	});

	it("should ignore directories under a workspace pattern that lack package.json", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({
			[path.join(ROOT, "packages/foo/package.json")]: '{"name":"@halcyon/foo"}',
			[path.join(ROOT, "packages/junk/README.md")]: "scratch",
			[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n  - packages/*\n",
		});

		expect(resolveOne(fileSystem, ROOT, "@halcyon/foo").packageDirectory).toBe(
			path.join(ROOT, "packages/foo"),
		);
	});

	it("should throw a clear error when pnpm-workspace.yaml is missing", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({
			[path.join(ROOT, "packages/foo/package.json")]: '{"name":"@halcyon/foo"}',
			[path.join(ROOT, "turbo.json")]: "{}",
		});

		expect(() => resolveOne(fileSystem, ROOT, "@halcyon/foo")).toThrowWithMessage(
			Error,
			"Workspace mode requires either a `workspace.packages` glob list in your " +
				"jest config or a pnpm-workspace.yaml at the workspace root. " +
				"Use `workspace.packages` (with `--workspace-root` to run from outside " +
				"a package) for Luau-only, npm, or yarn repos.",
		);
	});

	it("should resolve several names in the order they were asked for", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({
			[path.join(ROOT, "packages/bar/package.json")]: '{"name":"@halcyon/bar"}',
			[path.join(ROOT, "packages/foo/package.json")]: '{"name":"@halcyon/foo"}',
			[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n  - packages/*\n",
		});

		expect(
			resolvePackages(ROOT, ["@halcyon/foo", "@halcyon/bar"], { fileSystem }),
		).toStrictEqual([
			{ name: "@halcyon/foo", packageDirectory: path.join(ROOT, "packages/foo") },
			{ name: "@halcyon/bar", packageDirectory: path.join(ROOT, "packages/bar") },
		]);
	});

	it("should name the missing package when one of several does not resolve", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({
			[path.join(ROOT, "packages/foo/package.json")]: '{"name":"@halcyon/foo"}',
			[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n  - packages/*\n",
		});

		expect(() => {
			return resolvePackages(ROOT, ["@halcyon/foo", "@halcyon/baz"], { fileSystem });
		}).toThrowWithMessage(
			Error,
			'Package "@halcyon/baz" not found in workspace. Available: @halcyon/foo',
		);
	});

	describe("pnpm workspace state", () => {
		// The snapshot names a directory that holds no package.json, so a
		// walk could not produce this answer -- only the snapshot can.
		it("should answer from the snapshot rather than the filesystem", () => {
			expect.assertions(1);

			const fileSystem = writeInstalledWorkspace(
				{ [path.join(ROOT, "packages/ghost/README.md")]: "no manifest here" },
				{ [path.join(ROOT, "packages/ghost")]: { name: "@halcyon/ghost" } },
			);

			expect(resolveOne(fileSystem, ROOT, "@halcyon/ghost")).toStrictEqual({
				name: "@halcyon/ghost",
				packageDirectory: path.join(ROOT, "packages/ghost"),
			});
		});

		it("should list from the walk when no snapshot exists", () => {
			expect.assertions(1);

			const { fileSystem } = createMemoryFileSystem({
				[path.join(ROOT, "packages/foo/package.json")]: '{"name":"@halcyon/foo"}',
				[YAML_PATH]: "packages:\n  - packages/*\n",
			});

			expect(listPackages(ROOT, { fileSystem })).toStrictEqual([
				{ name: "@halcyon/foo", packageDirectory: path.join(ROOT, "packages/foo") },
			]);
		});

		it("should list the dot-directory packages a walk cannot see", () => {
			expect.assertions(1);

			const fileSystem = writeInstalledWorkspace(
				{},
				{ [path.join(ROOT, ".codex")]: { name: "halcyon-codex" } },
			);

			expect(listPackages(ROOT, { fileSystem })).toStrictEqual([
				{ name: "halcyon-codex", packageDirectory: path.join(ROOT, ".codex") },
			]);
		});

		// A package added since the last install is real but unrecorded, so a
		// miss must reach the filesystem before it becomes an error.
		it("should walk the filesystem when a name misses the snapshot", () => {
			expect.assertions(1);

			const fileSystem = writeInstalledWorkspace(
				{
					[path.join(ROOT, "packages/bar/package.json")]: '{"name":"@halcyon/bar"}',
					[path.join(ROOT, "packages/foo/package.json")]: '{"name":"@halcyon/foo"}',
				},
				{ [path.join(ROOT, "packages/foo")]: { name: "@halcyon/foo" } },
			);

			expect(resolveOne(fileSystem, ROOT, "@halcyon/bar").packageDirectory).toBe(
				path.join(ROOT, "packages/bar"),
			);
		});

		it("should resolve a batch where only some names reach the snapshot", () => {
			expect.assertions(1);

			const fileSystem = writeInstalledWorkspace(
				{
					[path.join(ROOT, "packages/bar/package.json")]: '{"name":"@halcyon/bar"}',
					[path.join(ROOT, "packages/foo/package.json")]: '{"name":"@halcyon/foo"}',
				},
				{ [path.join(ROOT, "packages/foo")]: { name: "@halcyon/foo" } },
			);

			expect(
				resolvePackages(ROOT, ["@halcyon/foo", "@halcyon/bar"], { fileSystem }),
			).toStrictEqual([
				{ name: "@halcyon/foo", packageDirectory: path.join(ROOT, "packages/foo") },
				{ name: "@halcyon/bar", packageDirectory: path.join(ROOT, "packages/bar") },
			]);
		});

		it("should report the walked names when a miss survives the fallback", () => {
			expect.assertions(1);

			const fileSystem = writeInstalledWorkspace(
				{ [path.join(ROOT, "packages/foo/package.json")]: '{"name":"@halcyon/foo"}' },
				{ [path.join(ROOT, "packages/foo")]: { name: "@halcyon/foo" } },
			);

			expect(() => resolveOne(fileSystem, ROOT, "@halcyon/baz")).toThrowWithMessage(
				Error,
				'Package "@halcyon/baz" not found in workspace. Available: @halcyon/foo',
			);
		});

		// The snapshot is machine-written, but two packages can still share a
		// name in it, and the resolver has no way to pick between them.
		it("should reject two snapshot projects that share a name", () => {
			expect.assertions(1);

			const fileSystem = writeInstalledWorkspace(
				{},
				{
					[path.join(ROOT, "libs/foo")]: { name: "@halcyon/foo" },
					[path.join(ROOT, "packages/foo")]: { name: "@halcyon/foo" },
				},
			);

			expect(() => resolveOne(fileSystem, ROOT, "@halcyon/foo")).toThrowWithMessage(
				Error,
				'Duplicate package name "@halcyon/foo" from libs/foo and packages/foo. ' +
					"Add a package.json with a unique `name`, or rename a directory.",
			);
		});

		it("should ignore the snapshot when workspace.packages patterns are given", () => {
			expect.assertions(1);

			const fileSystem = writeInstalledWorkspace(
				{ [path.join(ROOT, "libs/bar/jest.config.ts")]: "" },
				{ [path.join(ROOT, "packages/ghost")]: { name: "@halcyon/ghost" } },
			);

			expect(() => resolveOne(fileSystem, ROOT, "@halcyon/ghost", ["libs/*"])).toThrow(
				/not found/,
			);
		});
	});

	describe("workspace.packages globs", () => {
		it("should enumerate packages via patterns when no PM file exists", () => {
			expect.assertions(1);

			const { fileSystem } = createMemoryFileSystem({
				[path.join(ROOT, "packages/foo/jest.config.ts")]: "",
				[path.join(ROOT, "packages/foo/package.json")]: '{"name":"@halcyon/foo"}',
			});

			const info = resolveOne(fileSystem, ROOT, "@halcyon/foo", ["packages/*"]);

			expect(info.packageDirectory).toBe(path.join(ROOT, "packages/foo"));
		});

		it("should enumerate the workspace root when the pattern is a bare dot", () => {
			expect.assertions(1);

			const { fileSystem } = createMemoryFileSystem({
				[path.join(ROOT, "jest.config.ts")]: "",
				[path.join(ROOT, "package.json")]: '{"name":"anime-rush"}',
				[path.join(ROOT, "packages/foo/jest.config.ts")]: "",
			});

			const info = resolveOne(fileSystem, ROOT, "anime-rush", [".", "packages/*"]);

			expect(info.packageDirectory).toBe(ROOT);
		});

		it("should infer name from directory basename when no package.json exists (Luau-only)", () => {
			expect.assertions(1);

			const { fileSystem } = createMemoryFileSystem({
				[path.join(ROOT, "packages/foo/default.project.json")]: "{}",
				[path.join(ROOT, "packages/foo/jest.config.ts")]: "",
			});

			const info = resolveOne(fileSystem, ROOT, "foo", ["packages/*"]);

			expect(info.packageDirectory).toBe(path.join(ROOT, "packages/foo"));
		});

		it("should prefer package.json#name over directory basename", () => {
			expect.assertions(1);

			const { fileSystem } = createMemoryFileSystem({
				[path.join(ROOT, "packages/foo/jest.config.ts")]: "",
				[path.join(ROOT, "packages/foo/package.json")]: '{"name":"@halcyon/foo"}',
			});

			expect(() => resolveOne(fileSystem, ROOT, "foo", ["packages/*"])).toThrow(/not found/);
		});

		it("should skip directories without a jest.config", () => {
			expect.assertions(1);

			const { fileSystem } = createMemoryFileSystem({
				[path.join(ROOT, "packages/foo/jest.config.ts")]: "",
				[path.join(ROOT, "packages/junk/README.md")]: "scratch",
			});

			const info = resolveOne(fileSystem, ROOT, "foo", ["packages/*"]);

			expect(info.packageDirectory).toBe(path.join(ROOT, "packages/foo"));
		});

		it("should skip jest.config.spec.ts and similar non-config jest files", () => {
			expect.assertions(2);

			const { fileSystem, volume } = createMemoryFileSystem({
				[path.join(ROOT, "packages/foo/jest.config.spec.ts")]: "",
				[path.join(ROOT, "packages/foo/jest.config.ts")]: "",
			});

			const info = resolveOne(fileSystem, ROOT, "foo", ["packages/*"]);

			expect(info.packageDirectory).toBe(path.join(ROOT, "packages/foo"));

			volume.unlinkSync(path.join(ROOT, "packages/foo/jest.config.ts"));

			expect(() => resolveOne(fileSystem, ROOT, "foo", ["packages/*"])).toThrowWithMessage(
				Error,
				'Package "foo" not found in workspace. Available: ',
			);
		});

		it("should skip filenames that only end with jest.config.<ext>", () => {
			expect.assertions(1);

			const { fileSystem } = createMemoryFileSystem({
				[path.join(ROOT, "packages/foo/not-jest.config.ts")]: "",
			});

			expect(() => resolveOne(fileSystem, ROOT, "foo", ["packages/*"])).toThrowWithMessage(
				Error,
				'Package "foo" not found in workspace. Available: ',
			);
		});

		it("should expand multiple patterns", () => {
			expect.assertions(2);

			const { fileSystem } = createMemoryFileSystem({
				[path.join(ROOT, "apps/web/jest.config.ts")]: "",
				[path.join(ROOT, "libs/core/jest.config.ts")]: "",
			});

			const patterns = ["apps/*", "libs/*"];

			expect(resolveOne(fileSystem, ROOT, "web", patterns).packageDirectory).toBe(
				path.join(ROOT, "apps/web"),
			);
			expect(resolveOne(fileSystem, ROOT, "core", patterns).packageDirectory).toBe(
				path.join(ROOT, "libs/core"),
			);
		});

		it("should throw when two packages resolve to the same name", () => {
			expect.assertions(1);

			const { fileSystem } = createMemoryFileSystem({
				[path.join(ROOT, "libs/foo/jest.config.ts")]: "",
				[path.join(ROOT, "packages/foo/jest.config.ts")]: "",
			});

			expect(() => resolveOne(fileSystem, ROOT, "foo", ["libs/*", "packages/*"])).toThrow(
				/Duplicate package name.*foo.*libs\/foo.*packages\/foo/s,
			);
		});

		it("should name the workspace root as . when it duplicates a package name", () => {
			expect.assertions(1);

			const { fileSystem } = createMemoryFileSystem({
				[path.join(ROOT, "jest.config.ts")]: "",
				[path.join(ROOT, "package.json")]: '{"name":"foo"}',
				[path.join(ROOT, "packages/foo/jest.config.ts")]: "",
			});

			expect(() => resolveOne(fileSystem, ROOT, "foo", [".", "packages/*"])).toThrow(
				/Duplicate package name.*foo.*\. and packages\/foo/s,
			);
		});

		it("should take precedence over pnpm-workspace.yaml when both exist", () => {
			expect.assertions(1);

			const { fileSystem } = createMemoryFileSystem({
				[path.join(ROOT, "libs/bar/jest.config.ts")]: "",
				[path.join(ROOT, "libs/bar/package.json")]: '{"name":"@halcyon/bar"}',
				[path.join(ROOT, "packages/foo/package.json")]: '{"name":"@halcyon/foo"}',
				[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n  - packages/*\n",
			});

			expect(() => resolveOne(fileSystem, ROOT, "@halcyon/foo", ["libs/*"])).toThrow(
				/not found/,
			);
		});

		// `matchUnderPatterns` serves both sources, so an exclusion means the
		// same thing in `workspace.packages` as it does in `packages:`.
		it("should drop packages an exclusion pattern removes", () => {
			expect.assertions(2);

			const { fileSystem } = createMemoryFileSystem({
				[path.join(ROOT, "tools/cli/jest.config.ts")]: "",
				[path.join(ROOT, "tools/cli/tests/fixture/jest.config.ts")]: "",
			});

			const patterns = ["tools/**/*", "!tools/*/tests/*"];

			expect(resolveOne(fileSystem, ROOT, "cli", patterns).packageDirectory).toBe(
				path.join(ROOT, "tools/cli"),
			);
			expect(() => resolveOne(fileSystem, ROOT, "fixture", patterns)).toThrow(/not found/);
		});

		// The pnpm path adds the root whatever the patterns say, so a blank entry
		// selecting it there is invisible. Here it is not: nothing else puts the
		// root in the list, so an unguarded blank entry hands back a package the
		// config never named.
		it("should ignore a blank pattern rather than let it select the root", () => {
			expect.assertions(1);

			const { fileSystem } = createMemoryFileSystem({
				[path.join(ROOT, "jest.config.ts")]: "",
				[path.join(ROOT, "package.json")]: '{"name":"halcyon"}',
				[path.join(ROOT, "packages/foo/jest.config.ts")]: "",
			});

			expect(() => {
				return resolveOne(fileSystem, ROOT, "halcyon", ["", "packages/*"]);
			}).toThrowWithMessage(
				Error,
				'Package "halcyon" not found in workspace. Available: foo',
			);
		});

		it("should dedupe a directory with multiple jest.config files", () => {
			expect.assertions(1);

			const { fileSystem } = createMemoryFileSystem({
				[path.join(ROOT, "packages/foo/jest.config.ts")]: "",
				[path.join(ROOT, "packages/foo/jest.config.yaml")]: "",
			});

			const info = resolveOne(fileSystem, ROOT, "foo", ["packages/*"]);

			expect(info.packageDirectory).toBe(path.join(ROOT, "packages/foo"));
		});
	});
});

describe(enumerateWorkspacePackages, () => {
	it("should drop a pnpm package that carries no jest.config", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({
			[path.join(ROOT, "packages/bar/package.json")]: '{"name":"@halcyon/bar"}',
			[path.join(ROOT, "packages/foo/jest.config.ts")]: "",
			[path.join(ROOT, "packages/foo/package.json")]: '{"name":"@halcyon/foo"}',
			[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n  - packages/*\n",
		});

		expect(enumerateWorkspacePackages(ROOT, { fileSystem })).toStrictEqual([
			{ name: "@halcyon/foo", packageDirectory: path.join(ROOT, "packages/foo") },
		]);
	});

	it("should drop a package an exclude glob names", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({
			[path.join(ROOT, "packages/bar/jest.config.ts")]: "",
			[path.join(ROOT, "packages/bar/package.json")]: '{"name":"@halcyon/bar"}',
			[path.join(ROOT, "packages/foo/jest.config.ts")]: "",
			[path.join(ROOT, "packages/foo/package.json")]: '{"name":"@halcyon/foo"}',
			[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n  - packages/*\n",
		});

		const enumerated = enumerateWorkspacePackages(ROOT, {
			exclude: ["packages/bar"],
			fileSystem,
		});

		expect(enumerated.map((info) => info.name)).toStrictEqual(["@halcyon/foo"]);
	});

	it("should apply an exclude to the config glob source too", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({
			[path.join(ROOT, "fixtures/sample/jest.config.ts")]: "",
			[path.join(ROOT, "libs/core/jest.config.ts")]: "",
		});

		const enumerated = enumerateWorkspacePackages(ROOT, {
			exclude: ["fixtures/**"],
			fileSystem,
			patterns: ["fixtures/*", "libs/*"],
		});

		expect(enumerated.map((info) => info.name)).toStrictEqual(["core"]);
	});

	it("should not report a duplicate name the exclude removed", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({
			[path.join(ROOT, "fixtures/core/jest.config.ts")]: "",
			[path.join(ROOT, "libs/core/jest.config.ts")]: "",
		});

		const enumerated = enumerateWorkspacePackages(ROOT, {
			exclude: ["fixtures/**"],
			fileSystem,
			patterns: ["fixtures/*", "libs/*"],
		});

		expect(enumerated.map((info) => info.packageDirectory)).toStrictEqual([
			path.join(ROOT, "libs/core"),
		]);
	});

	it("should still resolve a named package that carries no jest.config", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({
			[path.join(ROOT, "packages/bar/package.json")]: '{"name":"@halcyon/bar"}',
			[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n  - packages/*\n",
		});

		// Enumeration skips it; naming it keeps failing downstream on the
		// missing config rather than reading as a package that does not exist.
		expect(resolveOne(fileSystem, ROOT, "@halcyon/bar").packageDirectory).toBe(
			path.join(ROOT, "packages/bar"),
		);
	});
});

describe("pnpm-workspace.yaml negation", () => {
	it("should drop a package a ! pattern excludes", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({
			[path.join(ROOT, "packages/foo/package.json")]: '{"name":"@halcyon/foo"}',
			[path.join(ROOT, "packages/tests/fixture/package.json")]: '{"name":"@halcyon/fixture"}',
			[path.join(ROOT, "pnpm-workspace.yaml")]:
				'packages:\n  - "!packages/tests/*"\n  - packages/*\n  - packages/**/*\n',
		});

		expect(listPackages(ROOT, { fileSystem }).map((info) => info.name)).toStrictEqual([
			"@halcyon/foo",
		]);
	});

	it("should drop a package a ! pattern excludes at any depth", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({
			[path.join(ROOT, "libs/core/out-tsc/stale/package.json")]: '{"name":"@halcyon/stale"}',
			[path.join(ROOT, "libs/core/package.json")]: '{"name":"@halcyon/core"}',
			[path.join(ROOT, "pnpm-workspace.yaml")]:
				'packages:\n  - "!**/out-tsc/**"\n  - libs/**/*\n',
		});

		expect(listPackages(ROOT, { fileSystem }).map((info) => info.name)).toStrictEqual([
			"@halcyon/core",
		]);
	});

	it("should apply a ! pattern to the config glob source too", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({
			[path.join(ROOT, "libs/core/jest.config.ts")]: "",
			[path.join(ROOT, "libs/fixture/jest.config.ts")]: "",
		});

		const enumerated = enumerateWorkspacePackages(ROOT, {
			fileSystem,
			patterns: ["!libs/fixture", "libs/*"],
		});

		expect(enumerated.map((info) => info.name)).toStrictEqual(["core"]);
	});
});

// pnpm appends the manifest name to every entry including negations, so a `!`
// glob filters manifest paths rather than directories. Verified against pnpm
// 11.17 with `pnpm ls -r`: both cases below drop the package.
describe("pnpm-workspace.yaml negation semantics", () => {
	it("should exclude a package one level down from a */** negation", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({
			[path.join(ROOT, "packages/a/package.json")]: '{"name":"pkg-a"}',
			[path.join(ROOT, "packages/tests/fixture/package.json")]: '{"name":"pkg-fixture"}',
			[path.join(ROOT, "pnpm-workspace.yaml")]:
				'packages:\n  - "!packages/*/**"\n  - packages/*\n  - packages/**/*\n',
		});

		// `**` collapses to zero segments before the manifest, so `packages/a`
		// goes too — matching the directory alone would keep it.
		expect(listPackages(ROOT, { fileSystem })).toBeEmpty();
	});

	it("should exclude a package whose own directory is the negated segment", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({
			[path.join(ROOT, "packages/a/package.json")]: '{"name":"pkg-a"}',
			[path.join(ROOT, "packages/out-tsc/package.json")]: '{"name":"pkg-out-tsc"}',
			[path.join(ROOT, "pnpm-workspace.yaml")]:
				'packages:\n  - "!**/out-tsc/**"\n  - packages/*\n',
		});

		expect(listPackages(ROOT, { fileSystem }).map((info) => info.name)).toStrictEqual([
			"pkg-a",
		]);
	});
});

describe(excludePackages, () => {
	const packages = [{ name: "@halcyon/foo", packageDirectory: path.join(ROOT, "packages/foo") }];

	it("should return the input untouched for an empty exclude list", () => {
		expect.assertions(1);

		expect(excludePackages(packages, ROOT, [])).toBe(packages);
	});

	it("should return the input untouched when no exclude is given", () => {
		expect.assertions(1);

		expect(excludePackages(packages, ROOT, undefined)).toBe(packages);
	});

	it("should keep a package no glob names", () => {
		expect.assertions(1);

		expect(excludePackages(packages, ROOT, ["packages/bar"])).toStrictEqual(packages);
	});

	it("should drop a package only one of several globs names", () => {
		expect.assertions(1);

		expect(excludePackages(packages, ROOT, ["libs/**", "packages/foo"])).toBeEmpty();
	});
});

describe("workspace enumeration edge cases", () => {
	it("should report a duplicate name the exclude did not remove", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({
			[path.join(ROOT, "fixtures/core/jest.config.ts")]: "",
			[path.join(ROOT, "libs/core/jest.config.ts")]: "",
		});

		expect(() => {
			return enumerateWorkspacePackages(ROOT, {
				fileSystem,
				patterns: ["fixtures/*", "libs/*"],
			});
		}).toThrow(/Duplicate package name.*core/s);
	});

	// Asserted through the config-glob source, which has no floor. The pnpm
	// source seats the workspace root whatever the patterns say, so the root
	// comes back there whether the guard ran or not.
	it("should skip a blank pattern rather than selecting the root", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({
			[path.join(ROOT, "jest.config.ts")]: "",
			[path.join(ROOT, "package.json")]: '{"name":"repo-root"}',
			[path.join(ROOT, "packages/foo/jest.config.ts")]: "",
			[path.join(ROOT, "packages/foo/package.json")]: '{"name":"@halcyon/foo"}',
		});

		expect(
			enumerateWorkspacePackages(ROOT, { fileSystem, patterns: ["  ", "packages/*"] }).map(
				(info) => info.name,
			),
		).toStrictEqual(["@halcyon/foo"]);
	});

	it("should find a jest.config beside a manifest at any depth", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({
			[path.join(ROOT, "a/b/c/jest.config.ts")]: "",
			[path.join(ROOT, "a/b/c/package.json")]: '{"name":"@halcyon/deep"}',
			[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n  - a/b/*\n",
		});

		// The jest.config sweep globs from the root rather than from the pnpm
		// patterns, so a package nested below them is still gated correctly.
		expect(
			enumerateWorkspacePackages(ROOT, { fileSystem }).map((info) => info.name),
		).toStrictEqual(["@halcyon/deep"]);
	});

	it("should not treat a dotted config suffix as a jest config", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({
			[path.join(ROOT, "packages/foo/jest.config.spec.ts")]: "",
			[path.join(ROOT, "packages/foo/package.json")]: '{"name":"@halcyon/foo"}',
			[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n  - packages/*\n",
		});

		expect(enumerateWorkspacePackages(ROOT, { fileSystem })).toBeEmpty();
	});
});

describe("workspace enumeration walk sharing", () => {
	it("should walk the workspace root once for every pnpm pattern and both leaves", () => {
		expect.assertions(2);

		const { fileSystem } = createMemoryFileSystem({
			[path.join(ROOT, "apps/web/jest.config.ts")]: "",
			[path.join(ROOT, "apps/web/package.json")]: '{"name":"@halcyon/web"}',
			[path.join(ROOT, "libs/core/jest.config.ts")]: "",
			[path.join(ROOT, "libs/core/package.json")]: '{"name":"@halcyon/core"}',
			[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n  - apps/*\n  - libs/*\n",
		});

		const readdir = vi.spyOn(fileSystem, "readdirSync");
		const enumerated = enumerateWorkspacePackages(ROOT, { fileSystem });
		// Four directories under the root, visited once each: two patterns and
		// two leaves (package.json, jest.config.*) share one walk.
		const directoriesWalked = new Set(readdir.mock.calls.map(([target]) => String(target)));

		expect(enumerated).toHaveLength(2);
		expect(readdir).toHaveBeenCalledTimes(directoriesWalked.size);
	});
});

describe("workspace pattern-list handling", () => {
	// Through the config-glob source, for the reason the bare-`!` spec below
	// gives: `path.posix.join("", leaf)` is the bare leaf, so an entry naming
	// nothing selects the root — which a source that always carries the root
	// would hide.
	it("should not let an empty entry select the root package", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({
			[path.join(ROOT, "jest.config.ts")]: "",
			[path.join(ROOT, "libs/core/jest.config.ts")]: "",
			[path.join(ROOT, "package.json")]: '{"name":"repo-root"}',
		});

		expect(
			enumerateWorkspacePackages(ROOT, { fileSystem, patterns: ["", "libs/*"] }).map(
				(info) => info.name,
			),
		).toStrictEqual(["core"]);
	});

	it("should drop a package matching any one of several negations", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({
			[path.join(ROOT, "packages/a/package.json")]: '{"name":"pkg-a"}',
			[path.join(ROOT, "packages/b/package.json")]: '{"name":"pkg-b"}',
			[path.join(ROOT, "packages/c/package.json")]: '{"name":"pkg-c"}',
			[path.join(ROOT, "pnpm-workspace.yaml")]:
				'packages:\n  - "!packages/a"\n  - "!packages/b"\n  - packages/*\n',
		});

		// `pkg-c` clears both negations; `pkg-a` and `pkg-b` each clear one.
		// Requiring every negation to pass is what drops them.
		expect(listPackages(ROOT, { fileSystem }).map((info) => info.name)).toStrictEqual([
			"pkg-c",
		]);
	});

	it("should walk the workspace root once for an uncached multi-pattern match", () => {
		expect.assertions(2);

		const { fileSystem } = createMemoryFileSystem({
			[path.join(ROOT, "apps/web/package.json")]: '{"name":"@halcyon/web"}',
			[path.join(ROOT, "libs/core/package.json")]: '{"name":"@halcyon/core"}',
			[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n  - apps/*\n  - libs/*\n",
		});

		const readdir = vi.spyOn(fileSystem, "readdirSync");
		const found = listPackages(ROOT, { fileSystem });
		const directoriesWalked = new Set(readdir.mock.calls.map(([target]) => String(target)));

		expect(found).toHaveLength(2);
		// The cache this path builds itself must still be declared for the
		// leaf, or each pattern falls back to a walk of its own.
		expect(readdir).toHaveBeenCalledTimes(directoriesWalked.size);
	});

	it("should name the remedy when two packages share a name", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({
			[path.join(ROOT, "libs/foo/package.json")]: '{"name":"foo"}',
			[path.join(ROOT, "packages/foo/package.json")]: '{"name":"foo"}',
			[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n  - libs/*\n  - packages/*\n",
		});

		expect(() => listPackages(ROOT, { fileSystem })).toThrowWithMessage(
			Error,
			'Duplicate package name "foo" from libs/foo and packages/foo. ' +
				"Add a package.json with a unique `name`, or rename a directory.",
		);
	});
});

// Both filters live downstream of the source fork, so neither can depend on
// which source answered. A source that gated itself would make `exclude` and
// the jest.config requirement intermittent the day a third source is added.
describe("workspace enumeration filters are source-independent", () => {
	it("should require a jest.config from the config-glob source too", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({
			[path.join(ROOT, "libs/core/jest.config.ts")]: "",
			[path.join(ROOT, "libs/plain/package.json")]: '{"name":"plain"}',
		});

		expect(
			enumerateWorkspacePackages(ROOT, { fileSystem, patterns: ["libs/*"] }).map(
				(info) => info.name,
			),
		).toStrictEqual(["core"]);
	});

	it("should apply the exclude to the config-glob source too", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({
			[path.join(ROOT, "libs/core/jest.config.ts")]: "",
			[path.join(ROOT, "libs/fixture/jest.config.ts")]: "",
		});

		expect(
			enumerateWorkspacePackages(ROOT, {
				exclude: ["libs/fixture"],
				fileSystem,
				patterns: ["libs/*"],
			}).map((info) => info.name),
		).toStrictEqual(["core"]);
	});

	it("should apply both filters to the pnpm source too", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({
			[path.join(ROOT, "libs/core/jest.config.ts")]: "",
			[path.join(ROOT, "libs/core/package.json")]: '{"name":"core"}',
			[path.join(ROOT, "libs/fixture/jest.config.ts")]: "",
			[path.join(ROOT, "libs/fixture/package.json")]: '{"name":"fixture"}',
			[path.join(ROOT, "libs/plain/package.json")]: '{"name":"plain"}',
			[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n  - libs/*\n",
		});

		expect(
			enumerateWorkspacePackages(ROOT, { exclude: ["libs/fixture"], fileSystem }).map(
				(info) => info.name,
			),
		).toStrictEqual(["core"]);
	});
});

describe("workspace.exclude glob shapes", () => {
	// The shape the README documents. It needs a trailing `**` to reach a
	// package nested below the excluded directory rather than beside it.
	it("should drop packages at any depth below a trailing doublestar", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({
			[path.join(ROOT, "libs/core/jest.config.ts")]: "",
			[path.join(ROOT, "libs/core/package.json")]: '{"name":"@halcyon/core"}',
			[path.join(ROOT, "pnpm-workspace.yaml")]:
				"packages:\n  - libs/*\n  - test/fixtures/**/*\n",
			[path.join(ROOT, "test/fixtures/deep/nested/jest.config.ts")]: "",
			[path.join(ROOT, "test/fixtures/deep/nested/package.json")]: '{"name":"@e2e/deep"}',
			[path.join(ROOT, "test/fixtures/flat/jest.config.ts")]: "",
			[path.join(ROOT, "test/fixtures/flat/package.json")]: '{"name":"@e2e/flat"}',
		});

		const enumerated = enumerateWorkspacePackages(ROOT, {
			exclude: ["test/fixtures/**"],
			fileSystem,
		});

		expect(enumerated.map((info) => info.name)).toStrictEqual(["@halcyon/core"]);
	});

	// Asserted through the config-glob source rather than the pnpm one on
	// purpose. Joining the leaf onto an empty negation body yields the bare
	// leaf, which is whatever file the root itself carries — so the entry
	// deletes the root package. A pnpm source that prepends the root
	// unconditionally (as pnpm does, and as a package-manager snapshot would)
	// puts it back either way, leaving nothing for the assertion to catch.
	it("should ignore a bare ! rather than delete the root package", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({
			[path.join(ROOT, "jest.config.ts")]: "",
			[path.join(ROOT, "libs/core/jest.config.ts")]: "",
			[path.join(ROOT, "package.json")]: '{"name":"the-root"}',
		});

		expect(
			enumerateWorkspacePackages(ROOT, { fileSystem, patterns: [".", "libs/*", "!"] }).map(
				(info) => info.name,
			),
		).toStrictEqual(["the-root", "core"]);
	});
});
