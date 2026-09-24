// cspell:ignore LOCALAPPDATA
import { fromAny } from "@total-typescript/shoehorn";

import { type } from "arktype";
import { describe, expect, it, vi } from "vitest";

import { createMemoryFileSystem } from "../../test/mocks/memory-file-system.ts";
import type { ChildProcessRunner } from "../utils/child-process.ts";
import type { FileSystem } from "../utils/file-system.ts";
import type { ManagedPluginOptions } from "./runner-plugin.ts";
import { installManagedPluginAsync, installRunnerPluginAsync } from "./runner-plugin.ts";

const projectSchema = type({ tree: "object" });

const PLUGINS = "/plugins";
const USAGE = "/state/managed-plugins";
const STAGING = "/repo/.jest-roblox/studio-cli/plugin";
const HOUR_MS = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 0, 10);

const SOURCES = [
	{
		path: "plugin/plugin.project.json",
		text: JSON.stringify({
			name: "JestRobloxRunner",
			tree: { $path: "src", shared: { $path: "../luau" } },
		}),
	},
	{ path: "plugin/src/test-in-run-mode.server.luau", text: "-- runner" },
	{ path: "luau/runner.luau", text: "return {}" },
];

type RojoExec = (
	file: string,
	args: Array<string>,
	options: object,
	callback: (error: Error | null, stdout: string, stderr: string) => void,
) => void;

function fakeRojo(fileSystem: FileSystem) {
	return vi.fn<ManagedPluginOptions["buildAsync"]>(async (_projectPath, outputPath) => {
		fileSystem.writeFileSync(outputPath, "rbxm-bytes");
	});
}

/** A `rojo build <project> -o <output>` that writes the output and succeeds. */
function rojoChildProcess(fileSystem: FileSystem) {
	const execFile = vi.fn<RojoExec>((_file, args, _options, callback) => {
		fileSystem.writeFileSync(args[3]!, "rbxm-bytes");
		callback(null, "", "");
	});
	return { childProcess: fromAny<ChildProcessRunner, unknown>({ execFile }), execFile };
}

function options(
	fileSystem: FileSystem,
	overrides: Partial<ManagedPluginOptions> = {},
): ManagedPluginOptions {
	return {
		buildAsync: fakeRojo(fileSystem),
		fileSystem,
		now: NOW,
		pluginsDirectory: PLUGINS,
		sources: SOURCES,
		stagingDirectory: STAGING,
		usageDirectory: USAGE,
		version: "1.2.3",
		...overrides,
	};
}

function managedFile(key: string): string {
	return `${PLUGINS}/JestRobloxRunner.cli-${key}.rbxm`;
}

function usageMark(key: string): string {
	return `${USAGE}/JestRobloxRunner.cli-${key}.rbxm`;
}

