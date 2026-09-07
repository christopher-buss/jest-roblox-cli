import { fromAny } from "@total-typescript/shoehorn";

import * as path from "node:path";
import process from "node:process";
import { assert, describe, expect, it, onTestFinished, vi } from "vitest";

import { createMemoryFileSystem } from "../../test/mocks/memory-file-system.ts";
import type { CliOptions, WorkspaceRunOptions } from "../config/schema.ts";
import { DEFAULT_CONFIG } from "../config/schema.ts";
import type { ChildProcessRunner } from "../utils/child-process.ts";
import {
	assertWorkspaceRunOptions,
	buildWorkspaceCredentials,
	resolveWorkspacePackages,
	validateBasicWorkspaceFlags,
} from "./workspace-validation.ts";

const ROOT = path.resolve("/workspace");

function makeCli(overrides: Partial<CliOptions> = {}): CliOptions {
	return { ...overrides };
}

function createRunner(): ChildProcessRunner {
	return fromAny({ execFileSync: vi.fn<ChildProcessRunner["execFileSync"]>() });
}

function packageDirectoryFor(name: string): string {
	return `packages/${name.replace(/^@[^/]+\//, "")}`;
}

function packageInfoFor(name: string, relativePath: string = packageDirectoryFor(name)) {
	return { name, packageDirectory: path.join(ROOT, relativePath) };
}

function seedWorkspace(names: Array<string>): Record<string, string> {
	const entries: Record<string, string> = {
		[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n  - packages/*\n",
	};
	for (const name of names) {
		const directory = packageDirectoryFor(name);
		entries[path.join(ROOT, directory, "package.json")] = `{"name":${JSON.stringify(name)}}`;
		entries[path.join(ROOT, directory, "jest.config.ts")] = "export default {};";
	}

	return entries;
}

function seedTurboWorkspace(names: Array<string>): Record<string, string> {
	return { [path.join(ROOT, "turbo.json")]: "{}", ...seedWorkspace(names) };
}

function stubLinux(): void {
	const original = process.platform;
	Object.defineProperty(process, "platform", { value: "linux" });
	onTestFinished(() => {
		Object.defineProperty(process, "platform", { value: original });
	});
}

function turboReturns(childProcess: ChildProcessRunner, names: Array<string>): void {
	vi.mocked(childProcess.execFileSync).mockReturnValue(
		JSON.stringify({
			packages: {
				items: names.map((name) => ({ name, path: packageDirectoryFor(name) })),
			},
		}),
	);
}

function makeRunOptions(overrides: Partial<WorkspaceRunOptions> = {}): WorkspaceRunOptions {
	return {
		backend: DEFAULT_CONFIG.backend,
		bail: false,
		binaryInput: DEFAULT_CONFIG.binaryInput,
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
	it("should return the affected set directly when --affected-since is set", () => {
		expect.assertions(2);

		stubLinux();
		const childProcess = createRunner();
		const { fileSystem } = createMemoryFileSystem(seedTurboWorkspace(["@org/a", "@org/b"]));
		turboReturns(childProcess, ["@org/a", "@org/b"]);

		const result = resolveWorkspacePackages(makeCli({ affectedSince: "HEAD~1" }), ROOT, {
			childProcess,
			fileSystem,
		});

		// The affected branch carries name + directory from turbo/nx, so it
		// must NOT round-trip through enumeration.
		expect(result).toStrictEqual([packageInfoFor("@org/a"), packageInfoFor("@org/b")]);
		expect(vi.mocked(childProcess.execFileSync)).toHaveBeenCalledExactlyOnceWith(
			"turbo",
			["ls", "--filter=...[HEAD~1]", "--output=json"],
			expect.objectContaining({ cwd: ROOT }),
		);
	});

	it("should drop an excluded package from the affected set", () => {
		expect.assertions(1);

		stubLinux();
		const childProcess = createRunner();
		const { fileSystem } = createMemoryFileSystem(seedTurboWorkspace(["@org/a"]));
		turboReturns(childProcess, ["@org/a"]);

		const result = resolveWorkspacePackages(makeCli({ affectedSince: "HEAD~1" }), ROOT, {
			childProcess,
			exclude: ["packages/**"],
			fileSystem,
		});

		expect(result).toBeEmpty();
	});

	it("should enumerate every package when neither flag narrows the run", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem(seedWorkspace(["a", "b"]));

		const result = resolveWorkspacePackages(makeCli({ workspace: true }), ROOT, {
			childProcess: createRunner(),
			fileSystem,
			patterns: ["packages/*"],
		});

		expect(result).toStrictEqual([packageInfoFor("a"), packageInfoFor("b")]);
	});

	it("should drop an excluded package from a bare --workspace run", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem(seedWorkspace(["a", "b"]));

		const result = resolveWorkspacePackages(makeCli({ workspace: true }), ROOT, {
			childProcess: createRunner(),
			exclude: ["packages/b"],
			fileSystem,
			patterns: ["packages/*"],
		});

		expect(result).toStrictEqual([packageInfoFor("a")]);
	});

	it("should resolve every comma-separated --packages name", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem(seedWorkspace(["a", "b", "c"]));

		const result = resolveWorkspacePackages(makeCli({ packages: "a,b,c" }), ROOT, {
			childProcess: createRunner(),
			fileSystem,
			patterns: ["packages/*"],
		});

		expect(result.map((info) => info.name)).toStrictEqual(["a", "b", "c"]);
	});

	it("should trim whitespace and drop empty entries before resolving", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem(seedWorkspace(["a", "b"]));

		const result = resolveWorkspacePackages(makeCli({ packages: " a , , b " }), ROOT, {
			childProcess: createRunner(),
			fileSystem,
			patterns: ["packages/*"],
		});

		expect(result.map((info) => info.name)).toStrictEqual(["a", "b"]);
	});

	it("should keep a named package an exclude glob would have dropped", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem(seedWorkspace(["a"]));

		const result = resolveWorkspacePackages(makeCli({ packages: "a" }), ROOT, {
			childProcess: createRunner(),
			exclude: ["packages/**"],
			fileSystem,
			patterns: ["packages/*"],
		});

		expect(result.map((info) => info.name)).toStrictEqual(["a"]);
	});
});

describe(buildWorkspaceCredentials, () => {
	it("should prefer CLI overrides over run-option defaults", () => {
		expect.assertions(1);

		const result = buildWorkspaceCredentials(
			makeCli({ apiKey: "k", placeId: "pp", universeId: "uu" }),
			makeRunOptions({ placeId: "configP", universeId: "configU" }),
		);

		expect(result).toStrictEqual({ apiKey: "k", placeId: "pp", universeId: "uu" });
	});

	it("should fall back to the run options for a place the CLI did not name", () => {
		expect.assertions(1);

		vi.stubEnv("JEST_ROBLOX_OPEN_CLOUD_API_KEY", "env-key");
		for (const suffix of ["PLACE_ID", "UNIVERSE_ID"]) {
			vi.stubEnv(`JEST_ROBLOX_${suffix}`, "");
			vi.stubEnv(`ROBLOX_${suffix}`, "");
		}

		const result = buildWorkspaceCredentials(
			makeCli(),
			makeRunOptions({ placeId: "configP", universeId: "configU" }),
		);

		expect(result).toStrictEqual({
			apiKey: "env-key",
			placeId: "configP",
			universeId: "configU",
		});
	});
});
