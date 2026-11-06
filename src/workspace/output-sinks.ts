import assert from "node:assert";
import * as path from "node:path";

import type { WorkspaceRunOptions } from "../config/schema.ts";
import type { ExecuteResult } from "../executor.ts";
import { formatJson } from "../formatters/json.ts";
import { usesAgentFormatter } from "../formatters/utils.ts";
import { mergeProjectResults, mergeResults } from "../output-merge.ts";
import { writeResultFileAsync } from "../output-sinks.ts";
import type { JestResult } from "../types/jest-result-types.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { nodeFileSystem } from "../utils/file-system.ts";
import {
	buildGroupedGameOutput,
	countGroupedEntries,
	formatGameOutputNotice,
	parseGameOutput,
	writeGameOutput,
	writeGroupedGameOutput,
} from "../utils/game-output.ts";
import type { PendingEntry } from "./pending-entry.ts";
import { projectKey } from "./project-key.ts";
import type { TypeTestProject } from "./test-selection.ts";

const PER_PACKAGE_OUTPUT_DIRECTORY = path.join(".jest-roblox", "output");
const FILESYSTEM_UNSAFE = /[^\w@.-]+/g;

interface PerPackageGameOutputFile {
	count: number;
	path: string;
}

interface EmitWorkspaceGameOutputInput {
	fileSystem: FileSystem;
	pending: Array<PendingEntry>;
	results: Array<ExecuteResult>;
	runOptions: WorkspaceRunOptions;
	verbose?: boolean | undefined;
	workspaceRoot: string;
}

// One per-package result file: the merged (runtime ∪ Type Test) result for a
// single (package, project) pair, written as `<pkg>--<project>.jest-output.log`.
interface PerPackageResultEntry {
	pkg: string;
	project: string;
	result: JestResult;
}

interface WorkspaceSinkInput {
	/** Where the sinks are written. Defaults to the real filesystem. */
	fileSystem?: FileSystem | undefined;
	pending: Array<PendingEntry>;
	results: Array<ExecuteResult>;
	runOptions: WorkspaceRunOptions;
	/** Merged Type Test result keyed by package name. */
	typecheckByPackage: Map<string, JestResult>;
	/** Aggregate Type Test result, `undefined` when the pass never ran. */
	typecheckResult: JestResult | undefined;
	typeTestProjects: Array<TypeTestProject>;
	verbose?: boolean | undefined;
	workspaceRoot: string;
}

/**
 * Every sink a workspace run with runtime jobs writes.
 * @param input - Run results, options and Type Test results to write.
 * @returns Resolves once every sink is written.
 */
export async function writeWorkspaceSinksAsync(input: WorkspaceSinkInput): Promise<void> {
	const { pending, results, runOptions, typeTestProjects, workspaceRoot } = input;
	const fileSystem = input.fileSystem ?? nodeFileSystem;

	if (runOptions.workspaceOutputFile) {
		const typeByPackage = input.typecheckByPackage;
		writePerPackageOutputFiles({
			entries: buildPerPackageResults({ pending, results, typeByPackage, typeTestProjects }),
			fileSystem,
			workspaceRoot,
		});
	}

	// Only merge the runtime side when there's a sink to write it to:
	// `mergeProjectResults` folds every project's coverage + source mappers, so
	// computing it for a run without `outputFile` (the common case) is wasted
	// work. `writeResultFile` still owns the merge-and-write across all modes.
	await writeResultFileAsync({
		fileSystem,
		outputFile: runOptions.outputFile,
		rootDir: workspaceRoot,
		runtime:
			runOptions.outputFile !== undefined ? mergeProjectResults(results).result : undefined,
		typecheck: input.typecheckResult,
	});

	emitWorkspaceGameOutput({
		fileSystem,
		pending,
		results,
		runOptions,
		verbose: input.verbose,
		workspaceRoot,
	});
}

/**
 * The `--typecheckOnly` sinks: there is no runtime side, so every per-package
 * file is the package's Type Test result under each of its type-test projects,
 * and no Game Output is produced.
 * @param input - Run options and Type Test results to write.
 * @returns Resolves once every sink is written.
 */
