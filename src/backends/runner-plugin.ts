/// <reference path="./runner-plugin-sources.d.ts" />
import { type } from "arktype";
import * as path from "node:path";
import runnerPluginSources from "virtual:runner-plugin-sources";

import packageJson from "../../package.json" with { type: "json" };
import { atomicWrite } from "../utils/atomic-write.ts";
import type { ChildProcessRunner } from "../utils/child-process.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { hashString } from "../utils/hash.ts";
import { buildWithRojoAsync } from "../utils/rojo-builder.ts";
import type { PluginsDirectoryOptions } from "./studio-discovery.ts";
import { discoverPluginsDirectory } from "./studio-discovery.ts";

export interface ManagedPluginOptions {
	/** Builds a rojo project to an `.rbxm`. */
	readonly buildAsync: (projectPath: string, outputPath: string) => Promise<void>;
	readonly fileSystem: FileSystem;
	/** Wall clock in milliseconds. */
	readonly now: number;
	/** The Studio plugins folder. */
	readonly pluginsDirectory: string;
	readonly sources: ReadonlyArray<RunnerPluginSource>;
	/** Scratch directory the plugin is built in. */
	readonly stagingDirectory: string;
	/** The CLI's release version. */
	readonly version: string;
}

/** What the CLI installed, and the jest-roblox plugins it found beside it. */
export interface ManagedPluginInstall {
	/** The Plugin Key the run must ask for. */
	readonly key: string;
	/** File names of the jest-roblox plugins the CLI does not manage. */
	readonly manualPlugins: ReadonlyArray<string>;
}

export interface RunnerPluginInstallOptions extends PluginsDirectoryOptions {
	readonly childProcess: ChildProcessRunner;
	readonly fileSystem: FileSystem;
	/** The run's scratch directory; the plugin is built beneath it. */
	readonly workDirectory: string;
}

type RunnerPluginSource = (typeof runnerPluginSources)[number];

const PLUGIN_DIRECTORY = "plugin";
const MANUAL_PROJECT_FILE = "plugin/plugin.project.json";
const MANAGED_PROJECT_FILE = "plugin/managed.project.json";
/** Generated beside the runner, relative to the plugin's project. */
const KEY_MODULE = "src/pluginKey.luau";
const VERSION_MODULE = "src/version.luau";
const BUILD_OUTPUT = "JestRobloxRunner.rbxm";
const KEY_HASH_LENGTH = 8;
const MANAGED_PREFIX = "JestRobloxRunner.cli-";
const MANAGED_SUFFIX = ".rbxm";
const JEST_PLUGIN_PATTERN = /jest.*\.rbxmx?$/i;

/**
 * How long another key's Managed Plugin sits unused before the sweep takes it.
 * Long enough that a run in another checkout still holds it loaded.
 */
const IDLE_SWEEP_MS = 24 * 60 * 60 * 1000;

const rojoProjectSchema = type({ name: "string", tree: "Record<string, unknown>" });

/**
 * Put the Managed Plugin for this CLI's Plugin Key in the plugins folder,
 * building it only when it is missing.
 *
 * @param options - Where the plugin goes, and what it is built from.
 * @returns The key to ask the run for, and the Manual Plugins beside it.
 */
export async function installManagedPluginAsync(
	options: ManagedPluginOptions,
): Promise<ManagedPluginInstall> {
	const project = managedProject(options.sources);
	const key = pluginKey({ project, sources: options.sources, version: options.version });
	const target = path.join(options.pluginsDirectory, managedPluginFileName(key));
	if (!options.fileSystem.existsSync(target)) {
		await buildManagedPluginAsync(options, { key, project, target });
	}

	const usedAt = new Date(options.now);
	options.fileSystem.utimesSync(target, usedAt, usedAt);
	sweepIdleManagedPlugins(options);
	return { key, manualPlugins: listManualPlugins(options) };
}

/**
 * Install this CLI's Managed Plugin with rojo, or nothing where the OS has no
 * known plugins folder.
 *
 * @param options - The run's seams and scratch directory.
 */
