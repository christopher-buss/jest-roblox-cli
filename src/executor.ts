import { resolveNestedProjects } from "@isentinel/rojo-utils";

import { type } from "arktype";
import { getTsconfig } from "get-tsconfig";
import * as fs from "node:fs";
import * as path from "node:path";
import process from "node:process";
import color from "tinyrainbow";

import { buildProjectResult } from "./backends/envelope.ts";
import type {
	Backend,
	BackendTiming,
	ProjectBackendResult,
	ProjectJob,
	StreamingHooks,
} from "./backends/interface.ts";
import { applySnapshotFormatDefaults } from "./config/loader.ts";
import type { ResolvedConfig } from "./config/schema.ts";
import type { CoverageManifest, RawCoverageData } from "./coverage/types.ts";
import { formatAgent } from "./formatters/agent.ts";
import { formatResult } from "./formatters/formatter.ts";
import { formatJson } from "./formatters/json.ts";
import {
	type AgentFormatterOptions,
	DEFAULT_MAX_FAILURES,
	findFormatterOptions,
} from "./formatters/utils.ts";
import type { SnapshotWrites } from "./reporter/parser.ts";
import { createSnapshotPathResolver } from "./snapshot/path-resolver.ts";
import { createSourceMapper, type SourceMapper } from "./source-mapper/index.ts";
import type { JestResult, TestFileResult } from "./types/jest-result.ts";
import { rojoProjectSchema } from "./types/rojo.ts";
import type { TimingResult } from "./types/timing.ts";
import type { TsconfigMapping } from "./types/tsconfig.ts";
import { formatBanner } from "./utils/banner.ts";
import { normalizeWindowsPath } from "./utils/normalize-windows-path.ts";

export interface ExecuteResult {
	coverageData?: RawCoverageData;
	exitCode: number;
	gameOutput?: string;
	output: string;
	result: JestResult;
	snapshotWriteFailures?: number;
	sourceMapper?: SourceMapper;
	timing: TimingResult;
}

export interface FormatOutputOptions {
	config: ResolvedConfig;
	result: JestResult;
	snapshotWriteFailures?: number;
	sourceMapper?: SourceMapper;
	timing: TimingResult;
	version: string;
}

export interface SnapshotWriteCounts {
	attempted: number;
	failed: number;
	written: number;
}

export interface TsconfigDirectories {
	outDir: string | undefined;
	rootDir: string | undefined;
}

export interface ProjectInput {
	config: ResolvedConfig;
	displayColor?: string;
	displayName?: string;
	pkg?: string;
	testFiles: Array<string>;
}

export interface RunProjectsOptions {
	backend: Backend;
	deferFormatting?: boolean;
	parallel?: "auto" | number;
	projects: Array<ProjectInput>;
	scriptOverride?: string;
	startTime: number;
	streaming?: StreamingHooks;
	version: string;
	workStealing?: boolean;
}

export interface RunProjectsResult {
	backendTiming: BackendTiming;
	results: Array<ExecuteResult>;
}

interface ProcessProjectOptions {
	backendTiming: BackendTiming;
	config: ResolvedConfig;
	deferFormatting?: boolean;
	startTime: number;
	version: string;
}

interface TsconfigCompilerOptions {
	outDir?: string;
	rootDir?: null | string;
	rootDirs?: Array<string>;
}

export function isLuauProject(
	testFiles: ReadonlyArray<string>,
	tsconfigMappings: ReadonlyArray<TsconfigMapping>,
): boolean {
	if (tsconfigMappings.length > 0) {
		return false;
	}

	if (testFiles.some((file) => /\.tsx?$/.test(file))) {
		return false;
	}

	return true;
}

export function readTsconfigMapping(tsconfigPath: string): TsconfigDirectories | undefined {
	try {
		const raw = JSON.parse(fs.readFileSync(tsconfigPath, "utf-8")) as {
			compilerOptions?: TsconfigCompilerOptions;
		};
		if (raw.compilerOptions === undefined) {
			return undefined;
		}

		const mappings = parseTsconfigMappings(raw.compilerOptions);
		return mappings[0];
	} catch {
		return undefined;
	}
}

