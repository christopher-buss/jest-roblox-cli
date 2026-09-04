import assert from "node:assert";
import process from "node:process";

import packageJson from "../../package.json" with { type: "json" };
import type { Backend } from "../backends/interface.ts";
import { createOpenCloudBackend, resolveOpenCloudBaseUrl } from "../backends/open-cloud.ts";
import { createStudioCliBackend } from "../backends/studio-cli.ts";
import { createStudioBackend } from "../backends/studio.ts";
import { loadRawConfig } from "../config/loader.ts";
import type { CliOptions, WorkspaceConfig, WorkspaceRunOptions } from "../config/schema.ts";
import { buildWorkspaceRunOptions } from "../config/workspace-run-options.ts";
import { mergeRawCoverage } from "../coverage-pipeline/merge-raw-coverage.ts";
import type { RawCoverageData } from "../coverage-pipeline/types.ts";
import {
	aggregateWorkspaceCoverage,
	type WorkspacePackageUniverse,
} from "../coverage-pipeline/workspace-aggregate.ts";
import type { BailSummary } from "../formatters/shared.ts";
import { isDefaultHumanFormatter } from "../formatters/utils.ts";
import { NOOP_RUN_PROGRESS, type RunProgress } from "../progress/reporter.ts";
import type { StreamingAggregatorOnEntry } from "../reporter/streaming-aggregator.ts";
import { formatStreamingProgressLine } from "../reporter/streaming-progress.ts";
import type { TimingCollector } from "../timing/orchestration-collector.ts";
import { composeEntryDisplayName } from "../utils/display-name.ts";
import {
	runWorkspaceAsync,
	type WorkspaceProjectResult,
	type WorkspaceRunnerOutput,
} from "../workspace-runner.ts";
import type { PackageCoverageSettings } from "../workspace/coverage-attach.ts";
import { discoverWorkspaceRoot } from "../workspace/discovery.ts";
import type { PackageInfo } from "../workspace/package-resolver.ts";
import { emitRunHeader } from "./run-header.ts";
import type {
	ProjectResult,
	WorkspacePackageCoverageGate,
	WorkspaceReportOptions,
	WorkspaceRunResult,
} from "./types.ts";
import {
	assertWorkspaceRunOptions,
	buildWorkspaceCredentials,
	resolveWorkspacePackages,
	validateBasicWorkspaceFlags,
} from "./workspace-validation.ts";

const VERSION = packageJson.version;

const EMPTY_RESULT = {
	coverageMs: 0,
	merged: {},
	mode: "workspace",
	projectResults: [],
	stagingMs: 0,
} as const satisfies WorkspaceRunResult;

interface ResolvedPackages {
	error?: { exitCode: 2; message: string };
	noAffected?: true | undefined;
	packageInfos?: Array<PackageInfo> | undefined;
	workspaceRoot?: string | undefined;
}

interface WorkspaceBackendResolution {
	backend?: Backend | undefined;
	error?: { exitCode: 2; message: string };
	workStealingCredentials?: {
		apiKey: string;
		baseUrl?: string | undefined;
		universeId: string;
	};
}

interface WorkspaceRunOptionsResolution {
	error?: { exitCode: 2; message: string };
	runOptions?: undefined | WorkspaceRunOptions;
}

/** One package's accumulated coverage inputs, merged across its projects. */
interface PackageEntry {
	coverageData: RawCoverageData | undefined;
	ignorePatterns: Array<string> | undefined;
	includePatterns: Array<string> | undefined;
	manifest: NonNullable<WorkspaceProjectResult["coverageManifest"]>;
	pkg: string;
	rootDir: string;
}

interface ExecuteWorkspaceRunOptions {
	cli: CliOptions;
	packageInfos: Array<PackageInfo>;
	runOptions: WorkspaceRunOptions;
	timing?: TimingCollector | undefined;
	workspaceRoot: string;
}

interface AggregatePerPackageCoverageResult {
	settingsByPackage: Map<string, PackageCoverageSettings>;
	universes: Array<WorkspacePackageUniverse>;
}

interface EnumerationRoot {
	exclude?: Array<string> | undefined;
	patterns?: Array<string> | undefined;
	workspaceRoot: string;
}