describe(installManagedPluginAsync, () => {
	it("should build and install the managed plugin when its key is missing", async () => {
		expect.assertions(2);

		const { fileSystem } = createMemoryFileSystem();

		const { key } = await installManagedPluginAsync(options(fileSystem));

		expect(key).toMatch(/^1\.2\.3-[\da-f]{8}$/);
		expect(fileSystem.readFileSync(managedFile(key), "utf8")).toBe("rbxm-bytes");
	});

	it("should build the plugin's tree around the run-mode runner, without the edit-mode client", async () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();
		let tree: unknown;
		const buildAsync = vi.fn<ManagedPluginOptions["buildAsync"]>(
			async (projectPath, output) => {
				({ tree } = projectSchema.assert(
					JSON.parse(fileSystem.readFileSync(projectPath, "utf8")),
				));
				fileSystem.writeFileSync(output, "rbxm-bytes");
			},
		);

		await installManagedPluginAsync(options(fileSystem, { buildAsync }));

		expect(tree).toStrictEqual({
			"$className": "Folder",
			"pluginKey": { $path: "src/pluginKey.luau" },
			"shared": { $path: "../luau" },
			"test-in-run-mode": { $path: "src/test-in-run-mode.server.luau" },
			"version": { $path: "src/version.luau" },
		});
	});

	it("should stamp the plugin with its key and the CLI version", async () => {
		expect.assertions(2);

		const { fileSystem } = createMemoryFileSystem();
		const modules: Array<string> = [];
		const buildAsync = vi.fn<ManagedPluginOptions["buildAsync"]>(async (_project, output) => {
			for (const module of ["pluginKey", "version"]) {
				modules.push(
					fileSystem.readFileSync(`${STAGING}/plugin/src/${module}.luau`, "utf8"),
				);
			}

			fileSystem.writeFileSync(output, "rbxm-bytes");
		});

		const { key } = await installManagedPluginAsync(options(fileSystem, { buildAsync }));

		expect(modules[0]).toBe(`--!strict\nreturn "${key}"\n`);
		expect(modules[1]).toBe('--!strict\nreturn "1.2.3"\n');
	});

	it("should give an edited source a key of its own", async () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();
		const edited = [...SOURCES.slice(0, 2), { path: "luau/runner.luau", text: "return 1" }];

		const first = await installManagedPluginAsync(options(fileSystem));
		const second = await installManagedPluginAsync(options(fileSystem, { sources: edited }));

		expect(second.key).not.toBe(first.key);
	});

	it("should build from a staging tree cleared of a previous build", async () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({ [`${STAGING}/luau/removed.luau`]: "" });
		let wasStaleKept = true;
		const buildAsync = vi.fn<ManagedPluginOptions["buildAsync"]>(async (_project, output) => {
			wasStaleKept = fileSystem.existsSync(`${STAGING}/luau/removed.luau`);
			fileSystem.writeFileSync(output, "rbxm-bytes");
		});

		await installManagedPluginAsync(options(fileSystem, { buildAsync }));

		expect(wasStaleKept).toBeFalse();
	});

	it("should keep a plugin another run published while this one was building", async () => {
		expect.assertions(1);

		const { key } = await installManagedPluginAsync(
			options(createMemoryFileSystem().fileSystem),
		);
		const { fileSystem } = createMemoryFileSystem();
		const buildAsync = vi.fn<ManagedPluginOptions["buildAsync"]>(async (_project, output) => {
			fileSystem.mkdirSync(PLUGINS, { recursive: true });
			fileSystem.writeFileSync(managedFile(key), "loaded-by-studio");
			fileSystem.writeFileSync(output, "rbxm-bytes");
		});

		await installManagedPluginAsync(options(fileSystem, { buildAsync }));

		expect(fileSystem.readFileSync(managedFile(key), "utf8")).toBe("loaded-by-studio");
	});

	it("should refuse sources that carry no plugin project", async () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();

		await expect(
			installManagedPluginAsync(options(fileSystem, { sources: SOURCES.slice(1) })),
		).rejects.toThrow("runner plugin sources carry no plugin/plugin.project.json");
	});

	it("should reuse the installed plugin and mark it used outside the plugins folder", async () => {
		expect.assertions(5);

		const { fileSystem } = createMemoryFileSystem();
		const { key } = await installManagedPluginAsync(options(fileSystem));
		const installedAt = new Date(NOW - HOUR_MS);
		fileSystem.utimesSync(managedFile(key), installedAt, installedAt);
		const buildAsync = fakeRojo(fileSystem);

		await installManagedPluginAsync(options(fileSystem, { buildAsync }));

		expect(buildAsync).not.toHaveBeenCalled();
		expect(fileSystem.readFileSync(managedFile(key), "utf8")).toBe("rbxm-bytes");
		expect(fileSystem.statSync(managedFile(key)).mtimeMs).toBe(installedAt.getTime());
		expect(fileSystem.statSync(usageMark(key)).mtimeMs).toBe(NOW);
		expect(fileSystem.readFileSync(usageMark(key), "utf8")).toBe("");
	});

	it("should delete other managed plugins idle for a day, and keep the rest", async () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();
		const idleFor = {
			[`${PLUGINS}/JestRobloxRunner-0.3.0.rbxm`]: 25 * HOUR_MS,
			[`${PLUGINS}/JestRobloxRunner.rbxm`]: 25 * HOUR_MS,
			[managedFile("0.9.0-aaaaaaaa")]: 25 * HOUR_MS,
			[managedFile("1.0.0-bbbbbbbb")]: HOUR_MS,
			[managedFile("1.0.0-cccccccc")]: 24 * HOUR_MS,
		};
		fileSystem.mkdirSync(PLUGINS, { recursive: true });
		for (const [file, idleMs] of Object.entries(idleFor)) {
			fileSystem.writeFileSync(file, "");
			fileSystem.utimesSync(file, new Date(NOW - idleMs), new Date(NOW - idleMs));
		}

		const { key } = await installManagedPluginAsync(options(fileSystem));

		expect(fileSystem.readdirSync(PLUGINS).toSorted()).toStrictEqual(
			[
				"JestRobloxRunner-0.3.0.rbxm",
				"JestRobloxRunner.cli-1.0.0-bbbbbbbb.rbxm",
				"JestRobloxRunner.cli-1.0.0-cccccccc.rbxm",
				`JestRobloxRunner.cli-${key}.rbxm`,
				"JestRobloxRunner.rbxm",
			].toSorted(),
		);
	});

	it("should judge idleness by the usage mark where one exists, and drop marks it outlives", async () => {
		expect.assertions(2);

		const { fileSystem } = createMemoryFileSystem();
		const ages = {
			[managedFile("1.0.0-aaaaaaaa")]: 25 * HOUR_MS,
			[managedFile("1.0.0-bbbbbbbb")]: 25 * HOUR_MS,
			[usageMark("1.0.0-aaaaaaaa")]: HOUR_MS,
			[usageMark("1.0.0-bbbbbbbb")]: 25 * HOUR_MS,
			[usageMark("1.0.0-cccccccc")]: HOUR_MS,
		};
		fileSystem.mkdirSync(PLUGINS, { recursive: true });
		fileSystem.mkdirSync(USAGE, { recursive: true });
		for (const [file, ageMs] of Object.entries(ages)) {
			fileSystem.writeFileSync(file, "");
			fileSystem.utimesSync(file, new Date(NOW - ageMs), new Date(NOW - ageMs));
		}

		const { key } = await installManagedPluginAsync(options(fileSystem));

		expect(fileSystem.readdirSync(PLUGINS).toSorted()).toStrictEqual(
			[
				"JestRobloxRunner.cli-1.0.0-aaaaaaaa.rbxm",
				`JestRobloxRunner.cli-${key}.rbxm`,
			].toSorted(),
		);
		expect(fileSystem.readdirSync(USAGE).toSorted()).toStrictEqual(
			[
				"JestRobloxRunner.cli-1.0.0-aaaaaaaa.rbxm",
				`JestRobloxRunner.cli-${key}.rbxm`,
			].toSorted(),
		);
	});

	it("should let a concurrent sweep take a stale plugin and mark first", async () => {
		expect.assertions(2);

		const { fileSystem: disk } = createMemoryFileSystem();
		const stalePlugin = managedFile("1.0.0-aaaaaaaa");
		const orphanMark = usageMark("1.0.0-bbbbbbbb");
		disk.mkdirSync(PLUGINS, { recursive: true });
		disk.mkdirSync(USAGE, { recursive: true });
		for (const file of [stalePlugin, orphanMark]) {
			disk.writeFileSync(file, "");
			disk.utimesSync(file, new Date(NOW - 25 * HOUR_MS), new Date(NOW - 25 * HOUR_MS));
		}

		const fileSystem: FileSystem = {
			...disk,
			rmSync: (target, rmOptions) => {
				// The other run's sweep, landing between this one's listing and
				// its delete.
				disk.rmSync(target, { force: true });
				disk.rmSync(target, rmOptions);
			},
		};

		await installManagedPluginAsync(options(fileSystem));

		expect(disk.existsSync(stalePlugin)).toBeFalse();
		expect(disk.existsSync(orphanMark)).toBeFalse();
	});

	it("should name the jest-roblox plugins it does not manage", async () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({
			[`${PLUGINS}/jest-old.rbxmx`]: "",
			[`${PLUGINS}/JestRobloxRunner.rbxm`]: "",
			[`${PLUGINS}/OtherPlugin.rbxm`]: "",
		});

		const { manualPlugins } = await installManagedPluginAsync(options(fileSystem));

		expect(manualPlugins.toSorted()).toStrictEqual(["JestRobloxRunner.rbxm", "jest-old.rbxmx"]);
	});
});

