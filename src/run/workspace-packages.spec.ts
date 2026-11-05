import { fromAny } from "@total-typescript/shoehorn";

import * as path from "node:path";
import process from "node:process";
import { describe, expect, it, vi } from "vitest";

import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import type { ChildProcessRunner } from "../utils/child-process.ts";
import { resolvePackages } from "./workspace-packages.ts";

const ROOT = path.resolve("/repo");

function makeDependencies(seed: Record<string, string> = {}) {
	const { fileSystem } = createMemoryFileSystem(seed, ROOT);
	const childProcess: ChildProcessRunner = fromAny({
		execFileSync: vi.fn<ChildProcessRunner["execFileSync"]>(),
	});
	return { childProcess, fileSystem };
}

describe(resolvePackages, () => {
	it("should enumerate packages under a declared workspace.packages glob", () => {
		expect.assertions(1);

		const resolved = resolvePackages({
			cli: {},
			dependencies: makeDependencies({
				[path.join(ROOT, "pkgs/a/jest.config.ts")]: "export default {};",
				[path.join(ROOT, "pkgs/a/package.json")]: '{"name":"a"}',
			}),
			workspace: { packages: ["pkgs/*"], root: ROOT },
		});

		expect(resolved.packageInfos!.map((info) => info.name)).toStrictEqual(["a"]);
	});

	it("should name the declared glob when it selects nothing", () => {
		expect.assertions(1);

		const resolved = resolvePackages({
			cli: {},
			dependencies: makeDependencies(),
			workspace: { packages: ["pkgs/*"], root: ROOT },
		});

		expect(resolved.error!.message).toContain("Widen `workspace.packages`");
	});

	it("should name pnpm-workspace.yaml when discovery selects nothing", () => {
		expect.assertions(1);

		vi.spyOn(process, "cwd").mockReturnValue(ROOT);
		const resolved = resolvePackages({
			cli: {},
			dependencies: makeDependencies({
				[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n  - packages/*\n",
			}),
			workspace: undefined,
		});

		expect(resolved.error!.message).toContain("Widen pnpm-workspace.yaml");
	});

	it("should report a discovery failure as a validation error", () => {
		expect.assertions(1);

		vi.spyOn(process, "cwd").mockReturnValue(ROOT);
		const resolved = resolvePackages({
			cli: {},
			dependencies: makeDependencies(),
			workspace: undefined,
		});

		expect(resolved.error!.exitCode).toBe(2);
	});
});
