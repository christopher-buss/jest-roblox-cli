import { describe, expect, it, vi } from "vitest";

import type { CliOptions, ResolvedConfig } from "../config/schema.ts";
import { DEFAULT_CONFIG } from "../config/schema.ts";
import {
	buildWorkspaceCredentials,
	resolveWorkspacePackageNames,
	validateWorkspaceFlags,
} from "./workspace-validation.ts";

vi.mock(import("../workspace/affected"));
vi.mock(import("@isentinel/roblox-runner"), async (importOriginal) => {
	const actual = await importOriginal();
	return {
		...actual,
		resolveCredentials: vi.fn<() => { apiKey: string; placeId: string; universeId: string }>(
			() => {
				return { apiKey: "test-key", placeId: "p", universeId: "u" };
			},
		),
	};
});

function makeCli(overrides: Partial<CliOptions> = {}): CliOptions {
	return { ...overrides };
}

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
	return { ...DEFAULT_CONFIG, ...overrides };
}

describe(validateWorkspaceFlags, () => {
	it("should reject when --packages and --affected-since are both set", () => {
		expect.assertions(1);

		const result = validateWorkspaceFlags(
			makeCli({ affectedSince: "main", packages: "a", workspace: true }),
			makeConfig({ backend: "open-cloud" }),
		);

		expect(result).toStrictEqual({
			exitCode: 2,
			message: "Error: --packages and --affected-since are mutually exclusive.\n",
			ok: false,
		});
	});

	it("should reject --packages without --workspace", () => {
		expect.assertions(1);

		const result = validateWorkspaceFlags(
			makeCli({ packages: "a" }),
			makeConfig({ backend: "open-cloud" }),
		);

		expect(result).toStrictEqual({
			exitCode: 2,
			message: "Error: --packages requires --workspace.\n",
			ok: false,
		});
	});

	it("should reject --affected-since without --workspace", () => {
		expect.assertions(1);

		const result = validateWorkspaceFlags(
			makeCli({ affectedSince: "main" }),
			makeConfig({ backend: "open-cloud" }),
		);

		expect(result).toStrictEqual({
			exitCode: 2,
			message: "Error: --affected-since requires --workspace.\n",
			ok: false,
		});
	});

	it("should reject --workspace without --packages or --affected-since", () => {
		expect.assertions(1);

		const result = validateWorkspaceFlags(
			makeCli({ workspace: true }),
			makeConfig({ backend: "open-cloud" }),
		);

		expect(result).toStrictEqual({
			exitCode: 2,
			message: "Error: --workspace requires --packages or --affected-since.\n",
			ok: false,
		});
	});

	it("should reject --workspace with empty --packages string", () => {
		expect.assertions(1);

		const result = validateWorkspaceFlags(
			makeCli({ packages: "   ", workspace: true }),
			makeConfig({ backend: "open-cloud" }),
		);

		expect(result.ok).toBeFalse();
	});

	it("should reject --packages that splits to zero entries", () => {
		expect.assertions(2);

		const result = validateWorkspaceFlags(
			makeCli({ packages: "  ,  ", workspace: true }),
			makeConfig({ backend: "open-cloud" }),
		);

		expect(result.ok).toBeFalse();
		expect((result as { message: string }).message).toBe(
			"Error: --workspace requires --packages or --affected-since.\n",
		);
	});

	it("should accept coverage with --workspace", () => {
		expect.assertions(1);

		const result = validateWorkspaceFlags(
			makeCli({ collectCoverage: true, packages: "a", workspace: true }),
			makeConfig({ backend: "open-cloud", collectCoverage: true }),
		);

		expect(result).toStrictEqual({ ok: true });
	});

	it("should accept coverage when only enabled via config", () => {
		expect.assertions(1);

		const result = validateWorkspaceFlags(
			makeCli({ packages: "a", workspace: true }),
			makeConfig({ backend: "open-cloud", collectCoverage: true }),
		);

		expect(result).toStrictEqual({ ok: true });
	});

	it("should accept --gameOutput with --workspace", () => {
		expect.assertions(1);

		const result = validateWorkspaceFlags(
			makeCli({ gameOutput: "/tmp/out.txt", packages: "a", workspace: true }),
			makeConfig({ backend: "open-cloud", gameOutput: "/tmp/out.txt" }),
		);

		expect(result).toStrictEqual({ ok: true });
	});

	it("should accept gameOutput when only set via config", () => {
		expect.assertions(1);

		const result = validateWorkspaceFlags(
			makeCli({ packages: "a", workspace: true }),
			makeConfig({ backend: "open-cloud", gameOutput: "/tmp/out.txt" }),
		);

		expect(result).toStrictEqual({ ok: true });
	});

	it("should reject studio backend with --workspace", () => {
		expect.assertions(1);

		const result = validateWorkspaceFlags(
			makeCli({ packages: "a", workspace: true }),
			makeConfig({ backend: "studio" }),
		);

		expect(result).toStrictEqual({
			exitCode: 2,
			message: "Error: --workspace requires --backend open-cloud (Studio not supported).\n",
			ok: false,
		});
	});

	it("should accept --workspace with --packages and open-cloud backend", () => {
		expect.assertions(1);

		const result = validateWorkspaceFlags(
			makeCli({ packages: "a,b", workspace: true }),
			makeConfig({ backend: "open-cloud" }),
		);

		expect(result).toStrictEqual({ ok: true });
	});

	it("should accept --workspace with --affected-since", () => {
		expect.assertions(1);

		const result = validateWorkspaceFlags(
			makeCli({ affectedSince: "HEAD~1", workspace: true }),
			makeConfig({ backend: "open-cloud" }),
		);

		expect(result).toStrictEqual({ ok: true });
	});
});