export async function runWorkspaceModeAsync(
	cli: CliOptions,
	workspace?: WorkspaceConfig,
	timing?: TimingCollector,
): Promise<WorkspaceRunResult> {
	const basicValidation = validateBasicWorkspaceFlags(cli);
	if (!basicValidation.ok) {
		return bail(basicValidation.exitCode, basicValidation.message);
	}

	const resolved = resolvePackages(cli, workspace);
	if (resolved.error !== undefined) {
		return bail(resolved.error.exitCode, resolved.error.message);
	}

	if (resolved.noAffected === true) {
		process.stdout.write("No affected packages — nothing to test.\n");
		return EMPTY_RESULT;
	}

	// eslint-disable-next-line ts/no-non-null-assertion -- guaranteed when no error/noAffected
	const packageInfos = resolved.packageInfos!;
	// eslint-disable-next-line ts/no-non-null-assertion -- guaranteed when no error/noAffected
	const workspaceRoot = resolved.workspaceRoot!;

	const optionsResolution = await resolveWorkspaceOptionsAsync(cli, packageInfos, workspaceRoot);
	if (optionsResolution.error !== undefined) {
		return bail(optionsResolution.error.exitCode, optionsResolution.error.message);
	}

	// eslint-disable-next-line ts/no-non-null-assertion -- guaranteed when there is no error
	const runOptions = optionsResolution.runOptions!;

	return executeWorkspaceRunAsync({
		cli,
		packageInfos,
		runOptions,
		timing,
		workspaceRoot,
	});
}

// Every validation failure reports through the same empty result, so the
// per-branch difference is only the exit code and (optionally) the message.
// Add `validationMessage` only when defined so the "no message" case keeps the
// key absent, as before.
function bail(validationExitCode: 2, validationMessage?: string): WorkspaceRunResult {
	const result = {
		...EMPTY_RESULT,
		validationExitCode,
	} satisfies WorkspaceRunResult;
	return validationMessage === undefined ? result : { ...result, validationMessage };
}

// Load every package's raw config, fold them into the consensus-resolved
// WorkspaceRunOptions, and check the resolved-value invariants. A config that
// fails to load and a consensus conflict both surface as the same validation
// error the caller bails on.
async function resolveWorkspaceOptionsAsync(
	cli: CliOptions,
	packageInfos: Array<PackageInfo>,
	workspaceRoot: string,
): Promise<WorkspaceRunOptionsResolution> {
	try {
		const perPackageConfigs = await Promise.all(
			packageInfos.map(async (info) => {
				return {
					name: info.name,
					config: await loadRawConfig(undefined, info.packageDirectory),
				};
			}),
		);
		const runOptions = buildWorkspaceRunOptions({ cli, perPackageConfigs, workspaceRoot });
		const assertion = assertWorkspaceRunOptions(runOptions);
		if (!assertion.ok) {
			return { error: { exitCode: assertion.exitCode, message: assertion.message } };
		}

		return { runOptions };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { error: { exitCode: 2, message: `Error: ${message}\n` } };
	}
}

// `collectCoverage` is intentionally omitted: workspace coverage is per-package
// (driven by each package's manifest), so there is no workspace-level flag to
// surface the "Coverage enabled" subtitle.
function emitWorkspaceRunHeader({
	cli,
	progress,
	runOptions,
	workspaceRoot,
}: {
	cli: CliOptions;
	progress: RunProgress;
	runOptions: WorkspaceRunOptions;
	workspaceRoot: string;
}): void {
	emitRunHeader({
		color: runOptions.color,
		formatters: runOptions.formatters,
		progress,
		rootDir: workspaceRoot,
		silent: runOptions.silent,
		verbose: cli.verbose,
		version: VERSION,
	});
}

// Credential resolution is the only failing step here, so the whole Open Cloud
// branch is a try/catch that converts a missing/invalid secret into the
// validation error the caller bails on.
function resolveOpenCloudBackendFor(
	cli: CliOptions,
	runOptions: WorkspaceRunOptions,
): WorkspaceBackendResolution {
	try {
		const credentials = buildWorkspaceCredentials(cli, runOptions);
		const backend = createOpenCloudBackend(credentials);
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
		const message = err instanceof Error ? err.message : String(err);
		return { error: { exitCode: 2, message: `Error: ${message}\n` } };
	}
}