export async function writeTypecheckOnlySinksAsync(
	input: Pick<
		WorkspaceSinkInput,
		| "fileSystem"
		| "runOptions"
		| "typecheckByPackage"
		| "typecheckResult"
		| "typeTestProjects"
		| "workspaceRoot"
	>,
): Promise<void> {
	const { fileSystem = nodeFileSystem } = input;
	await writeResultFileAsync({
		fileSystem,
		outputFile: input.runOptions.outputFile,
		rootDir: input.workspaceRoot,
		runtime: undefined,
		typecheck: input.typecheckResult,
	});

	// Per-package files route through the same writer as the runtime path.
	if (input.runOptions.workspaceOutputFile) {
		writePerPackageOutputFiles({
			entries: buildPerPackageResults({
				pending: [],
				results: [],
				typeByPackage: input.typecheckByPackage,
				typeTestProjects: input.typeTestProjects,
			}),
			fileSystem,
			workspaceRoot: input.workspaceRoot,
		});
	}
}

/**
 * Builds the per-(package, project) files the workspace writes when
 * `workspace.outputFile` is on: each file mirrors the aggregate at finer
 * granularity via the shared `mergeResults`, so the per-package sink can't drift
 * from the aggregate. Runtime pairs come from `pending`/`results`; Type Test
 * pairs reuse each package's whole type result (the tsgo pass collapses a
 * package's projects, so package-level is the finest honest split) under every
 * project that owns Type Tests. A pair present on both sides merges.
 * @param options - Runtime and Type Test results.
 * @param options.pending - Entries in the same order as `results`.
 * @param options.results - Runtime results.
 * @param options.typeByPackage - Type Test result per package name.
 * @param options.typeTestProjects - Projects that own Type Tests.
 * @returns One merged result per (package, project) pair.
 */
function buildPerPackageResults({
	pending,
	results,
	typeByPackage,
	typeTestProjects,
}: {
	readonly pending: Array<PendingEntry>;
	readonly results: Array<ExecuteResult>;
	readonly typeByPackage: Map<string, JestResult>;
	readonly typeTestProjects: Array<TypeTestProject>;
}): Array<PerPackageResultEntry> {
	const byKey = new Map<string, PerPackageResultEntry>();

	for (const [index, result] of results.entries()) {
		// oxlint-disable-next-line typescript/no-non-null-assertion -- runProjects preserves order
		const entry = pending[index]!;
		const { displayName } = entry.project;
		byKey.set(projectKey(entry.pkg, displayName), {
			pkg: entry.pkg,
			project: displayName,
			result: result.result,
		});
	}

	for (const { pkg, project } of typeTestProjects) {
		// Every type-test project's package ran a group, so `byPackage` has it.
		// oxlint-disable-next-line typescript/no-non-null-assertion -- invariant: pkg ran a type pass
		const typeResult = typeByPackage.get(pkg)!;
		const key = projectKey(pkg, project);
		byKey.set(key, {
			pkg,
			project,
			result: mergeResults(typeResult, byKey.get(key)?.result),
		});
	}

	return [...byKey.values()];
}

function sanitizePathSegment(segment: string): string {
	return segment.replace(FILESYSTEM_UNSAFE, "-");
}

function writePerPackageOutputFiles({
	entries,
	fileSystem,
	workspaceRoot,
}: {
	readonly entries: Array<PerPackageResultEntry>;
	readonly fileSystem: FileSystem;
	readonly workspaceRoot: string;
}): void {
	const directory = path.join(workspaceRoot, PER_PACKAGE_OUTPUT_DIRECTORY);
	fileSystem.mkdirSync(directory, { recursive: true });

	for (const entry of entries) {
		const filename = `${sanitizePathSegment(entry.pkg)}--${sanitizePathSegment(
			entry.project,
		)}.jest-output.log`;
		fileSystem.writeFileSync(
			path.join(directory, filename),
			formatJson(entry.result, workspaceRoot),
			"utf8",
		);
	}
}

/**
 * Sibling of writePerPackageOutputFiles; emits a `.game-output.log`
 * companion alongside each (pkg, project) result file under
 * `.jest-roblox/output/`. The path is built absolute against workspaceRoot
 * before calling writeGameOutput — that helper calls path.resolve which
 * would otherwise fall back to process.cwd() and silently mis-route files.
 * Returns each written file's path and entry count so the caller can build
 * notices for the non-empty ones.
 * @param options - Results to write and where.
 * @param options.fileSystem - File system to write through.
 * @param options.pending - Entries in the same order as `results`.
 * @param options.results - Runtime results.
 * @param options.workspaceRoot - Root the output directory resolves against.
 * @returns Path and entry count of each written file.
 */
