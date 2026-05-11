import { collectPaths, loadRojoProject, resolveNestedProjects } from "@isentinel/rojo-utils";

import * as fs from "node:fs";
import * as path from "node:path";
import process from "node:process";

import type { Backend, BackendTiming, ProjectBackendResult } from "./backends/interface.ts";
import { loadConfig } from "./config/loader.ts";
import { mergeCliWithConfig } from "./config/merge.ts";
import type { ResolvedProjectConfig } from "./config/projects.ts";
import { createFsClassifier, resolveAllProjects } from "./config/projects.ts";
import type {
	CliOptions,
	InlineProjectConfig,
	ProjectEntry,
	ResolvedConfig,
} from "./config/schema.ts";
import { createSetupResolver } from "./config/setup-resolver.ts";
import { generateProjectStubs, STUB_FILENAME } from "./config/stubs.ts";
import type { CoverageManifest } from "./coverage/types.ts";
import {
	prepareWorkspaceCoverage,
	type WorkspacePackageCoverage,
} from "./coverage/workspace-prepare.ts";
import {
	buildProjectJob,
	executeBackend,
	type ExecuteResult,
	processProjectResult,
} from "./executor.ts";
import type { MemoryStoreQueueClient } from "./memory-store/queue-client.ts";
import { prepareWorkStealingQueue } from "./memory-store/work-stealing.ts";
import { type PackageDescriptor, type StubMount, synthesize } from "./staging/synthesizer.ts";
import {
	generateMaterializerScript,
	generateWorkStealingScript,
	type MaterializerInput,
} from "./staging/test-script-staged.ts";
import type { RojoTreeNode } from "./types/rojo.ts";
import { globSync } from "./utils/glob.ts";
import { buildWithRojo } from "./utils/rojo-builder.ts";
import { ensurePackageDirectories } from "./workspace/ensure-paths.ts";
import type { PackageInfo } from "./workspace/package-resolver.ts";
import { type PreflightError, validatePackages } from "./workspace/preflight.ts";

const SYNTHESIZED_PROJECT_FILE = "synthesized.project.json";
const SYNTHESIZED_PLACE_FILE = "synthesized.rbxl";
const WORKSPACE_CACHE_DIRECTORY = path.join(".jest-roblox", "workspace");
const ROJO_PROJECT_DEFAULT = "test.project.json";

export interface RunWorkspaceOptions {
	backend: Backend;
	cli: CliOptions;
	config: ResolvedConfig;
	packageInfos: Array<PackageInfo>;
	/**
	 * MemoryStore queue client used to coordinate work-stealing across
	 * parallel OCALE tasks. When provided alongside `cli.parallel > 1`, the
	 * workspace runner pushes every (pkg, project) onto a per-run UUID queue
	 * and the backend fires N tasks all running the same materializer script.
	 * Without it (or with parallel=1) the runner uses the existing
	 * single-task embedded-entries path.
	 */
	queueClient?: MemoryStoreQueueClient;
	version: string;
	workspaceRoot: string;
}

export interface WorkspaceProjectResult {
	/**
	 * When coverage is enabled in workspace mode, the per-package manifest
	 * captured during `prepareWorkspaceCoverage`. Downstream aggregation maps
	 * the result's `coverageData` (raw hit counts captured by the materializer)
	 * back through this manifest to produce TS-coord Istanbul records.
	 */
	coverageManifest?: CoverageManifest;
	displayName: string;
	pkg: string;
	result: ExecuteResult;
}

interface PackageContext {
	cacheRoot: string;
	descriptor: PackageDescriptor;
	info: PackageInfo;
	pkgConfig: ResolvedConfig;
	projects: Array<ResolvedProjectConfig>;
}

interface LoadedPackage {
	descriptor: PackageDescriptor;
	info: PackageInfo;
	pkgConfig: ResolvedConfig;
}

interface PendingEntry {
	pkg: string;
	project: ResolvedProjectConfig;
	projectConfig: ResolvedConfig;
	testFiles: Array<string>;
}

interface MapResultsOptions {
	backendTiming: BackendTiming;
	coverageByPackage: Map<string, WorkspacePackageCoverage>;
	startTime: number;
	version: string;
}

