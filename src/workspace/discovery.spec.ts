import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { createMemoryFileSystem } from "../../test/mocks/memory-file-system.ts";
import { discoverWorkspaceRoot } from "./discovery.ts";

const ROOT = path.resolve("/repo");

describe(discoverWorkspaceRoot, () => {
	it("should return cwd when it contains pnpm-workspace.yaml", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({
			[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n",
		});

		expect(discoverWorkspaceRoot(ROOT, fileSystem)).toBe(ROOT);
	});

	it("should walk up to find a parent containing pnpm-workspace.yaml", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({
			[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n",
		});

		expect(discoverWorkspaceRoot(path.join(ROOT, "packages/foo/src"), fileSystem)).toBe(ROOT);
	});

	it("should accept turbo.json as a workspace marker", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({ [path.join(ROOT, "turbo.json")]: "{}" });

		expect(discoverWorkspaceRoot(ROOT, fileSystem)).toBe(ROOT);
	});

	it("should accept nx.json as a workspace marker", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({ [path.join(ROOT, "nx.json")]: "{}" });

		expect(discoverWorkspaceRoot(ROOT, fileSystem)).toBe(ROOT);
	});

	it("should return the closest matching directory when nested workspaces exist", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		const inner = path.join(ROOT, "apps/inner");

		volume.fromJSON({
			[path.join(inner, "pnpm-workspace.yaml")]: "packages:\n",
			[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n",
		});

		expect(discoverWorkspaceRoot(path.join(inner, "packages/foo"), fileSystem)).toBe(inner);
	});

	it("should throw when no marker is found above cwd", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({ [path.join(ROOT, "src/foo.ts")]: "" });

		expect(() => discoverWorkspaceRoot(path.join(ROOT, "src"), fileSystem)).toThrow(
			/no workspace root found/i,
		);
	});
});
