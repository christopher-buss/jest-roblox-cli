import type { StudioInstalledCheck } from "../backends/auto.ts";
import { assertVmParallel, resolveAutoBackend } from "../backends/auto.ts";
import type { Backend } from "../backends/interface.ts";
import { resolveOpenCloudBaseUrl } from "../backends/open-cloud-environment.ts";
import type { createOpenCloudBackend } from "../backends/open-cloud.ts";
import type { createStudioCliBackend } from "../backends/studio-cli.ts";
import type { createStudioBackend } from "../backends/studio.ts";
import type { loadRawConfig } from "../config/loader.ts";
import type { CliOptions, WorkspaceRunOptions } from "../config/schema.ts";
import { buildWorkspaceRunOptions } from "../config/workspace-run-options.ts";
import type { FileSystem } from "../utils/file-system.ts";
import type { PackageInfo } from "../workspace/package-resolver.ts";
import { buildWorkspaceCredentials } from "./workspace-validation.ts";

/** Backend factories a workspace run picks from. */
export interface WorkspaceBackendFactories {
	/** Creates the Open Cloud backend. */
	openCloudBackend: typeof createOpenCloudBackend;
	/** Creates the attached Studio backend. */
	studioBackend: typeof createStudioBackend;
	/** Creates the self-launched Studio backend. */
	studioCliBackend: typeof createStudioCliBackend;
}

/** Backend of a workspace run, its work-stealing credentials, or an error. */
export interface WorkspaceBackendResolution {
	/** Backend to dispatch to; absent on a `--typecheckOnly` run. */
	backend?: Backend | undefined;
	/** Exit code `2` and the message when resolution failed. */
	error?: {
		/** Exit code of the failed run. */
		exitCode: 2;
		/** Message for stderr. */
		message: string;
	};
	/** Work-stealing credentials; present only for Open Cloud. */
	workStealingCredentials?: {
		/** Open Cloud API key. */
		apiKey: string;
		/** Open Cloud base URL override, if any. */
		baseUrl?: string | undefined;
		/** Universe that holds the work-stealing memory store. */
		universeId: string;
	};
}

interface WorkspaceRunOptionsResolution {
	error?: { exitCode: 2; message: string };
	runOptions?: undefined | WorkspaceRunOptions;
}

/**
 * Load every package's raw config and fold them into the consensus-resolved
 * WorkspaceRunOptions. A config that fails to load and a consensus conflict
 * both surface as the same validation error the caller bails on.
 *
 * @param options - CLI options, packages, root and the config loader.
 * @param options.cli - Parsed command-line options.
 * @param options.fileSystem - File system to load configs from.
 * @param options.isStudioInstalled - Checks for a local Studio when the backend is auto.
 * @param options.loadPackageConfig - Loads one package's raw config.
 * @param options.packageInfos - Selected packages.
 * @param options.workspaceRoot - Absolute workspace root directory.
 * @returns The run options, or exit code `2` with the error message.
 */
export async function resolveWorkspaceOptionsAsync({
	cli,
	fileSystem,
	isStudioInstalled,
	loadPackageConfig,
	packageInfos,
	workspaceRoot,
}: {
	/** Parsed command-line options. */
	cli: CliOptions;
	/** File system to load configs from. */
	fileSystem: FileSystem;
	/** Checks for a local Studio when the backend is auto. */
	isStudioInstalled: StudioInstalledCheck;
	/** Loads one package's raw config. */
	loadPackageConfig: typeof loadRawConfig;
	/** Selected packages. */
	packageInfos: Array<PackageInfo>;
	/** Absolute workspace root directory. */
	workspaceRoot: string;
}): Promise<WorkspaceRunOptionsResolution> {
	try {
		const perPackageConfigs = await Promise.all(
			packageInfos.map(async (info) => {
				return {
					name: info.name,
					config: await loadPackageConfig({
						configPath: undefined,
						cwd: info.packageDirectory,
						fileSystem,
					}),
				};
			}),
		);
		const runOptions = resolveRunBackend({
			cli,
			isStudioInstalled,
			runOptions: buildWorkspaceRunOptions({ cli, perPackageConfigs, workspaceRoot }),
		});

		return { runOptions };
	} catch (err) {
		return setupFailure(err);
	}
}

