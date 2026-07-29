import * as fs from "node:fs";
import * as path from "node:path";
import process from "node:process";

import type { Backend } from "./backends/interface.ts";
import type { CliOptions, WorkspaceRunOptions } from "./config/schema.ts";
import type { ExecuteResult } from "./executor.ts";
import type { StreamingAggregatorOnEntry } from "./reporter/streaming-aggregator.ts";
import { NOOP_TIMING_COLLECTOR, type TimingCollector } from "./timing/orchestration-collector.ts";
import { attachCoverageManifests } from "./workspace/coverage-attach.ts";
import { prepareWorkspaceDispatchAsync, runDispatchedProjectsAsync } from "./workspace/dispatch.ts";
import { ensurePackageDirectories } from "./workspace/ensure-paths.ts";
import { writeWorkspaceSinksAsync } from "./workspace/output-sinks.ts";
import { type LoadedPackage, loadWorkspacePackagesAsync } from "./workspace/package-loader.ts";
import type { PackageInfo } from "./workspace/package-resolver.ts";
import { stageWorkspacePlace } from "./workspace/place-staging.ts";
import { type PreflightError, validatePackages } from "./workspace/preflight.ts";
import { resolvePackageContextsAsync } from "./workspace/project-contexts.ts";
import { selectWorkspaceTests, type WorkspaceTestSelection } from "./workspace/test-selection.ts";
import {
	attachTypecheck,
	runTypecheckOnlyWorkspaceAsync,
	runWorkspaceTypecheckPassAsync,
	type WorkspaceRunnerOutput,
	type WorkspaceTypecheckPass,
} from "./workspace/typecheck-pass.ts";

export type { WorkspaceProjectResult } from "./workspace/coverage-attach.ts";
export type { WorkspaceRunnerOutput } from "./workspace/typecheck-pass.ts";

const WORKSPACE_CACHE_DIRECTORY = path.join(".jest-roblox", "workspace");

export interface RunWorkspaceOptions {
	/**
	 * Open Cloud backend for the runtime dispatch. Optional: `--typecheckOnly`
	 * runs pure-local tsgo and short-circuits before any dispatch, so the
	 * caller omits the backend (and its credentials) entirely for type-only
	 * runs.
	 */
	backend?: Backend | undefined;
	cli: CliOptions;
	/**
	 * When provided, called once per newly-observed streaming result as
	 * packages complete (work-stealing mode only). The intended consumer is
	 * the human formatter, which uses this hook to flush per-package output
	 * to stdout as it lands. Omit for buffering formatters (JSON) so the
	 * final envelope is built once at task end.
	 */
	onStreamingResult?: StreamingAggregatorOnEntry | undefined;
	packageInfos: Array<PackageInfo>;
	/**
	 * Per-invocation knobs resolved by `buildWorkspaceRunOptions` —
	 * CLI > per-package consensus > defaults. The workspace runner does
	 * NOT read jest-shaped fields here; per-package config (loaded inside
	 * `loadWorkspacePackages`) is the source of truth for those.
	 */
	runOptions: WorkspaceRunOptions;
	/**
	 * Span-tree profiler created at the top of `runJestRoblox`. The
	 * workspace runner does NOT flush — the caller owns the lifecycle so a
	 * single `[TIMING]` waterfall covers the whole invocation rather than
	 * emitting a half-tree if a downstream phase throws. Optional so direct
	 * test seams keep working; production callers always pass one.
	 */
	timing?: TimingCollector | undefined;
	version: string;
	workspaceRoot: string;
	/**
	 * Credentials used to coordinate work-stealing across parallel OCALE
	 * tasks via a memory-store queue. When provided alongside
	 * `cli.parallel > 1`, the workspace runner pushes every (pkg, project)
	 * onto a per-run UUID queue and the backend fires N tasks all running
	 * the same materializer script. Without it (or with parallel=1) the
	 * runner uses the existing single-task embedded-entries path.
	 */
	workStealingCredentials?: { apiKey: string; baseUrl?: string; universeId: string };
}

interface WorkspaceRuntimeInput {
	cacheDirectory: string;
	loaded: Array<LoadedPackage>;
	options: RunWorkspaceOptions;
	selection: WorkspaceTestSelection;
	startTime: number;
	timing: TimingCollector;
}

export async function runWorkspaceAsync(
	options: RunWorkspaceOptions,
): Promise<undefined | WorkspaceRunnerOutput> {
	return runWorkspaceProfiledAsync(options, options.timing ?? NOOP_TIMING_COLLECTOR);
}