export async function runWorkspace(
	options: RunWorkspaceOptions,
): Promise<Array<WorkspaceProjectResult> | undefined> {
	const { backend, cli, config, packageInfos, version, workspaceRoot } = options;
	const startTime = Date.now();

	// Load each package's config FIRST so that per-package `rojoProject`
	// declarations override the workspace default. Building the descriptor
	// (and the path preflight uses) before loadConfig pinned every package
	// to the parent's rojo file.
	const loaded = await loadPackages({ cli, config, packageInfos });

	ensurePackageDirectories(loaded.map((entry) => entry.descriptor));

	const errors = validatePackages(loaded.map((entry) => entry.descriptor));
	if (errors.length > 0) {
		writePreflightErrors(errors);
		return undefined;
	}

	const cacheDirectory = path.join(workspaceRoot, WORKSPACE_CACHE_DIRECTORY);
	fs.mkdirSync(cacheDirectory, { recursive: true });

	const contexts = await resolvePackageContexts({ cacheDirectory, loaded });

	const filteredContexts = applyProjectFilter(contexts, cli.project);

	const allEntries = collectPendingEntries(filteredContexts);

	// D8: passWithNoTests is workspace-global. Drop projects whose runtime
	// discovery returned zero files BEFORE building jobs so empty projects
	// inside an otherwise non-empty workspace do not fail with "no tests
	// found". The workspace-global zero-check still fires when nothing is
	// left.
	const pending = allEntries.filter((entry) => entry.testFiles.length > 0);

	if (pending.length === 0) {
		if (config.passWithNoTests) {
			return [];
		}

		process.stderr.write("No test files found in any package\n");
		return undefined;
	}

	// Limit instrumentation to packages that actually have pending tests.
	// `--project` and zero-discovery filters narrow the set of pending
	// entries; instrumenting packages that won't run wastes time on every
	// run (instrumentation is the dominant pre-OCALE cost).
	const pendingPackageNames = new Set(pending.map((entry) => entry.pkg));
	const coverageByPackage = config.collectCoverage
		? buildCoverageMap(
				prepareWorkspaceCoverage({
					config,
					packages: loaded
						.map((entry) => entry.descriptor)
						.filter((descriptor) => pendingPackageNames.has(descriptor.name)),
					workspaceRoot,
				}),
			)
		: new Map<string, WorkspacePackageCoverage>();

	const descriptorsWithStubs = writeStubsAndBuildDescriptors(filteredContexts).map(
		(descriptor) => {
			const coverage = coverageByPackage.get(descriptor.name);
			return coverage !== undefined
				? { ...descriptor, coverageRoots: coverage.coverageRoots }
				: descriptor;
		},
	);

	const synthProjectPath = path.join(cacheDirectory, SYNTHESIZED_PROJECT_FILE);
	const synthRbxlPath = path.join(cacheDirectory, SYNTHESIZED_PLACE_FILE);

	const projectJson = synthesize({ packages: descriptorsWithStubs });
	fs.writeFileSync(synthProjectPath, projectJson);
	buildWithRojo(synthProjectPath, synthRbxlPath);

	const jobs = pending.map((entry) => {
		return buildProjectJob({
			config: { ...entry.projectConfig, placeFile: synthRbxlPath },
			displayColor: entry.project.displayColor,
			displayName: entry.project.displayName,
			pkg: entry.pkg,
			testFiles: entry.testFiles,
		});
	});

	const inputs: Array<MaterializerInput> = pending.map((entry) => {
		return {
			config: { ...entry.projectConfig, placeFile: synthRbxlPath },
			pkg: entry.pkg,
			project: entry.project.displayName,
			testFiles: entry.testFiles,
		};
	});

	const { queueClient } = options;
	const { results, timing: backendTiming } = await dispatchWorkspace({
		backend,
		cli,
		inputs,
		jobs,
		queueClient,
	});

	return mapBackendResults(results, pending, {
		backendTiming,
		coverageByPackage,
		startTime,
		version,
	});
}

function buildCoverageMap(
	entries: Array<WorkspacePackageCoverage>,
): Map<string, WorkspacePackageCoverage> {
	const map = new Map<string, WorkspacePackageCoverage>();
	for (const entry of entries) {
		map.set(entry.pkg, entry);
	}

	return map;
}

const PER_PACKAGE_TIMEOUT_SECONDS = 60;

async function dispatchWorkspace(input: {
	backend: Backend;
	cli: CliOptions;
	inputs: Array<MaterializerInput>;
	jobs: Array<ReturnType<typeof buildProjectJob>>;
	queueClient: MemoryStoreQueueClient | undefined;
}): Promise<{
	results: Array<ProjectBackendResult>;
	timing: BackendTiming;
}> {
	const { backend, cli, inputs, jobs, queueClient } = input;

	const parallel = typeof cli.parallel === "number" ? cli.parallel : undefined;
	const useWorkStealing = queueClient !== undefined && parallel !== undefined && parallel > 1;

	if (useWorkStealing) {
		const prepared = await prepareWorkStealingQueue({
			packages: inputs.map((entry) => ({ pkg: entry.pkg, project: entry.project })),
			perPackageTimeoutSeconds: PER_PACKAGE_TIMEOUT_SECONDS,
			queueClient,
		});
		const script = generateWorkStealingScript(
			inputs,
			prepared.queueId,
			prepared.invisibilityWindowSeconds,
		);

		return backend.runTests({
			jobs,
			parallel,
			scriptOverride: script,
			workStealing: true,
		});
	}

	const script = generateMaterializerScript(inputs);
	return executeBackend(backend, jobs, undefined, script);
}

