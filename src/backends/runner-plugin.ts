/// <reference path="./runner-plugin-sources.d.ts" />
import { parseRojoProject } from "@isentinel/rojo-utils";

import * as path from "node:path";
import runnerPluginSources from "virtual:runner-plugin-sources";

import { PLUGIN_KEY_MODULE, PLUGIN_VERSION_MODULE } from "../protocol/studio.ts";
import { atomicWrite } from "../utils/atomic-write.ts";
import type { ChildProcessRunner } from "../utils/child-process.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { hashString } from "../utils/hash.ts";
import { buildWithRojoAsync } from "../utils/rojo-builder.ts";
import { VERSION } from "../version.ts";
import type { UserDirectoryOptions } from "./studio-discovery.ts";
import { discoverUserDirectories } from "./studio-discovery.ts";

/** What the CLI installed, and the jest-roblox plugins it found beside it. */
export interface ManagedPluginInstall {
	/** The Plugin Key the run must ask for. */
	readonly key: string;
	/** File names of the jest-roblox plugins the CLI does not manage. */
	readonly manualPlugins: ReadonlyArray<string>;
}

/** What a run needs to install the runner plugin. */
export interface RunnerPluginInstallOptions extends UserDirectoryOptions {
	/** Runs rojo. */
	readonly childProcess: ChildProcessRunner;
	/** File system the plugin is written to. */
	readonly fileSystem: FileSystem;
	/** Wall clock in milliseconds. Defaults to `Date.now()`. */
	readonly now?: number | undefined;
	/** Plugin source files the build reads. Defaults to the bundled sources. */
	readonly sources?: ReadonlyArray<RunnerPluginSource> | undefined;
	/** The CLI's release version. Defaults to the package version. */
	readonly version?: string | undefined;
	/** The run's scratch directory; the plugin is built beneath it. */
	readonly workDirectory: string;
}

type RunnerPluginSource = (typeof runnerPluginSources)[number];

/** What a Managed Plugin install needs. */
interface ManagedPluginOptions {
	/** Builds a rojo project to an `.rbxm`. */
	readonly buildAsync: (projectPath: string, outputPath: string) => Promise<void>;
	/** File system the plugin and its marks are written to. */
	readonly fileSystem: FileSystem;
	/** Wall clock in milliseconds. */
	readonly now: number;
	/** The Studio plugins folder. */
	readonly pluginsDirectory: string;
	/** Plugin source files the build reads. */
	readonly sources: ReadonlyArray<RunnerPluginSource>;
	/** Scratch directory the plugin is built in. */
	readonly stagingDirectory: string;
	/**
	 * Where each plugin's last use is marked. Never inside the plugins folder:
	 * Studio reloads a plugin whose file changes, even by mtime alone.
	 */
	readonly usageDirectory: string;
	/** The CLI's release version. */
	readonly version: string;
}

const PLUGIN_DIRECTORY = "plugin";
const MANUAL_PROJECT_FILE = "plugin/plugin.project.json";
const MANAGED_PROJECT_FILE = "plugin/managed.project.json";
const KEY_MODULE = `src/${PLUGIN_KEY_MODULE}.luau`;
const VERSION_MODULE = `src/${PLUGIN_VERSION_MODULE}.luau`;
const BUILD_OUTPUT = "JestRobloxRunner.rbxm";
const KEY_HASH_LENGTH = 8;
const MANAGED_PREFIX = "JestRobloxRunner.cli-";
const MANAGED_SUFFIX = ".rbxm";
const JEST_PLUGIN_PATTERN = /jest.*\.rbxmx?$/i;
// Bump when a copy built by an older CLI would break this CLI's runs.
const MANAGED_GENERATION = 2;
const GENERATION_PATTERN = /^g(\d+)-/;

const IDLE_SWEEP_MS = 24 * 60 * 60 * 1000;

/**
 * Install this CLI's Managed Plugin with rojo, or nothing where the OS has no
 * known plugins folder.
 *
 * @param options - The run's seams and scratch directory.
 * @returns The install, or undefined when the OS has no known plugins folder.
 */
