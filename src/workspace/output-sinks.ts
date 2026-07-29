import assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

import type { WorkspaceRunOptions } from "../config/schema.ts";
import type { ExecuteResult } from "../executor.ts";
import { usesAgentFormatter } from "../formatters/utils.ts";
import { mergeProjectResults, mergeResults, writeResultFileAsync } from "../output.ts";
import type { JestResult } from "../types/jest-result.ts";
import {
	buildGroupedGameOutput,
	countGroupedEntries,
	formatGameOutputNotice,
	parseGameOutput,
	writeGameOutput,
	writeGroupedGameOutput,
} from "../utils/game-output.ts";
import type { PendingEntry, TypeTestProject } from "./test-selection.ts";

const PER_PACKAGE_OUTPUT_DIRECTORY = path.join(".jest-roblox", "output");
const FILESYSTEM_UNSAFE = /[^\w@.-]+/g;

interface PerPackageGameOutputFile {
	count: number;
	path: string;
}

interface EmitWorkspaceGameOutputInput {
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

/** Every sink a workspace run with runtime jobs writes. */
export async function writeWorkspaceSinksAsync(input: WorkspaceSinkInput): Promise<void> {
	const { pending, results, runOptions, typeTestProjects, workspaceRoot } = input;

	if (runOptions.workspaceOutputFile) {
		writePerPackageOutputFiles(
			workspaceRoot,
			buildPerPackageResults(pending, results, input.typecheckByPackage, typeTestProjects),
		);
	}

	// Only merge the runtime side when there's a sink to write it to:
	// `mergeProjectResults` folds every project's coverage + source mappers, so
	// computing it for a run without `outputFile` (the common case) is wasted
	// work. `writeResultFile` still owns the merge-and-write across all modes.
	await writeResultFileAsync(
		runOptions.outputFile,
		input.typecheckResult,
		runOptions.outputFile !== undefined ? mergeProjectResults(results).result : undefined,
	);

	emitWorkspaceGameOutput({
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
 */
export async function writeTypecheckOnlySinksAsync(
	input: Pick<
		WorkspaceSinkInput,
		| "runOptions"
		| "typecheckByPackage"
		| "typecheckResult"
		| "typeTestProjects"
		| "workspaceRoot"
	>,
): Promise<void> {
	await writeResultFileAsync(input.runOptions.outputFile, input.typecheckResult, undefined);

	// Per-package files route through the same writer as the runtime path.
	if (input.runOptions.workspaceOutputFile) {
		writePerPackageOutputFiles(
			input.workspaceRoot,
			buildPerPackageResults([], [], input.typecheckByPackage, input.typeTestProjects),
		);
	}
}

// JSON-encode the `(pkg, project)` pair so neither segment's content can collide
// into another pair's key (parity with `groupTypecheckByTsconfig`).
function projectKey(packageName: string, project: string): string {
	return JSON.stringify([packageName, project]);
}

// Builds the per-(package, project) files the workspace writes when
// `workspace.outputFile` is on: each file mirrors the aggregate at finer
// granularity via the shared `mergeResults`, so the per-package sink can't drift
// from the aggregate. Runtime pairs come from `pending`/`results`; Type Test
// pairs reuse each package's whole type result (the tsgo pass collapses a
// package's projects, so package-level is the finest honest split) under every
// project that owns Type Tests. A pair present on both sides merges.
function buildPerPackageResults(
	pending: Array<PendingEntry>,
	results: Array<ExecuteResult>,
	typeByPackage: Map<string, JestResult>,
	typeTestProjects: Array<TypeTestProject>,
): Array<PerPackageResultEntry> {
	const byKey = new Map<string, PerPackageResultEntry>();

	for (const [index, result] of results.entries()) {
		// eslint-disable-next-line ts/no-non-null-assertion -- runProjects preserves order
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
		// eslint-disable-next-line ts/no-non-null-assertion -- invariant: pkg ran a type pass
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

function writePerPackageOutputFiles(
	workspaceRoot: string,
	entries: Array<PerPackageResultEntry>,
): void {
	const directory = path.join(workspaceRoot, PER_PACKAGE_OUTPUT_DIRECTORY);
	fs.mkdirSync(directory, { recursive: true });

	for (const entry of entries) {
		const filename = `${sanitizePathSegment(entry.pkg)}--${sanitizePathSegment(
			entry.project,
		)}.jest-output.log`;
		fs.writeFileSync(
			path.join(directory, filename),
			JSON.stringify(entry.result, null, 2),
			"utf8",
		);
	}
}

// Sibling of writePerPackageOutputFiles; emits a `.game-output.log`
// companion alongside each (pkg, project) result file under
// `.jest-roblox/output/`. The path is built absolute against workspaceRoot
// before calling writeGameOutput — that helper calls path.resolve which
// would otherwise fall back to process.cwd() and silently mis-route files.
// Returns each written file's path and entry count so the caller can build
// notices for the non-empty ones.
function writePerPackageGameOutputFiles(
	workspaceRoot: string,
	pending: Array<PendingEntry>,
	results: Array<ExecuteResult>,
): Array<PerPackageGameOutputFile> {
	const directory = path.join(workspaceRoot, PER_PACKAGE_OUTPUT_DIRECTORY);

	return results.map((result, index) => {
		// eslint-disable-next-line ts/no-non-null-assertion -- runProjects preserves order
		const entry = pending[index]!;
		const filename = `${sanitizePathSegment(entry.pkg)}--${sanitizePathSegment(
			entry.project.displayName,
		)}.game-output.log`;
		const filePath = path.join(directory, filename);
		const entries = parseGameOutput(result.gameOutput);
		writeGameOutput(filePath, entries);
		return { count: entries.length, path: filePath };
	});
}

// The single grouped Game Output file (top-level `gameOutput`). Returns the
// notice announcing it so the caller can pick which sink to advertise.
function writeAggregateGameOutput(
	aggregatePath: string,
	pending: Array<PendingEntry>,
	results: Array<ExecuteResult>,
): string {
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
	writeGroupedGameOutput(aggregatePath, groups);
	return formatGameOutputNotice(aggregatePath, countGroupedEntries(groups));
}

// Writes the configured Game Output sinks for a workspace run and announces
// exactly one of them. Aggregated (single grouped file, top-level
// `gameOutput`) and Per-package (`.jest-roblox/output/` files,
// `workspace.gameOutput`) are independent; either, both, or neither may be
// active. Humans prefer the single aggregate (one place to look); agents
// prefer the per-package files (smaller, targeted context).
function emitWorkspaceGameOutput({
	pending,
	results,
	runOptions,
	verbose,
	workspaceRoot,
}: EmitWorkspaceGameOutputInput): void {
	const aggregatePath = runOptions.gameOutput;
	const aggregateNotice =
		aggregatePath !== undefined
			? writeAggregateGameOutput(aggregatePath, pending, results)
			: "";

	let perPackageNotices: Array<string> = [];
	if (runOptions.workspaceGameOutput) {
		perPackageNotices = writePerPackageGameOutputFiles(workspaceRoot, pending, results)
			.map((file) => formatGameOutputNotice(file.path, file.count))
			.filter((notice) => notice !== "");
	}

	if (runOptions.silent) {
		return;
	}

	const isAggregateActive = aggregatePath !== undefined;
	const isPerPackageActive = runOptions.workspaceGameOutput;
	const shouldPreferPerPackage = usesAgentFormatter(runOptions.formatters, verbose);

	const shouldAnnouncePerPackage = shouldPreferPerPackage
		? isPerPackageActive
		: !isAggregateActive && isPerPackageActive;

	if (shouldAnnouncePerPackage) {
		for (const notice of perPackageNotices) {
			console.error(notice);
		}
	} else if (isAggregateActive && aggregateNotice !== "") {
		console.error(aggregateNotice);
	}
}
