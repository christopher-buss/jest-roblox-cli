import { type } from "arktype";
import { getTsconfig } from "get-tsconfig";
import * as fs from "node:fs";
import * as path from "node:path";
import process from "node:process";
import color from "tinyrainbow";

import type { Backend } from "./backends/interface.ts";
import { applySnapshotFormatDefaults } from "./config/loader.ts";
import type { ResolvedConfig } from "./config/schema.ts";
import type { CoverageManifest, RawCoverageData } from "./coverage/types.ts";
import { formatCompact } from "./formatters/compact.ts";
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

export interface ExecuteOptions {
	backend: Backend;
	config: ResolvedConfig;
	deferFormatting?: boolean;
	testFiles: Array<string>;
	version: string;
}

export interface ExecuteResult {
	coverageData?: RawCoverageData;
	exitCode: number;
	gameOutput?: string;
	output: string;
	result: JestResult;
	sourceMapper?: SourceMapper;
	timing: TimingResult;
}

export interface FormatOutputOptions {
	config: ResolvedConfig;
	result: JestResult;
	sourceMapper?: SourceMapper;
	timing: TimingResult;
	version: string;
}

export interface TsconfigDirectories {
	outDir: string | undefined;
	rootDir: string | undefined;
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
	const { config, result, sourceMapper, timing, version } = options;

	if (config.silent) {
		return "";
	}

	const resolvedOutputFile =
		config.outputFile !== undefined ? path.resolve(config.outputFile) : undefined;
	const resolvedGameOutput =
		config.gameOutput !== undefined ? path.resolve(config.gameOutput) : undefined;

	// Formatter names are normalized by resolveFormatters before reaching here,
	// so the "compact" alias is already resolved to "agent".
	const agentOptions = findFormatterOptions(config.formatters ?? [], "agent") as
		| AgentFormatterOptions
		| undefined;

	if (agentOptions !== undefined && !config.verbose) {
		const maxFailures = agentOptions.maxFailures ?? DEFAULT_MAX_FAILURES;

		return formatCompact(result, {
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
		sourceMapper,
		verbose: config.verbose,
		version,
	});
}

export async function execute(options: ExecuteOptions): Promise<ExecuteResult> {
	const startTime = Date.now();

	const tsconfigMappings = resolveAllTsconfigMappings(options.config.rootDir);
	const luauProject = isLuauProject(options.testFiles, tsconfigMappings);
	const config = applySnapshotFormatDefaults(options.config, luauProject);

	const {
		coverageData,
		gameOutput,
		luauTiming,
		result,
		snapshotWrites,
		timing: backendTiming,
	} = await options.backend.runTests({
		config,
		testFiles: options.testFiles,
	});

	if (snapshotWrites !== undefined) {
		writeSnapshots(snapshotWrites, config, tsconfigMappings);
	}

	const testsMs = calculateTestsMs(result.testResults);
	const sourceMapper = config.sourceMap ? buildSourceMapper(config, tsconfigMappings) : undefined;

	resolveTestFilePaths(result, sourceMapper);

	const totalMs = Date.now() - startTime;

	const timing = {
		executionMs: backendTiming.executionMs,
		startTime,
		testsMs,
		totalMs,
		uploadCached: backendTiming.uploadCached,
		uploadMs: backendTiming.uploadMs,
	} satisfies TimingResult;

	const output =
		options.deferFormatting !== true
			? formatExecuteOutput({
					config,
					result,
					sourceMapper,
					timing,
					version: options.version,
				})
			: "";

	if (luauTiming !== undefined) {
		printLuauTiming(luauTiming);
	}

	const exitCode = result.success ? 0 : 1;

	return { coverageData, exitCode, gameOutput, output, result, sourceMapper, timing };
}

function normalizeDirectoryPath(directory: string): string {
	return path.normalize(directory).replaceAll("\\", "/");
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

		return createSourceMapper({
			mappings: tsconfigMappings,
			rojoProject: rojoResult,
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
	const manifestPath = path.join(rootDirectory, ".jest-roblox-coverage", "manifest.json");
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

function writeSnapshots(
	snapshotWrites: SnapshotWrites,
	config: ResolvedConfig,
	tsconfigMappings: ReadonlyArray<TsconfigMapping>,
): void {
	const rojoProjectPath = config.rojoProject ?? findRojoProject(config.rootDir);
	if (rojoProjectPath === undefined || !fs.existsSync(rojoProjectPath)) {
		process.stderr.write("Warning: Cannot write snapshots - no rojo project found\n");
		return;
	}

	try {
		const rojoProjectRaw = JSON.parse(fs.readFileSync(rojoProjectPath, "utf-8"));
		const rojoResult = rojoProjectSchema(rojoProjectRaw);
		if (rojoResult instanceof type.errors) {
			process.stderr.write("Warning: Cannot write snapshots - invalid rojo project\n");
			return;
		}

		const resolver = createSnapshotPathResolver({
			mappings: tsconfigMappings,
			rojoProject: rojoResult,
		});

		let written = 0;
		for (const [virtualPath, content] of Object.entries(snapshotWrites)) {
			const resolved = resolver.resolve(virtualPath);
			if (resolved === undefined) {
				process.stderr.write(`Warning: Cannot resolve snapshot path: ${virtualPath}\n`);
				continue;
			}

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
		}

		if (written > 0) {
			process.stderr.write(
				`Wrote ${String(written)} snapshot file${written === 1 ? "" : "s"}\n`,
			);
		}
	} catch (err) {
		if (err instanceof SyntaxError) {
			process.stderr.write(
				formatBanner({
					body: [
						color.red(`Failed to parse rojo project: ${err.message}`),
						`  ${color.dim("File:")} ${rojoProjectPath}`,
					],
					level: "warn",
					title: "Snapshot Warning",
				}),
			);
		} else {
			process.stderr.write(`Warning: Failed to write snapshot files: ${String(err)}\n`);
		}
	}
}