// Resolves the backend for a workspace run, plus work-stealing credentials when
// it's Open Cloud. `--typecheckOnly` is pure-local tsgo — the runner
// short-circuits before any dispatch — so it needs no backend at all: skip
// creation entirely and run with no secrets.
//
// The local Studio backends need no Open Cloud credentials. studio-cli launches
// its own Studio against the synthesized mega-place the workspace runner builds;
// the attached `studio` backend runs the workspace against a developer's open
// Studio (debug/introspection). Both bypass the credential path entirely; only
// open-cloud (and `auto`, which never probes in workspace mode) resolves them.
function resolveWorkspaceBackend(
	cli: CliOptions,
	runOptions: WorkspaceRunOptions,
): WorkspaceBackendResolution {
	if (cli.typecheckOnly === true) {
		return {};
	}

	if (runOptions.backend === "studio-cli") {
		return {
			backend: createStudioCliBackend({
				// `headed` is CLI-only — read straight from `cli`, not the
				// consensus-resolved run options.
				headed: cli.headed,
				studioPath: runOptions.studioPath,
			}),
		};
	}

	if (runOptions.backend === "studio") {
		return { backend: createStudioBackend({ port: runOptions.port }) };
	}

	return resolveOpenCloudBackendFor(cli, runOptions);
}

function aggregatePerPackageCoverage(
	runtimeResults: Array<WorkspaceProjectResult>,
): AggregatePerPackageCoverageResult {
	// A package with multiple projects emits one entry per project. Each
	// project runs Jest with its own `_G.__jest_roblox_cov` reset, so the
	// per-entry `coverageData` captures DIFFERENT hits across projects. We
	// must additively merge those maps per pkg (not drop them) before passing
	// one entry per pkg into the mapper — otherwise multi-project packages
	// silently lose coverage from all but the first project.
	const byPackage = new Map<string, PackageEntry>();
	const settingsByPackage = new Map<string, PackageCoverageSettings>();

	for (const entry of runtimeResults) {
		if (entry.coverageManifest === undefined || entry.coverageSettings === undefined) {
			continue;
		}

		const existing = byPackage.get(entry.pkg);
		if (existing === undefined) {
			byPackage.set(entry.pkg, {
				coverageData: entry.result.coverageData,
				ignorePatterns: entry.coverageSettings.coveragePathIgnorePatterns,
				includePatterns: entry.coverageSettings.collectCoverageFrom,
				manifest: entry.coverageManifest,
				pkg: entry.pkg,
				rootDir: entry.coverageSettings.rootDir,
			});
			settingsByPackage.set(entry.pkg, entry.coverageSettings);
			continue;
		}

		existing.coverageData = mergeRawCoverage(existing.coverageData, entry.result.coverageData);
	}

	return {
		settingsByPackage,
		universes: aggregateWorkspaceCoverage([...byPackage.values()]),
	};
}

// Drive coverage off per-package manifests, not the workspace-level
// `collectCoverage`. A package that opted into coverage via its own jest.config
// carries a `coverageManifest`; aggregating regardless of workspace config keeps
// that report from being dropped. Each gate carries the package's own reporter
// settings so the report layer emits one report per package, into that
// package's own directory, from that package's own config.
function resolveWorkspaceCoverage(
	runtimeResults: Array<WorkspaceProjectResult>,
): Pick<WorkspaceRunResult, "coveragePackages"> {
	const hasCoverage = runtimeResults.some((entry) => entry.coverageManifest !== undefined);
	if (!hasCoverage) {
		return {};
	}

	const { settingsByPackage, universes } = aggregatePerPackageCoverage(runtimeResults);
	const coveragePackages = universes.map(({ pkg, universe }) => {
		// `universes` is derived from the same map `settingsByPackage` is keyed
		// by, so every entry has settings.
		const settings = settingsByPackage.get(pkg);
		assert(settings !== undefined, `missing coverage settings for ${pkg}`);

		let coveragePackage: WorkspacePackageCoverageGate = {
			coverageDirectory: settings.coverageDirectory,
			coverageReporters: settings.coverageReporters,
			pkg,
			universe,
		};
		if (settings.coverageThreshold !== undefined) {
			coveragePackage = {
				...coveragePackage,
				coverageThreshold: settings.coverageThreshold,
			};
		}

		return coveragePackage;
	});

	return { coveragePackages };
}

