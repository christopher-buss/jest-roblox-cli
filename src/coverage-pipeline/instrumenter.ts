import type { AstStatBlock } from "@isentinel/luau-ast";

import * as cp from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import parseAstLuauSource from "../luau/parse-ast.luau";
import { NOOP_TIMING_COLLECTOR, type TimingCollector } from "../timing/orchestration-collector.ts";
import { hashBuffer } from "../utils/hash.ts";
import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import { collectCoverage } from "./coverage-collector.ts";
import { buildCoverageMap } from "./coverage-map-builder.ts";
import { writeCoverageMap } from "./coverage-map.ts";
import type { CoverageManifest, InstrumentedFileRecord } from "./manifest.ts";
import { MANIFEST_VERSION, writeManifest } from "./manifest.ts";
import { insertProbes } from "./probe-inserter.ts";

export const INSTRUMENTER_VERSION = 3;

const LUAU_EXTENSION = /\.luau?$/;

// Temp directory is never explicitly cleaned up (OS handles it).
// Tests use the parseScript override to bypass this cache entirely.
let cachedTemporaryDirectory: string | undefined;

export interface InstrumentRootOptions {
	/** Override the AST output directory (for testing). */
	astOutputDirectory?: string | undefined;
	luauRoot: string;
	/** Override the path to parse-ast.luau (for testing). */
	parseScript?: string | undefined;
	shadowDir: string;
	/**
	 * Relative paths lute must not parse — unchanged files whose records the
	 * caller carries forward, plus files outside the coverage universe. Both
	 * reach the same skip list because a file lute never parses is a file it
	 * never pays for, and parsing dominates this pass. Telling them apart is
	 * the caller's job: only the first kind has a record worth keeping.
	 */
	skipFiles?: Set<string> | undefined;
	/**
	 * Orchestration profiler; records `parse-ast` / `probe-insert` /
	 * `map-build`.
	 */
	timing?: TimingCollector | undefined;
}

export interface InstrumentOptions extends InstrumentRootOptions {
	manifestPath: string;
}

/** Everything the per-file instrumentation pass captures from its root. */
interface InstrumentFileContext {
	astOutputDirectory: string;
	/** POSIX-normalized luauRoot — the first half of every file key. */
	posixLuauRoot: string;
	shadowDir: string;
	timing: TimingCollector;
}

/** Resolved script + AST output locations for one `instrumentRoot` call. */
interface InstrumentPaths {
	astOutputDirectory: string;
	scriptPath: string;
}

/**
 * Instrument a single luauRoot directory. Returns the files map without
 * writing a manifest — used by `prepareCoverage()` to merge multiple roots.
 */
export function instrumentRoot(options: InstrumentRootOptions): CoverageManifest["files"] {
	const { luauRoot, shadowDir, skipFiles } = options;
	const timing = options.timing ?? NOOP_TIMING_COLLECTOR;

	const { astOutputDirectory, scriptPath } = resolveInstrumentPaths(options);
	const luteArgs = buildLuteArgs(scriptPath, luauRoot, astOutputDirectory, skipFiles);
	const fileList = discoverFileList(luteArgs, timing);

	const files: CoverageManifest["files"] = {};
	const context: InstrumentFileContext = {
		astOutputDirectory,
		posixLuauRoot: normalizeWindowsPath(luauRoot),
		shadowDir,
		timing,
	};

	for (const relativePath of fileList) {
		if (shouldSkipFile(relativePath, skipFiles)) {
			continue;
		}

		const record = instrumentFile(relativePath, context);
		files[record.key] = record;
	}

	return files;
}

/**
 * Instrument a single luauRoot and write a standalone manifest.
 * Used by the `instrument` subcommand.
 */
export function instrument(options: InstrumentOptions): CoverageManifest {
	const { luauRoot, manifestPath, shadowDir } = options;

	const files = instrumentRoot(options);
	const posixLuauRoot = normalizeWindowsPath(luauRoot);

	const generatedAtDate = new Date();
	const manifest: CoverageManifest = {
		buildId: crypto.randomUUID(),
		files,
		generatedAt: generatedAtDate.toISOString(),
		instrumenterVersion: INSTRUMENTER_VERSION,
		luauRoots: [posixLuauRoot],
		nonInstrumentedFiles: {},
		shadowDir: normalizeWindowsPath(shadowDir),
		version: MANIFEST_VERSION,
	};

	writeManifest(manifestPath, manifest);

	return manifest;
}

function getTemporaryDirectory(): string {
	if (cachedTemporaryDirectory !== undefined && fs.existsSync(cachedTemporaryDirectory)) {
		return cachedTemporaryDirectory;
	}

	cachedTemporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "jest-roblox-instrument-"));
	return cachedTemporaryDirectory;
}

/**
 * Resolve where the parse script lives and where its ASTs land, materializing
 * the bundled `parse-ast.luau` into a temp dir unless the caller overrode it.
 */
function resolveInstrumentPaths({
	astOutputDirectory: astOutputDirectoryOption,
	parseScript,
}: InstrumentRootOptions): InstrumentPaths {
	const shouldUseTemporaryDirectory =
		parseScript === undefined || astOutputDirectoryOption === undefined;
	const lazyTemporaryDirectory = shouldUseTemporaryDirectory ? getTemporaryDirectory() : "";
	const scriptPath = parseScript ?? path.join(lazyTemporaryDirectory, "parse-ast.luau");
	const astOutputDirectory =
		astOutputDirectoryOption ?? path.join(lazyTemporaryDirectory, "asts");

	if (parseScript === undefined) {
		fs.writeFileSync(scriptPath, parseAstLuauSource);
	}

	fs.mkdirSync(astOutputDirectory, { recursive: true });

	return { astOutputDirectory, scriptPath };
}