/**
 * Resolves the backend for a workspace run, plus work-stealing credentials when
 * it's Open Cloud. `--typecheckOnly` is pure-local tsgo — the runner
 * short-circuits before any dispatch — so it needs no backend at all: skip
 * creation entirely and run with no secrets.
 *
 * The local Studio backends need no Open Cloud credentials. The studio-cli
 * backend launches its own Studio against the synthesized mega-place the
 * workspace runner builds; the attached `studio` backend runs the workspace
 * against a developer's open Studio (debug/introspection). Both bypass the
 * credential path entirely; only open-cloud resolves them.
 *
 * @param options - CLI options, backend factories and run options.
 * @param options.cli - Parsed command-line options.
 * @param options.dependencies - Backend factories.
 * @param options.runOptions - Consensus-resolved run options with the backend kind.
 * @returns The backend and credentials, nothing for a type-only run, or an error.
 */
export function resolveWorkspaceBackend({
	cli,
	dependencies,
	runOptions,
}: {
	/** Parsed command-line options. */
	cli: CliOptions;
	/** Backend factories. */
	dependencies: WorkspaceBackendFactories;
	/** Consensus-resolved run options with the backend kind. */
	runOptions: WorkspaceRunOptions;
}): WorkspaceBackendResolution {
	if (cli.typecheckOnly === true) {
		return {};
	}

	if (runOptions.backend === "studio-cli") {
		return { backend: studioCliBackendFor({ cli, dependencies, runOptions }) };
	}

	if (runOptions.backend === "studio") {
		return { backend: dependencies.studioBackend({ port: runOptions.port }) };
	}

	return resolveOpenCloudBackendFor({
		cli,
		openCloudBackend: dependencies.openCloudBackend,
		runOptions,
	});
}

/**
 * A typecheck-only run dispatches nothing, so it has no backend to name.
 *
 * @param options - CLI options, Studio check and run options.
 * @param options.cli - Parsed command-line options.
 * @param options.isStudioInstalled - Checks for a local Studio.
 * @param options.runOptions - Consensus-resolved run options.
 * @returns The run options with the auto backend resolved.
 * @throws {Error} When `experimentalVmParallel` does not suit the backend.
 */
function resolveRunBackend({
	cli,
	isStudioInstalled,
	runOptions,
}: {
	cli: CliOptions;
	isStudioInstalled: StudioInstalledCheck;
	runOptions: WorkspaceRunOptions;
}): WorkspaceRunOptions {
	if (cli.typecheckOnly === true) {
		return runOptions;
	}

	const backend = resolveAutoBackend(runOptions, isStudioInstalled);
	assertVmParallel(backend, runOptions.experimentalVmParallel);
	return { ...runOptions, backend };
}

function setupFailure(err: unknown): { error: { exitCode: 2; message: string } } {
	const message = err instanceof Error ? err.message : String(err);
	return { error: { exitCode: 2, message: `Error: ${message}\n` } };
}

/**
 * Credential resolution is the only failing step here, so the whole Open Cloud
 * branch is a try/catch that converts a missing/invalid secret into the
 * validation error the caller bails on.
 *
 * @param options - CLI options, Open Cloud factory and run options.
 * @param options.cli - Parsed command-line options.
 * @param options.openCloudBackend - Creates the Open Cloud backend.
 * @param options.runOptions - Consensus-resolved run options.
 * @returns The backend and credentials, or exit code `2` with the error message.
 */
function resolveOpenCloudBackendFor({
	cli,
	openCloudBackend,
	runOptions,
}: {
	cli: CliOptions;
	openCloudBackend: typeof createOpenCloudBackend;
	runOptions: WorkspaceRunOptions;
}): WorkspaceBackendResolution {
	try {
		const credentials = buildWorkspaceCredentials(cli, runOptions);
		const backend = openCloudBackend(credentials);
		const baseUrl = resolveOpenCloudBaseUrl();
		return {
			backend,
			workStealingCredentials: {
				apiKey: credentials.apiKey,
				baseUrl,
				universeId: credentials.universeId,
			},
		};
	} catch (err) {
		return setupFailure(err);
	}
}

function studioCliBackendFor({
	cli,
	dependencies,
	runOptions,
}: {
	cli: CliOptions;
	dependencies: WorkspaceBackendFactories;
	runOptions: WorkspaceRunOptions;
}): Backend {
	return dependencies.studioCliBackend({
		// `headed` is CLI-only — read straight from `cli`, not the
		// consensus-resolved run options.
		headed: cli.headed,
		hiddenDesktop: runOptions.hiddenDesktop,
		pluginsDirectory: runOptions.pluginsDirectory,
		studioPath: runOptions.studioPath,
	});
}