describe(resolveWorkspacePackageNames, () => {
	it("should call getAffectedPackages when --affected-since is set", async () => {
		expect.assertions(2);

		const { getAffectedPackages } = await import("../workspace/affected");
		vi.mocked(getAffectedPackages).mockReturnValue(["pkg-a", "pkg-b"]);
		const result = resolveWorkspacePackageNames(
			makeCli({ affectedSince: "HEAD~1" }),
			"/workspace",
		);

		expect(result).toStrictEqual(["pkg-a", "pkg-b"]);
		expect(getAffectedPackages).toHaveBeenCalledWith("/workspace", "HEAD~1");
	});

	it("should split comma-separated --packages", () => {
		expect.assertions(1);

		const result = resolveWorkspacePackageNames(makeCli({ packages: "a,b,c" }), "/workspace");

		expect(result).toStrictEqual(["a", "b", "c"]);
	});

	it("should trim whitespace and drop empty entries", () => {
		expect.assertions(1);

		const result = resolveWorkspacePackageNames(
			makeCli({ packages: " a , , b " }),
			"/workspace",
		);

		expect(result).toStrictEqual(["a", "b"]);
	});
});

describe(buildWorkspaceCredentials, () => {
	it("should forward CLI overrides and config defaults to resolveCredentials", async () => {
		expect.assertions(2);

		const { resolveCredentials } = await import("@isentinel/roblox-runner");
		const cli = makeCli({ apiKey: "k", placeId: "pp", universeId: "uu" });
		const config = makeConfig({ placeId: "configP", universeId: "configU" });
		const result = buildWorkspaceCredentials(cli, config);

		expect(result).toStrictEqual({ apiKey: "test-key", placeId: "p", universeId: "u" });
		expect(resolveCredentials).toHaveBeenCalledWith({
			defaults: { placeId: "configP", universeId: "configU" },
			envPrefix: "JEST_",
			overrides: { apiKey: "k", placeId: "pp", universeId: "uu" },
		});
	});
});