function buildLuteArgs(
	scriptPath: string,
	luauRoot: string,
	astOutputDirectory: string,
	skipFiles: Set<string> | undefined,
): Array<string> {
	const luteArgs = ["run", scriptPath, "--", path.resolve(luauRoot), astOutputDirectory];

	// Write skip list so lute can skip parsing unchanged files
	if (skipFiles !== undefined && skipFiles.size > 0) {
		const skipListPath = normalizeWindowsPath(path.join(astOutputDirectory, "skip-list.json"));
		fs.writeFileSync(skipListPath, JSON.stringify([...skipFiles]));
		luteArgs.push(skipListPath);
	}

	return luteArgs;
}

function isStringArray(value: JSONValue): value is Array<string> {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/**
 * Single lute call: discovers files, parses + strips ASTs, writes per-file
 * JSON. Skipped files are still included in the returned file list.
 */
function discoverFileList(luteArgs: Array<string>, timing: TimingCollector): Array<string> {
	let fileListJson: string;
	try {
		fileListJson = timing.profile("parse-ast", () => {
			return cp.execFileSync("lute", luteArgs, {
				encoding: "utf-8",
				// File list only (paths, not ASTs) — 1MB is plenty
				maxBuffer: 1024 * 1024,
				windowsHide: true,
			});
		});
	} catch (err) {
		if (err instanceof Error && "code" in err && err.code === "ENOENT") {
			throw new Error("lute is required for instrumentation but was not found on PATH");
		}

		throw new Error("Failed to parse Luau files", { cause: err });
	}

	let parsed: JSONValue;
	try {
		parsed = JSON.parse(fileListJson);
	} catch (err) {
		throw new Error("Failed to parse file list from lute", { cause: err });
	}

	if (!isStringArray(parsed)) {
		throw new Error("Expected file list array from lute");
	}

	return parsed;
}

/**
 * Shallow guard over the AST JSON `parse-ast.luau` emits. Only the root tag is
 * checked: the file is our own output, and validating every node per file would
 * dominate the instrumentation pass.
 */
function isAstStatBlock(value: JSONValue): value is AstStatBlock & JSONValue {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		value["tag"] === "block"
	);
}

/** Reads one `parse-ast.luau` sidecar, failing loudly on either IO or shape. */
function readAst(astJsonPath: string, relativePath: string): AstStatBlock {
	let astJson: string;
	try {
		astJson = fs.readFileSync(astJsonPath, "utf-8");
	} catch (err) {
		throw new Error(`Failed to read AST for ${relativePath}`, { cause: err });
	}

	const parsed = JSON.parse(astJson);
	if (!isAstStatBlock(parsed)) {
		throw new Error(`Malformed AST for ${relativePath}`);
	}

	return parsed;
}

/**
 * Instrument one discovered file: write its instrumented twin and `.cov-map`
 * sidecar into the shadow dir, and return the manifest record for it.
 */
function instrumentFile(
	relativePath: string,
	{ astOutputDirectory, posixLuauRoot, shadowDir, timing }: InstrumentFileContext,
): InstrumentedFileRecord {
	// The cross-machine join key: the same string is written to the manifest
	// record below and baked into the instrumented preamble by `insertProbes`,
	// so the runtime hit map lines up with the static maps byte-for-byte.
	const fileKey = normalizeWindowsPath(path.join(posixLuauRoot, relativePath));
	const shadowFilePath = path.join(shadowDir, relativePath);
	// LUAU_EXTENSION is end-anchored, so swapping the suffix on the joined path
	// is the same as joining the swapped relative path.
	const coverageMapOutputPath = shadowFilePath.replace(LUAU_EXTENSION, ".cov-map.json");

	const ast = readAst(path.join(astOutputDirectory, `${relativePath}.json`), relativePath);
	fs.mkdirSync(path.dirname(shadowFilePath), { recursive: true });

	const sourceBuffer = fs.readFileSync(path.resolve(fileKey));
	const source = sourceBuffer.toString("utf-8");
	const collectorResult = collectCoverage(ast, source);
	const instrumentedSource = timing.profile("probe-insert", () => {
		return insertProbes(source, collectorResult, fileKey);
	});
	const coverageMap = timing.profile("map-build", () => buildCoverageMap(collectorResult));

	fs.writeFileSync(shadowFilePath, instrumentedSource);
	writeCoverageMap(coverageMapOutputPath, coverageMap);

	return {
		key: fileKey,
		branchCount: collectorResult.branches.length,
		coverageMapPath: normalizeWindowsPath(coverageMapOutputPath),
		functionCount: collectorResult.functions.length,
		instrumentedLuauPath: normalizeWindowsPath(shadowFilePath),
		originalLuauPath: fileKey,
		sourceHash: hashBuffer(sourceBuffer),
		sourceMapPath: `${fileKey}.map`,
		statementCount: collectorResult.statements.length,
	};
}

function shouldSkipFile(relativePath: string, skipFiles: Set<string> | undefined): boolean {
	if (relativePath.endsWith(".snap.luau") || relativePath.endsWith(".snap.lua")) {
		return true;
	}

	return skipFiles?.has(relativePath) === true;
}