async function loadPackages(input: {
	cli: CliOptions;
	config: ResolvedConfig;
	packageInfos: Array<PackageInfo>;
}): Promise<Array<LoadedPackage>> {
	const { cli, config, packageInfos } = input;
	const loaded: Array<LoadedPackage> = [];

	for (const info of packageInfos) {
		const fileConfig = await loadConfig(undefined, info.packageDirectory);
		const packageConfig = mergeCliWithConfig(cli, fileConfig);

		// Resolve rojoProjectPath from the merged per-package config so a
		// package whose own jest.config declares `rojoProject` overrides
		// the workspace-level default. Fall back to the parent's value
		// (then the package-default) when the package doesn't set it.
		const rojoProject = packageConfig.rojoProject ?? config.rojoProject ?? ROJO_PROJECT_DEFAULT;

		loaded.push({
			descriptor: {
				name: info.name,
				packageDirectory: info.packageDirectory,
				rojoProjectPath: path.resolve(info.packageDirectory, rojoProject),
			},
			info,
			pkgConfig: packageConfig,
		});
	}

	return loaded;
}

function synthesizeVirtualProjectEntry(
	packageName: string,
	packageConfig: ResolvedConfig,
	rojoTree: RojoTreeNode,
	packageDirectory: string,
): InlineProjectConfig {
	const mountPaths: Array<string> = [];
	collectPaths(rojoTree, mountPaths);

	// Use the FS classifier so dotted-name directories (e.g. `src/has.dot`)
	// are not mis-classified as files. `path.posix.extname` would treat
	// `.dot` as an extension and skip the directory entirely.
	const classify = createFsClassifier(packageDirectory);
	const directoryRoots = mountPaths.filter((value) => classify(value) === "directory");

	const include = directoryRoots.flatMap((root) => {
		return packageConfig.testMatch.map((pattern) => path.posix.join(root, pattern));
	});

	return {
		test: {
			displayName: packageName,
			include,
		},
	};
}

function readRawProjects(config: ResolvedConfig): Array<ProjectEntry> | undefined {
	// `ResolvedConfig.projects` is structurally typed `Array<string>`
	// post-resolution, but workspace mode reads the field BEFORE
	// per-package resolution runs, when entries are still raw
	// `ProjectEntry` (string paths or `{ test }` inline configs). The
	// downcast is bounded by `Array.isArray` and consumers that fail on
	// malformed entries.
	const { projects } = config as unknown as { projects?: unknown };
	if (!Array.isArray(projects)) {
		return undefined;
	}

	return projects as Array<ProjectEntry>;
}

function resolveProjectEntries(
	packageName: string,
	packageConfig: ResolvedConfig,
	rojoTree: RojoTreeNode,
	packageDirectory: string,
): Array<ProjectEntry> {
	const rawProjects = readRawProjects(packageConfig);
	if (rawProjects !== undefined && rawProjects.length > 0) {
		return rawProjects;
	}

	return [synthesizeVirtualProjectEntry(packageName, packageConfig, rojoTree, packageDirectory)];
}

function loadPackageRojoTree(rojoProjectPath: string): RojoTreeNode {
	const project = loadRojoProject(rojoProjectPath);
	return resolveNestedProjects(project.tree, path.dirname(rojoProjectPath));
}

function applySetupResolver(
	config: Pick<ResolvedConfig, "setupFiles" | "setupFilesAfterEnv">,
	resolve: (input: string) => string,
): void {
	if (config.setupFiles !== undefined) {
		config.setupFiles = config.setupFiles.map(resolve);
	}

	if (config.setupFilesAfterEnv !== undefined) {
		config.setupFilesAfterEnv = config.setupFilesAfterEnv.map(resolve);
	}
}

