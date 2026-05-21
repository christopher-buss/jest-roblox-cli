import process from "node:process";

import packageJson from "../../package.json" with { type: "json" };
import type { Backend } from "../backends/interface.ts";
import { createOpenCloudBackend, resolveOpenCloudBaseUrl } from "../backends/open-cloud.ts";
import { loadRawConfig } from "../config/loader.ts";
import type { CliOptions, WorkspaceRunOptions } from "../config/schema.ts";
import { buildWorkspaceRunOptions } from "../config/workspace-run-options.ts";
import type { MappedCoverageResult } from "../coverage/mapper.ts";
import { mergeRawCoverage } from "../coverage/merge-raw-coverage.ts";
import type { RawCoverageData } from "../coverage/types.ts";
import { aggregateWorkspaceCoverage } from "../coverage/workspace-aggregate.ts";
import { hasFormatter, usesAgentFormatter } from "../formatters/utils.ts";
import type { StreamingAggregatorOnEntry } from "../reporter/streaming-aggregator.ts";
import { formatStreamingProgressLine } from "../reporter/streaming-progress.ts";
import { runWorkspace, type WorkspaceProjectResult } from "../workspace-runner.ts";
import { discoverWorkspaceRoot } from "../workspace/discovery.ts";
import type { PackageInfo } from "../workspace/package-resolver.ts";
import { resolvePackage } from "../workspace/package-resolver.ts";
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

export async function runWorkspaceMode(cli: CliOptions): Promise<WorkspaceRunResult> {
	const basicValidation = validateBasicWorkspaceFlags(cli);
	if (!basicValidation.ok) {
		return {
			...EMPTY_RESULT,
			validationExitCode: basicValidation.exitCode,
			validationMessage: basicValidation.message,
		};
	}

	const resolved = resolvePackages(cli);
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
		runOptions = buildWorkspaceRunOptions({ cli, perPackageConfigs });
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

	let backend: Backend;
	let workStealingCredentials: { apiKey: string; baseUrl?: string; universeId: string };
	try {
		const credentials = buildWorkspaceCredentials(cli, runOptions);
		backend = createOpenCloudBackend(credentials);
		const baseUrl = resolveOpenCloudBaseUrl();
		workStealingCredentials = {
			apiKey: credentials.apiKey,
			...(baseUrl !== undefined ? { baseUrl } : {}),
			universeId: credentials.universeId,
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			...EMPTY_RESULT,
			validationExitCode: 2,
			validationMessage: `Error: ${message}\n`,
		};
	}

	let runtimeResults;
	try {
		const onStreamingResult = resolveStreamingProgressSink(runOptions, cli);
		runtimeResults = await runWorkspace({
			backend,
			cli,
			...(onStreamingResult !== undefined ? { onStreamingResult } : {}),
			packageInfos,
			runOptions,
			version: VERSION,
			workspaceRoot,
			workStealingCredentials,
		});
	} finally {
		await backend.close?.();
	}

	if (runtimeResults === undefined) {
		return { ...EMPTY_RESULT, validationExitCode: 2 };
	}

	if (runtimeResults.length === 0) {
		return EMPTY_RESULT;
	}

	const projectResults: Array<ProjectResult> = runtimeResults.map((entry) => {
		return {
			displayName: composeWorkspaceDisplayName(entry.pkg, entry.displayName),
			result: entry.result,
		};
	});

	// Drive coverage off per-package manifests, not the workspace-level
	// `collectCoverage`. A package that opted into coverage via its own
	// jest.config will carry a `coverageManifest` here; aggregating
	// regardless of workspace config keeps that report from being dropped.
	const hasCoverage = runtimeResults.some((entry) => entry.coverageManifest !== undefined);
	const coverageMapped = hasCoverage
		? normalizeEmptyCoverage(aggregatePerPackageCoverage(runtimeResults))
		: undefined;

	return {
		coverageMapped,
		merged: {},
		mode: "workspace",
		preCoverageMs: 0,
		projectResults,
	};
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
				manifest: entry.coverageManifest,
				pkg: entry.pkg,
			});
			continue;
		}

		existing.coverageData = mergeRawCoverage(existing.coverageData, entry.result.coverageData);
	}

	return aggregateWorkspaceCoverage([...byPackage.values()]);
}

function resolvePackages(cli: CliOptions): ResolvedPackages {
	try {
		const workspaceRoot = discoverWorkspaceRoot(process.cwd());
		const packageNames = resolveWorkspacePackageNames(cli, workspaceRoot);

		if (packageNames.length === 0) {
			// validateWorkspaceFlags requires --affected-since when --packages
			// produces zero entries, so we can only land here via that branch.
			return { noAffected: true };
		}

		const packageInfos = packageNames.map((name) => resolvePackage(workspaceRoot, name));
		return { packageInfos, workspaceRoot };
	} catch (err) {
		return { error: { exitCode: 2, message: `Error: ${String(err)}\n` } };
	}
}

function composeWorkspaceDisplayName(package_: string, project: string): string {
	return package_ === project ? package_ : `${package_} › ${project}`;
}

/**
 * Build a streaming progress sink when the human formatter is active. Returns
 * undefined for JSON/agent/silent runs — those formatters buffer a single
 * final envelope (per HAL-160 AC#5) so live per-package stdout writes would
 * either break the structured output or be silenced anyway.
 */
function resolveStreamingProgressSink(
	runOptions: WorkspaceRunOptions,
	cli: CliOptions,
): StreamingAggregatorOnEntry | undefined {
	if (runOptions.silent) {
		return undefined;
	}

	if (
		hasFormatter(runOptions.formatters, "json") ||
		usesAgentFormatter(runOptions.formatters, cli.verbose)
	) {
		return undefined;
	}

	return (entry) => {
		const line = formatStreamingProgressLine(entry, { color: runOptions.color });
		process.stdout.write(`${line}\n`);
	};
}
