import { fromAny } from "@total-typescript/shoehorn";

import * as path from "node:path";
import process from "node:process";
import { describe, expect, it, vi } from "vitest";

import { fakeTimingCollector, phaseNamesOf } from "../../test/mocks/fake-timing-collector.ts";
import { createMemoryFileSystem } from "../../test/mocks/memory-file-system.ts";
import type { ResolvedProjectConfig } from "../config/projects.ts";
import {
	cleanLeftoverStubs,
	generateProjectStubs,
	hasUserAuthoredConfig,
} from "../config/stubs.ts";
import type { WorkspacePackageCoverage } from "../coverage-pipeline/workspace-prepare.ts";
import type { PackageDescriptor } from "../staging/synthesizer.ts";
import { toPosixRoot } from "../utils/normalize-windows-path.ts";
import type { PackageContext } from "./project-contexts.ts";
import { stageWorkspaceStubs } from "./stub-staging.ts";
import type { PendingEntry } from "./test-selection.ts";

vi.mock(import("../config/stubs"));

const mocks = {
	cleanLeftoverStubs: vi.mocked(cleanLeftoverStubs),
	generateProjectStubs: vi.mocked(generateProjectStubs),
	hasUserAuthoredConfig: vi.mocked(hasUserAuthoredConfig),
};

function makeProject(displayName: string, mounts = ["src/Server"]): ResolvedProjectConfig {
	return fromAny({
		displayName,
		rojoMounts: mounts.map((fsPath) => {
			return { dataModelPath: `ServerScriptService/${displayName}`, fsPath };
		}),
	});
}

function makeContext(name: string, projects: Array<ResolvedProjectConfig>): PackageContext {
	const packageDirectory = path.resolve("/workspace", name);
	return fromAny({
		cacheRoot: path.resolve("/cache", name),
		descriptor: {
			name,
			packageDirectory,
			rojoProjectPath: path.resolve(packageDirectory, "default.project.json"),
		} satisfies PackageDescriptor,
		info: { name, packageDirectory },
		projects,
	});
}

function makePending(packageName: string, project: ResolvedProjectConfig): PendingEntry {
	return fromAny({ pkg: packageName, project });
}

function setupMocks(): void {
	vi.clearAllMocks();
	mocks.cleanLeftoverStubs.mockReturnValue([]);
	mocks.hasUserAuthoredConfig.mockReturnValue(false);
}

describe(stageWorkspaceStubs, () => {
	it("should stage only live projects and attach coverage roots to their package", () => {
		expect.assertions(5);

		setupMocks();

		const client = makeProject("client");
		const dormant = makeProject("dormant");
		const server = makeProject("server");
		const foo = makeContext("@halcyon/foo", [client, dormant]);
		const bar = makeContext("@halcyon/bar", [server]);
		const coverageRoots = [{ luauRoot: toPosixRoot("src"), shadowDir: "/shadow/foo" }];
		const coverageSpine = [{ luauRoot: toPosixRoot("."), shadowDir: "/shadow/.spine" }];
		const coverageByPackage = new Map<string, WorkspacePackageCoverage>([
			["@halcyon/foo", fromAny({ coverageRoots, coverageSpine })],
		]);
		const timing = fakeTimingCollector(12);

		const { fileSystem } = createMemoryFileSystem();

		const { elapsedMs, value: descriptors } = stageWorkspaceStubs({
			contexts: [foo, bar],
			coverageByPackage,
			fileSystem,
			pending: [makePending("@halcyon/foo", client), makePending("@halcyon/bar", server)],
			timing,
		});

		expect(mocks.generateProjectStubs.mock.calls).toStrictEqual([
			[[client], foo.info.packageDirectory, foo.cacheRoot, fileSystem],
			[[server], bar.info.packageDirectory, bar.cacheRoot, fileSystem],
		]);
		expect(mocks.cleanLeftoverStubs.mock.calls).toStrictEqual([
			[[client], foo.info.packageDirectory, fileSystem],
			[[server], bar.info.packageDirectory, fileSystem],
		]);
		expect(descriptors).toStrictEqual([
			{
				...foo.descriptor,
				coverageRoots,
				coverageSpine,
				stubMounts: [
					{
						absStubPath: path.resolve(foo.cacheRoot, "src/Server/jest.config.luau"),
						dataModelPath: "ServerScriptService/client",
					},
				],
			},
			{
				...bar.descriptor,
				stubMounts: [
					{
						absStubPath: path.resolve(bar.cacheRoot, "src/Server/jest.config.luau"),
						dataModelPath: "ServerScriptService/server",
					},
				],
			},
		]);
		// Both phases carry the names multi opens for the same work, and the
		// caller is handed what the two cost together.
		expect(phaseNamesOf(timing.profileTimed)).toStrictEqual([
			"cleanLeftoverStubs",
			"buildStubs",
		]);
		expect(elapsedMs).toBe(24);
	});

	it("should omit only mounts that contain a user-authored config", () => {
		expect.assertions(2);

		setupMocks();

		const project = makeProject("server", ["src/Server", "src/Shared"]);
		const context = makeContext("@halcyon/foo", [project]);
		mocks.hasUserAuthoredConfig.mockImplementation((mount) => mount.endsWith("Shared"));

		const { fileSystem } = createMemoryFileSystem();

		const { value: descriptors } = stageWorkspaceStubs({
			contexts: [context],
			coverageByPackage: new Map(),
			fileSystem,
			pending: [makePending("@halcyon/foo", project)],
			timing: fakeTimingCollector(12),
		});

		expect(mocks.hasUserAuthoredConfig.mock.calls).toStrictEqual([
			[path.resolve(context.info.packageDirectory, "src/Server"), fileSystem],
			[path.resolve(context.info.packageDirectory, "src/Shared"), fileSystem],
		]);
		expect(descriptors[0]!.stubMounts).toStrictEqual([
			{
				absStubPath: path.resolve(context.cacheRoot, "src/Server/jest.config.luau"),
				dataModelPath: "ServerScriptService/server",
			},
		]);
	});

	it("should report every cleaned source stub with package identity", () => {
		expect.assertions(1);

		setupMocks();

		const project = makeProject("server");
		const context = makeContext("@halcyon/foo", [project]);
		mocks.cleanLeftoverStubs.mockReturnValue(["/workspace/foo/a", "/workspace/foo/b"]);
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

		stageWorkspaceStubs({
			contexts: [context],
			coverageByPackage: new Map(),
			pending: [makePending("@halcyon/foo", project)],
			timing: fakeTimingCollector(12),
		});

		expect(stderr).toHaveBeenCalledExactlyOnceWith(
			"jest-roblox: cleaned 2 leftover stub(s) from @halcyon/foo:\n" +
				"  /workspace/foo/a\n" +
				"  /workspace/foo/b\n",
		);
	});

	it("should stay silent when cleanup finds no source stubs", () => {
		expect.assertions(1);

		setupMocks();

		const project = makeProject("server");
		const context = makeContext("@halcyon/foo", [project]);
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

		stageWorkspaceStubs({
			contexts: [context],
			coverageByPackage: new Map(),
			pending: [makePending("@halcyon/foo", project)],
			timing: fakeTimingCollector(12),
		});

		expect(stderr).not.toHaveBeenCalled();
	});
});
