import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { CliOptions } from "./schema.ts";
import { DEFAULT_CONFIG } from "./schema.ts";
import { buildWorkspaceRunOptions, WorkspaceConsensusError } from "./workspace-run-options.ts";

const stdEnvironmentMock = vi.hoisted(() => ({ isAgent: false }));

vi.mock(import("std-env"), () => stdEnvironmentMock);

function emptyCli(): CliOptions {
	return {};
}

describe(buildWorkspaceRunOptions, () => {
	describe("happy path: per-package consensus", () => {
		it("should use the agreed value when every package declares the same value", () => {
			expect.assertions(1);

			const result = buildWorkspaceRunOptions({
				cli: emptyCli(),
				perPackageConfigs: [
					{ name: "alpha", config: { backend: "open-cloud" } },
					{ name: "beta", config: { backend: "open-cloud" } },
				],
			});

			expect(result.backend).toBe("open-cloud");
		});

		it("should treat deep-equal arrays as agreement", () => {
			expect.assertions(1);

			const result = buildWorkspaceRunOptions({
				cli: emptyCli(),
				perPackageConfigs: [
					{ name: "alpha", config: { formatters: ["json"] } },
					{ name: "beta", config: { formatters: ["json"] } },
				],
			});

			expect(result.formatters).toStrictEqual(["json"]);
		});

		it("should read silent from test.silent in the raw config", () => {
			expect.assertions(1);

			const result = buildWorkspaceRunOptions({
				cli: emptyCli(),
				perPackageConfigs: [
					{ name: "alpha", config: { test: { silent: true } } },
					{ name: "beta", config: { test: { silent: true } } },
				],
			});

			expect(result.silent).toBeTrue();
		});
	});

	describe("workspace.packages convergence", () => {
		it("should throw when packages disagree on workspace.packages", () => {
			expect.assertions(2);

			let thrown: unknown;
			try {
				buildWorkspaceRunOptions({
					cli: emptyCli(),
					perPackageConfigs: [
						{
							name: "alpha",
							config: { workspace: { packages: ["packages/*"], root: "/r" } },
						},
						{
							name: "beta",
							config: { workspace: { packages: ["libs/*"], root: "/r" } },
						},
					],
				});
			} catch (err) {
				thrown = err;
			}

			expect(thrown).toBeInstanceOf(WorkspaceConsensusError);
			expect((thrown as Error).message).toContain("workspace.packages");
		});

		it("should throw when packages disagree on workspace.root", () => {
			expect.assertions(1);

			expect(() => {
				return buildWorkspaceRunOptions({
					cli: emptyCli(),
					perPackageConfigs: [
						{
							name: "alpha",
							config: { workspace: { packages: ["packages/*"], root: "/a" } },
						},
						{
							name: "beta",
							config: { workspace: { packages: ["packages/*"], root: "/b" } },
						},
					],
				});
			}).toThrow(WorkspaceConsensusError);
		});

		it("should not throw when every package agrees on workspace.root/packages", () => {
			expect.assertions(1);

			expect(() => {
				return buildWorkspaceRunOptions({
					cli: emptyCli(),
					perPackageConfigs: [
						{
							name: "alpha",
							config: { workspace: { packages: ["packages/*"], root: "/r" } },
						},
						{
							name: "beta",
							config: { workspace: { packages: ["packages/*"], root: "/r" } },
						},
					],
				});
			}).not.toThrow();
		});
	});

	describe("default-config fallback", () => {
		it("should fall back to DEFAULT_CONFIG when no package declares the field", () => {
			expect.assertions(4);

			const result = buildWorkspaceRunOptions({
				cli: emptyCli(),
				perPackageConfigs: [
					{ name: "alpha", config: {} },
					{ name: "beta", config: {} },
				],
			});

			expect(result.backend).toBe(DEFAULT_CONFIG.backend);
			expect(result.color).toBe(DEFAULT_CONFIG.color);
			expect(result.silent).toBe(DEFAULT_CONFIG.silent);
			expect(result.port).toBe(DEFAULT_CONFIG.port);
		});

		it("should leave optional fields undefined when no one declares them", () => {
			expect.assertions(3);

			const result = buildWorkspaceRunOptions({
				cli: emptyCli(),
				perPackageConfigs: [{ name: "alpha", config: {} }],
			});

			expect(result.placeId).toBeUndefined();
			expect(result.universeId).toBeUndefined();
			expect(result.parallel).toBeUndefined();
		});

		it("should fall back to a non-empty env-detected default formatter list", () => {
			expect.assertions(2);

			const result = buildWorkspaceRunOptions({
				cli: emptyCli(),
				perPackageConfigs: [{ name: "alpha", config: {} }],
			});

			// Either ["default"] or ["agent"] depending on std-env detection;
			// CI may also append "github-actions". The contract is "non-empty
			// with at least one named formatter" — exact values are
			// env-dependent.
			expect(result.formatters.length).toBeGreaterThan(0);
			expect(result.formatters[0]).toMatch(/^(default|agent)$/);
		});
	});

	describe("mixed-values conflict", () => {
		it("should throw WorkspaceConsensusError when packages declare different values", () => {
			expect.assertions(1);

			expect(() => {
				return buildWorkspaceRunOptions({
					cli: emptyCli(),
					perPackageConfigs: [
						{ name: "alpha", config: { backend: "open-cloud" } },
						{ name: "beta", config: { backend: "studio" } },
					],
				});
			}).toThrow(WorkspaceConsensusError);
		});

		it("should list each declared value with the packages declaring it", () => {
			expect.assertions(4);

			let captured: undefined | WorkspaceConsensusError;
			try {
				buildWorkspaceRunOptions({
					cli: emptyCli(),
					perPackageConfigs: [
						{ name: "alpha", config: { backend: "open-cloud" } },
						{ name: "gamma", config: { backend: "open-cloud" } },
						{ name: "beta", config: { backend: "studio" } },
					],
				});
			} catch (err) {
				captured = err as WorkspaceConsensusError;
			}

			expect(captured).toBeInstanceOf(WorkspaceConsensusError);
			expect(captured?.message).toContain("backend");
			expect(captured?.message).toContain("alpha");
			expect(captured?.message).toContain("beta");
		});

		it("should reject mixed values for deep-compared arrays", () => {
			expect.assertions(1);

			expect(() => {
				return buildWorkspaceRunOptions({
					cli: emptyCli(),
					perPackageConfigs: [
						{ name: "alpha", config: { formatters: ["json"] } },
						{ name: "beta", config: { formatters: ["agent"] } },
					],
				});
			}).toThrow(WorkspaceConsensusError);
		});
	});

	describe("partial-declaration conflict", () => {
		it("should throw when some packages declare and others omit", () => {
			expect.assertions(1);

			expect(() => {
				return buildWorkspaceRunOptions({
					cli: emptyCli(),
					perPackageConfigs: [
						{ name: "alpha", config: { backend: "open-cloud" } },
						{ name: "beta", config: {} },
					],
				});
			}).toThrow(WorkspaceConsensusError);
		});

		it("should use the partial-variant wording in the error message", () => {
			expect.assertions(2);

			let captured: undefined | WorkspaceConsensusError;
			try {
				buildWorkspaceRunOptions({
					cli: emptyCli(),
					perPackageConfigs: [
						{ name: "alpha", config: { backend: "open-cloud" } },
						{ name: "beta", config: {} },
					],
				});
			} catch (err) {
				captured = err as WorkspaceConsensusError;
			}

			expect(captured?.message).toContain("not declared by");
			expect(captured?.message).toContain("beta");
		});
	});

	describe("cli override", () => {
		it("should let a CLI flag beat per-package disagreement", () => {
			expect.assertions(1);

			const result = buildWorkspaceRunOptions({
				cli: { backend: "open-cloud" },
				perPackageConfigs: [
					{ name: "alpha", config: { backend: "auto" } },
					{ name: "beta", config: { backend: "studio" } },
				],
			});

			expect(result.backend).toBe("open-cloud");
		});

		it("should let a CLI silent override beat per-package disagreement", () => {
			expect.assertions(1);

			const result = buildWorkspaceRunOptions({
				cli: { silent: true },
				perPackageConfigs: [
					{ name: "alpha", config: { test: { silent: false } } },
					{ name: "beta", config: {} },
				],
			});

			expect(result.silent).toBeTrue();
		});

		it("should let CLI formatters override per-package values", () => {
			expect.assertions(1);

			const result = buildWorkspaceRunOptions({
				cli: { formatters: ["json"] },
				perPackageConfigs: [
					{ name: "alpha", config: { formatters: ["agent"] } },
					{ name: "beta", config: { formatters: ["default"] } },
				],
			});

			expect(result.formatters).toStrictEqual(["json"]);
		});

		it("should let CLI override an optional field (placeId/universeId/parallel)", () => {
			expect.assertions(3);

			const result = buildWorkspaceRunOptions({
				cli: { parallel: 4, placeId: "p", universeId: "u" },
				perPackageConfigs: [{ name: "alpha", config: {} }],
			});

			expect(result.placeId).toBe("p");
			expect(result.universeId).toBe("u");
			expect(result.parallel).toBe(4);
		});
	});

	describe("studioPath resolution", () => {
		it("should let the CLI override studioPath for studio-cli workspace runs", () => {
			expect.assertions(1);

			const result = buildWorkspaceRunOptions({
				cli: { studioPath: "C:/custom/RobloxStudioBeta.exe" },
				perPackageConfigs: [{ name: "alpha", config: {} }],
			});

			expect(result.studioPath).toBe("C:/custom/RobloxStudioBeta.exe");
		});

		it("should propagate per-package studioPath when all agree", () => {
			expect.assertions(1);

			const result = buildWorkspaceRunOptions({
				cli: {},
				perPackageConfigs: [
					{ name: "alpha", config: { studioPath: "C:/s.exe" } },
					{ name: "beta", config: { studioPath: "C:/s.exe" } },
				],
			});

			expect(result.studioPath).toBe("C:/s.exe");
		});

		it("should leave studioPath undefined when no one declares it", () => {
			expect.assertions(1);

			const result = buildWorkspaceRunOptions({
				cli: {},
				perPackageConfigs: [{ name: "alpha", config: {} }],
			});

			expect(result.studioPath).toBeUndefined();
		});
	});

	describe("optional-field consensus", () => {
		it("should propagate per-package universeId when all agree", () => {
			expect.assertions(1);

			const result = buildWorkspaceRunOptions({
				cli: {},
				perPackageConfigs: [
					{ name: "alpha", config: { universeId: "shared-universe" } },
					{ name: "beta", config: { universeId: "shared-universe" } },
				],
			});

			expect(result.universeId).toBe("shared-universe");
		});
	});

	describe("env-driven formatter defaults", () => {
		it("should append github-actions when GITHUB_ACTIONS env is true", () => {
			expect.assertions(1);

			vi.stubEnv("GITHUB_ACTIONS", "true");

			const result = buildWorkspaceRunOptions({
				cli: {},
				perPackageConfigs: [{ name: "alpha", config: {} }],
			});

			expect(result.formatters).toContain("github-actions");
		});

		it("should pick the agent default when std-env reports an agent runtime", () => {
			expect.assertions(1);

			stdEnvironmentMock.isAgent = true;

			const result = buildWorkspaceRunOptions({
				cli: {},
				perPackageConfigs: [{ name: "alpha", config: {} }],
			});

			stdEnvironmentMock.isAgent = false;

			expect(result.formatters).toContain("agent");
		});
	});

	describe("gameOutput (aggregated)", () => {
		it("should resolve a unanimous string path against the workspace root", () => {
			expect.assertions(1);

			const result = buildWorkspaceRunOptions({
				cli: emptyCli(),
				perPackageConfigs: [
					{ name: "alpha", config: { gameOutput: "logs.json" } },
					{ name: "beta", config: { gameOutput: "logs.json" } },
				],
				workspaceRoot: "/repo",
			});

			expect(result.gameOutput).toBe(path.join("/repo", "logs.json"));
		});

		it("should expand `true` to game-output.log under the workspace root", () => {
			expect.assertions(1);

			const result = buildWorkspaceRunOptions({
				cli: emptyCli(),
				perPackageConfigs: [
					{ name: "alpha", config: { gameOutput: true } },
					{ name: "beta", config: { gameOutput: true } },
				],
				workspaceRoot: "/repo",
			});

			expect(result.gameOutput).toBe(path.join("/repo", "game-output.log"));
		});

		it("should leave an absolute path untouched", () => {
			expect.assertions(1);

			const absolute = path.resolve("/abs/logs.json");
			const result = buildWorkspaceRunOptions({
				cli: emptyCli(),
				perPackageConfigs: [{ name: "alpha", config: { gameOutput: absolute } }],
				workspaceRoot: "/repo",
			});

			expect(result.gameOutput).toBe(absolute);
		});

		it("should be undefined when no package declares gameOutput", () => {
			expect.assertions(1);

			const result = buildWorkspaceRunOptions({
				cli: emptyCli(),
				perPackageConfigs: [{ name: "alpha", config: {} }],
				workspaceRoot: "/repo",
			});

			expect(result.gameOutput).toBeUndefined();
		});

		it("should let the CLI flag override per-package values", () => {
			expect.assertions(1);

			const result = buildWorkspaceRunOptions({
				cli: { gameOutput: "cli.json" },
				perPackageConfigs: [{ name: "alpha", config: { gameOutput: "pkg.json" } }],
				workspaceRoot: "/repo",
			});

			expect(result.gameOutput).toBe(path.join("/repo", "cli.json"));
		});

		it("should throw WorkspaceConsensusError when `true` and a string disagree", () => {
			expect.assertions(1);

			expect(() => {
				return buildWorkspaceRunOptions({
					cli: emptyCli(),
					perPackageConfigs: [
						{ name: "alpha", config: { gameOutput: true } },
						{ name: "beta", config: { gameOutput: "game-output.log" } },
					],
					workspaceRoot: "/repo",
				});
			}).toThrow(WorkspaceConsensusError);
		});
	});

	describe("workspace.gameOutput (per-package files)", () => {
		it("should be true when every package declares it", () => {
			expect.assertions(1);

			const result = buildWorkspaceRunOptions({
				cli: emptyCli(),
				perPackageConfigs: [
					{ name: "alpha", config: { workspace: { gameOutput: true } } },
					{ name: "beta", config: { workspace: { gameOutput: true } } },
				],
				workspaceRoot: "/repo",
			});

			expect(result.workspaceGameOutput).toBeTrue();
		});

		it("should be false when no package declares it", () => {
			expect.assertions(1);

			const result = buildWorkspaceRunOptions({
				cli: emptyCli(),
				perPackageConfigs: [{ name: "alpha", config: {} }],
				workspaceRoot: "/repo",
			});

			expect(result.workspaceGameOutput).toBeFalse();
		});

		it("should throw WorkspaceConsensusError when only some packages declare it", () => {
			expect.assertions(1);

			expect(() => {
				return buildWorkspaceRunOptions({
					cli: emptyCli(),
					perPackageConfigs: [
						{ name: "alpha", config: { workspace: { gameOutput: true } } },
						{ name: "beta", config: {} },
					],
					workspaceRoot: "/repo",
				});
			}).toThrow(WorkspaceConsensusError);
		});
	});

	describe("outputFile (aggregated)", () => {
		it("should expand `true` to jest-output.log under the workspace root", () => {
			expect.assertions(1);

			const result = buildWorkspaceRunOptions({
				cli: emptyCli(),
				perPackageConfigs: [
					{ name: "alpha", config: { outputFile: true } },
					{ name: "beta", config: { outputFile: true } },
				],
				workspaceRoot: "/repo",
			});

			expect(result.outputFile).toBe(path.join("/repo", "jest-output.log"));
		});

		it("should resolve a unanimous string path against the workspace root", () => {
			expect.assertions(1);

			const result = buildWorkspaceRunOptions({
				cli: emptyCli(),
				perPackageConfigs: [{ name: "alpha", config: { outputFile: "results.json" } }],
				workspaceRoot: "/repo",
			});

			expect(result.outputFile).toBe(path.join("/repo", "results.json"));
		});

		it("should be undefined when no package declares outputFile", () => {
			expect.assertions(1);

			const result = buildWorkspaceRunOptions({
				cli: emptyCli(),
				perPackageConfigs: [{ name: "alpha", config: {} }],
				workspaceRoot: "/repo",
			});

			expect(result.outputFile).toBeUndefined();
		});

		it("should let the CLI flag override per-package values", () => {
			expect.assertions(1);

			const result = buildWorkspaceRunOptions({
				cli: { outputFile: "cli.json" },
				perPackageConfigs: [{ name: "alpha", config: { outputFile: "pkg.json" } }],
				workspaceRoot: "/repo",
			});

			expect(result.outputFile).toBe(path.join("/repo", "cli.json"));
		});

		it("should throw WorkspaceConsensusError when `true` and a string disagree", () => {
			expect.assertions(1);

			expect(() => {
				return buildWorkspaceRunOptions({
					cli: emptyCli(),
					perPackageConfigs: [
						{ name: "alpha", config: { outputFile: true } },
						{ name: "beta", config: { outputFile: "jest-output.log" } },
					],
					workspaceRoot: "/repo",
				});
			}).toThrow(WorkspaceConsensusError);
		});
	});

	describe("workspace.outputFile (per-package files)", () => {
		it("should be true when every package declares it", () => {
			expect.assertions(1);

			const result = buildWorkspaceRunOptions({
				cli: emptyCli(),
				perPackageConfigs: [
					{ name: "alpha", config: { workspace: { outputFile: true } } },
					{ name: "beta", config: { workspace: { outputFile: true } } },
				],
				workspaceRoot: "/repo",
			});

			expect(result.workspaceOutputFile).toBeTrue();
		});

		it("should be false when no package declares it", () => {
			expect.assertions(1);

			const result = buildWorkspaceRunOptions({
				cli: emptyCli(),
				perPackageConfigs: [{ name: "alpha", config: {} }],
				workspaceRoot: "/repo",
			});

			expect(result.workspaceOutputFile).toBeFalse();
		});

		it("should throw WorkspaceConsensusError when only some packages declare it", () => {
			expect.assertions(1);

			expect(() => {
				return buildWorkspaceRunOptions({
					cli: emptyCli(),
					perPackageConfigs: [
						{ name: "alpha", config: { workspace: { outputFile: true } } },
						{ name: "beta", config: {} },
					],
					workspaceRoot: "/repo",
				});
			}).toThrow(WorkspaceConsensusError);
		});
	});

	describe("selection scope", () => {
		it("should ignore packages not passed in perPackageConfigs", () => {
			expect.assertions(1);

			// Excluded packages (those not in perPackageConfigs) cannot
			// contribute to a conflict. The contract: only the selected slice
			// matters.
			const result = buildWorkspaceRunOptions({
				cli: emptyCli(),
				perPackageConfigs: [{ name: "alpha", config: { backend: "open-cloud" } }],
			});

			expect(result.backend).toBe("open-cloud");
		});
	});
});

describe(WorkspaceConsensusError, () => {
	it("should be an instance of Error", () => {
		expect.assertions(1);

		const error = new WorkspaceConsensusError("backend", [
			{ packages: ["alpha"], value: "open-cloud" },
			{ packages: ["beta"], value: "studio" },
		]);

		expect(error).toBeInstanceOf(Error);
	});
});