describe(installRunnerPluginAsync, () => {
	it("should install nothing where the OS has no known plugins folder", async () => {
		expect.assertions(2);

		const { fileSystem } = createMemoryFileSystem();
		const { childProcess, execFile } = rojoChildProcess(fileSystem);

		const install = await installRunnerPluginAsync({
			childProcess,
			fileSystem,
			platform: "linux",
			workDirectory: "/repo/.jest-roblox/studio-cli",
		});

		expect(install).toBeUndefined();
		expect(execFile).not.toHaveBeenCalled();
	});

	it("should build the runner plugin with rojo into the Windows plugins folder", async () => {
		expect.assertions(2);

		const { fileSystem } = createMemoryFileSystem();
		const { childProcess, execFile } = rojoChildProcess(fileSystem);

		const install = await installRunnerPluginAsync({
			childProcess,
			environment: { LOCALAPPDATA: "/local" },
			fileSystem,
			platform: "win32",
			workDirectory: "/repo/.jest-roblox/studio-cli",
		});

		expect(execFile).toHaveBeenCalledWith(
			"rojo",
			[
				"build",
				expect.stringMatching(
					/studio-cli[/\\]plugin[/\\]plugin[/\\]managed\.project\.json$/,
				),
				"-o",
				expect.any(String),
			],
			expect.anything(),
			expect.any(Function),
		);
		expect(
			fileSystem.existsSync(
				`/local/Roblox/Plugins/JestRobloxRunner.cli-${install!.key}.rbxm`,
			),
		).toBeTrue();
	});

	it.for([
		{
			discovery: { environment: { LOCALAPPDATA: "/local" }, platform: "win32" as const },
			usageDirectory: "/local/jest-roblox/managed-plugins",
		},
		{
			discovery: { homeDirectory: "/home/me", platform: "darwin" as const },
			usageDirectory: "/home/me/Library/Caches/jest-roblox/managed-plugins",
		},
	])("should mark the plugin used in $usageDirectory", async ({ discovery, usageDirectory }) => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();
		const { childProcess } = rojoChildProcess(fileSystem);

		const install = await installRunnerPluginAsync({
			childProcess,
			fileSystem,
			workDirectory: "/repo/.jest-roblox/studio-cli",
			...discovery,
		});

		expect(
			fileSystem.existsSync(`${usageDirectory}/JestRobloxRunner.cli-${install!.key}.rbxm`),
		).toBeTrue();
	});
});
