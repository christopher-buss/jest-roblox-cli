import { fromAny } from "@total-typescript/shoehorn";

import { vol } from "memfs";
import * as fs from "node:fs";
import * as path from "node:path";
import { assert, describe, expect, it, vi } from "vitest";

import {
	enumerateWorkspacePackages,
	excludePackages,
	listPackages,
	resolvePackage,
} from "./package-resolver.ts";

vi.mock(import("node:fs"), async () => {
	const memfs = await vi.importActual<typeof import("memfs")>("memfs");
	return fromAny({ ...memfs.fs, default: memfs.fs });
});

const ROOT = path.resolve("/repo");

describe(resolvePackage, () => {
	it("should resolve a package by exact package.json.name match", () => {
		expect.assertions(1);

		vol.reset();

		vol.fromJSON({
			[path.join(ROOT, "packages/foo/package.json")]: '{"name":"@halcyon/foo"}',
			[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n  - packages/*\n",
		});

		expect(resolvePackage(ROOT, "@halcyon/foo")).toStrictEqual({
			name: "@halcyon/foo",
			packageDirectory: path.join(ROOT, "packages/foo"),
		});
	});

	it("should throw with candidate names when package is not found", () => {
		expect.assertions(1);

		vol.reset();

		vol.fromJSON({
			[path.join(ROOT, "packages/bar/package.json")]: '{"name":"@halcyon/bar"}',
			[path.join(ROOT, "packages/foo/package.json")]: '{"name":"@halcyon/foo"}',
			[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n  - packages/*\n",
		});

		expect(() => resolvePackage(ROOT, "@halcyon/baz")).toThrowWithMessage(
			Error,
			'Package "@halcyon/baz" not found in workspace. Available: @halcyon/bar, @halcyon/foo',
		);
	});

	it("should expand multiple workspace patterns", () => {
		expect.assertions(1);

		vol.reset();

		vol.fromJSON({
			[path.join(ROOT, "apps/web/package.json")]: '{"name":"@halcyon/web"}',
			[path.join(ROOT, "libs/core/package.json")]: '{"name":"@halcyon/core"}',
			[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n  - apps/*\n  - libs/*\n",
		});

		expect(resolvePackage(ROOT, "@halcyon/core").packageDirectory).toBe(
			path.join(ROOT, "libs/core"),
		);
	});

	it("should resolve the workspace root when the pattern is a bare dot", () => {
		expect.assertions(1);

		vol.reset();

		vol.fromJSON({
			[path.join(ROOT, "package.json")]: '{"name":"anime-rush"}',
			[path.join(ROOT, "packages/foo/package.json")]: '{"name":"@halcyon/foo"}',
			[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n  - .\n  - packages/*\n",
		});

		expect(resolvePackage(ROOT, "anime-rush")).toStrictEqual({
			name: "anime-rush",
			packageDirectory: ROOT,
		});
	});

	it("should resolve a package selected by two overlapping patterns once", () => {
		expect.assertions(1);

		vol.reset();

		vol.fromJSON({
			[path.join(ROOT, "packages/foo/package.json")]: '{"name":"@halcyon/foo"}',
			[path.join(ROOT, "pnpm-workspace.yaml")]:
				"packages:\n  - packages/*\n  - packages/foo\n",
		});

		expect(resolvePackage(ROOT, "@halcyon/foo").packageDirectory).toBe(
			path.join(ROOT, "packages/foo"),
		);
	});

	it("should throw when two pnpm packages share a name", () => {
		expect.assertions(1);

		vol.reset();

		vol.fromJSON({
			[path.join(ROOT, "package.json")]: '{"name":"foo"}',
			[path.join(ROOT, "packages/foo/package.json")]: '{"name":"foo"}',
			[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n  - .\n  - packages/*\n",
		});

		expect(() => resolvePackage(ROOT, "foo")).toThrow(
			/Duplicate package name.*foo.*\. and packages\/foo/s,
		);
	});

	it("should ignore a blank pattern rather than let it select the root", () => {
		expect.assertions(1);

		vol.reset();

		vol.fromJSON({
			[path.join(ROOT, "package.json")]: '{"name":"anime-rush"}',
			[path.join(ROOT, "packages/foo/package.json")]: '{"name":"@halcyon/foo"}',
			[path.join(ROOT, "pnpm-workspace.yaml")]: 'packages:\n  - "   "\n  - packages/*\n',
		});

		expect(() => resolvePackage(ROOT, "anime-rush")).toThrowWithMessage(
			Error,
			'Package "anime-rush" not found in workspace. Available: @halcyon/foo',
		);
	});

	it("should throw when pnpm-workspace.yaml has no packages field", () => {
		expect.assertions(1);

		vol.reset();

		vol.fromJSON({
			[path.join(ROOT, "pnpm-workspace.yaml")]: "autoInstallPeers: true\n",
		});

		expect(() => resolvePackage(ROOT, "@halcyon/foo")).toThrowWithMessage(
			Error,
			'Package "@halcyon/foo" not found in workspace. Available: ',
		);
	});

	it("should ignore a package.json that is not a JSON object (e.g. an array)", () => {
		expect.assertions(1);

		vol.reset();

		vol.fromJSON({
			[path.join(ROOT, "packages/bar/package.json")]: '{"name":"@halcyon/bar"}',
			[path.join(ROOT, "packages/foo/package.json")]: "[]",
			[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n  - packages/*\n",
		});

		expect(resolvePackage(ROOT, "@halcyon/bar").packageDirectory).toBe(
			path.join(ROOT, "packages/bar"),
		);
	});

	it("should surface the file path when a package.json is malformed JSON", () => {
		expect.assertions(2);

		vol.reset();

		vol.fromJSON({
			[path.join(ROOT, "packages/foo/package.json")]: "{ not valid json",
			[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n  - packages/*\n",
		});

		let caught: unknown;
		try {
			resolvePackage(ROOT, "@halcyon/foo");
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

		vol.reset();

		vol.fromJSON({
			[path.join(ROOT, "packages/bar/package.json")]: '{"name":"@halcyon/bar"}',
			[path.join(ROOT, "packages/foo/package.json")]: '{"version":"1.0.0"}',
			[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n  - packages/*\n",
		});

		expect(resolvePackage(ROOT, "@halcyon/bar").packageDirectory).toBe(
			path.join(ROOT, "packages/bar"),
		);
	});

	it("should ignore directories under a workspace pattern that lack package.json", () => {
		expect.assertions(1);

		vol.reset();

		vol.fromJSON({
			[path.join(ROOT, "packages/foo/package.json")]: '{"name":"@halcyon/foo"}',
			[path.join(ROOT, "packages/junk/README.md")]: "scratch",
			[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n  - packages/*\n",
		});

		expect(resolvePackage(ROOT, "@halcyon/foo").packageDirectory).toBe(
			path.join(ROOT, "packages/foo"),
		);
	});

	it("should throw a clear error when pnpm-workspace.yaml is missing", () => {
		expect.assertions(1);

		vol.reset();

		vol.fromJSON({
			[path.join(ROOT, "packages/foo/package.json")]: '{"name":"@halcyon/foo"}',
			[path.join(ROOT, "turbo.json")]: "{}",
		});

		expect(() => resolvePackage(ROOT, "@halcyon/foo")).toThrowWithMessage(
			Error,
			"Workspace mode requires either a `workspace.packages` glob list in your " +
				"jest config or a pnpm-workspace.yaml at the workspace root. " +
				"Use `workspace.packages` (with `--workspace-root` to run from outside " +
				"a package) for Luau-only, npm, or yarn repos.",
		);
	});

	describe("workspace.packages globs", () => {
		it("should enumerate packages via patterns when no PM file exists", () => {
			expect.assertions(1);

			vol.reset();

			vol.fromJSON({
				[path.join(ROOT, "packages/foo/jest.config.ts")]: "",
				[path.join(ROOT, "packages/foo/package.json")]: '{"name":"@halcyon/foo"}',
			});

			const info = resolvePackage(ROOT, "@halcyon/foo", ["packages/*"]);

			expect(info.packageDirectory).toBe(path.join(ROOT, "packages/foo"));
		});

		it("should enumerate the workspace root when the pattern is a bare dot", () => {
			expect.assertions(1);

			vol.reset();

			vol.fromJSON({
				[path.join(ROOT, "jest.config.ts")]: "",
				[path.join(ROOT, "package.json")]: '{"name":"anime-rush"}',
				[path.join(ROOT, "packages/foo/jest.config.ts")]: "",
			});

			const info = resolvePackage(ROOT, "anime-rush", [".", "packages/*"]);

			expect(info.packageDirectory).toBe(ROOT);
		});

		it("should infer name from directory basename when no package.json exists (Luau-only)", () => {
			expect.assertions(1);

			vol.reset();

			vol.fromJSON({
				[path.join(ROOT, "packages/foo/default.project.json")]: "{}",
				[path.join(ROOT, "packages/foo/jest.config.ts")]: "",
			});

			const info = resolvePackage(ROOT, "foo", ["packages/*"]);

			expect(info.packageDirectory).toBe(path.join(ROOT, "packages/foo"));
		});

		it("should prefer package.json#name over directory basename", () => {
			expect.assertions(1);

			vol.reset();

			vol.fromJSON({
				[path.join(ROOT, "packages/foo/jest.config.ts")]: "",
				[path.join(ROOT, "packages/foo/package.json")]: '{"name":"@halcyon/foo"}',
			});

			expect(() => resolvePackage(ROOT, "foo", ["packages/*"])).toThrow(/not found/);
		});

		it("should skip directories without a jest.config", () => {
			expect.assertions(1);

			vol.reset();

			vol.fromJSON({
				[path.join(ROOT, "packages/foo/jest.config.ts")]: "",
				[path.join(ROOT, "packages/junk/README.md")]: "scratch",
			});

			const info = resolvePackage(ROOT, "foo", ["packages/*"]);

			expect(info.packageDirectory).toBe(path.join(ROOT, "packages/foo"));
		});

		it("should skip jest.config.spec.ts and similar non-config jest files", () => {
			expect.assertions(2);

			vol.reset();

			vol.fromJSON({
				[path.join(ROOT, "packages/foo/jest.config.spec.ts")]: "",
				[path.join(ROOT, "packages/foo/jest.config.ts")]: "",
			});

			const info = resolvePackage(ROOT, "foo", ["packages/*"]);

			expect(info.packageDirectory).toBe(path.join(ROOT, "packages/foo"));

			vol.unlinkSync(path.join(ROOT, "packages/foo/jest.config.ts"));

			expect(() => resolvePackage(ROOT, "foo", ["packages/*"])).toThrowWithMessage(
				Error,
				'Package "foo" not found in workspace. Available: ',
			);
		});

		it("should skip filenames that only end with jest.config.<ext>", () => {
			expect.assertions(1);

			vol.reset();
			vol.fromJSON({
				[path.join(ROOT, "packages/foo/not-jest.config.ts")]: "",
			});

			expect(() => resolvePackage(ROOT, "foo", ["packages/*"])).toThrowWithMessage(
				Error,
				'Package "foo" not found in workspace. Available: ',
			);
		});

		it("should expand multiple patterns", () => {
			expect.assertions(2);

			vol.reset();

			vol.fromJSON({
				[path.join(ROOT, "apps/web/jest.config.ts")]: "",
				[path.join(ROOT, "libs/core/jest.config.ts")]: "",
			});

			const patterns = ["apps/*", "libs/*"];

			expect(resolvePackage(ROOT, "web", patterns).packageDirectory).toBe(
				path.join(ROOT, "apps/web"),
			);
			expect(resolvePackage(ROOT, "core", patterns).packageDirectory).toBe(
				path.join(ROOT, "libs/core"),
			);
		});

		it("should throw when two packages resolve to the same name", () => {
			expect.assertions(1);

			vol.reset();

			vol.fromJSON({
				[path.join(ROOT, "libs/foo/jest.config.ts")]: "",
				[path.join(ROOT, "packages/foo/jest.config.ts")]: "",
			});

			expect(() => resolvePackage(ROOT, "foo", ["libs/*", "packages/*"])).toThrow(
				/Duplicate package name.*foo.*libs\/foo.*packages\/foo/s,
			);
		});

		it("should name the workspace root as . when it duplicates a package name", () => {
			expect.assertions(1);

			vol.reset();

			vol.fromJSON({
				[path.join(ROOT, "jest.config.ts")]: "",
				[path.join(ROOT, "package.json")]: '{"name":"foo"}',
				[path.join(ROOT, "packages/foo/jest.config.ts")]: "",
			});

			expect(() => resolvePackage(ROOT, "foo", [".", "packages/*"])).toThrow(
				/Duplicate package name.*foo.*\. and packages\/foo/s,
			);
		});

		it("should take precedence over pnpm-workspace.yaml when both exist", () => {
			expect.assertions(1);

			vol.reset();

			vol.fromJSON({
				[path.join(ROOT, "libs/bar/jest.config.ts")]: "",
				[path.join(ROOT, "libs/bar/package.json")]: '{"name":"@halcyon/bar"}',
				[path.join(ROOT, "packages/foo/package.json")]: '{"name":"@halcyon/foo"}',
				[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n  - packages/*\n",
			});

			expect(() => resolvePackage(ROOT, "@halcyon/foo", ["libs/*"])).toThrow(/not found/);
		});

		it("should dedupe a directory with multiple jest.config files", () => {
			expect.assertions(1);

			vol.reset();

			vol.fromJSON({
				[path.join(ROOT, "packages/foo/jest.config.ts")]: "",
				[path.join(ROOT, "packages/foo/jest.config.yaml")]: "",
			});

			const info = resolvePackage(ROOT, "foo", ["packages/*"]);

			expect(info.packageDirectory).toBe(path.join(ROOT, "packages/foo"));
		});
	});
});

describe(enumerateWorkspacePackages, () => {
	it("should drop a pnpm package that carries no jest.config", () => {
		expect.assertions(1);

		vol.reset();

		vol.fromJSON({
			[path.join(ROOT, "packages/bar/package.json")]: '{"name":"@halcyon/bar"}',
			[path.join(ROOT, "packages/foo/jest.config.ts")]: "",
			[path.join(ROOT, "packages/foo/package.json")]: '{"name":"@halcyon/foo"}',
			[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n  - packages/*\n",
		});

		expect(enumerateWorkspacePackages(ROOT)).toStrictEqual([
			{ name: "@halcyon/foo", packageDirectory: path.join(ROOT, "packages/foo") },
		]);
	});

	it("should drop a package an exclude glob names", () => {
		expect.assertions(1);

		vol.reset();

		vol.fromJSON({
			[path.join(ROOT, "packages/bar/jest.config.ts")]: "",
			[path.join(ROOT, "packages/bar/package.json")]: '{"name":"@halcyon/bar"}',
			[path.join(ROOT, "packages/foo/jest.config.ts")]: "",
			[path.join(ROOT, "packages/foo/package.json")]: '{"name":"@halcyon/foo"}',
			[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n  - packages/*\n",
		});

		const enumerated = enumerateWorkspacePackages(ROOT, {
			exclude: ["packages/bar"],
		});

		expect(enumerated.map((info) => info.name)).toStrictEqual(["@halcyon/foo"]);
	});

	it("should apply an exclude to the config glob source too", () => {
		expect.assertions(1);

		vol.reset();

		vol.fromJSON({
			[path.join(ROOT, "fixtures/sample/jest.config.ts")]: "",
			[path.join(ROOT, "libs/core/jest.config.ts")]: "",
		});

		const enumerated = enumerateWorkspacePackages(ROOT, {
			exclude: ["fixtures/**"],
			patterns: ["fixtures/*", "libs/*"],
		});

		expect(enumerated.map((info) => info.name)).toStrictEqual(["core"]);
	});

	it("should not report a duplicate name the exclude removed", () => {
		expect.assertions(1);

		vol.reset();

		vol.fromJSON({
			[path.join(ROOT, "fixtures/core/jest.config.ts")]: "",
			[path.join(ROOT, "libs/core/jest.config.ts")]: "",
		});

		const enumerated = enumerateWorkspacePackages(ROOT, {
			exclude: ["fixtures/**"],
			patterns: ["fixtures/*", "libs/*"],
		});

		expect(enumerated.map((info) => info.packageDirectory)).toStrictEqual([
			path.join(ROOT, "libs/core"),
		]);
	});

	it("should still resolve a named package that carries no jest.config", () => {
		expect.assertions(1);

		vol.reset();

		vol.fromJSON({
			[path.join(ROOT, "packages/bar/package.json")]: '{"name":"@halcyon/bar"}',
			[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n  - packages/*\n",
		});

		// Enumeration skips it; naming it keeps failing downstream on the
		// missing config rather than reading as a package that does not exist.
		expect(resolvePackage(ROOT, "@halcyon/bar").packageDirectory).toBe(
			path.join(ROOT, "packages/bar"),
		);
	});
});

describe("pnpm-workspace.yaml negation", () => {
	it("should drop a package a ! pattern excludes", () => {
		expect.assertions(1);

		vol.reset();

		vol.fromJSON({
			[path.join(ROOT, "packages/foo/package.json")]: '{"name":"@halcyon/foo"}',
			[path.join(ROOT, "packages/tests/fixture/package.json")]: '{"name":"@halcyon/fixture"}',
			[path.join(ROOT, "pnpm-workspace.yaml")]:
				'packages:\n  - "!packages/tests/*"\n  - packages/*\n  - packages/**/*\n',
		});

		expect(listPackages(ROOT).map((info) => info.name)).toStrictEqual(["@halcyon/foo"]);
	});

	it("should drop a package a ! pattern excludes at any depth", () => {
		expect.assertions(1);

		vol.reset();

		vol.fromJSON({
			[path.join(ROOT, "libs/core/out-tsc/stale/package.json")]: '{"name":"@halcyon/stale"}',
			[path.join(ROOT, "libs/core/package.json")]: '{"name":"@halcyon/core"}',
			[path.join(ROOT, "pnpm-workspace.yaml")]:
				'packages:\n  - "!**/out-tsc/**"\n  - libs/**/*\n',
		});

		expect(listPackages(ROOT).map((info) => info.name)).toStrictEqual(["@halcyon/core"]);
	});

	it("should apply a ! pattern to the config glob source too", () => {
		expect.assertions(1);

		vol.reset();

		vol.fromJSON({
			[path.join(ROOT, "libs/core/jest.config.ts")]: "",
			[path.join(ROOT, "libs/fixture/jest.config.ts")]: "",
		});

		const enumerated = enumerateWorkspacePackages(ROOT, {
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

		vol.reset();

		vol.fromJSON({
			[path.join(ROOT, "packages/a/package.json")]: '{"name":"pkg-a"}',
			[path.join(ROOT, "packages/tests/fixture/package.json")]: '{"name":"pkg-fixture"}',
			[path.join(ROOT, "pnpm-workspace.yaml")]:
				'packages:\n  - "!packages/*/**"\n  - packages/*\n  - packages/**/*\n',
		});

		// `**` collapses to zero segments before the manifest, so `packages/a`
		// goes too — matching the directory alone would keep it.
		expect(listPackages(ROOT)).toBeEmpty();
	});

	it("should exclude a package whose own directory is the negated segment", () => {
		expect.assertions(1);

		vol.reset();

		vol.fromJSON({
			[path.join(ROOT, "packages/a/package.json")]: '{"name":"pkg-a"}',
			[path.join(ROOT, "packages/out-tsc/package.json")]: '{"name":"pkg-out-tsc"}',
			[path.join(ROOT, "pnpm-workspace.yaml")]:
				'packages:\n  - "!**/out-tsc/**"\n  - packages/*\n',
		});

		expect(listPackages(ROOT).map((info) => info.name)).toStrictEqual(["pkg-a"]);
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

		vol.reset();

		vol.fromJSON({
			[path.join(ROOT, "fixtures/core/jest.config.ts")]: "",
			[path.join(ROOT, "libs/core/jest.config.ts")]: "",
		});

		expect(() => {
			return enumerateWorkspacePackages(ROOT, { patterns: ["fixtures/*", "libs/*"] });
		}).toThrow(/Duplicate package name.*core/s);
	});

	it("should skip a blank pnpm pattern rather than selecting the root", () => {
		expect.assertions(1);

		vol.reset();

		vol.fromJSON({
			[path.join(ROOT, "jest.config.ts")]: "",
			[path.join(ROOT, "package.json")]: '{"name":"repo-root"}',
			[path.join(ROOT, "packages/foo/jest.config.ts")]: "",
			[path.join(ROOT, "packages/foo/package.json")]: '{"name":"@halcyon/foo"}',
			[path.join(ROOT, "pnpm-workspace.yaml")]: 'packages:\n  - "  "\n  - packages/*\n',
		});

		expect(enumerateWorkspacePackages(ROOT).map((info) => info.name)).toStrictEqual([
			"@halcyon/foo",
		]);
	});

	it("should find a jest.config beside a manifest at any depth", () => {
		expect.assertions(1);

		vol.reset();

		vol.fromJSON({
			[path.join(ROOT, "a/b/c/jest.config.ts")]: "",
			[path.join(ROOT, "a/b/c/package.json")]: '{"name":"@halcyon/deep"}',
			[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n  - a/b/*\n",
		});

		// The jest.config sweep globs from the root rather than from the pnpm
		// patterns, so a package nested below them is still gated correctly.
		expect(enumerateWorkspacePackages(ROOT).map((info) => info.name)).toStrictEqual([
			"@halcyon/deep",
		]);
	});

	it("should not treat a dotted config suffix as a jest config", () => {
		expect.assertions(1);

		vol.reset();

		vol.fromJSON({
			[path.join(ROOT, "packages/foo/jest.config.spec.ts")]: "",
			[path.join(ROOT, "packages/foo/package.json")]: '{"name":"@halcyon/foo"}',
			[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n  - packages/*\n",
		});

		expect(enumerateWorkspacePackages(ROOT)).toBeEmpty();
	});
});

describe("workspace enumeration walk sharing", () => {
	it("should walk the workspace root once for every pnpm pattern and both leaves", () => {
		expect.assertions(2);

		vol.reset();

		vol.fromJSON({
			[path.join(ROOT, "apps/web/jest.config.ts")]: "",
			[path.join(ROOT, "apps/web/package.json")]: '{"name":"@halcyon/web"}',
			[path.join(ROOT, "libs/core/jest.config.ts")]: "",
			[path.join(ROOT, "libs/core/package.json")]: '{"name":"@halcyon/core"}',
			[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n  - apps/*\n  - libs/*\n",
		});

		const readdir = vi.spyOn(fs, "readdirSync");
		const enumerated = enumerateWorkspacePackages(ROOT);
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

		vol.reset();

		vol.fromJSON({
			[path.join(ROOT, "jest.config.ts")]: "",
			[path.join(ROOT, "libs/core/jest.config.ts")]: "",
			[path.join(ROOT, "package.json")]: '{"name":"repo-root"}',
		});

		expect(
			enumerateWorkspacePackages(ROOT, { patterns: ["", "libs/*"] }).map((info) => info.name),
		).toStrictEqual(["core"]);
	});

	it("should drop a package matching any one of several negations", () => {
		expect.assertions(1);

		vol.reset();

		vol.fromJSON({
			[path.join(ROOT, "packages/a/package.json")]: '{"name":"pkg-a"}',
			[path.join(ROOT, "packages/b/package.json")]: '{"name":"pkg-b"}',
			[path.join(ROOT, "packages/c/package.json")]: '{"name":"pkg-c"}',
			[path.join(ROOT, "pnpm-workspace.yaml")]:
				'packages:\n  - "!packages/a"\n  - "!packages/b"\n  - packages/*\n',
		});

		// `pkg-c` clears both negations; `pkg-a` and `pkg-b` each clear one.
		// Requiring every negation to pass is what drops them.
		expect(listPackages(ROOT).map((info) => info.name)).toStrictEqual(["pkg-c"]);
	});

	it("should walk the workspace root once for an uncached multi-pattern match", () => {
		expect.assertions(2);

		vol.reset();

		vol.fromJSON({
			[path.join(ROOT, "apps/web/package.json")]: '{"name":"@halcyon/web"}',
			[path.join(ROOT, "libs/core/package.json")]: '{"name":"@halcyon/core"}',
			[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n  - apps/*\n  - libs/*\n",
		});

		const readdir = vi.spyOn(fs, "readdirSync");
		const found = listPackages(ROOT);
		const directoriesWalked = new Set(readdir.mock.calls.map(([target]) => String(target)));

		expect(found).toHaveLength(2);
		// The cache this path builds itself must still be declared for the
		// leaf, or each pattern falls back to a walk of its own.
		expect(readdir).toHaveBeenCalledTimes(directoriesWalked.size);
	});

	it("should name the remedy when two packages share a name", () => {
		expect.assertions(1);

		vol.reset();

		vol.fromJSON({
			[path.join(ROOT, "libs/foo/package.json")]: '{"name":"foo"}',
			[path.join(ROOT, "packages/foo/package.json")]: '{"name":"foo"}',
			[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n  - libs/*\n  - packages/*\n",
		});

		expect(() => listPackages(ROOT)).toThrowWithMessage(
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

		vol.reset();

		vol.fromJSON({
			[path.join(ROOT, "libs/core/jest.config.ts")]: "",
			[path.join(ROOT, "libs/plain/package.json")]: '{"name":"plain"}',
		});

		expect(
			enumerateWorkspacePackages(ROOT, { patterns: ["libs/*"] }).map((info) => info.name),
		).toStrictEqual(["core"]);
	});

	it("should apply the exclude to the config-glob source too", () => {
		expect.assertions(1);

		vol.reset();

		vol.fromJSON({
			[path.join(ROOT, "libs/core/jest.config.ts")]: "",
			[path.join(ROOT, "libs/fixture/jest.config.ts")]: "",
		});

		expect(
			enumerateWorkspacePackages(ROOT, {
				exclude: ["libs/fixture"],
				patterns: ["libs/*"],
			}).map((info) => info.name),
		).toStrictEqual(["core"]);
	});

	it("should apply both filters to the pnpm source too", () => {
		expect.assertions(1);

		vol.reset();

		vol.fromJSON({
			[path.join(ROOT, "libs/core/jest.config.ts")]: "",
			[path.join(ROOT, "libs/core/package.json")]: '{"name":"core"}',
			[path.join(ROOT, "libs/fixture/jest.config.ts")]: "",
			[path.join(ROOT, "libs/fixture/package.json")]: '{"name":"fixture"}',
			[path.join(ROOT, "libs/plain/package.json")]: '{"name":"plain"}',
			[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n  - libs/*\n",
		});

		expect(
			enumerateWorkspacePackages(ROOT, { exclude: ["libs/fixture"] }).map(
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

		vol.reset();

		vol.fromJSON({
			[path.join(ROOT, "libs/core/jest.config.ts")]: "",
			[path.join(ROOT, "libs/core/package.json")]: '{"name":"@halcyon/core"}',
			[path.join(ROOT, "pnpm-workspace.yaml")]:
				"packages:\n  - libs/*\n  - test/fixtures/**/*\n",
			[path.join(ROOT, "test/fixtures/deep/nested/jest.config.ts")]: "",
			[path.join(ROOT, "test/fixtures/deep/nested/package.json")]: '{"name":"@e2e/deep"}',
			[path.join(ROOT, "test/fixtures/flat/jest.config.ts")]: "",
			[path.join(ROOT, "test/fixtures/flat/package.json")]: '{"name":"@e2e/flat"}',
		});

		const enumerated = enumerateWorkspacePackages(ROOT, { exclude: ["test/fixtures/**"] });

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

		vol.reset();

		vol.fromJSON({
			[path.join(ROOT, "jest.config.ts")]: "",
			[path.join(ROOT, "libs/core/jest.config.ts")]: "",
			[path.join(ROOT, "package.json")]: '{"name":"the-root"}',
		});

		expect(
			enumerateWorkspacePackages(ROOT, { patterns: [".", "libs/*", "!"] }).map(
				(info) => info.name,
			),
		).toStrictEqual(["the-root", "core"]);
	});
});
