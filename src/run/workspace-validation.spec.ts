import { assert, describe, expect, it, vi } from "vitest";

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
		bail: false,
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

	it("should reject --experimental-vm-parallel in workspace mode", () => {
		expect.assertions(1);

		const result = validateBasicWorkspaceFlags(
			makeCli({ experimentalVmParallel: 2, packages: "a", workspace: true }),
		);

		expect(result).toStrictEqual({
			exitCode: 2,
			message:
				"Error: --experimental-vm-parallel is not supported in workspace mode; " +
				"it splits the configs of a single multi-project run.\n",
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

	// --bail only has a meaning in workspace mode, so silently ignoring it on a
	// single-package run would leave the user waiting for a stop that never
	// comes.
	it("should reject --bail without --workspace", () => {
		expect.assertions(1);

		const result = validateBasicWorkspaceFlags(makeCli({ bail: true }));

		expect(result).toStrictEqual({
			exitCode: 2,
			message: "Error: --bail requires --workspace.\n",
			ok: false,
		});
	});

	it("should accept a bare --workspace as every package", () => {
		expect.assertions(1);

		const result = validateBasicWorkspaceFlags(makeCli({ workspace: true }));

		expect(result).toStrictEqual({ ok: true });
	});

	// A bare --workspace runs everything, so an empty --packages must not read
	// as one: the user narrowed the run and then named nothing.
	it("should reject --workspace with empty --packages string", () => {
		expect.assertions(1);

		const result = validateBasicWorkspaceFlags(
			makeCli({ packages: " ".repeat(3), workspace: true }),
		);

		expect(result).toStrictEqual({
			exitCode: 2,
			message: "Error: --packages names no packages.\n",
			ok: false,
		});
	});

	it("should reject --packages that splits to zero entries", () => {
		expect.assertions(1);

		const result = validateBasicWorkspaceFlags(makeCli({ packages: "  ,  ", workspace: true }));

		expect(result).toStrictEqual({
			exitCode: 2,
			message: "Error: --packages names no packages.\n",
			ok: false,
		});
	});

	it("should accept --workspace with --packages", () => {
		expect.assertions(1);

		const result = validateBasicWorkspaceFlags(makeCli({ packages: "a, ", workspace: true }));

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
		expect.assertions(1);

		const result = assertWorkspaceRunOptions(
			makeRunOptions({ backend: "studio-cli", parallel: 2 }),
		);
		assert(!result.ok);

		expect(result).toStrictEqual({
			exitCode: 2,
			message:
				"Error: studio-cli backend is serial (one Studio instance) and cannot " +
				'shard; set parallel to 1 or "auto" for a --workspace run.\n',
			ok: false,
		});
	});

	it("should accept studio-cli with --parallel auto", () => {
		expect.assertions(1);

		const result = assertWorkspaceRunOptions(
			makeRunOptions({ backend: "studio-cli", parallel: "auto" }),
		);

		expect(result).toStrictEqual({ ok: true });
	});

	it("should accept studio-cli with --parallel 1", () => {
		expect.assertions(1);

		const result = assertWorkspaceRunOptions(
			makeRunOptions({ backend: "studio-cli", parallel: 1 }),
		);

		expect(result).toStrictEqual({ ok: true });
	});

	// The bail rides the Open Cloud task envelope and a MemoryStore signal map,
	// neither of which the Studio transports have — better to say so than to run
	// the whole batch while the user believes it will stop early.
	it("should reject --bail on a Studio backend", () => {
		expect.assertions(1);

		const result = assertWorkspaceRunOptions(makeRunOptions({ backend: "studio", bail: true }));
		assert(!result.ok);

		expect(result).toStrictEqual({
			exitCode: 2,
			message:
				"Error: --bail is Open Cloud only; a Studio backend runs every " +
				"package in the workspace regardless.\n",
			ok: false,
		});
	});

	it("should accept --bail on the open-cloud backend", () => {
		expect.assertions(1);

		const result = assertWorkspaceRunOptions(
			makeRunOptions({ backend: "open-cloud", bail: true }),
		);

		expect(result).toStrictEqual({ ok: true });
	});

	// "auto" is the default, and workspace mode resolves it to Open Cloud
	// without probing — so this is the invocation the README documents.
	it("should accept --bail on the default auto backend", () => {
		expect.assertions(1);

		const result = assertWorkspaceRunOptions(makeRunOptions({ backend: "auto", bail: true }));

		expect(result).toStrictEqual({ ok: true });
	});

	it("should reject --bail on studio-cli", () => {
		expect.assertions(1);

		const result = assertWorkspaceRunOptions(
			makeRunOptions({ backend: "studio-cli", bail: true }),
		);
		assert(!result.ok);

		expect(result).toStrictEqual({
			exitCode: 2,
			message:
				"Error: --bail is Open Cloud only; a Studio backend runs every " +
				"package in the workspace regardless.\n",
			ok: false,
		});
	});

	it("should accept a Studio backend without --bail", () => {
		expect.assertions(1);

		const result = assertWorkspaceRunOptions(makeRunOptions({ backend: "studio-cli" }));

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
		const { excludePackages } = await import("../workspace/package-resolver");
		const affected = [
			{ name: "@org/pkg-a", packageDirectory: "/workspace/packages/a" },
			{ name: "@org/pkg-b", packageDirectory: "/workspace/packages/b" },
		];
		vi.mocked(getAffectedPackages).mockReturnValue(affected);
		vi.mocked(excludePackages).mockImplementation((packages) => packages);
		const result = resolveWorkspacePackages(makeCli({ affectedSince: "HEAD~1" }), "/workspace");

		// The affected branch carries name + directory from turbo/nx, so it
		// must NOT round-trip through resolvePackage.
		expect(result).toStrictEqual(affected);
		expect(getAffectedPackages).toHaveBeenCalledWith("/workspace", "HEAD~1");
	});

	it("should drop an excluded package from the affected set", async () => {
		expect.assertions(1);

		const { getAffectedPackages } = await import("../workspace/affected");
		const { excludePackages } = await import("../workspace/package-resolver");
		const affected = [{ name: "@org/pkg-a", packageDirectory: "/workspace/packages/a" }];
		vi.mocked(getAffectedPackages).mockReturnValue(affected);
		vi.mocked(excludePackages).mockReturnValue([]);

		const result = resolveWorkspacePackages(
			makeCli({ affectedSince: "HEAD~1" }),
			"/workspace",
			{
				exclude: ["packages/**"],
			},
		);

		expect(result).toBeEmpty();
	});

	it("should enumerate every package when neither flag narrows the run", async () => {
		expect.assertions(2);

		const { enumerateWorkspacePackages } = await import("../workspace/package-resolver");
		const all = [
			{ name: "a", packageDirectory: "/workspace/packages/a" },
			{ name: "b", packageDirectory: "/workspace/packages/b" },
		];
		vi.mocked(enumerateWorkspacePackages).mockReturnValue(all);

		const result = resolveWorkspacePackages(makeCli({ workspace: true }), "/workspace", {
			exclude: ["fixtures/**"],
			patterns: ["packages/*"],
		});

		expect(result).toStrictEqual(all);
		expect(enumerateWorkspacePackages).toHaveBeenCalledWith("/workspace", {
			exclude: ["fixtures/**"],
			patterns: ["packages/*"],
		});
	});

	it("should enumerate once for every comma-separated --packages name", async () => {
		expect.assertions(2);

		const { listPackages } = await import("../workspace/package-resolver");
		vi.mocked(listPackages).mockReturnValue([
			{ name: "a", packageDirectory: "/workspace/packages/a" },
			{ name: "b", packageDirectory: "/workspace/packages/b" },
			{ name: "c", packageDirectory: "/workspace/packages/c" },
		]);

		const result = resolveWorkspacePackages(makeCli({ packages: "a,b,c" }), "/workspace", {
			patterns: ["packages/*"],
		});

		expect(result.map((info) => info.name)).toStrictEqual(["a", "b", "c"]);
		// One walk of the workspace root for the flag, not one per name.
		expect(listPackages).toHaveBeenCalledExactlyOnceWith("/workspace", ["packages/*"]);
	});

	it("should trim whitespace and drop empty entries before resolving", async () => {
		expect.assertions(1);

		const { listPackages } = await import("../workspace/package-resolver");
		vi.mocked(listPackages).mockReturnValue([
			{ name: "a", packageDirectory: "/workspace/packages/a" },
			{ name: "b", packageDirectory: "/workspace/packages/b" },
		]);

		const result = resolveWorkspacePackages(makeCli({ packages: " a , , b " }), "/workspace");

		expect(result.map((info) => info.name)).toStrictEqual(["a", "b"]);
	});

	it("should name the available packages when --packages misses", async () => {
		expect.assertions(1);

		const { listPackages } = await import("../workspace/package-resolver");
		vi.mocked(listPackages).mockReturnValue([
			{ name: "a", packageDirectory: "/workspace/packages/a" },
		]);

		expect(() => {
			return resolveWorkspacePackages(makeCli({ packages: "z" }), "/workspace");
		}).toThrowWithMessage(Error, 'Package "z" not found in workspace. Available: a');
	});

	it("should keep a named package an exclude glob would have dropped", async () => {
		expect.assertions(2);

		const { excludePackages, listPackages } = await import("../workspace/package-resolver");
		vi.mocked(listPackages).mockReturnValue([
			{ name: "a", packageDirectory: "/workspace/fixtures/a" },
		]);

		const result = resolveWorkspacePackages(makeCli({ packages: "a" }), "/workspace", {
			exclude: ["fixtures/**"],
		});

		expect(result.map((info) => info.name)).toStrictEqual(["a"]);
		expect(excludePackages).not.toHaveBeenCalled();
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
