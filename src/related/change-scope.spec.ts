import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { posixPath } from "#test/mocks/posix-path.ts";
import type { ChangeKind, ChangeScope } from "./change-scope.ts";
import { classifyChange, resolveChangeScope } from "./change-scope.ts";

const WORKSPACE = path.resolve("/workspace");
const PROJECT = path.join(WORKSPACE, "packages", "game");

function key(file: string): string {
	return posixPath(file);
}

function scopeOf(seed: Record<string, string>): ChangeScope {
	const { fileSystem } = createMemoryFileSystem(seed);
	return resolveChangeScope({
		fileSystem,
		forceRerunTriggers: ["pnpm-lock.yaml"],
		projectRoot: PROJECT,
		rojoRoots: [path.join(PROJECT, "src")],
	});
}

describe(resolveChangeScope, () => {
	it("should take the nearest folder with a workspace marker as the workspace root", () => {
		expect.assertions(1);

		const scope = scopeOf({ [path.join(WORKSPACE, "nx.json")]: "{}" });

		expect(scope.workspaceRoot).toBe(key(WORKSPACE));
	});

	it("should fall back to the project root when no folder holds a workspace marker", () => {
		expect.assertions(1);

		const scope = scopeOf({ [path.join(PROJECT, "default.project.json")]: "{}" });

		expect(scope.workspaceRoot).toBe(key(PROJECT));
	});
});

describe(classifyChange, () => {
	it.for<[ChangeKind, string]>([
		["trigger", path.join(WORKSPACE, "pnpm-lock.yaml")],
		["module", path.join(PROJECT, "src", "util.luau")],
		["module", path.join(PROJECT, "src", "util.lua")],
		["opaque", path.join(PROJECT, "src", "main.client.luau")],
		["opaque", path.join(PROJECT, "src", "init.meta.json")],
		["opaque", path.join(PROJECT, "jest.config.luau")],
		["ignored", path.join(WORKSPACE, "packages", "other", "util.luau")],
		["ignored", path.join(path.resolve("/elsewhere"), "pnpm-lock.yaml")],
	])("should classify a change as %s: %s", ([kind, file]) => {
		expect.assertions(1);

		const scope = scopeOf({ [path.join(WORKSPACE, "pnpm-workspace.yaml")]: "" });

		expect(classifyChange(scope, key(file))).toBe(kind);
	});
});
