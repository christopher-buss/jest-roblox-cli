import * as path from "node:path";
import { assert, describe, expect, it, vi } from "vitest";

import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { ROOT, writeInstalledWorkspace, YAML_PATH } from "#test/mocks/spec-pnpm-workspace.ts";
import { pnpmPackages } from "./pnpm-packages.ts";

describe(pnpmPackages, () => {
	it("should answer from the snapshot rather than the filesystem", () => {
		expect.assertions(1);

		const fileSystem = writeInstalledWorkspace(
			{ [path.join(ROOT, "packages/ghost/README.md")]: "no manifest here" },
			{ [path.join(ROOT, "packages/ghost")]: { name: "@halcyon/ghost" } },
		);

		expect(
			pnpmPackages({ fileSystem, names: ["@halcyon/ghost"], workspaceRoot: ROOT }),
		).toStrictEqual([
			{ name: "@halcyon/ghost", packageDirectory: path.join(ROOT, "packages/ghost") },
		]);
	});

	it("should answer from a snapshot that records more than the asked name", () => {
		expect.assertions(1);

		const fileSystem = writeInstalledWorkspace(
			{},
			{
				[path.join(ROOT, "packages/ghost")]: { name: "@halcyon/ghost" },
				[path.join(ROOT, "packages/shade")]: { name: "@halcyon/shade" },
			},
		);

		expect(
			pnpmPackages({ fileSystem, names: ["@halcyon/ghost"], workspaceRoot: ROOT }).map(
				(info) => info.name,
			),
		).toStrictEqual(["@halcyon/ghost", "@halcyon/shade"]);
	});

	it("should list from the walk when no snapshot exists", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({
			[path.join(ROOT, "packages/foo/package.json")]: '{"name":"@halcyon/foo"}',
			[YAML_PATH]: "packages:\n  - packages/*\n",
		});

		expect(pnpmPackages({ fileSystem, names: [], workspaceRoot: ROOT })).toStrictEqual([
			{ name: "@halcyon/foo", packageDirectory: path.join(ROOT, "packages/foo") },
		]);
	});

	it("should walk the workspace root once for several patterns", () => {
		expect.assertions(2);

		const { fileSystem } = createMemoryFileSystem({
			[path.join(ROOT, "apps/bar/package.json")]: '{"name":"@halcyon/bar"}',
			[path.join(ROOT, "packages/foo/package.json")]: '{"name":"@halcyon/foo"}',
			[YAML_PATH]: "packages:\n  - packages/*\n  - apps/*\n",
		});
		const readdirSync = vi.spyOn(fileSystem, "readdirSync");

		expect(
			pnpmPackages({ fileSystem, names: [], workspaceRoot: ROOT }).map(({ name }) => name),
		).toStrictEqual(["@halcyon/foo", "@halcyon/bar"]);
		expect(
			readdirSync.mock.calls.filter(
				([directory]) => path.resolve(String(directory)) === ROOT,
			),
		).toHaveLength(1);
	});

	it("should list from the snapshot when no name is asked for", () => {
		expect.assertions(1);

		const fileSystem = writeInstalledWorkspace(
			{},
			{ [path.join(ROOT, "packages/ghost")]: { name: "@halcyon/ghost" } },
		);

		expect(pnpmPackages({ fileSystem, names: [], workspaceRoot: ROOT })).toStrictEqual([
			{ name: "@halcyon/ghost", packageDirectory: path.join(ROOT, "packages/ghost") },
		]);
	});

	it("should list the dot-directory packages a walk cannot see", () => {
		expect.assertions(1);

		const fileSystem = writeInstalledWorkspace(
			{},
			{ [path.join(ROOT, ".codex")]: { name: "halcyon-codex" } },
		);

		expect(pnpmPackages({ fileSystem, names: [], workspaceRoot: ROOT })).toStrictEqual([
			{ name: "halcyon-codex", packageDirectory: path.join(ROOT, ".codex") },
		]);
	});

	it("should walk the filesystem when a name misses the snapshot", () => {
		expect.assertions(1);

		const fileSystem = writeInstalledWorkspace(
			{
				[path.join(ROOT, "packages/bar/package.json")]: '{"name":"@halcyon/bar"}',
				[path.join(ROOT, "packages/foo/package.json")]: '{"name":"@halcyon/foo"}',
			},
			{ [path.join(ROOT, "packages/foo")]: { name: "@halcyon/foo" } },
		);

		expect(
			pnpmPackages({
				fileSystem,
				names: ["@halcyon/foo", "@halcyon/bar"],
				workspaceRoot: ROOT,
			}).map((info) => info.name),
		).toStrictEqual(["@halcyon/bar", "@halcyon/foo"]);
	});

	it("should surface the file path when a package.json is malformed JSON", () => {
		expect.assertions(2);

		const { fileSystem } = createMemoryFileSystem({
			[path.join(ROOT, "packages/foo/package.json")]: "{ not valid json",
			[YAML_PATH]: "packages:\n  - packages/*\n",
		});

		let caught: unknown;
		try {
			pnpmPackages({ fileSystem, names: [], workspaceRoot: ROOT });
		} catch (err) {
			caught = err;
		}

		assert(caught instanceof Error);

		expect(caught.message).toBe(
			`Failed to parse ${path.join(ROOT, "packages/foo/package.json")}.`,
		);
		expect(caught.cause).toBeInstanceOf(SyntaxError);
	});
});

describe("pnpm-workspace.yaml negation semantics", () => {
	it("should exclude a package one level down from a */** negation", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({
			[path.join(ROOT, "packages/a/package.json")]: '{"name":"pkg-a"}',
			[path.join(ROOT, "packages/tests/fixture/package.json")]: '{"name":"pkg-fixture"}',
			[YAML_PATH]: 'packages:\n  - "!packages/*/**"\n  - packages/*\n  - packages/**/*\n',
		});

		expect(pnpmPackages({ fileSystem, names: [], workspaceRoot: ROOT })).toBeEmpty();
	});

	it("should exclude a package whose own directory is the negated segment", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({
			[path.join(ROOT, "packages/a/package.json")]: '{"name":"pkg-a"}',
			[path.join(ROOT, "packages/out-tsc/package.json")]: '{"name":"pkg-out-tsc"}',
			[YAML_PATH]: 'packages:\n  - "!**/out-tsc/**"\n  - packages/*\n',
		});

		expect(
			pnpmPackages({ fileSystem, names: [], workspaceRoot: ROOT }).map((info) => info.name),
		).toStrictEqual(["pkg-a"]);
	});
});
