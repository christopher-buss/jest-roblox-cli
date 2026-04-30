import { fromAny } from "@total-typescript/shoehorn";

import { vol } from "memfs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { discoverWorkspaceRoot } from "./discovery.ts";

vi.mock(import("node:fs"), async () => {
	const memfs = await vi.importActual<typeof import("memfs")>("memfs");
	return fromAny({ ...memfs.fs, default: memfs.fs });
});

const ROOT = path.resolve("/repo");

describe(discoverWorkspaceRoot, () => {
	it("should return cwd when it contains pnpm-workspace.yaml", () => {
		expect.assertions(1);

		vol.reset();

		vol.fromJSON({ [path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n" });

		expect(discoverWorkspaceRoot(ROOT)).toBe(ROOT);
	});

	it("should walk up to find a parent containing pnpm-workspace.yaml", () => {
		expect.assertions(1);

		vol.reset();

		vol.fromJSON({ [path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n" });

		expect(discoverWorkspaceRoot(path.join(ROOT, "packages/foo/src"))).toBe(ROOT);
	});

	it("should accept turbo.json as a workspace marker", () => {
		expect.assertions(1);

		vol.reset();

		vol.fromJSON({ [path.join(ROOT, "turbo.json")]: "{}" });

		expect(discoverWorkspaceRoot(ROOT)).toBe(ROOT);
	});

	it("should accept nx.json as a workspace marker", () => {
		expect.assertions(1);

		vol.reset();

		vol.fromJSON({ [path.join(ROOT, "nx.json")]: "{}" });

		expect(discoverWorkspaceRoot(ROOT)).toBe(ROOT);
	});

	it("should return the closest matching directory when nested workspaces exist", () => {
		expect.assertions(1);

		const inner = path.join(ROOT, "apps/inner");
		vol.fromJSON({
			[path.join(inner, "pnpm-workspace.yaml")]: "packages:\n",
			[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n",
		});

		expect(discoverWorkspaceRoot(path.join(inner, "packages/foo"))).toBe(inner);
	});

	it("should throw when no marker is found above cwd", () => {
		expect.assertions(1);

		vol.reset();

		vol.fromJSON({ [path.join(ROOT, "src/foo.ts")]: "" });

		expect(() => discoverWorkspaceRoot(path.join(ROOT, "src"))).toThrow(
			/no workspace root found/i,
		);
	});
});
