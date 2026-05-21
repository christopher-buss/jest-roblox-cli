import { describe, expect, it, vi } from "vitest";

import type { CliOptions, WorkspaceRunOptions } from "../config/schema.ts";
import { DEFAULT_CONFIG } from "../config/schema.ts";
import {
	assertWorkspaceRunOptions,
	buildWorkspaceCredentials,
	resolveWorkspacePackageNames,
	validateBasicWorkspaceFlags,
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

function makeRunOptions(overrides: Partial<WorkspaceRunOptions> = {}): WorkspaceRunOptions {
	return {
		backend: DEFAULT_CONFIG.backend,
		color: DEFAULT_CONFIG.color,
		formatters: [],
		pollInterval: DEFAULT_CONFIG.pollInterval,
		port: DEFAULT_CONFIG.port,
		silent: DEFAULT_CONFIG.silent,
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
	it("should reject studio backend", () => {
		expect.assertions(1);

		const result = assertWorkspaceRunOptions(makeRunOptions({ backend: "studio" }));

		expect(result).toStrictEqual({
			exitCode: 2,
			message: "Error: --workspace requires --backend open-cloud (Studio not supported).\n",
			ok: false,
		});
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