async function executeWorkspaceRunAsync({
	options,
	placeFile,
	selection,
	startTime,
	timing,
}: WorkspaceRuntimeInput & { placeFile: string }): Promise<{
	results: Array<ExecuteResult>;
	typecheckPass: WorkspaceTypecheckPass;
}> {
	const { pending, typecheckByDirectory, typeTestEntries } = selection;

	const dispatchSpec = await timing.profileAsync("prepareDispatch", async () => {
		return prepareWorkspaceDispatchAsync({
			onStreamingResult: options.onStreamingResult,
			parallel: options.runOptions.parallel,
			pending,
			placeFile,
			workStealingCredentials: options.workStealingCredentials,
		});
	});

	// The grouped tsgo pass depends only on the filesystem (discovery already
	// ran), so it overlaps the network-bound Open Cloud upload/poll. Await both,
	// then record the tsgo span — the collector's LIFO stack is not
	// concurrency-safe, so the pass times itself and the span lands after the
	// barrier (same caveat as single/multi).
	const [results, typecheckPass] = await Promise.all([
		runDispatchedProjectsAsync({
			backend: options.backend,
			dispatchSpec,
			pending,
			placeFile,
			startTime,
			timing,
			version: options.version,
		}),
		runWorkspaceTypecheckPassAsync(typeTestEntries, typecheckByDirectory),
	]);

	return { results, typecheckPass };
}

async function runWorkspaceRuntimeAsync(
	input: WorkspaceRuntimeInput,
): Promise<WorkspaceRunnerOutput> {
	const { options, selection, timing } = input;
	const { coverageByPackage, placeFile } = stageWorkspacePlace({
		cacheDirectory: input.cacheDirectory,
		loaded: input.loaded,
		selection,
		timing,
		workspaceRoot: options.workspaceRoot,
	});

	const { results, typecheckPass } = await executeWorkspaceRunAsync({ ...input, placeFile });

	await writeWorkspaceSinksAsync({
		pending: selection.pending,
		results,
		runOptions: options.runOptions,
		typecheckByPackage: typecheckPass.byPackage,
		typecheckResult: typecheckPass.outcome.result,
		typeTestProjects: selection.typeTestProjects,
		verbose: options.cli.verbose,
		workspaceRoot: options.workspaceRoot,
	});

	return attachTypecheck(
		attachCoverageManifests(results, selection.pending, coverageByPackage),
		typecheckPass.outcome,
		timing,
	);
}

// No runtime jobs. With Type Tests present (`--typecheckOnly`, or type-test-only
// packages), skip instrumentation, the synthesized place build, and Open Cloud
// dispatch entirely — run only the host-side type pass and return it. Without
// Type Tests, nothing to test.
async function runWorkspaceNoRuntimeAsync(
	options: RunWorkspaceOptions,
	selection: WorkspaceTestSelection,
	timing: TimingCollector,
): Promise<WorkspaceRunnerOutput> {
	if (selection.typeTestEntries.length === 0) {
		return { results: [] };
	}

	return runTypecheckOnlyWorkspaceAsync({
		runOptions: options.runOptions,
		timing,
		typecheckByDirectory: selection.typecheckByDirectory,
		typeTestEntries: selection.typeTestEntries,
		typeTestProjects: selection.typeTestProjects,
		workspaceRoot: options.workspaceRoot,
	});
}

function writePreflightErrors(errors: Array<PreflightError>): void {
	process.stderr.write("Pre-flight validation failed:\n");
	for (const error of errors) {
		process.stderr.write(`  ${error.package}: ${error.reason}\n`);
	}
}

function runWorkspacePreflight(loaded: Array<LoadedPackage>): boolean {
	const descriptors = loaded.map((entry) => entry.descriptor);
	ensurePackageDirectories(descriptors);

	const errors = validatePackages(descriptors);
	if (errors.length === 0) {
		return true;
	}

	writePreflightErrors(errors);
	return false;
}

function reportTestSelectionErrors(selection: WorkspaceTestSelection): void {
	for (const error of selection.emptyPackageErrors) {
		process.stderr.write(`${error}\n`);
	}
}

function createWorkspaceCacheDirectory(workspaceRoot: string): string {
	const cacheDirectory = path.join(workspaceRoot, WORKSPACE_CACHE_DIRECTORY);
	fs.mkdirSync(cacheDirectory, { recursive: true });
	return cacheDirectory;
}

async function runWorkspaceProfiledAsync(
	options: RunWorkspaceOptions,
	timing: TimingCollector,
): Promise<undefined | WorkspaceRunnerOutput> {
	const { cli, packageInfos, workspaceRoot } = options;
	const startTime = Date.now();

	// Load each package's config FIRST so that per-package `rojoProject`
	// declarations override the workspace default. Building the descriptor
	// (and the path preflight uses) before loadConfig pinned every package
	// to the parent's rojo file.
	const loaded = await timing.profileAsync("loadPackages", async () => {
		return loadWorkspacePackagesAsync({ cli, packageInfos, timing });
	});

	if (!runWorkspacePreflight(loaded)) {
		return undefined;
	}

	const cacheDirectory = createWorkspaceCacheDirectory(workspaceRoot);

	const contexts = await timing.profileAsync("resolveContexts", async () => {
		return resolvePackageContextsAsync({ cacheDirectory, loaded });
	});

	const selection = timing.profile("discoverTests", () => selectWorkspaceTests(contexts, cli));
	if (selection.emptyPackageErrors.length > 0) {
		reportTestSelectionErrors(selection);
		return undefined;
	}

	if (selection.pending.length === 0) {
		return runWorkspaceNoRuntimeAsync(options, selection, timing);
	}

	return runWorkspaceRuntimeAsync({
		cacheDirectory,
		loaded,
		options,
		selection,
		startTime,
		timing,
	});
}