export function resolveAllTsconfigMappings(projectRoot: string): Array<TsconfigMapping> {
	const resolvedRoot = path.resolve(projectRoot);
	let files: Array<string>;
	try {
		files = fs.readdirSync(resolvedRoot).filter((file) => /^tsconfig.*\.json$/i.test(file));
	} catch {
		return [];
	}

	const seen = new Set<string>();
	const mappings: Array<TsconfigMapping> = [];

	for (const file of files) {
		const tsconfig = getTsconfig(resolvedRoot, file);
		const compilerOptions = tsconfig?.config.compilerOptions as
			| TsconfigCompilerOptions
			| undefined;
		if (compilerOptions?.outDir === undefined) {
			continue;
		}

		const parsed = parseTsconfigMappings(compilerOptions);
		for (const entry of parsed) {
			const key = `${entry.outDir}:${entry.rootDir}`;
			if (!seen.has(key)) {
				seen.add(key);
				mappings.push(entry);
			}
		}
	}

	// Longest outDir first for correct prefix matching
	mappings.sort((a, b) => b.outDir.length - a.outDir.length);

	return mappings;
}

export function resolveTsconfigDirectories(projectRoot: string): TsconfigDirectories {
	// Prefer tsconfig.lib.json (roblox-ts compilation config with correct outDir)
	// over tsconfig.json (which may point to type-checking outDir like out-tsc/)
	const tsconfig = getTsconfig(projectRoot, "tsconfig.lib.json") ?? getTsconfig(projectRoot);

	// Only use tsconfig if it lives within the project root — ignore
	// parent-directory tsconfigs that getTsconfig walks up to find.
	const tsconfigDirectory =
		tsconfig !== null ? path.dirname(path.resolve(tsconfig.path)) : undefined;
	const resolvedRoot = path.resolve(projectRoot);
	const isLocal = tsconfigDirectory?.startsWith(resolvedRoot) === true;

	if (!isLocal || tsconfig?.config.compilerOptions === undefined) {
		return { outDir: undefined, rootDir: undefined };
	}

	const outDirectory = tsconfig.config.compilerOptions.outDir ?? "out";
	const rootDirectory = tsconfig.config.compilerOptions.rootDir ?? "src";

	return {
		outDir: normalizeDirectoryPath(outDirectory),
		rootDir: normalizeDirectoryPath(rootDirectory),
	};
}

export function formatExecuteOutput(options: FormatOutputOptions): string {
	const { config, result, snapshotWriteFailures, sourceMapper, timing, version } = options;

	if (config.silent) {
		return "";
	}

	const resolvedOutputFile =
		config.outputFile !== undefined ? path.resolve(config.outputFile) : undefined;
	const resolvedGameOutput =
		config.gameOutput !== undefined ? path.resolve(config.gameOutput) : undefined;

	const agentOptions = findFormatterOptions(config.formatters ?? [], "agent") as
		| AgentFormatterOptions
		| undefined;

	if (agentOptions !== undefined && !config.verbose) {
		const maxFailures = agentOptions.maxFailures ?? DEFAULT_MAX_FAILURES;

		return formatAgent(result, {
			gameOutput: resolvedGameOutput,
			maxFailures,
			outputFile: resolvedOutputFile,
			rootDir: config.rootDir,
			sourceMapper,
		});
	}

	const jsonOptions = findFormatterOptions(config.formatters ?? [], "json");
	if (jsonOptions !== undefined) {
		return formatJson(result);
	}

	return formatResult(result, timing, {
		collectCoverage: config.collectCoverage,
		color: config.color,
		gameOutput: resolvedGameOutput,
		outputFile: resolvedOutputFile,
		rootDir: config.rootDir,
		showLuau: config.showLuau,
		slowTestThreshold: config.slowTestThreshold,
		snapshotWriteFailures,
		sourceMapper,
		verbose: config.verbose,
		version,
	});
}

/**
 * Unified orchestration entry point: builds jobs for every input project,
 * dispatches them through the backend in one call, shapes each raw envelope
 * entry into a `ProjectBackendResult`, then maps each through per-project
 * post-processing. Single-, multi-, and workspace-run callers all funnel
 * through here so the build→execute→shape→process sequence lives in
 * exactly one place.
 *
 * Ordering contract: the returned `results` array is in the same order as
 * `options.projects`. Backends MUST return `rawResults` in the same order
 * as the submitted `jobs` envelope — `runProjects` indexes into `jobs[i]`
 * to recover each project's resolved config and pair it with the matching
 * raw entry, so out-of-order results would post-process with the wrong
 * config.
 */
