import { fromAny } from "@total-typescript/shoehorn";

import { vol } from "memfs";
import * as path from "node:path";
import { assert, describe, expect, it, vi } from "vitest";

import { resolvePackage } from "./package-resolver.ts";

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
