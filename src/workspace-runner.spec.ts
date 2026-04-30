import { fromAny } from "@total-typescript/shoehorn";

import { vol } from "memfs";
import * as path from "node:path";
import process from "node:process";
import { describe, expect, it, vi } from "vitest";

import type { Backend, BackendOptions, BackendResult } from "./backends/interface.ts";
import { DEFAULT_CONFIG, type ResolvedConfig } from "./config/schema.ts";
import { runWorkspace } from "./workspace-runner.ts";

vi.mock(import("node:fs"), async () => {
	const memfs = await vi.importActual<typeof import("memfs")>("memfs");
	return fromAny({ ...memfs.fs, default: memfs.fs });
});

vi.mock(import("./utils/rojo-builder.ts"));

const ROOT = path.resolve("/repo");
const FOO_DIR = path.join(ROOT, "packages/foo");
const PACKAGE_INFO = { name: "@halcyon/foo", packageDirectory: FOO_DIR };

function packageJson(json: object): string {
	return String(JSON.stringify(json));
}

function passingResult(): string {
	return JSON.stringify({
		numFailedTests: 0,
		numPassedTests: 1,
		numPendingTests: 0,
		numTotalTests: 1,
		startTime: 0,
		success: true,
		testResults: [],
	});
}

function failingResult(): string {
	return JSON.stringify({
		numFailedTests: 1,
		numPassedTests: 0,
		numPendingTests: 0,
		numTotalTests: 1,
		startTime: 0,
		success: false,
		testResults: [],
	});
}

function createStubBackend(envelope: string): Backend {
	return {
		kind: "open-cloud",
		runTests: async (_options: BackendOptions): Promise<BackendResult> => {
			const parsed = JSON.parse(envelope) as {
				entries: Array<{ jestOutput: string; pkg?: string }>;
			};
			return {
				results: parsed.entries.map((entry) => {
					return {
						displayName: entry.pkg ?? "",
						elapsedMs: 0,
						result: JSON.parse(entry.jestOutput) as never,
					};
				}),
				timing: { executionMs: 0, uploadMs: 0 },
			};
		},
	};
}

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
	return { ...DEFAULT_CONFIG, rootDir: FOO_DIR, ...overrides };
}

function seedWorkspaceWithProject(): void {
	vol.fromJSON({
		[path.join(FOO_DIR, "jest.config.ts")]: "export default {}",
		[path.join(FOO_DIR, "package.json")]: packageJson({ name: "@halcyon/foo" }),
		[path.join(FOO_DIR, "test.project.json")]: packageJson({
			name: "foo-test",
			tree: { $className: "DataModel" },
		}),
		[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n  - packages/*\n",
	});
}

describe(runWorkspace, () => {
	it("should return ExecuteResult with exit code 0 on success", async () => {
		expect.assertions(2);

		vol.reset();
		seedWorkspaceWithProject();

		const envelope = JSON.stringify({
			entries: [{ jestOutput: passingResult(), pkg: "@halcyon/foo" }],
		});

		const result = await runWorkspace({
			backend: createStubBackend(envelope),
			config: makeConfig(),
			packageInfo: PACKAGE_INFO,
			version: "0.0.0-test",
			workspaceRoot: ROOT,
		});

		expect(result?.exitCode).toBe(0);
		expect(result?.result.success).toBeTrue();
	});

	it("should return ExecuteResult with exit code 1 on failure", async () => {
		expect.assertions(1);

		vol.reset();
		seedWorkspaceWithProject();

		const envelope = JSON.stringify({
			entries: [{ jestOutput: failingResult(), pkg: "@halcyon/foo" }],
		});

		const result = await runWorkspace({
			backend: createStubBackend(envelope),
			config: makeConfig(),
			packageInfo: PACKAGE_INFO,
			version: "0.0.0-test",
			workspaceRoot: ROOT,
		});

		expect(result?.exitCode).toBe(1);
	});

	it("should return undefined and write to stderr when pre-flight fails", async () => {
		expect.assertions(2);

		vol.reset();
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

		vol.fromJSON({
			[path.join(FOO_DIR, "jest.config.ts")]: "export default {}",
			[path.join(FOO_DIR, "package.json")]: packageJson({ name: "@halcyon/foo" }),
			[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n  - packages/*\n",
			// no test.project.json — preflight fails
		});

		const result = await runWorkspace({
			backend: createStubBackend(""),
			config: makeConfig(),
			packageInfo: PACKAGE_INFO,
			version: "0.0.0-test",
			workspaceRoot: ROOT,
		});

		expect(result).toBeUndefined();
		expect(stderr).toHaveBeenCalledWith(expect.stringMatching(/Pre-flight validation failed/));
	});
});