async function resolvePackageContexts(input: {
	cacheDirectory: string;
	loaded: Array<LoadedPackage>;
}): Promise<Array<PackageContext>> {
	const { cacheDirectory, loaded } = input;
	const contexts: Array<PackageContext> = [];

	for (const entry of loaded) {
		const { descriptor, info, pkgConfig } = entry;
		const rojoTree = loadPackageRojoTree(descriptor.rojoProjectPath);
		const projectEntries = resolveProjectEntries(
			info.name,
			pkgConfig,
			rojoTree,
			info.packageDirectory,
		);
		const projects = await resolveAllProjects(
			projectEntries,
			pkgConfig,
			rojoTree,
			info.packageDirectory,
		);

		// Resolve setupFiles / setupFilesAfterEnv for every project against
		// the package's own rojo tree. Without this, the materializer
		// payload carries raw filesystem paths that Jest cannot find as
		// ModuleScript Instances.
		const resolveSetup = createSetupResolver({
			configDirectory: info.packageDirectory,
			rojoConfigPath: descriptor.rojoProjectPath,
		});
		for (const project of projects) {
			applySetupResolver(project.config, resolveSetup);
		}

		contexts.push({
			cacheRoot: path.join(cacheDirectory, info.name),
			descriptor,
			info,
			pkgConfig,
			projects,
		});
	}

	return contexts;
}

function applyProjectFilter(
	contexts: Array<PackageContext>,
	filter: Array<string> | undefined,
): Array<PackageContext> {
	if (filter === undefined || filter.length === 0) {
		return contexts;
	}

	const wanted = new Set(filter);
	const available = new Set<string>();
	for (const ctx of contexts) {
		for (const project of ctx.projects) {
			available.add(project.displayName);
		}
	}

	const unknown = filter.filter((name) => !available.has(name));
	if (unknown.length > 0) {
		throw new Error(
			`Unknown project name(s): ${unknown.join(", ")}. Available: ${[...available].join(", ")}`,
		);
	}

	return contexts
		.map((ctx) => {
			return {
				...ctx,
				projects: ctx.projects.filter((project) => wanted.has(project.displayName)),
			};
		})
		.filter((ctx) => ctx.projects.length > 0);
}

function buildProjectExecutionConfig(
	packageConfig: ResolvedConfig,
	project: ResolvedProjectConfig,
): ResolvedConfig {
	return {
		...project.config,
		passWithNoTests: packageConfig.passWithNoTests,
		projects: project.projects,
		rootDir: packageConfig.rootDir,
		testMatch: project.testMatch,
	};
}

function discoverProjectTestFiles(
	project: ResolvedProjectConfig,
	packageDirectory: string,
): Array<string> {
	const found: Array<string> = [];
	for (const pattern of project.include) {
		found.push(...globSync(pattern, { cwd: packageDirectory }));
	}

	return [...new Set(found)];
}

function collectPendingEntries(contexts: Array<PackageContext>): Array<PendingEntry> {
	const pending: Array<PendingEntry> = [];

	for (const ctx of contexts) {
		for (const project of ctx.projects) {
			const projectConfig = buildProjectExecutionConfig(ctx.pkgConfig, project);
			const testFiles = discoverProjectTestFiles(project, ctx.info.packageDirectory);
			pending.push({
				pkg: ctx.info.name,
				project,
				projectConfig,
				testFiles,
			});
		}
	}

	return pending;
}

function mapBackendResults(
	results: Array<ProjectBackendResult>,
	pending: Array<PendingEntry>,
	options: MapResultsOptions,
): Array<WorkspaceProjectResult> {
	return results.map((entry, index) => {
		// eslint-disable-next-line ts/no-non-null-assertion -- length matches pending
		const pendingEntry = pending[index]!;
		const coverage = options.coverageByPackage.get(pendingEntry.pkg);
		return {
			coverageManifest: coverage?.manifest,
			displayName: pendingEntry.project.displayName,
			pkg: pendingEntry.pkg,
			result: processProjectResult(entry, {
				backendTiming: options.backendTiming,
				config: pendingEntry.projectConfig,
				deferFormatting: true,
				startTime: options.startTime,
				version: options.version,
			}),
		};
	});
}

function writePreflightErrors(errors: Array<PreflightError>): void {
	process.stderr.write("Pre-flight validation failed:\n");
	for (const error of errors) {
		process.stderr.write(`  ${error.package}: ${error.reason}\n`);
	}
}

function writeStubsAndBuildDescriptors(contexts: Array<PackageContext>): Array<PackageDescriptor> {
	return contexts.map((ctx) => {
		generateProjectStubs(ctx.projects, ctx.info.packageDirectory, ctx.cacheRoot);

		const stubMounts: Array<StubMount> = [];
		for (const project of ctx.projects) {
			for (const mount of project.rojoMounts) {
				stubMounts.push({
					absStubPath: path.resolve(ctx.cacheRoot, mount.fsPath, STUB_FILENAME),
					dataModelPath: mount.dataModelPath,
				});
			}
		}

		return { ...ctx.descriptor, stubMounts };
	});
}