export async function runProjects(options: RunProjectsOptions): Promise<RunProjectsResult> {
	const jobs = options.projects.map((project) => buildProjectJob(project));

	const { rawResults, timing: backendTiming } = await options.backend.runTests({
		jobs,
		parallel: options.parallel,
		scriptOverride: options.scriptOverride,
		streaming: options.streaming,
		workStealing: options.workStealing,
	});

	if (rawResults.length !== jobs.length) {
		throw new Error(
			`Backend returned ${rawResults.length.toString()} results for ${jobs.length.toString()} jobs — rawResults must be parallel to jobs`,
		);
	}

	const results = rawResults.map((raw, index) => {
		// eslint-disable-next-line ts/no-non-null-assertion -- length equality asserted above
		const job = jobs[index]!;
		const projectResult = buildProjectResult(raw.entry, job, raw.fallbackGameOutput);
		return processProjectResult(projectResult, {
			backendTiming,
			config: job.config,
			deferFormatting: options.deferFormatting,
			startTime: options.startTime,
			version: options.version,
		});
	});

	return { backendTiming, results };
}

function normalizeDirectoryPath(directory: string): string {
	return normalizeWindowsPath(path.normalize(directory));
}

function parseTsconfigMappings(options: TsconfigCompilerOptions): Array<TsconfigMapping> {
	const outDirectory = normalizeDirectoryPath(options.outDir ?? "out");

	if (options.rootDirs !== undefined && options.rootDirs.length > 0) {
		// rootDirs creates a virtual merged root. Output preserves directory
		// names relative to their common ancestor. Compute the common ancestor
		// as the effective rootDir.
		const normalized = options.rootDirs.map((directory) => normalizeDirectoryPath(directory));
		const commonAncestor = normalized.reduce((ancestor, directory) => {
			const parts = ancestor.split("/");
			const directoryParts = directory.split("/");
			let common = 0;
			while (
				common < parts.length &&
				common < directoryParts.length &&
				parts[common] === directoryParts[common]
			) {
				common++;
			}

			return parts.slice(0, common).join("/");
		});
		return [{ outDir: outDirectory, rootDir: commonAncestor || "." }];
	}

	if (options.rootDir === null) {
		return [];
	}

	return [{ outDir: outDirectory, rootDir: normalizeDirectoryPath(options.rootDir ?? "src") }];
}

function findRojoProject(rootDirectory: string): string | undefined {
	const defaultPath = path.join(rootDirectory, "default.project.json");
	if (fs.existsSync(defaultPath)) {
		return defaultPath;
	}

	const files = fs.readdirSync(rootDirectory);
	const projectFile = files.find((file) => file.endsWith(".project.json"));
	return projectFile !== undefined ? path.join(rootDirectory, projectFile) : undefined;
}

function buildSourceMapper(
	config: ResolvedConfig,
	tsconfigMappings: ReadonlyArray<TsconfigMapping>,
): SourceMapper | undefined {
	const rojoProjectPath = config.rojoProject ?? findRojoProject(config.rootDir);
	if (rojoProjectPath === undefined || !fs.existsSync(rojoProjectPath)) {
		return undefined;
	}

	try {
		const rojoProjectRaw = JSON.parse(fs.readFileSync(rojoProjectPath, "utf-8"));
		const rojoResult = rojoProjectSchema(rojoProjectRaw);
		if (rojoResult instanceof type.errors) {
			return undefined;
		}

		const resolvedTree = resolveNestedProjects(rojoResult.tree, path.dirname(rojoProjectPath));

		return createSourceMapper({
			mappings: tsconfigMappings,
			rojoProject: { ...rojoResult, tree: resolvedTree },
		});
	} catch {
		return undefined;
	}
}

function resolveTestFilePaths(result: JestResult, sourceMapper: SourceMapper | undefined): void {
	if (sourceMapper === undefined) {
		return;
	}

	for (const file of result.testResults) {
		file.testFilePath =
			sourceMapper.resolveTestFilePath(file.testFilePath) ?? file.testFilePath;
	}
}

function calculateTestsMs(testResults: Array<TestFileResult>): number {
	let total = 0;
	for (const file of testResults) {
		for (const test of file.testResults) {
			if (test.duration !== undefined) {
				total += test.duration;
			}
		}
	}

	return total;
}

function printLuauTiming(timing: Record<string, number>): void {
	let total = 0;
	for (const [phase, seconds] of Object.entries(timing)) {
		const ms = Math.round(seconds * 1000);
		total += ms;
		process.stderr.write(`[TIMING] ${phase}: ${String(ms)}ms\n`);
	}

	process.stderr.write(`[TIMING] total: ${String(total)}ms\n`);
}