// Surface the consensus-resolved aggregate sink paths the runner wrote so
// formatters point "View …" hints at files that actually exist.
function resolvedSinkPaths(
	runOptions: WorkspaceRunOptions,
): Pick<WorkspaceRunResult, "gameOutput" | "outputFile"> {
	return {
		gameOutput: runOptions.gameOutput,
		outputFile: runOptions.outputFile,
	};
}

// The output layer has no config to read in workspace mode, so hand it the
// values this run resolved: the consensus knobs for the render, the workspace
// root the formatters report paths against, and `verbose` straight off the CLI
// (it is a flag, never a per-package config value — the run header and the
// streaming sink read it the same way).
function resolveReportOptions(
	cli: CliOptions,
	runOptions: WorkspaceRunOptions,
	workspaceRoot: string,
): WorkspaceReportOptions {
	return {
		color: runOptions.color,
		formatters: runOptions.formatters,
		rootDir: workspaceRoot,
		silent: runOptions.silent,
		verbose: cli.verbose === true,
	};
}

// Counted in packages, not project rows: one package can own several projects,
// and "after 3 packages" reading as 3 when only one package ran would misreport
// how far the run got.
function bailSummary(
	bailedPackages: Array<string> | undefined,
	results: Array<WorkspaceProjectResult>,
): { bail?: BailSummary } {
	if (bailedPackages === undefined || bailedPackages.length === 0) {
		return {};
	}

	const ranPackages = new Set(results.map((entry) => entry.pkg));
	return { bail: { notRun: bailedPackages.length, ran: ranPackages.size } };
}

// Builds the final `WorkspaceRunResult` from the runner's output: the runtime
// project results plus (when present) the merged Type Test result.
function buildWorkspaceResult({
	cli,
	output: { bailedPackages, coverageMs, results, stagingMs, typecheckResult },
	runOptions,
	workspaceRoot,
}: {
	cli: CliOptions;
	output: WorkspaceRunnerOutput;
	runOptions: WorkspaceRunOptions;
	workspaceRoot: string;
}): WorkspaceRunResult {
	// A run with neither runtime results nor a Type Test result tested nothing
	// (no pending specs, typecheck off). `--typecheckOnly` lands here with zero
	// runtime results but a populated `typecheckResult`, so it must not collapse
	// to EMPTY_RESULT.
	if (typecheckResult === undefined && results.length === 0) {
		return EMPTY_RESULT;
	}

	const projectResults: Array<ProjectResult> = results.map((entry) => {
		return {
			displayName: composeEntryDisplayName(entry.pkg, entry.displayName),
			result: entry.result,
		};
	});

	return {
		...resolveWorkspaceCoverage(results),
		...bailSummary(bailedPackages, results),
		// A typecheck-only run stages nothing, so the runner reports neither.
		coverageMs: coverageMs ?? 0,
		merged: {},
		mode: "workspace",
		projectResults,
		reportOptions: resolveReportOptions(cli, runOptions, workspaceRoot),
		stagingMs: stagingMs ?? 0,
		typecheckResult,
		...resolvedSinkPaths(runOptions),
	};
}

/**
 * Build a streaming progress sink when the human formatter is active. Returns
 * undefined for JSON/agent/silent runs — those formatters buffer a single
 * final envelope so live per-package stdout writes would
 * either break the structured output or be silenced anyway.
 */
