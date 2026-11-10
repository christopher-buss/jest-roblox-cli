import { fromAny } from "@total-typescript/shoehorn";

import * as path from "node:path";
import process from "node:process";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import type { CliOptions } from "../config/resolved-config.ts";
import type { ChildProcessRunner } from "../utils/child-process.ts";
import {
	refuseWorkspaceOnlyFlags,
	resolveWorkspacePackages,
	validateBasicWorkspaceFlags,
} from "./validation.ts";

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

describe(refuseWorkspaceOnlyFlags, () => {
	it("should allow workspace-only flags with --workspace", () => {
		expect.assertions(1);

		expect(
			refuseWorkspaceOnlyFlags(makeCli({ bail: true, packages: "a", workspace: true })),
		).toBeUndefined();
	});

	it("should allow a run with no workspace-only flag", () => {
		expect.assertions(1);

		expect(refuseWorkspaceOnlyFlags(makeCli({ bail: false }))).toBeUndefined();
	});

	it.for([
		[{ packages: "a" }, "--packages"],
		[{ affectedSince: "main" }, "--affected-since"],
		[{ bail: true }, "--bail"],
	] as const)("should refuse %o without --workspace", ([flags, name]) => {
		expect.assertions(1);

		expect(refuseWorkspaceOnlyFlags(makeCli(flags))).toBe(
			`Error: ${name} requires --workspace.\n`,
		);
	});
});

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

	it("should accept --experimental-vm-parallel in workspace mode", () => {
		expect.assertions(1);

		const result = validateBasicWorkspaceFlags(
			makeCli({ experimentalVmParallel: 2, packages: "a", workspace: true }),
		);

		expect(result).toStrictEqual({ ok: true });
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

describe(resolveWorkspacePackages, () => {
	it("should return the affected set directly when --affected-since is set", () => {
		expect.assertions(2);

		stubLinux();
		const childProcess = createRunner();
		const { fileSystem } = createMemoryFileSystem(seedTurboWorkspace(["@org/a", "@org/b"]));
		turboReturns(childProcess, ["@org/a", "@org/b"]);

		const result = resolveWorkspacePackages({
			childProcess,
			cli: makeCli({ affectedSince: "HEAD~1" }),
			fileSystem,
			workspaceRoot: ROOT,
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

		const result = resolveWorkspacePackages({
			childProcess,
			cli: makeCli({ affectedSince: "HEAD~1" }),
			exclude: ["packages/**"],
			fileSystem,
			workspaceRoot: ROOT,
		});

		expect(result).toBeEmpty();
	});

	it("should enumerate every package when neither flag narrows the run", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem(seedWorkspace(["a", "b"]));

		const result = resolveWorkspacePackages({
			childProcess: createRunner(),
			cli: makeCli({ workspace: true }),
			fileSystem,
			patterns: ["packages/*"],
			workspaceRoot: ROOT,
		});

		expect(result).toStrictEqual([packageInfoFor("a"), packageInfoFor("b")]);
	});

	it("should drop an excluded package from a bare --workspace run", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem(seedWorkspace(["a", "b"]));

		const result = resolveWorkspacePackages({
			childProcess: createRunner(),
			cli: makeCli({ workspace: true }),
			exclude: ["packages/b"],
			fileSystem,
			patterns: ["packages/*"],
			workspaceRoot: ROOT,
		});

		expect(result).toStrictEqual([packageInfoFor("a")]);
	});

	it("should resolve every comma-separated --packages name", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem(seedWorkspace(["a", "b", "c"]));

		const result = resolveWorkspacePackages({
			childProcess: createRunner(),
			cli: makeCli({ packages: "a,b,c" }),
			fileSystem,
			patterns: ["packages/*"],
			workspaceRoot: ROOT,
		});

		expect(result.map((info) => info.name)).toStrictEqual(["a", "b", "c"]);
	});

	it("should trim whitespace and drop empty entries before resolving", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem(seedWorkspace(["a", "b"]));

		const result = resolveWorkspacePackages({
			childProcess: createRunner(),
			cli: makeCli({ packages: " a , , b " }),
			fileSystem,
			patterns: ["packages/*"],
			workspaceRoot: ROOT,
		});

		expect(result.map((info) => info.name)).toStrictEqual(["a", "b"]);
	});

	it("should keep a named package an exclude glob would have dropped", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem(seedWorkspace(["a"]));

		const result = resolveWorkspacePackages({
			childProcess: createRunner(),
			cli: makeCli({ packages: "a" }),
			exclude: ["packages/**"],
			fileSystem,
			patterns: ["packages/*"],
			workspaceRoot: ROOT,
		});

		expect(result.map((info) => info.name)).toStrictEqual(["a"]);
	});
});
