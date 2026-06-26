import { describe, expect, it, vi } from "vitest";

import type { CliOptions, WorkspaceRunOptions } from "../config/schema.ts";
import { DEFAULT_CONFIG } from "../config/schema.ts";
import {
	assertWorkspaceRunOptions,
	buildWorkspaceCredentials,
	resolveWorkspacePackages,
	validateBasicWorkspaceFlags,
} from "./workspace-validation.ts";

vi.mock(import("../workspace/affected"));
vi.mock(import("../workspace/package-resolver"));
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

function makeRunOptions(overrides: Partial<WorkspaceRunOptions> = {}): WorkspaceRunOptions {
	return {
		backend: DEFAULT_CONFIG.backend,
		color: DEFAULT_CONFIG.color,
		formatters: [],
		port: DEFAULT_CONFIG.port,
		silent: DEFAULT_CONFIG.silent,
		workspaceGameOutput: false,
		workspaceOutputFile: false,
		...overrides,
	};
}

describe(validateBasicWorkspaceFlags, () => {
	it("should reject when --packages and --affected-since are both set", () => {
		expect.assertions(1);

		const result = validateBasicWorkspaceFlags(
			makeCli({ affectedSince: "main", packages: "a", workspace: true }),
		);

		expect(result).toStrictEqual({
			exitCode: 2,
			message: "Error: --packages and --affected-since are mutually exclusive.\n",
			ok: false,
		});
	});

	it("should reject --packages without --workspace", () => {
		expect.assertions(1);

		const result = validateBasicWorkspaceFlags(makeCli({ packages: "a" }));

		expect(result).toStrictEqual({
			exitCode: 2,
			message: "Error: --packages requires --workspace.\n",
			ok: false,
		});
	});

	it("should reject --affected-since without --workspace", () => {
		expect.assertions(1);

		const result = validateBasicWorkspaceFlags(makeCli({ affectedSince: "main" }));

		expect(result).toStrictEqual({
			exitCode: 2,
			message: "Error: --affected-since requires --workspace.\n",
			ok: false,
		});
	});

	it("should reject --workspace without --packages or --affected-since", () => {
		expect.assertions(1);

		const result = validateBasicWorkspaceFlags(makeCli({ workspace: true }));

		expect(result).toStrictEqual({
			exitCode: 2,
			message: "Error: --workspace requires --packages or --affected-since.\n",
			ok: false,
		});
	});

	it("should reject --workspace with empty --packages string", () => {
		expect.assertions(1);

		const result = validateBasicWorkspaceFlags(makeCli({ packages: "   ", workspace: true }));

		expect(result.ok).toBeFalse();
	});

	it("should reject --packages that splits to zero entries", () => {
		expect.assertions(2);

		const result = validateBasicWorkspaceFlags(makeCli({ packages: "  ,  ", workspace: true }));

		expect(result.ok).toBeFalse();
		expect((result as { message: string }).message).toBe(
			"Error: --workspace requires --packages or --affected-since.\n",
		);
	});

	it("should accept --workspace with --packages", () => {
		expect.assertions(1);

		const result = validateBasicWorkspaceFlags(makeCli({ packages: "a,b", workspace: true }));

		expect(result).toStrictEqual({ ok: true });
	});

	it("should accept --workspace with --affected-since", () => {
		expect.assertions(1);

		const result = validateBasicWorkspaceFlags(
			makeCli({ affectedSince: "HEAD~1", workspace: true }),
		);

		expect(result).toStrictEqual({ ok: true });
	});
});