function writePerPackageGameOutputFiles({
	fileSystem,
	pending,
	results,
	workspaceRoot,
}: {
	readonly fileSystem: FileSystem;
	readonly pending: Array<PendingEntry>;
	readonly results: Array<ExecuteResult>;
	readonly workspaceRoot: string;
}): Array<PerPackageGameOutputFile> {
	const directory = path.join(workspaceRoot, PER_PACKAGE_OUTPUT_DIRECTORY);

	return results.map((result, index) => {
		// oxlint-disable-next-line typescript/no-non-null-assertion -- runProjects preserves order
		const entry = pending[index]!;
		const filename = `${sanitizePathSegment(entry.pkg)}--${sanitizePathSegment(
			entry.project.displayName,
		)}.game-output.log`;
		const filePath = path.join(directory, filename);
		const entries = parseGameOutput(result.gameOutput);
		writeGameOutput({ entries, filePath, fileSystem });
		return { count: entries.length, path: filePath };
	});
}

/**
 * The single grouped Game Output file (top-level `gameOutput`). Returns the
 * notice announcing it so the caller can pick which sink to advertise.
 * @param options - Results to write and where.
 * @param options.aggregatePath - Path of the grouped file.
 * @param options.fileSystem - File system to write through.
 * @param options.pending - Entries in the same order as `results`.
 * @param options.results - Runtime results.
 * @returns The notice that names the written file.
 */
function writeAggregateGameOutput({
	aggregatePath,
	fileSystem,
	pending,
	results,
}: {
	readonly aggregatePath: string;
	readonly fileSystem: FileSystem;
	readonly pending: Array<PendingEntry>;
	readonly results: Array<ExecuteResult>;
}): string {
	const groups = buildGroupedGameOutput(
		results.map((result, index) => {
			const entry = pending[index];
			assert(entry !== undefined, "Pending entry missing for workspace result");
			return {
				package: entry.pkg,
				project: entry.project.displayName,
				raw: result.gameOutput,
			};
		}),
	);
	writeGroupedGameOutput({ filePath: aggregatePath, fileSystem, groups });
	return formatGameOutputNotice(aggregatePath, countGroupedEntries(groups));
}

/**
 * Names one of the two sinks on stderr. An agent formatter prefers the
 * per-package files whenever they were written; every other formatter names
 * them only when there is no aggregate to name instead.
 * @param options - Notices and the formatter choice.
 * @param options.aggregateNotice - Notice for the grouped file, if written.
 * @param options.perPackageNotices - Notices for the per-package files, if written.
 * @param options.runOptions - Run options that name the formatters.
 * @param options.verbose - Whether the run is verbose.
 */
function announceGameOutput({
	aggregateNotice,
	perPackageNotices,
	runOptions,
	verbose = false,
}: {
	aggregateNotice: string | undefined;
	perPackageNotices: Array<string> | undefined;
	runOptions: WorkspaceRunOptions;
	verbose?: boolean | undefined;
}): void {
	if (
		perPackageNotices !== undefined &&
		(aggregateNotice === undefined || usesAgentFormatter(runOptions.formatters, verbose))
	) {
		for (const notice of perPackageNotices) {
			console.error(notice);
		}
	} else if (aggregateNotice !== undefined && aggregateNotice !== "") {
		console.error(aggregateNotice);
	}
}

/**
 * Writes the configured Game Output sinks for a workspace run and announces
 * exactly one of them. Aggregated (single grouped file, top-level
 * `gameOutput`) and Per-package (`.jest-roblox/output/` files,
 * `workspace.gameOutput`) are independent; either, both, or neither may be
 * active. Humans prefer the single aggregate (one place to look); agents
 * prefer the per-package files (smaller, targeted context).
 * @param input - Results, run options and workspace root.
 */
function emitWorkspaceGameOutput({
	fileSystem,
	pending,
	results,
	runOptions,
	verbose,
	workspaceRoot,
}: EmitWorkspaceGameOutputInput): void {
	const aggregatePath = runOptions.gameOutput;
	const aggregateNotice =
		aggregatePath !== undefined
			? writeAggregateGameOutput({
					aggregatePath,
					fileSystem,
					pending,
					results,
				})
			: undefined;

	let perPackageNotices: Array<string> | undefined;
	if (runOptions.workspaceGameOutput) {
		perPackageNotices = writePerPackageGameOutputFiles({
			fileSystem,
			pending,
			results,
			workspaceRoot,
		})
			.map((file) => formatGameOutputNotice(file.path, file.count))
			.filter((notice) => notice !== "");
	}

	if (!runOptions.silent) {
		announceGameOutput({ aggregateNotice, perPackageNotices, runOptions, verbose });
	}
}
