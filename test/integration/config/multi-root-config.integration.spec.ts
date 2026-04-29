import type { PathKind, RojoTreeNode } from "@isentinel/rojo-utils";

import { describe, expect, it } from "vitest";

import { createFsClassifier, resolveProjectConfig } from "../../../src/config/projects.ts";
import type { ResolvedConfig } from "../../../src/config/schema.ts";
import { DEFAULT_CONFIG, defineProject } from "../../../src/config/schema.ts";

// Mirrors the real friends-package layout: one logical package that a rojo
// project splits across ReplicatedStorage (client + shared) and
// ServerScriptService (server), with a separate test-fixture mount in a
// fourth DataModel location. Represents the output of resolveNestedProjects
// — the tree below is what would remain after inlining the package's own
// `default.project.json`, `client.project.json`, etc.
const friendsPackageTree = {
	$className: "DataModel",
	ReplicatedStorage: {
		FriendsClient: {
			Components: { $path: "packages/friends-package/src/Client/Components" },
			Systems: { $path: "packages/friends-package/src/Client/Systems" },
		},
		FriendsIntegration: {
			$path: "packages/friends-package/test",
		},
		FriendsShared: {
			Network: { $path: "packages/friends-package/src/Shared/Network" },
			Types: { $path: "packages/friends-package/src/Shared/Types" },
		},
	},
	ServerScriptService: {
		FriendsServer: {
			Components: { $path: "packages/friends-package/src/Server/Components" },
			Systems: { $path: "packages/friends-package/src/Server/Systems" },
		},
	},
} satisfies RojoTreeNode;

const rootConfig: ResolvedConfig = {
	...DEFAULT_CONFIG,
	rootDir: "/workspace",
};

function allDirectories(): PathKind {
	return "directory";
}

describe("multi-root project integration — friends-package layout", () => {
	it("should resolve rojoMounts for every touched service branch", () => {
		expect.assertions(2);

		const project = defineProject({
			test: {
				displayName: "friends-package",
				include: [
					"packages/friends-package/src/**/*.spec.luau",
					"packages/friends-package/test/**/*.spec.luau",
				],
			},
		});

		const resolved = resolveProjectConfig(
			project.test,
			rootConfig,
			friendsPackageTree,
			allDirectories,
		);

		// Six mounts under `src/` (2 Client + 2 Shared + 2 Server) plus
		// one exact-lookup mount for `test/`.
		expect(resolved.rojoMounts).toStrictEqual([
			{
				dataModelPath: "ReplicatedStorage/FriendsClient/Components",
				fsPath: "packages/friends-package/src/Client/Components",
			},
			{
				dataModelPath: "ReplicatedStorage/FriendsClient/Systems",
				fsPath: "packages/friends-package/src/Client/Systems",
			},
			{
				dataModelPath: "ReplicatedStorage/FriendsShared/Network",
				fsPath: "packages/friends-package/src/Shared/Network",
			},
			{
				dataModelPath: "ReplicatedStorage/FriendsShared/Types",
				fsPath: "packages/friends-package/src/Shared/Types",
			},
			{
				dataModelPath: "ServerScriptService/FriendsServer/Components",
				fsPath: "packages/friends-package/src/Server/Components",
			},
			{
				dataModelPath: "ServerScriptService/FriendsServer/Systems",
				fsPath: "packages/friends-package/src/Server/Systems",
			},
			{
				dataModelPath: "ReplicatedStorage/FriendsIntegration",
				fsPath: "packages/friends-package/test",
			},
		]);

		// Jest's `projects` array mirrors rojoMounts — every touched
		// DataModel path so Jest walks each service ancestor chain.
		expect(resolved.projects).toStrictEqual([
			"ReplicatedStorage/FriendsClient/Components",
			"ReplicatedStorage/FriendsClient/Systems",
			"ReplicatedStorage/FriendsShared/Network",
			"ReplicatedStorage/FriendsShared/Types",
			"ServerScriptService/FriendsServer/Components",
			"ServerScriptService/FriendsServer/Systems",
			"ReplicatedStorage/FriendsIntegration",
		]);
	});

	it("should pin to a single mount when outDir is set", () => {
		expect.assertions(1);

		const project = defineProject({
			test: {
				displayName: "friends-client-only",
				include: [
					"packages/friends-package/src/**/*.spec.luau",
					"packages/friends-package/test/**/*.spec.luau",
				],
				// outDir pins the project to one DataModel mount regardless of
				// how many include roots there are.
				outDir: "packages/friends-package/src/Client/Components",
			},
		});

		const resolved = resolveProjectConfig(
			project.test,
			rootConfig,
			friendsPackageTree,
			allDirectories,
		);

		expect(resolved.rojoMounts).toStrictEqual([
			{
				dataModelPath: "ReplicatedStorage/FriendsClient/Components",
				fsPath: "packages/friends-package/src/Client/Components",
			},
		]);
	});

	it("should resolve exact-match roots without invoking the classifier", () => {
		expect.assertions(1);

		// The production FS classifier is used when no test-side override
		// is supplied. For exact-match roots (test/ maps directly to a
		// $path), resolution succeeds without any classifier calls — this
		// keeps resolution deterministic for the common Luau case.
		const classify = createFsClassifier("/workspace");

		const project = defineProject({
			test: {
				displayName: "friends-test-only",
				include: ["packages/friends-package/test/**/*.spec.luau"],
			},
		});

		const resolved = resolveProjectConfig(
			project.test,
			rootConfig,
			friendsPackageTree,
			classify,
		);

		expect(resolved.rojoMounts).toStrictEqual([
			{
				dataModelPath: "ReplicatedStorage/FriendsIntegration",
				fsPath: "packages/friends-package/test",
			},
		]);
	});
});
