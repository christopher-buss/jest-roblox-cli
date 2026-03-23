import { describe, expect, it } from "vitest";

import type { RojoProject, RojoTreeNode } from "./rojo-rewriter.ts";
import { rewriteRojoProject } from "./rojo-rewriter.ts";

describe(rewriteRojoProject, () => {
	describe("when rewriting $path entries under luauRoot", () => {
		it("should rewrite a $path that starts with luauRoot to use shadowDir", () => {
			expect.assertions(1);

			const project: RojoProject = {
				name: "test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: {
						$path: "out-tsc/test/client",
					},
				},
			};

			const result = rewriteRojoProject(project, {
				luauRoot: "out-tsc/test",
				shadowDir: ".jest-roblox-coverage/out-tsc/test",
			});

			const node = result.tree["ReplicatedStorage"] as RojoTreeNode;

			expect(node.$path).toBe(".jest-roblox-coverage/out-tsc/test/client");
		});

		it("should leave a $path that does not start with luauRoot unchanged", () => {
			expect.assertions(2);

			const project: RojoProject = {
				name: "test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: {
						$path: "include",
					},
					ServerScriptService: {
						$path: "../../node_modules/@flamework",
					},
				},
			};

			const result = rewriteRojoProject(project, {
				luauRoot: "out-tsc/test",
				shadowDir: ".jest-roblox-coverage/out-tsc/test",
			});

			expect((result.tree["ReplicatedStorage"] as RojoTreeNode).$path).toBe("include");
			expect((result.tree["ServerScriptService"] as RojoTreeNode).$path).toBe(
				"../../node_modules/@flamework",
			);
		});

		it("should rewrite nested $path entries in child nodes", () => {
			expect.assertions(2);

			const project: RojoProject = {
				name: "test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: {
						client: {
							$path: "out-tsc/test/client",
						},
						shared: {
							$path: "out-tsc/test/shared",
						},
					},
				},
			};

			const result = rewriteRojoProject(project, {
				luauRoot: "out-tsc/test",
				shadowDir: ".jest-roblox-coverage/out-tsc/test",
			});

			const replicated = result.tree["ReplicatedStorage"] as RojoTreeNode;

			expect((replicated["client"] as RojoTreeNode).$path).toBe(
				".jest-roblox-coverage/out-tsc/test/client",
			);
			expect((replicated["shared"] as RojoTreeNode).$path).toBe(
				".jest-roblox-coverage/out-tsc/test/shared",
			);
		});

		it("should rewrite a $path that exactly matches luauRoot", () => {
			expect.assertions(1);

			const project: RojoProject = {
				name: "test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: {
						$path: "out-tsc/test",
					},
				},
			};

			const result = rewriteRojoProject(project, {
				luauRoot: "out-tsc/test",
				shadowDir: ".jest-roblox-coverage/out-tsc/test",
			});

			expect((result.tree["ReplicatedStorage"] as RojoTreeNode).$path).toBe(
				".jest-roblox-coverage/out-tsc/test",
			);
		});
	});

	describe("when preserving non-path properties", () => {
		it("should preserve $className and other Rojo properties", () => {
			expect.assertions(3);

			const project: RojoProject = {
				name: "game",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: {
						$className: "ReplicatedStorage",
						$path: "out-tsc/test/client",
					},
				},
			};

			const result = rewriteRojoProject(project, {
				luauRoot: "out-tsc/test",
				shadowDir: ".jest-roblox-coverage/out-tsc/test",
			});

			expect(result.name).toBe("game");
			expect(result.tree.$className).toBe("DataModel");
			expect((result.tree["ReplicatedStorage"] as RojoTreeNode).$className).toBe(
				"ReplicatedStorage",
			);
		});
	});

	describe("when projectRelocation is set", () => {
		it("should strip shadow prefix from matching paths so they resolve relative to relocated project", () => {
			expect.assertions(1);

			const project: RojoProject = {
				name: "test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: {
						$path: "out-tsc/test/client",
					},
				},
			};

			const result = rewriteRojoProject(project, {
				luauRoot: "out-tsc/test",
				projectRelocation: "..",
				relocatedShadowDirectory: "out-tsc/test",
				shadowDir: ".jest-roblox-coverage/out-tsc/test",
			});

			// Project is inside .jest-roblox-coverage/, shadow dir is also inside
			// .jest-roblox-coverage/, so the path from relocated project to
			// shadow content is just "out-tsc/test/client" (strip the shared
			// prefix)
			expect((result.tree["ReplicatedStorage"] as RojoTreeNode).$path).toBe(
				"out-tsc/test/client",
			);
		});

		it("should prepend projectRelocation to non-matching paths", () => {
			expect.assertions(2);

			const project: RojoProject = {
				name: "test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: {
						$path: "include",
					},
					Workspace: {
						$path: "node_modules/@halcyon",
					},
				},
			};

			const result = rewriteRojoProject(project, {
				luauRoot: "out-tsc/test",
				projectRelocation: "..",
				relocatedShadowDirectory: "out-tsc/test",
				shadowDir: ".jest-roblox-coverage/out-tsc/test",
			});

			expect((result.tree["ReplicatedStorage"] as RojoTreeNode).$path).toBe("../include");
			expect((result.tree["Workspace"] as RojoTreeNode).$path).toBe(
				"../node_modules/@halcyon",
			);
		});

		it("should prepend projectRelocation to non-matching paths with relative parent refs", () => {
			expect.assertions(2);

			const project: RojoProject = {
				name: "test",
				tree: {
					$className: "DataModel",
					ServerScriptService: {
						$path: "../../node_modules/@flamework",
					},
					StarterPlayer: {
						$path: "../../rojo-sync/@rbxts",
					},
				},
			};

			const result = rewriteRojoProject(project, {
				luauRoot: "out-tsc/test",
				projectRelocation: "..",
				relocatedShadowDirectory: "out-tsc/test",
				shadowDir: ".jest-roblox-coverage/out-tsc/test",
			});

			expect((result.tree["ServerScriptService"] as RojoTreeNode).$path).toBe(
				"../../../node_modules/@flamework",
			);
			expect((result.tree["StarterPlayer"] as RojoTreeNode).$path).toBe(
				"../../../rojo-sync/@rbxts",
			);
		});

		it("should handle exact luauRoot match with relocation", () => {
			expect.assertions(1);

			const project: RojoProject = {
				name: "test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: {
						$path: "out-tsc/test",
					},
				},
			};

			const result = rewriteRojoProject(project, {
				luauRoot: "out-tsc/test",
				projectRelocation: "..",
				relocatedShadowDirectory: "out-tsc/test",
				shadowDir: ".jest-roblox-coverage/out-tsc/test",
			});

			expect((result.tree["ReplicatedStorage"] as RojoTreeNode).$path).toBe("out-tsc/test");
		});

		it("should apply relocation recursively to nested nodes", () => {
			expect.assertions(2);

			const project: RojoProject = {
				name: "test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: {
						client: {
							$path: "out-tsc/test/client",
						},
						libs: {
							$path: "include",
						},
					},
				},
			};

			const result = rewriteRojoProject(project, {
				luauRoot: "out-tsc/test",
				projectRelocation: "..",
				relocatedShadowDirectory: "out-tsc/test",
				shadowDir: ".jest-roblox-coverage/out-tsc/test",
			});

			const replicated = result.tree["ReplicatedStorage"] as RojoTreeNode;

			expect((replicated["client"] as RojoTreeNode).$path).toBe("out-tsc/test/client");
			expect((replicated["libs"] as RojoTreeNode).$path).toBe("../include");
		});
	});

	describe("when normalizing paths", () => {
		it("should handle luauRoot with trailing slash", () => {
			expect.assertions(1);

			const project: RojoProject = {
				name: "test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: {
						$path: "out-tsc/test/client",
					},
				},
			};

			const result = rewriteRojoProject(project, {
				luauRoot: "out-tsc/test/",
				shadowDir: ".jest-roblox-coverage/out-tsc/test",
			});

			expect((result.tree["ReplicatedStorage"] as RojoTreeNode).$path).toBe(
				".jest-roblox-coverage/out-tsc/test/client",
			);
		});

		it("should not rewrite a $path that is a prefix but not a path boundary", () => {
			expect.assertions(1);

			const project: RojoProject = {
				name: "test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: {
						$path: "out-tsc/testing",
					},
				},
			};

			const result = rewriteRojoProject(project, {
				luauRoot: "out-tsc/test",
				shadowDir: ".jest-roblox-coverage/out-tsc/test",
			});

			expect((result.tree["ReplicatedStorage"] as RojoTreeNode).$path).toBe(
				"out-tsc/testing",
			);
		});
	});

	describe("when rewriting with multiple roots", () => {
		it("should rewrite paths matching any of the provided roots", () => {
			expect.assertions(2);

			const project: RojoProject = {
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

			const result = rewriteRojoProject(project, {
				projectRelocation: "..",
				roots: [
					{
						luauRoot: "packages/core/out",
						relocatedShadowDirectory: "packages/core/out",
						shadowDir: ".jest-roblox-coverage/packages/core/out",
					},
					{
						luauRoot: "packages/test-utils/out",
						relocatedShadowDirectory: "packages/test-utils/out",
						shadowDir: ".jest-roblox-coverage/packages/test-utils/out",
					},
				],
			});

			expect((result.tree["ReplicatedStorage"] as RojoTreeNode).$path).toBe(
				"packages/core/out",
			);
			expect((result.tree["ServerScriptService"] as RojoTreeNode).$path).toBe(
				"packages/test-utils/out",
			);
		});

		it("should prepend projectRelocation to non-matching paths with multiple roots", () => {
			expect.assertions(1);

			const project: RojoProject = {
				name: "test",
				tree: {
					$className: "DataModel",
					Workspace: {
						$path: "include",
					},
				},
			};

			const result = rewriteRojoProject(project, {
				projectRelocation: "..",
				roots: [
					{
						luauRoot: "packages/core/out",
						relocatedShadowDirectory: "packages/core/out",
						shadowDir: ".jest-roblox-coverage/packages/core/out",
					},
				],
			});

			expect((result.tree["Workspace"] as RojoTreeNode).$path).toBe("../include");
		});

		it("should use first matching root when roots overlap in prefix", () => {
			expect.assertions(1);

			const project: RojoProject = {
				name: "test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: {
						$path: "packages/core/out/client",
					},
				},
			};

			const result = rewriteRojoProject(project, {
				projectRelocation: "..",
				roots: [
					{
						luauRoot: "packages/core/out",
						relocatedShadowDirectory: "packages/core/out",
						shadowDir: ".jest-roblox-coverage/packages/core/out",
					},
					{
						luauRoot: "packages/core/out/client",
						relocatedShadowDirectory: "packages/core/out/client",
						shadowDir: ".jest-roblox-coverage/packages/core/out/client",
					},
				],
			});

			// First root matches, so uses its shadow directory
			expect((result.tree["ReplicatedStorage"] as RojoTreeNode).$path).toBe(
				"packages/core/out/client",
			);
		});
	});
});