/**
 * Process a single `ProjectBackendResult` into an `ExecuteResult`: writes
 * snapshots, builds the source mapper, resolves test-file paths, and renders
 * formatter output. Called once per job.
 */
function processProjectResult(
	entry: ProjectBackendResult,
	options: ProcessProjectOptions,
): ExecuteResult {
	const { backendTiming, config, deferFormatting, startTime, version } = options;
	const { coverageData, gameOutput, luauTiming, result, setupMs, snapshotWrites } = entry;

	const tsconfigMappings = resolveAllTsconfigMappings(config.rootDir);

	const writeCounts: SnapshotWriteCounts =
		snapshotWrites !== undefined
			? writeSnapshots(snapshotWrites, config, tsconfigMappings)
			: { attempted: 0, failed: 0, written: 0 };

	const testsMs = calculateTestsMs(result.testResults);
	const sourceMapper = config.sourceMap ? buildSourceMapper(config, tsconfigMappings) : undefined;

	resolveTestFilePaths(result, sourceMapper);

	const totalMs = Date.now() - startTime;

	const timing = {
		executionMs: backendTiming.executionMs,
		setupMs,
		startTime,
		testsMs,
		totalMs,
		uploadCached: backendTiming.uploadCached,
		uploadMs: backendTiming.uploadMs,
	} satisfies TimingResult;

	const output =
		deferFormatting !== true
			? formatExecuteOutput({
					config,
					result,
					snapshotWriteFailures: writeCounts.failed,
					sourceMapper,
					timing,
					version,
				})
			: "";

	if (luauTiming !== undefined) {
		printLuauTiming(luauTiming);
	}

	const exitCode = result.success && writeCounts.failed === 0 ? 0 : 1;

	return {
		coverageData,
		exitCode,
		gameOutput,
		output,
		result,
		snapshotWriteFailures: writeCounts.failed > 0 ? writeCounts.failed : undefined,
		sourceMapper,
		timing,
	};
}

/**
 * Build a `ProjectJob` with `snapshotFormat` resolved per-project. Each job
 * carries its own config so the Luau runner never re-resolves or shares format
 * state across projects (fixes the spike's snapshot-diff regression — C1).
 */
function buildProjectJob(parameters: ProjectInput): ProjectJob {
	const tsconfigMappings = resolveAllTsconfigMappings(parameters.config.rootDir);
	const luauProject = isLuauProject(parameters.testFiles, tsconfigMappings);
	const config = applySnapshotFormatDefaults(parameters.config, luauProject);
	return {
		config,
		displayColor: parameters.displayColor,
		displayName: parameters.displayName ?? "",
		pkg: parameters.pkg,
		testFiles: parameters.testFiles,
	};
}

const instrumentedFileRecordSchema = type({
	"key": "string",
	"branchCount?": "number",
	"coverageMapPath": "string",
	"functionCount?": "number",
	"instrumentedLuauPath": "string",
	"originalLuauPath": "string",
	"sourceMapPath": "string",
	"statementCount": "number",
});

const coverageManifestSchema = type({
	files: type("Record<string, unknown>").pipe((files) => {
		const validated: Record<string, typeof instrumentedFileRecordSchema.infer> = {};
		const skipped: Array<string> = [];
		for (const [key, value] of Object.entries(files)) {
			const parsed = instrumentedFileRecordSchema(value);
			if (parsed instanceof type.errors) {
				skipped.push(key);
			} else {
				validated[key] = parsed;
			}
		}

		if (skipped.length > 0) {
			process.stderr.write(
				`Warning: ${skipped.length} file record(s) in coverage manifest failed validation and were skipped: ${skipped.join(", ")}\n`,
			);
		}

		return validated;
	}),
	generatedAt: "string",
	luauRoots: "string[]",
	shadowDir: "string",
	version: type.unit(1),
});

export function loadCoverageManifest(rootDirectory: string): CoverageManifest | undefined {
	const manifestPath = path.join(rootDirectory, ".jest-roblox", "coverage", "manifest.json");
	try {
		const raw = fs.readFileSync(manifestPath, "utf-8");
		const parsed = coverageManifestSchema(JSON.parse(raw));
		if (parsed instanceof type.errors) {
			process.stderr.write(
				`Warning: Coverage manifest is invalid (re-run \`jest-roblox instrument\`): ${parsed.summary}\n`,
			);
			return undefined;
		}

		return parsed as CoverageManifest;
	} catch (err) {
		if (err instanceof SyntaxError) {
			process.stderr.write(
				"Warning: Coverage manifest is malformed JSON (re-run `jest-roblox instrument`)\n",
			);
		}

		return undefined;
	}
}