export async function installRunnerPluginAsync({
	childProcess,
	fileSystem,
	workDirectory,
	...discovery
}: RunnerPluginInstallOptions): Promise<ManagedPluginInstall | undefined> {
	const pluginsDirectory = discoverPluginsDirectory(discovery);
	if (pluginsDirectory === undefined) {
		return undefined;
	}

	return installManagedPluginAsync({
		buildAsync: async (projectPath, outputPath) => {
			return buildWithRojoAsync(projectPath, outputPath, childProcess);
		},
		fileSystem,
		now: Date.now(),
		pluginsDirectory,
		sources: runnerPluginSources,
		stagingDirectory: path.join(workDirectory, "plugin"),
		version: packageJson.version,
	});
}

function managedPluginFileName(key: string): string {
	return `${MANAGED_PREFIX}${key}${MANAGED_SUFFIX}`;
}

function pluginKey({
	project,
	sources,
	version,
}: Pick<ManagedPluginOptions, "sources" | "version"> & { project: string }): string {
	const digest = hashString(
		JSON.stringify([project, sources.map(({ path: file, text }) => [file, text])]),
	);
	return `${version}-${digest.slice(0, KEY_HASH_LENGTH)}`;
}

/**
 * The Manual Plugin's rojo project with its root swapped for a Folder holding
 * the Run-mode runner alone: the edit-mode client would load in every Studio
 * the user opens and dial the `studio` backend.
 */
function managedProject(sources: ReadonlyArray<RunnerPluginSource>): string {
	const manual = sources.find((source) => source.path === MANUAL_PROJECT_FILE);
	if (manual === undefined) {
		throw new Error(`runner plugin sources carry no ${MANUAL_PROJECT_FILE}`);
	}

	const { name, tree } = rojoProjectSchema.assert(JSON.parse(manual.text));
	const { $path: _editModeClient, ...children } = tree;
	return JSON.stringify({
		name,
		tree: {
			...children,
			"$className": "Folder",
			"pluginKey": { $path: KEY_MODULE },
			"test-in-run-mode": { $path: "src/test-in-run-mode.server.luau" },
			"version": { $path: VERSION_MODULE },
		},
	});
}

function luauStringModule(value: string): string {
	return `--!strict\nreturn ${JSON.stringify(value)}\n`;
}

async function buildManagedPluginAsync(
	{ buildAsync, fileSystem, sources, stagingDirectory, version }: ManagedPluginOptions,
	{ key, project, target }: { key: string; project: string; target: string },
): Promise<void> {
	fileSystem.rmSync(stagingDirectory, { force: true, recursive: true });
	const generated = [
		...sources,
		{ path: MANAGED_PROJECT_FILE, text: project },
		{ path: `${PLUGIN_DIRECTORY}/${KEY_MODULE}`, text: luauStringModule(key) },
		{ path: `${PLUGIN_DIRECTORY}/${VERSION_MODULE}`, text: luauStringModule(version) },
	];
	for (const source of generated) {
		const file = path.join(stagingDirectory, source.path);
		fileSystem.mkdirSync(path.dirname(file), { recursive: true });
		fileSystem.writeFileSync(file, source.text);
	}

	const output = path.join(stagingDirectory, BUILD_OUTPUT);
	await buildAsync(path.join(stagingDirectory, MANAGED_PROJECT_FILE), output);
	atomicWrite({ contents: fileSystem.readFileSync(output), fileSystem, targetPath: target });
}

function isManagedPlugin(entry: string): boolean {
	return entry.startsWith(MANAGED_PREFIX) && entry.endsWith(MANAGED_SUFFIX);
}

/** Delete other keys' Managed Plugins that have sat idle. */
function sweepIdleManagedPlugins({
	fileSystem,
	now,
	pluginsDirectory,
}: ManagedPluginOptions): void {
	for (const entry of fileSystem.readdirSync(pluginsDirectory)) {
		const file = path.join(pluginsDirectory, entry);
		if (isManagedPlugin(entry) && now - fileSystem.statSync(file).mtimeMs > IDLE_SWEEP_MS) {
			fileSystem.rmSync(file);
		}
	}
}

/** Every jest-roblox plugin in the folder the CLI does not manage. */
function listManualPlugins({ fileSystem, pluginsDirectory }: ManagedPluginOptions): Array<string> {
	return fileSystem.readdirSync(pluginsDirectory).filter((entry) => {
		return !isManagedPlugin(entry) && JEST_PLUGIN_PATTERN.test(entry);
	});
}
