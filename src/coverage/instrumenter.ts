import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { AstStatBlock } from "../luau/ast-types.ts";
import parseAstLuauSource from "../luau/parse-ast.luau";
import { hashBuffer } from "../utils/hash.ts";
import { collectCoverage } from "./coverage-collector.ts";
import { buildCoverageMap } from "./coverage-map-builder.ts";
import { insertProbes } from "./probe-inserter.ts";
import type { CoverageManifest, InstrumentedFileRecord } from "./types.ts";

export const INSTRUMENTER_VERSION = 2;

// Temp directory is never explicitly cleaned up (OS handles it).
// Tests use the parseScript override to bypass this cache entirely.
let cachedTemporaryDirectory: string | undefined;

export interface InstrumentRootOptions {
	/** Override the AST output directory (for testing). */
	astOutputDirectory?: string;
	luauRoot: string;
	/** Override the path to parse-ast.luau (for testing). */
	parseScript?: string;
	shadowDir: string;
	/** Relative paths to skip (already instrumented / unchanged). */
	skipFiles?: Set<string>;
}

export interface InstrumentOptions extends InstrumentRootOptions {
	manifestPath: string;
}

/**
 * Instrument a single luauRoot directory. Returns the files map without
 * writing a manifest — used by `prepareCoverage()` to merge multiple roots.
 */
export function instrumentRoot(
	options: InstrumentRootOptions,
): Record<string, InstrumentedFileRecord> {
	const {
		astOutputDirectory: astOutputDirectoryOption,
		luauRoot,
		parseScript,
		shadowDir,
		skipFiles,
	} = options;

	const needsTemporaryDirectory =
		parseScript === undefined || astOutputDirectoryOption === undefined;
	const lazyTemporaryDirectory = needsTemporaryDirectory ? getTemporaryDirectory() : "";
	const scriptPath = parseScript ?? path.join(lazyTemporaryDirectory, "parse-ast.luau");
	const astOutputDirectory =
		astOutputDirectoryOption ?? path.join(lazyTemporaryDirectory, "asts");

	if (parseScript === undefined) {
		fs.writeFileSync(scriptPath, parseAstLuauSource);
	}

	fs.mkdirSync(astOutputDirectory, { recursive: true });

	// Write skip list so lute can skip parsing unchanged files
	const luteArgs = ["run", scriptPath, "--", path.resolve(luauRoot), astOutputDirectory];
	if (skipFiles !== undefined && skipFiles.size > 0) {
		const skipListPath = toPosix(path.join(astOutputDirectory, "skip-list.json"));
		fs.writeFileSync(skipListPath, JSON.stringify([...skipFiles]));
		luteArgs.push(skipListPath);
	}

	// Single lute call: discovers files, parses + strips ASTs, writes per-file
	// JSON. Skipped files are still included in the file list.
	let fileListJson: string;
	try {
		fileListJson = cp.execFileSync("lute", luteArgs, {
			encoding: "utf-8",
			// File list only (paths, not ASTs) — 1MB is plenty
			maxBuffer: 1024 * 1024,
		});
	} catch (err) {
		if (err instanceof Error && "code" in err && err.code === "ENOENT") {
			throw new Error("lute is required for instrumentation but was not found on PATH");
		}

		throw new Error("Failed to parse Luau files", { cause: err });
	}

	let fileList: Array<string>;
	try {
		fileList = JSON.parse(fileListJson) as Array<string>;
	} catch (err) {
		throw new Error("Failed to parse file list from lute", { cause: err });
	}

	if (!Array.isArray(fileList)) {
		throw new Error("Expected file list array from lute");
	}

	const files: Record<string, InstrumentedFileRecord> = {};
	const posixLuauRoot = toPosix(luauRoot);

	for (const relativePath of fileList) {
		if (shouldSkipFile(relativePath, skipFiles)) {
			continue;
		}

		const astJsonPath = path.join(astOutputDirectory, `${relativePath}.json`);
		let astJson: string;
		try {
			astJson = fs.readFileSync(astJsonPath, "utf-8");
		} catch (err) {
			throw new Error(`Failed to read AST for ${relativePath}`, { cause: err });
		}

		// AST is already validated and stripped by parse-ast.luau, so we can
		// assert its shape with a simple type assertion rather than a full
		// schema validation. Additionally, to validate every field with a
		// schema would be expensive given the size of the ASTs, and we want to
		// avoid that overhead in the instrumentation process.
		const ast = JSON.parse(astJson) as unknown as AstStatBlock;

		const fileKey = toPosix(path.join(posixLuauRoot, relativePath));
		const originalLuauPath = fileKey;
		const instrumentedLuauPath = toPosix(path.join(shadowDir, relativePath));
		const coverageMapOutputPath = path.join(
			shadowDir,
			relativePath.replace(/\.luau$/, ".cov-map.json"),
		);
		const sourceMapPath = `${originalLuauPath}.map`;

		const outputDirectory = path.dirname(path.join(shadowDir, relativePath));
		fs.mkdirSync(outputDirectory, { recursive: true });

		const sourceBuffer = fs.readFileSync(path.resolve(originalLuauPath));
		const source = sourceBuffer.toString("utf-8");
		const collectorResult = collectCoverage(ast);
		const instrumentedSource = insertProbes(source, collectorResult, fileKey);
		const coverageMap = buildCoverageMap(collectorResult);

		fs.writeFileSync(path.join(shadowDir, relativePath), instrumentedSource);
		fs.writeFileSync(coverageMapOutputPath, JSON.stringify(coverageMap, undefined, "\t"));

		files[fileKey] = {
			key: fileKey,
			branchCount: collectorResult.branches.length,
			coverageMapPath: toPosix(coverageMapOutputPath),
			functionCount: collectorResult.functions.length,
			instrumentedLuauPath,
			originalLuauPath,
			sourceHash: hashBuffer(sourceBuffer),
			sourceMapPath,
			statementCount: collectorResult.statements.length,
		};
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
	const posixLuauRoot = toPosix(luauRoot);

	const manifest = {
		files,
		generatedAt: new Date().toISOString(),
		instrumenterVersion: INSTRUMENTER_VERSION,
		luauRoots: [posixLuauRoot],
		nonInstrumentedFiles: {},
		shadowDir: toPosix(shadowDir),
		version: 1,
	} satisfies CoverageManifest;

	fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
	fs.writeFileSync(manifestPath, JSON.stringify(manifest, undefined, "\t"));

	return manifest;
}

function shouldSkipFile(relativePath: string, skipFiles: Set<string> | undefined): boolean {
	if (relativePath.endsWith(".snap.luau") || relativePath.endsWith(".snap.lua")) {
		return true;
	}

	return skipFiles?.has(relativePath) === true;
}

function getTemporaryDirectory(): string {
	if (cachedTemporaryDirectory !== undefined && fs.existsSync(cachedTemporaryDirectory)) {
		return cachedTemporaryDirectory;
	}

	cachedTemporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "jest-roblox-instrument-"));
	return cachedTemporaryDirectory;
}

function toPosix(value: string): string {
	return value.replaceAll("\\", "/");
}