function logSnapshotWriteSummary(options: {
	attempted: number;
	failed: number;
	silent?: boolean;
	written: number;
}): void {
	const { attempted, failed, silent, written } = options;
	if (written === 0 || silent === true) {
		return;
	}

	const plural = written === 1 ? "" : "s";
	const message =
		failed > 0
			? `Wrote ${String(written)} of ${String(attempted)} snapshot files\n`
			: `Wrote ${String(written)} snapshot file${plural}\n`;
	process.stderr.write(message);
}

function writeSnapshots(
	snapshotWrites: SnapshotWrites,
	config: ResolvedConfig,
	tsconfigMappings: ReadonlyArray<TsconfigMapping>,
): SnapshotWriteCounts {
	const attempted = Object.keys(snapshotWrites).length;

	const rojoProjectPath = config.rojoProject ?? findRojoProject(config.rootDir);
	if (rojoProjectPath === undefined || !fs.existsSync(rojoProjectPath)) {
		process.stderr.write("Warning: Cannot write snapshots - no rojo project found\n");
		return { attempted, failed: attempted, written: 0 };
	}

	let rojoProjectSource: string;
	try {
		rojoProjectSource = fs.readFileSync(rojoProjectPath, "utf-8");
	} catch (err) {
		process.stderr.write(
			`Warning: Cannot read rojo project ${rojoProjectPath}: ${(err as Error).message}\n`,
		);
		return { attempted, failed: attempted, written: 0 };
	}

	let rojoProjectRaw: unknown;
	try {
		rojoProjectRaw = JSON.parse(rojoProjectSource);
	} catch (err) {
		process.stderr.write(
			formatBanner({
				body: [
					color.red(`Failed to parse rojo project: ${(err as Error).message}`),
					`  ${color.dim("File:")} ${rojoProjectPath}`,
				],
				level: "warn",
				title: "Snapshot Warning",
			}),
		);
		return { attempted, failed: attempted, written: 0 };
	}

	const rojoResult = rojoProjectSchema(rojoProjectRaw);
	if (rojoResult instanceof type.errors) {
		process.stderr.write("Warning: Cannot write snapshots - invalid rojo project\n");
		return { attempted, failed: attempted, written: 0 };
	}

	let resolver: ReturnType<typeof createSnapshotPathResolver>;
	try {
		const resolvedTree = resolveNestedProjects(rojoResult.tree, path.dirname(rojoProjectPath));
		resolver = createSnapshotPathResolver({
			mappings: tsconfigMappings,
			rojoProject: { ...rojoResult, tree: resolvedTree },
		});
	} catch (err) {
		process.stderr.write(
			`Warning: Cannot resolve rojo project tree: ${(err as Error).message}\n`,
		);
		return { attempted, failed: attempted, written: 0 };
	}

	let written = 0;
	let failed = 0;

	for (const [virtualPath, content] of Object.entries(snapshotWrites)) {
		const resolved = resolver.resolve(virtualPath);
		if (resolved === undefined) {
			process.stderr.write(`Warning: Cannot resolve snapshot path: ${virtualPath}\n`);
			failed++;
			continue;
		}

		try {
			const absolutePath = path.resolve(config.rootDir, resolved.filePath);
			fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
			fs.writeFileSync(absolutePath, content);

			// Also write to out dir so rojo picks it up without recompile
			const { filePath, mapping } = resolved;
			if (mapping !== undefined) {
				const outPath = mapping.outDir + filePath.slice(mapping.rootDir.length);
				const absoluteOutPath = path.resolve(config.rootDir, outPath);
				fs.mkdirSync(path.dirname(absoluteOutPath), { recursive: true });
				fs.writeFileSync(absoluteOutPath, content);
			}

			written++;
		} catch (err) {
			process.stderr.write(
				`Warning: Failed to write snapshot ${virtualPath}: ${String(err)}\n`,
			);
			failed++;
		}
	}

	logSnapshotWriteSummary({ attempted, failed, silent: config.silent, written });

	return { attempted, failed, written };
}
