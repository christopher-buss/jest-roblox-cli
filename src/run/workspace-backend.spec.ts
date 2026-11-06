import { fromAny, fromPartial } from "@total-typescript/shoehorn";

import { describe, expect, it, vi } from "vitest";

import { createLuteChildProcess } from "#test/mocks/lute-child-process.ts";
import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import type { createOpenCloudBackend } from "../backends/open-cloud.ts";
import type { createStudioCliBackend } from "../backends/studio-cli.ts";
import type { createStudioBackend } from "../backends/studio.ts";
import type { loadRawConfig } from "../config/loader.ts";
import type { WorkspaceRunOptions } from "../config/schema.ts";
import type { WorkspaceBackendFactories } from "./workspace-backend.ts";
import { resolveWorkspaceBackend, resolveWorkspaceOptionsAsync } from "./workspace-backend.ts";

function makeFactories() {
	return {
		openCloudBackend: vi.fn<typeof createOpenCloudBackend>(() => {
			return fromAny({ kind: "open-cloud" });
		}),
		studioBackend: vi.fn<typeof createStudioBackend>(() => fromAny({ kind: "studio" })),
		studioCliBackend: vi.fn<typeof createStudioCliBackend>(() => {
			return fromAny({ kind: "studio-cli" });
		}),
	} satisfies WorkspaceBackendFactories;
}

function runOptionsWith(backend: WorkspaceRunOptions["backend"]): WorkspaceRunOptions {
	return fromPartial({ backend, port: 3000 });
}

describe(resolveWorkspaceBackend, () => {
	it("should resolve no backend for a typecheck-only run", () => {
		expect.assertions(1);

		const resolution = resolveWorkspaceBackend({
			cli: { typecheckOnly: true },
			dependencies: makeFactories(),
			runOptions: runOptionsWith("open-cloud"),
		});

		expect(resolution).toStrictEqual({});
	});

	it("should read headed from the cli for studio-cli", () => {
		expect.assertions(1);

		const dependencies = makeFactories();
		resolveWorkspaceBackend({
			cli: { headed: true },
			dependencies,
			runOptions: runOptionsWith("studio-cli"),
		});

		expect(dependencies.studioCliBackend).toHaveBeenCalledWith(
			expect.objectContaining({ headed: true }),
		);
	});

	it("should pass the port to the attached studio backend", () => {
		expect.assertions(1);

		const dependencies = makeFactories();
		resolveWorkspaceBackend({
			cli: {},
			dependencies,
			runOptions: runOptionsWith("studio"),
		});

		expect(dependencies.studioBackend).toHaveBeenCalledWith({ port: 3000 });
	});

	it("should return work-stealing credentials for open-cloud", () => {
		expect.assertions(1);

		const resolution = resolveWorkspaceBackend({
			cli: { apiKey: "key", placeId: "1", universeId: "2" },
			dependencies: makeFactories(),
			runOptions: runOptionsWith("open-cloud"),
		});

		expect(resolution.workStealingCredentials).toMatchObject({
			apiKey: "key",
			universeId: "2",
		});
	});

	it("should report a factory failure as a validation error", () => {
		expect.assertions(1);

		const dependencies = makeFactories();
		dependencies.openCloudBackend.mockImplementation(() => {
			throw new Error("bad secret");
		});

		const resolution = resolveWorkspaceBackend({
			cli: { apiKey: "key", placeId: "1", universeId: "2" },
			dependencies,
			runOptions: runOptionsWith("open-cloud"),
		});

		expect(resolution.error).toStrictEqual({ exitCode: 2, message: "Error: bad secret\n" });
	});
});

describe(resolveWorkspaceOptionsAsync, () => {
	it("should report a config load failure as a validation error", async () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();
		const resolution = await resolveWorkspaceOptionsAsync({
			childProcess: createLuteChildProcess({ version: "1.0.1" }),
			cli: {},
			fileSystem,
			isStudioInstalled: () => false,
			loadPackageConfig: vi.fn<typeof loadRawConfig>(async () => {
				throw new Error("boom");
			}),
			packageInfos: [{ name: "a", packageDirectory: "/repo/a" }],
			workspaceRoot: "/repo",
		});

		expect(resolution.error).toStrictEqual({ exitCode: 2, message: "Error: boom\n" });
	});

	it("should leave the backend unresolved for a typecheck-only run", async () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();
		const resolution = await resolveWorkspaceOptionsAsync({
			childProcess: createLuteChildProcess({ version: "1.0.1" }),
			cli: { typecheckOnly: true },
			fileSystem,
			isStudioInstalled: () => false,
			loadPackageConfig: vi.fn<typeof loadRawConfig>(async () => ({})),
			packageInfos: [{ name: "a", packageDirectory: "/repo/a" }],
			workspaceRoot: "/repo",
		});

		expect(resolution.runOptions!.backend).toBe("auto");
	});
});
