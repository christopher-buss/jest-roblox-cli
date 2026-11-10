import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { projectJob } from "#test/mocks/project-job.ts";
import { createResolvedConfig } from "#test/mocks/resolved-config.ts";
import initSource from "../../plugin/src/init.server.luau";
import runModeSource from "../../plugin/src/test-in-run-mode.server.luau";
import type { ResolvedConfig } from "../config/resolved-config.ts";
import { RUN_SIDE_CHANNEL_ATTRIBUTE } from "../protocol/studio.ts";
import type { ProjectJob } from "./interface.ts";
import type { RunPayloadRequest } from "./plugin-payload.ts";
import { buildStudioArgs, studioOutputFile } from "./studio-cli-bootstrap.ts";

const PLUGIN_SOURCES: Record<string, string> = {
	"init.server.luau": initSource,
	"test-in-run-mode.server.luau": runModeSource,
};

const WORK_DIRECTORY = path.resolve("/repo/.jest-roblox/studio-cli");

function job(displayName: string, overrides: Partial<ResolvedConfig> = {}): ProjectJob {
	return projectJob({
		config: {
			...createResolvedConfig(),
			backend: "studio-cli",
			rootDir: "/repo",
			...overrides,
		},
		displayName,
		testFiles: [`${displayName}/test.spec.ts`],
	});
}

function writeBootstrap({
	jobs = [job("alpha")],
	vmParallel,
}: {
	jobs?: RunPayloadRequest["jobs"];
	vmParallel?: RunPayloadRequest["vmParallel"];
} = {}) {
	const { fileSystem } = createMemoryFileSystem();
	fileSystem.mkdirSync(WORK_DIRECTORY, { recursive: true });
	const args = buildStudioArgs({
		bail: false,
		fileSystem,
		jobs,
		placeFile: path.join(WORK_DIRECTORY, "place.rbxl"),
		pluginKey: undefined,
		port: 4321,
		requestId: "request-1",
		runBudgetMs: 300_000,
		vmParallel,
		workDirectory: WORK_DIRECTORY,
		workspace: false,
	});
	const bootstrap = fileSystem.readFileSync(args[args.indexOf("--runScriptFile") + 1]!, "utf8");
	return { args, bootstrap };
}

describe(buildStudioArgs, () => {
	it("should point Studio at the place, the bootstrap and the output log", () => {
		expect.assertions(2);

		const { args } = writeBootstrap();

		expect(args[args.indexOf("--outputFile") + 1]).toContain("output.log");
		expect(args).toContain("--quitAfterExecution");
	});

	it("should leave the stubs to the place it opens", () => {
		expect.assertions(1);

		const { bootstrap } = writeBootstrap({
			jobs: [{ ...job("alpha"), runtimeInjectionPaths: ["ReplicatedStorage/alpha"] }],
		});

		expect(bootstrap).toContain('"runtimeStubMounts":[]');
	});

	it("should carry the requested VM count in the bootstrap payload", () => {
		expect.assertions(1);

		const { bootstrap } = writeBootstrap({ jobs: [job("alpha"), job("beta")], vmParallel: 2 });

		expect(bootstrap).toContain('"vmParallel":2');
	});

	it("should omit the VM count from the bootstrap payload when not vm-parallel", () => {
		expect.assertions(1);

		const { bootstrap } = writeBootstrap();

		expect(bootstrap).not.toContain("vmParallel");
	});

	it("should go on to ExecuteRunModeAsync when the side channel cannot be set", () => {
		expect.assertions(2);

		const { bootstrap } = writeBootstrap();
		const guard = bootstrap.indexOf(
			[
				"if not sideChannelSet then",
				'\tprint("studio-cli: failed to set the run side channel: " .. tostring(sideChannelError))',
				"end",
			].join("\n"),
		);

		expect(guard).toBeGreaterThan(-1);
		expect(guard).toBeLessThan(bootstrap.indexOf("ExecuteRunModeAsync"));
	});

	it("should escape a config value containing the Luau long-string terminator", () => {
		expect.assertions(2);

		const { bootstrap } = writeBootstrap({
			jobs: [job("alpha", { testNamePattern: "x]=]y" })],
		});

		expect(bootstrap).toContain("JSONDecode([==[");
		expect(bootstrap).toContain("x]=]y");
	});
});

describe(studioOutputFile, () => {
	it("should log inside the work directory", () => {
		expect.assertions(1);

		expect(studioOutputFile(WORK_DIRECTORY)).toBe(path.join(WORK_DIRECTORY, "output.log"));
	});
});

describe("protocol version parity", () => {
	it.for(["init.server.luau", "test-in-run-mode.server.luau"])(
		"should read the protocol version from the generated module in %s",
		(file) => {
			expect.assertions(1);

			expect(PLUGIN_SOURCES[file]).toContain("Protocol.studio.protocolVersion");
		},
	);

	it("should read the pluginKey field the studio-cli payload sends", () => {
		expect.assertions(1);

		expect(runModeSource).toContain("testArgs.pluginKey");
	});

	it("should hand the studio-cli bootstrap payload over the attribute the runner reads", () => {
		expect.assertions(1);

		const { bootstrap } = writeBootstrap();

		expect(bootstrap).toContain(
			`ReplicatedStorage:SetAttribute("${RUN_SIDE_CHANNEL_ATTRIBUTE}",`,
		);
	});
});
