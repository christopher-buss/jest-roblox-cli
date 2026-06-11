import assert from "node:assert";
import process from "node:process";

import packageJson from "../../package.json" with { type: "json" };
import type { Backend } from "../backends/interface.ts";
import { createOpenCloudBackend, resolveOpenCloudBaseUrl } from "../backends/open-cloud.ts";
import { loadRawConfig } from "../config/loader.ts";
import type { CliOptions, WorkspaceConfig, WorkspaceRunOptions } from "../config/schema.ts";
import { buildWorkspaceRunOptions } from "../config/workspace-run-options.ts";
import type { MappedCoverageResult } from "../coverage/mapper.ts";
import { mergeRawCoverage } from "../coverage/merge-raw-coverage.ts";
import type { RawCoverageData } from "../coverage/types.ts";
import { aggregateWorkspaceCoverage } from "../coverage/workspace-aggregate.ts";
import { isDefaultHumanFormatter } from "../formatters/utils.ts";
import type { StreamingAggregatorOnEntry } from "../reporter/streaming-aggregator.ts";
import { formatStreamingProgressLine } from "../reporter/streaming-progress.ts";
import type { TimingCollector } from "../timing/orchestration-collector.ts";
import {
	runWorkspace,
	type WorkspaceProjectResult,
	type WorkspaceRunnerOutput,
} from "../workspace-runner.ts";
import { discoverWorkspaceRoot } from "../workspace/discovery.ts";
import type { PackageInfo } from "../workspace/package-resolver.ts";
import { resolvePackage } from "../workspace/package-resolver.ts";
import { emitRunHeader } from "./run-header.ts";
import type { ProjectResult, WorkspaceRunResult } from "./types.ts";
import {
	assertWorkspaceRunOptions,
	buildWorkspaceCredentials,
	resolveWorkspacePackageNames,
	validateBasicWorkspaceFlags,
} from "./workspace-validation.ts";

const VERSION: string = packageJson.version;

const EMPTY_RESULT = {
	merged: {},
	mode: "workspace",
	preCoverageMs: 0,
	projectResults: [],
} as const satisfies WorkspaceRunResult;

interface ResolvedPackages {
	error?: { exitCode: 2; message: string };
	noAffected?: true;
	packageInfos?: Array<PackageInfo>;
	workspaceRoot?: string;
}

interface WorkspaceBackendResolution {
	backend?: Backend;
	error?: { exitCode: 2; message: string };
	workStealingCredentials?: { apiKey: string; baseUrl?: string; universeId: string };
}

export async function runWorkspaceMode(
	cli: CliOptions,
	workspace?: WorkspaceConfig,
	timing?: TimingCollector,
): Promise<WorkspaceRunResult> {
	const basicValidation = validateBasicWorkspaceFlags(cli);
	if (!basicValidation.ok) {
		return {
			...EMPTY_RESULT,
			validationExitCode: basicValidation.exitCode,
			validationMessage: basicValidation.message,
		};
	}

	const resolved = resolvePackages(cli, workspace);
	if (resolved.error !== undefined) {
		return {
			...EMPTY_RESULT,
			validationExitCode: resolved.error.exitCode,
			validationMessage: resolved.error.message,
		};
	}

	if (resolved.noAffected === true) {
		process.stdout.write("No affected packages — nothing to test.\n");
		return EMPTY_RESULT;
	}

	// eslint-disable-next-line ts/no-non-null-assertion -- guaranteed when no error/noAffected
	const packageInfos = resolved.packageInfos!;
	// eslint-disable-next-line ts/no-non-null-assertion -- guaranteed when no error/noAffected
	const workspaceRoot = resolved.workspaceRoot!;

	let runOptions: WorkspaceRunOptions;
	try {
		const perPackageConfigs = await Promise.all(
			packageInfos.map(async (info) => {
				return {
					name: info.name,
					config: await loadRawConfig(undefined, info.packageDirectory),
				};
			}),
		);
		runOptions = buildWorkspaceRunOptions({ cli, perPackageConfigs, workspaceRoot });
		const assertion = assertWorkspaceRunOptions(runOptions);
		if (!assertion.ok) {
			return {
				...EMPTY_RESULT,
				validationExitCode: assertion.exitCode,
				validationMessage: assertion.message,
			};
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			...EMPTY_RESULT,
			validationExitCode: 2,
			validationMessage: `Error: ${message}\n`,
		};
	}

	const resolution = resolveWorkspaceBackend(cli, runOptions);
	if (resolution.error !== undefined) {
		return {
			...EMPTY_RESULT,
			validationExitCode: resolution.error.exitCode,
			validationMessage: resolution.error.message,
		};
	}

	const { backend, workStealingCredentials } = resolution;

	let output;
	try {
		// `collectCoverage` is intentionally omitted: workspace coverage is
		// per-package (driven by each package's manifest), so there is no
		// workspace-level flag to surface the "Coverage enabled" subtitle.
		emitRunHeader({
			color: runOptions.color,
			formatters: runOptions.formatters,
			rootDir: workspaceRoot,
			silent: runOptions.silent,
			verbose: cli.verbose,
			version: VERSION,
		});
		const onStreamingResult = resolveStreamingProgressSink(runOptions, cli);
		output = await runWorkspace({
			...(backend !== undefined ? { backend } : {}),
			cli,
			...(onStreamingResult !== undefined ? { onStreamingResult } : {}),
			packageInfos,
			runOptions,
			timing,
			version: VERSION,
			workspaceRoot,
			...(workStealingCredentials !== undefined ? { workStealingCredentials } : {}),
		});
	} finally {
		await backend?.close?.();
	}

	if (output === undefined) {
		return { ...EMPTY_RESULT, validationExitCode: 2 };
	}

	return buildWorkspaceResult(output, runOptions);
}