export async function installRunnerPluginAsync({
	childProcess,
	fileSystem,
	now = Date.now(),
	sources = runnerPluginSources,
	version = VERSION,
	workDirectory,
	...discovery
}: RunnerPluginInstallOptions): Promise<ManagedPluginInstall | undefined> {
	const directories = discoverUserDirectories(discovery);
	if (directories === undefined) {
		return undefined;
	}

	return installManagedPluginAsync({
		buildAsync: async (projectPath, outputPath) => {
			return buildWithRojoAsync({ childProcess, outputPath, projectPath });
		},
		fileSystem,
		now,
		pluginsDirectory: directories.plugins,
		sources,
		stagingDirectory: path.join(workDirectory, "plugin"),
		usageDirectory: path.join(directories.state, "managed-plugins"),
		version,
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
	return `g${MANAGED_GENERATION.toString()}-${version}-${digest.slice(0, KEY_HASH_LENGTH)}`;
}

function managedProject(sources: ReadonlyArray<RunnerPluginSource>): string {
	const manual = sources.find((source) => source.path === MANUAL_PROJECT_FILE);
	if (manual === undefined) {
		throw new Error(`runner plugin sources carry no ${MANUAL_PROJECT_FILE}`);
	}

	const { name, tree } = parseRojoProject(manual.text, MANUAL_PROJECT_FILE);
	const { $path: _editModeClient, ...children } = tree;
	return JSON.stringify({
		name,
		tree: {
			...children,
			"$className": "Folder",
			[PLUGIN_KEY_MODULE]: { $path: KEY_MODULE },
			[PLUGIN_VERSION_MODULE]: { $path: VERSION_MODULE },
			"test-in-run-mode": { $path: "src/test-in-run-mode.server.luau" },
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
	// A Studio may have loaded a copy another run published; do not reload it.
	if (fileSystem.existsSync(target)) {
		return;
	}

	atomicWrite({ contents: fileSystem.readFileSync(output), fileSystem, targetPath: target });
}

function markUsed(
	{ fileSystem, now, usageDirectory }: ManagedPluginOptions,
	fileName: string,
): void {
	const mark = path.join(usageDirectory, fileName);
	fileSystem.mkdirSync(usageDirectory, { recursive: true });
	fileSystem.writeFileSync(mark, "");
	const usedAt = new Date(now);
	fileSystem.utimesSync(mark, usedAt, usedAt);
}

function isManagedPlugin(entry: string): boolean {
	return entry.startsWith(MANAGED_PREFIX) && entry.endsWith(MANAGED_SUFFIX);
}

function managedGeneration(entry: string): number {
	const match = GENERATION_PATTERN.exec(entry.slice(MANAGED_PREFIX.length));
	return match === null ? 1 : Number(match[1]);
}

function sweepStaleManagedPlugins({
	fileSystem,
	now,
	pluginsDirectory,
	usageDirectory,
}: ManagedPluginOptions): void {
	for (const entry of fileSystem.readdirSync(pluginsDirectory)) {
		if (!isManagedPlugin(entry)) {
			continue;
		}

		const file = path.join(pluginsDirectory, entry);
		const mark = path.join(usageDirectory, entry);
		const usedAt =
			fileSystem.statSync(mark, { throwIfNoEntry: false }) ?? fileSystem.statSync(file);
		if (managedGeneration(entry) < MANAGED_GENERATION || now - usedAt.mtimeMs > IDLE_SWEEP_MS) {
			fileSystem.rmSync(file, { force: true });
		}
	}

	for (const entry of fileSystem.readdirSync(usageDirectory)) {
		if (!fileSystem.existsSync(path.join(pluginsDirectory, entry))) {
			fileSystem.rmSync(path.join(usageDirectory, entry), { force: true });
		}
	}
}

function listManualPlugins({ fileSystem, pluginsDirectory }: ManagedPluginOptions): Array<string> {
	return fileSystem.readdirSync(pluginsDirectory).filter((entry) => {
		return !isManagedPlugin(entry) && JEST_PLUGIN_PATTERN.test(entry);
	});
}

async function installManagedPluginAsync(
	options: ManagedPluginOptions,
): Promise<ManagedPluginInstall> {
	const project = managedProject(options.sources);
	const key = pluginKey({ project, sources: options.sources, version: options.version });
	const fileName = managedPluginFileName(key);
	const target = path.join(options.pluginsDirectory, fileName);
	if (!options.fileSystem.existsSync(target)) {
		await buildManagedPluginAsync(options, { key, project, target });
	}

	markUsed(options, fileName);
	sweepStaleManagedPlugins(options);
	return { key, manualPlugins: listManualPlugins(options) };
}
