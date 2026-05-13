import process from "node:process";

import packageJson from "../../package.json" with { type: "json" };
import type { Backend } from "../backends/interface.ts";
import { createOpenCloudBackend, resolveOpenCloudBaseUrl } from "../backends/open-cloud.ts";
import type { ResolvedConfig } from "../config/schema.ts";
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
import type { ProjectResult, RunOptions, WorkspaceRunResult } from "./types.ts";
import {
	buildWorkspaceCredentials,
	resolveWorkspacePackageNames,
	validateWorkspaceFlags,
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

export async function runWorkspaceMode(options: RunOptions): Promise<WorkspaceRunResult> {
	const { cli, config } = options;

	const validation = validateWorkspaceFlags(cli, config);
	if (!validation.ok) {
		return {
			...EMPTY_RESULT,
			validationExitCode: validation.exitCode,
			validationMessage: validation.message,
		};
	}

	const resolved = resolvePackages(options);
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

	let backend: Backend;
	let workStealingCredentials: { apiKey: string; baseUrl?: string; universeId: string };
	try {
		const credentials = buildWorkspaceCredentials(cli, config);
		backend = createOpenCloudBackend(credentials);
		const baseUrl = resolveOpenCloudBaseUrl();
		workStealingCredentials = {
			apiKey: credentials.apiKey,
			...(baseUrl !== undefined ? { baseUrl } : {}),
			universeId: credentials.universeId,
		};
	} catch (err) {
		return {
			...EMPTY_RESULT,
			validationExitCode: 2,
			validationMessage: `Error: ${String(err)}\n`,
		};
	}

	let runtimeResults;
	try {
		const onStreamingResult = resolveStreamingProgressSink(config);
		runtimeResults = await runWorkspace({
			backend,
			cli,
			config,
			...(onStreamingResult !== undefined ? { onStreamingResult } : {}),
			// eslint-disable-next-line ts/no-non-null-assertion -- guaranteed when no error/noAffected
			packageInfos: resolved.packageInfos!,
			version: VERSION,
			// eslint-disable-next-line ts/no-non-null-assertion -- guaranteed when no error/noAffected
			workspaceRoot: resolved.workspaceRoot!,
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

	const coverageMapped = config.collectCoverage
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

function resolvePackages(options: RunOptions): ResolvedPackages {
	const { cli } = options;
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
	config: ResolvedConfig,
): StreamingAggregatorOnEntry | undefined {
	if (config.silent) {
		return undefined;
	}

	if (hasFormatter(config, "json") || usesAgentFormatter(config)) {
		return undefined;
	}

	return (entry) => {
		const line = formatStreamingProgressLine(entry, { color: config.color });
		process.stdout.write(`${line}\n`);
	};
}