describe(assertWorkspaceRunOptions, () => {
	it("should accept the studio backend (workspace debug via an open Studio)", () => {
		expect.assertions(1);

		const result = assertWorkspaceRunOptions(makeRunOptions({ backend: "studio" }));

		expect(result).toStrictEqual({ ok: true });
	});

	it("should accept the studio-cli backend", () => {
		expect.assertions(1);

		const result = assertWorkspaceRunOptions(makeRunOptions({ backend: "studio-cli" }));

		expect(result).toStrictEqual({ ok: true });
	});

	it("should reject studio-cli with --parallel > 1 (it is serial)", () => {
		expect.assertions(2);

		const result = assertWorkspaceRunOptions(
			makeRunOptions({ backend: "studio-cli", parallel: 2 }),
		);

		expect(result.ok).toBeFalse();
		expect((result as { message: string }).message).toContain("serial");
	});

	it("should reject studio-cli with --parallel auto", () => {
		expect.assertions(1);

		const result = assertWorkspaceRunOptions(
			makeRunOptions({ backend: "studio-cli", parallel: "auto" }),
		);

		expect(result.ok).toBeFalse();
	});

	it("should accept studio-cli with --parallel 1", () => {
		expect.assertions(1);

		const result = assertWorkspaceRunOptions(
			makeRunOptions({ backend: "studio-cli", parallel: 1 }),
		);

		expect(result).toStrictEqual({ ok: true });
	});

	it("should accept open-cloud backend", () => {
		expect.assertions(1);

		const result = assertWorkspaceRunOptions(makeRunOptions({ backend: "open-cloud" }));

		expect(result).toStrictEqual({ ok: true });
	});

	it("should accept auto backend", () => {
		expect.assertions(1);

		const result = assertWorkspaceRunOptions(makeRunOptions({ backend: "auto" }));

		expect(result).toStrictEqual({ ok: true });
	});
});

describe(resolveWorkspacePackages, () => {
	it("should return getAffectedPackages output directly when --affected-since is set", async () => {
		expect.assertions(2);

		const { getAffectedPackages } = await import("../workspace/affected");
		const affected = [
			{ name: "@org/pkg-a", packageDirectory: "/workspace/packages/a" },
			{ name: "@org/pkg-b", packageDirectory: "/workspace/packages/b" },
		];
		vi.mocked(getAffectedPackages).mockReturnValue(affected);
		const result = resolveWorkspacePackages(makeCli({ affectedSince: "HEAD~1" }), "/workspace");

		// The affected branch carries name + directory from turbo/nx, so it
		// must NOT round-trip through resolvePackage.
		expect(result).toStrictEqual(affected);
		expect(getAffectedPackages).toHaveBeenCalledWith("/workspace", "HEAD~1");
	});

	it("should resolve each comma-separated --packages name against the workspace", async () => {
		expect.assertions(4);

		const { resolvePackage } = await import("../workspace/package-resolver");
		vi.mocked(resolvePackage).mockImplementation((root, name) => {
			return { name, packageDirectory: `${root}/packages/${name}` };
		});

		const result = resolveWorkspacePackages(makeCli({ packages: "a,b,c" }), "/workspace", [
			"packages/*",
		]);

		expect(result).toStrictEqual([
			{ name: "a", packageDirectory: "/workspace/packages/a" },
			{ name: "b", packageDirectory: "/workspace/packages/b" },
			{ name: "c", packageDirectory: "/workspace/packages/c" },
		]);
		expect(resolvePackage).toHaveBeenCalledWith("/workspace", "a", ["packages/*"]);
		expect(resolvePackage).toHaveBeenCalledWith("/workspace", "b", ["packages/*"]);
		expect(resolvePackage).toHaveBeenCalledWith("/workspace", "c", ["packages/*"]);
	});

	it("should trim whitespace and drop empty entries before resolving", async () => {
		expect.assertions(2);

		const { resolvePackage } = await import("../workspace/package-resolver");
		vi.mocked(resolvePackage).mockImplementation((root, name) => {
			return { name, packageDirectory: `${root}/packages/${name}` };
		});

		const result = resolveWorkspacePackages(makeCli({ packages: " a , , b " }), "/workspace");

		expect(result.map((info) => info.name)).toStrictEqual(["a", "b"]);
		expect(resolvePackage).toHaveBeenCalledTimes(2);
	});
});

describe(buildWorkspaceCredentials, () => {
	it("should forward CLI overrides and run-option defaults to resolveCredentials", async () => {
		expect.assertions(2);

		const { resolveCredentials } = await import("@isentinel/roblox-runner");
		const cli = makeCli({ apiKey: "k", placeId: "pp", universeId: "uu" });
		const runOptions = makeRunOptions({ placeId: "configP", universeId: "configU" });
		const result = buildWorkspaceCredentials(cli, runOptions);

		expect(result).toStrictEqual({ apiKey: "test-key", placeId: "p", universeId: "u" });
		expect(resolveCredentials).toHaveBeenCalledWith({
			defaults: { placeId: "configP", universeId: "configU" },
			envPrefix: "JEST_",
			overrides: { apiKey: "k", placeId: "pp", universeId: "uu" },
		});
	});
});