function resolveStreamingProgressSink({
	cli,
	progress,
	runOptions,
}: {
	cli: CliOptions;
	progress: RunProgress;
	runOptions: WorkspaceRunOptions;
}): StreamingAggregatorOnEntry | undefined {
	if (
		!isDefaultHumanFormatter({
			formatters: runOptions.formatters,
			silent: runOptions.silent,
			verbose: cli.verbose,
		})
	) {
		return undefined;
	}

	// Through the reporter rather than stdout: a live stage block owns the last
	// lines on screen, so a bare write would land inside it and leave the next
	// repaint erasing this line in place of its own rows.
	return (entry) => {
		const line = formatStreamingProgressLine(entry, { color: runOptions.color });
		progress.interleave(() => {
			process.stdout.write(`${line}\n`);
		});
	};
}

// Resolve the backend, emit the run header, and drive the workspace runner,
// always closing the backend afterwards.
async function executeWorkspaceRunAsync({
	cli,
	packageInfos,
	runOptions,
	timing,
	workspaceRoot,
}: ExecuteWorkspaceRunOptions): Promise<WorkspaceRunResult> {
	const resolution = resolveWorkspaceBackend(cli, runOptions);
	if (resolution.error !== undefined) {
		return bail(resolution.error.exitCode, resolution.error.message);
	}

	const { backend, workStealingCredentials } = resolution;
	const progress = timing?.progress ?? NOOP_RUN_PROGRESS;

	let output;
	try {
		emitWorkspaceRunHeader({ cli, progress, runOptions, workspaceRoot });
		output = await runWorkspaceAsync({
			backend,
			cli,
			// Read here, the layer that already reads it to discover the
			// workspace root above it.
			cwd: process.cwd(),
			onStreamingResult: resolveStreamingProgressSink({ cli, progress, runOptions }),
			packageInfos,
			runOptions,
			timing,
			version: VERSION,
			workspaceRoot,
			workStealingCredentials,
		});
	} finally {
		await backend?.closeAsync?.();
	}

	if (output === undefined) {
		return bail(2);
	}

	return buildWorkspaceResult({ cli, output, runOptions, workspaceRoot });
}

// `workspace.packages` (declared in a shared config, anchored absolute root)
// enumerates packages by globbing for jest configs — no package-manager
// workspace file required. Falls back to discovering a pnpm/turbo/nx root.
function resolveEnumerationRoot(workspace?: WorkspaceConfig): EnumerationRoot {
	if (workspace?.packages !== undefined) {
		// The schema's co-requirement check guarantees `root` is present, and
		// the loader resolved it to an absolute path at config load.
		assert(workspace.root !== undefined, "workspace.root is required with workspace.packages");
		return {
			exclude: workspace.exclude,
			patterns: workspace.packages,
			workspaceRoot: workspace.root,
		};
	}

	// `exclude` stands alone: it narrows the pnpm source too, where the root
	// comes from discovery rather than from config.
	return { exclude: workspace?.exclude, workspaceRoot: discoverWorkspaceRoot(process.cwd()) };
}

/**
 * Name the source that came up empty, since the remedy differs: a
 * `workspace.packages` list is the user's own glob to widen, while the pnpm
 * source points back at `pnpm-workspace.yaml`.
 */
function emptyWorkspaceMessage(patterns: Array<string> | undefined): string {
	const source =
		patterns === undefined
			? "Widen pnpm-workspace.yaml, or declare `workspace.packages` in your jest config"
			: "Widen `workspace.packages`";
	return (
		"Error: no packages with a jest.config.* to run in this workspace.\n" +
		`${source}, and check workspace.exclude.\n`
	);
}

function resolvePackages(cli: CliOptions, workspace?: WorkspaceConfig): ResolvedPackages {
	try {
		const { exclude, patterns, workspaceRoot } = resolveEnumerationRoot(workspace);
		const packageInfos = resolveWorkspacePackages(cli, workspaceRoot, { exclude, patterns });

		if (packageInfos.length === 0) {
			// Two ways to select nothing, and they mean opposite things. A
			// change-detected set can legitimately be empty; a workspace with
			// no testable package in it is a misconfiguration, and reporting it
			// as a clean run would hide that behind a green exit.
			return cli.affectedSince !== undefined
				? { noAffected: true }
				: { error: { exitCode: 2, message: emptyWorkspaceMessage(patterns) } };
		}

		return { packageInfos, workspaceRoot };
	} catch (err) {
		return { error: { exitCode: 2, message: `Error: ${String(err)}\n` } };
	}
}