// Resolves the Open Cloud backend + work-stealing credentials, or an error to
// surface. `--typecheckOnly` is pure-local tsgo — the runner short-circuits
// before any dispatch — so it needs no credentials at all: skip backend
// creation entirely and run with no secrets.
function resolveWorkspaceBackend(
	cli: CliOptions,
	runOptions: WorkspaceRunOptions,
): WorkspaceBackendResolution {
	if (cli.typecheckOnly === true) {
		return {};
	}

	try {
		const credentials = buildWorkspaceCredentials(cli, runOptions);
		const backend = createOpenCloudBackend(credentials);
		const baseUrl = resolveOpenCloudBaseUrl();
		return {
			backend,
			workStealingCredentials: {
				apiKey: credentials.apiKey,
				...(baseUrl !== undefined ? { baseUrl } : {}),
				universeId: credentials.universeId,
			},
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { error: { exitCode: 2, message: `Error: ${message}\n` } };
	}
}

function normalizeEmptyCoverage(mapped: MappedCoverageResult): MappedCoverageResult | undefined {
	return Object.keys(mapped.files).length === 0 ? undefined : mapped;
}

function aggregatePerPackageCoverage(
	runtimeResults: Array<WorkspaceProjectResult>,
): MappedCoverageResult {
	// A package with multiple projects emits one entry per project. Each
	// project runs Jest with its own `_G.__jest_roblox_cov` reset, so the
	// per-entry `coverageData` captures DIFFERENT hits across projects. We
	// must additively merge those maps per pkg (not drop them) before passing
	// one entry per pkg into the mapper — otherwise multi-project packages
	// silently lose coverage from all but the first project.
	interface PackageEntry {
		coverageData: RawCoverageData | undefined;
		ignorePatterns: Array<string> | undefined;
		manifest: NonNullable<WorkspaceProjectResult["coverageManifest"]>;
		pkg: string;
	}

	const byPackage = new Map<string, PackageEntry>();

	for (const entry of runtimeResults) {
		if (entry.coverageManifest === undefined) {
			continue;
		}

		const existing = byPackage.get(entry.pkg);
		if (existing === undefined) {
			byPackage.set(entry.pkg, {
				coverageData: entry.result.coverageData,
				ignorePatterns: entry.coveragePathIgnorePatterns,
				manifest: entry.coverageManifest,
				pkg: entry.pkg,
			});
			continue;
		}

		existing.coverageData = mergeRawCoverage(existing.coverageData, entry.result.coverageData);
	}

	return aggregateWorkspaceCoverage([...byPackage.values()]);
}

// Drive coverage off per-package manifests, not the workspace-level
// `collectCoverage`. A package that opted into coverage via its own jest.config
// carries a `coverageManifest`; aggregating regardless of workspace config keeps
// that report from being dropped.
function resolveWorkspaceCoverageMapped(
	runtimeResults: Array<WorkspaceProjectResult>,
): MappedCoverageResult | undefined {
	const hasCoverage = runtimeResults.some((entry) => entry.coverageManifest !== undefined);
	return hasCoverage
		? normalizeEmptyCoverage(aggregatePerPackageCoverage(runtimeResults))
		: undefined;
}

// Surface the consensus-resolved aggregate sink paths the runner wrote so
// formatters point "View …" hints at files that actually exist.
function resolvedSinkPaths(runOptions: WorkspaceRunOptions): {
	gameOutput?: string;
	outputFile?: string;
} {
	return {
		...(runOptions.gameOutput !== undefined ? { gameOutput: runOptions.gameOutput } : {}),
		...(runOptions.outputFile !== undefined ? { outputFile: runOptions.outputFile } : {}),
	};
}

function composeWorkspaceDisplayName(package_: string, project: string): string {
	return package_ === project ? package_ : `${package_} › ${project}`;
}

// Builds the final `WorkspaceRunResult` from the runner's output: the runtime
// project results plus (when present) the merged Type Test result.
function buildWorkspaceResult(
	output: WorkspaceRunnerOutput,
	runOptions: WorkspaceRunOptions,
): WorkspaceRunResult {
	const { results, typecheckResult } = output;

	// A run with neither runtime results nor a Type Test result tested nothing
	// (no pending specs, typecheck off). `--typecheckOnly` lands here with zero
	// runtime results but a populated `typecheckResult`, so it must not collapse
	// to EMPTY_RESULT.
	if (results.length === 0 && typecheckResult === undefined) {
		return EMPTY_RESULT;
	}

	const projectResults: Array<ProjectResult> = results.map((entry) => {
		return {
			displayName: composeWorkspaceDisplayName(entry.pkg, entry.displayName),
			result: entry.result,
		};
	});

	return {
		coverageMapped: resolveWorkspaceCoverageMapped(results),
		merged: {},
		mode: "workspace",
		preCoverageMs: 0,
		projectResults,
		...(typecheckResult !== undefined ? { typecheckResult } : {}),
		...resolvedSinkPaths(runOptions),
	};
}

// `workspace.packages` (declared in a shared config, anchored absolute root)
// enumerates packages by globbing for jest configs — no package-manager
// workspace file required. Falls back to discovering a pnpm/turbo/nx root.
function resolveEnumerationRoot(workspace?: WorkspaceConfig): {
	patterns?: Array<string>;
	workspaceRoot: string;
} {
	if (workspace?.packages !== undefined) {
		// The schema's co-requirement check guarantees `root` is present, and
		// the loader resolved it to an absolute path at config load.
		assert(workspace.root !== undefined, "workspace.root is required with workspace.packages");
		return { patterns: workspace.packages, workspaceRoot: workspace.root };
	}

	return { workspaceRoot: discoverWorkspaceRoot(process.cwd()) };
}

function resolvePackages(cli: CliOptions, workspace?: WorkspaceConfig): ResolvedPackages {
	try {
		const { patterns, workspaceRoot } = resolveEnumerationRoot(workspace);
		const packageNames = resolveWorkspacePackageNames(cli, workspaceRoot);

		if (packageNames.length === 0) {
			// validateWorkspaceFlags requires --affected-since when --packages
			// produces zero entries, so we can only land here via that branch.
			return { noAffected: true };
		}

		const packageInfos = packageNames.map((name) =>
			resolvePackage(workspaceRoot, name, patterns),
		);
		return { packageInfos, workspaceRoot };
	} catch (err) {
		return { error: { exitCode: 2, message: `Error: ${String(err)}\n` } };
	}
}

/**
 * Build a streaming progress sink when the human formatter is active. Returns
 * undefined for JSON/agent/silent runs — those formatters buffer a single
 * final envelope so live per-package stdout writes would
 * either break the structured output or be silenced anyway.
 */
function resolveStreamingProgressSink(
	runOptions: WorkspaceRunOptions,
	cli: CliOptions,
): StreamingAggregatorOnEntry | undefined {
	if (
		!isDefaultHumanFormatter({
			formatters: runOptions.formatters,
			silent: runOptions.silent,
			verbose: cli.verbose,
		})
	) {
		return undefined;
	}

	return (entry) => {
		const line = formatStreamingProgressLine(entry, { color: runOptions.color });
		process.stdout.write(`${line}\n`);
	};
}
