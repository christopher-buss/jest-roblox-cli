import { fromAny } from "@total-typescript/shoehorn";

import { vol } from "memfs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";

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

		expect(() => resolvePackage(ROOT, "@halcyon/baz")).toThrow(
			/not found.*@halcyon\/bar.*@halcyon\/foo/s,
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

	it("should throw when pnpm-workspace.yaml has no packages field", () => {
		expect.assertions(1);

		vol.reset();

		vol.fromJSON({
			[path.join(ROOT, "pnpm-workspace.yaml")]: "autoInstallPeers: true\n",
		});

		expect(() => resolvePackage(ROOT, "@halcyon/foo")).toThrow(/not found/);
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

		expect(() => resolvePackage(ROOT, "@halcyon/foo")).toThrow(/requires pnpm-workspace\.yaml/);
	});
});
