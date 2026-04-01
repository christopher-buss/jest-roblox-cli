import { type } from "arktype";
import { getTsconfig } from "get-tsconfig";
import * as fs from "node:fs";
import * as path from "node:path";
import picomatch from "picomatch";

import type { ResolvedConfig } from "../config/schema.ts";
import { rojoProjectSchema } from "../types/rojo.ts";
import { hashBuffer } from "../utils/hash.ts";
import { collectPaths, resolveNestedProjects } from "../utils/rojo-tree.ts";
import { INSTRUMENTER_VERSION, instrumentRoot } from "./instrumenter.ts";
import { buildWithRojo } from "./rojo-builder.ts";
import type { RojoProject, RootEntry } from "./rojo-rewriter.ts";
import { rewriteRojoProject } from "./rojo-rewriter.ts";
import type {
	CoverageManifest,
	InstrumentedFileRecord,
	NonInstrumentedFileRecord,
} from "./types.ts";

const COVERAGE_DIR = ".jest-roblox-coverage";

/**
 * Suffixes for files that are not instrumented for coverage but still need
 * syncing to the shadow directory. Matches parse-ast.luau:131-139.
 */
export const NON_INSTRUMENTED_SUFFIXES = [
	".spec.luau",
	".test.luau",
	".spec.lua",
	".test.lua",
	".snap.luau",
	".snap.lua",
] as const;

/** Previous manifests may lack nonInstrumentedFiles (pre-fix). */
type PreviousManifest = Omit<CoverageManifest, "nonInstrumentedFiles"> & {
	nonInstrumentedFiles?: CoverageManifest["nonInstrumentedFiles"];
};

export function isNonInstrumentedFile(filename: string): boolean {
	return NON_INSTRUMENTED_SUFFIXES.some((suffix) => filename.endsWith(suffix));
}

const previousManifestSchema = type({
	"files": type({ "[string]": { sourceHash: "string" } }),
	"instrumenterVersion": "number",
	"luauRoots": "string[]",
	"nonInstrumentedFiles?": type({
		"[string]": { shadowPath: "string", sourceHash: "string", sourcePath: "string" },
	}),
	"placeFilePath?": "string",
	"shadowDir": "string",
	"version": "number",
}).as<PreviousManifest>();

export interface PrepareCoverageResult {
	manifest: CoverageManifest;
	placeFile: string;
}

interface InstrumentRootResult {
	changed: boolean;
	files: Record<string, InstrumentedFileRecord>;
	nonInstrumentedFiles: Record<string, NonInstrumentedFileRecord>;
	rootEntry: RootEntry;
}

interface WriteManifestOptions {
	allFiles: Record<string, InstrumentedFileRecord>;
	luauRoots: Array<string>;
	manifestPath: string;
	nonInstrumentedFiles: Record<string, NonInstrumentedFileRecord>;
	placeFile: string;
}

interface SyncResult {
	changed: boolean;
	files: Record<string, NonInstrumentedFileRecord>;
}

interface FullCacheOptions {
	luauRoot: string;
	previousManifest: PreviousManifest;
	rootEntry: RootEntry;
	shadowDirectory: string;
	skipFiles: Set<string>;
}

export function collectLuauRootsFromRojo(
	project: RojoProject,
	config: ResolvedConfig,
): Array<string> {
	const paths: Array<string> = [];
	collectPaths(project.tree, paths);

	const ignorePatterns = config.coveragePathIgnorePatterns;
	// contains: true so bare strings like "rojo-sync" match "rojo-sync/rbxts",
	// mirroring Jest's regex-based coveragePathIgnorePatterns behavior.
	const isIgnored = picomatch(ignorePatterns, { contains: true });

	return paths.filter((directoryPath) => {
		if (!fs.existsSync(directoryPath)) {
			return false;
		}

		// Only directories can be coverage roots (skip single-file $path entries)
		if (!fs.statSync(directoryPath).isDirectory()) {
			return false;
		}

		if (isIgnored(directoryPath)) {
			return false;
		}

		return containsLuauFiles(directoryPath);
	});
}

export function resolveLuauRoots(config: ResolvedConfig): Array<string> {
	return resolveLuauRootsWithRojo(config);
}

/**
 * Fast directory walk to discover instrumentable .luau/.lua files.
 * Must match parse-ast.luau's discoverFiles logic (same skip rules).
 */
export function discoverInstrumentableFiles(luauRoot: string): Set<string> {
	const posixRoot = luauRoot.replaceAll("\\", "/");
	const results: Array<string> = [];
	walkLuauDirectory(posixRoot, posixRoot, isInstrumentableFile, results);
	return new Set(results);
}

export function prepareCoverage(
	config: ResolvedConfig,
	beforeBuild?: (shadowDirectory: string) => boolean,
): PrepareCoverageResult {
	const rojoProjectPath = findRojoProject(config);
	const luauRoots = resolveLuauRootsWithRojo(config, rojoProjectPath);

	validateRelativeRoots(luauRoots);

	const manifestPath = path.join(COVERAGE_DIR, "manifest.json");
	const previousManifest = loadPreviousManifest(manifestPath);
	const useIncremental = canUseIncremental(previousManifest, config);

	if (!useIncremental && fs.existsSync(COVERAGE_DIR)) {
		fs.rmSync(COVERAGE_DIR, { recursive: true });
	}

	const allFiles: Record<string, InstrumentedFileRecord> = {};
	const allNonInstrumented: Record<string, NonInstrumentedFileRecord> = {};
	const roots: Array<RootEntry> = [];
	let hasChanges = !useIncremental;

	for (const luauRoot of luauRoots) {
		const rootResult = instrumentRootWithCache(luauRoot, useIncremental, previousManifest);

		if (rootResult.changed) {
			hasChanges = true;
		}

		Object.assign(allFiles, rootResult.files);
		Object.assign(allNonInstrumented, rootResult.nonInstrumentedFiles);
		roots.push(rootResult.rootEntry);
	}

	if (useIncremental && previousManifest !== undefined) {
		const deleted = detectDeletedFiles(previousManifest, allFiles);
		cleanupDeletedFiles(deleted);

		if (deleted.length > 0) {
			hasChanges = true;
		}
	}

	if (beforeBuild !== undefined) {
		const extraChanges = beforeBuild(COVERAGE_DIR);
		if (extraChanges) {
			hasChanges = true;
		}
	}

	const placeFile = path.join(COVERAGE_DIR, "game.rbxl");
	const manifest = writeManifest({
		allFiles,
		luauRoots,
		manifestPath,
		nonInstrumentedFiles: allNonInstrumented,
		placeFile,
	});

	if (!hasChanges && previousManifest?.placeFilePath !== undefined) {
		return { manifest, placeFile: previousManifest.placeFilePath };
	}

	buildRojoProject(rojoProjectPath, roots, placeFile);

	return { manifest, placeFile };
}

function containsLuauFiles(directoryPath: string): boolean {
	const entries = fs.readdirSync(directoryPath, { withFileTypes: true });
	return entries.some((entry) => {
		if (entry.isFile() && entry.name.endsWith(".luau")) {
			return true;
		}

		if (entry.isDirectory()) {
			return containsLuauFiles(path.join(directoryPath, entry.name));
		}

		return false;
	});
}

function findRojoProject(config: ResolvedConfig): string {
	if (config.rojoProject !== undefined) {
		return config.rojoProject;
	}

	const defaultPath = path.join(config.rootDir, "default.project.json");
	if (fs.existsSync(defaultPath)) {
		return defaultPath;
	}

	const files = fs.readdirSync(config.rootDir, "utf-8");
	const projectFile = files.find((file) => file.endsWith(".project.json"));
	if (projectFile !== undefined) {
		return path.join(config.rootDir, projectFile);
	}

	throw new Error(
		"No Rojo project found. Set rojoProject in config or add a .project.json file.",
	);
}

function resolveLuauRootsWithRojo(config: ResolvedConfig, rojoProjectPath?: string): Array<string> {
	if (config.luauRoots !== undefined && config.luauRoots.length > 0) {
		return config.luauRoots;
	}

	// Auto-detect from Rojo project
	try {
		const resolvedPath = rojoProjectPath ?? findRojoProject(config);
		const rojoProject = JSON.parse(
			fs.readFileSync(resolvedPath, "utf-8"),
		) as unknown as RojoProject;

		const roots = collectLuauRootsFromRojo(rojoProject, config);
		if (roots.length > 0) {
			return roots;
		}
	} catch (err) {
		// Expected: no project file found → fall through to tsconfig.
		// Unexpected: malformed JSON → surface to help debugging.
		if (err instanceof SyntaxError) {
			throw new Error(`Malformed Rojo project JSON: ${err.message}`, { cause: err });
		}
	}

	const tsconfig = getTsconfig(config.rootDir) ?? undefined;
	const outDirectory = tsconfig?.config.compilerOptions?.outDir;
	if (outDirectory !== undefined) {
		return [outDirectory];
	}

	throw new Error(
		"Could not determine luauRoots. Set luauRoots in config or ensure tsconfig has outDir.",
	);
}

/**
 * Shared directory walker. Skips node_modules, .jest-roblox-coverage, and
 * dot-prefixed directories — matching parse-ast.luau:113-147.
 * `predicate` receives the entry name and returns true to collect the file.
 */
function walkLuauDirectory(
	directory: string,
	relativeTo: string,
	predicate: (name: string) => boolean,
	results: Array<string>,
): void {
	const entries = fs.readdirSync(directory, { withFileTypes: true });
	for (const entry of entries) {
		const fullPath = path.join(directory, entry.name).replaceAll("\\", "/");
		if (entry.isDirectory()) {
			if (entry.name === "node_modules" || entry.name === COVERAGE_DIR) {
				continue;
			}

			if (entry.name.startsWith(".")) {
				continue;
			}

			walkLuauDirectory(fullPath, relativeTo, predicate, results);
		} else if (predicate(entry.name)) {
			const relative = fullPath.slice(relativeTo.length + 1);
			results.push(relative);
		}
	}
}

function isInstrumentableFile(name: string): boolean {
	return (name.endsWith(".luau") || name.endsWith(".lua")) && !isNonInstrumentedFile(name);
}

function validateRelativeRoots(luauRoots: Array<string>): void {
	for (const root of luauRoots) {
		if (path.isAbsolute(root)) {
			throw new Error(
				"luauRoots must be relative paths, got absolute path. " +
					"Set a relative outDir in tsconfig or relative luauRoots in config.",
			);
		}
	}
}

function carryForwardRecords(
	luauRoot: string,
	previousManifest: PreviousManifest,
	allFiles: Record<string, InstrumentedFileRecord>,
	skipFiles: Set<string>,
): void {
	const posixRoot = luauRoot.replaceAll("\\", "/");

	for (const relativePath of skipFiles) {
		const fileKey = `${posixRoot}/${relativePath}`;
		Object.assign(allFiles, { [fileKey]: previousManifest.files[fileKey] });
	}
}

function discoverNonInstrumentedFiles(
	directory: string,
	relativeTo: string,
	results: Array<string>,
): void {
	walkLuauDirectory(directory, relativeTo, isNonInstrumentedFile, results);
}

function pruneStaleNonInstrumented(
	posixRoot: string,
	previousNonInstrumented: Record<string, NonInstrumentedFileRecord> | undefined,
	currentFiles: Record<string, NonInstrumentedFileRecord>,
): boolean {
	if (previousNonInstrumented === undefined) {
		return false;
	}

	let changed = false;
	for (const [fileKey, record] of Object.entries(previousNonInstrumented)) {
		if (!fileKey.startsWith(`${posixRoot}/`)) {
			continue;
		}

		if (fileKey in currentFiles) {
			continue;
		}

		try {
			if (fs.existsSync(record.shadowPath)) {
				fs.unlinkSync(record.shadowPath);
			}
		} catch {
			// Best-effort cleanup
		}

		changed = true;
	}

	return changed;
}

function syncNonInstrumentedFiles(
	luauRoot: string,
	shadowDirectory: string,
	previousNonInstrumented: Record<string, NonInstrumentedFileRecord> | undefined,
): SyncResult {
	const posixRoot = luauRoot.replaceAll("\\", "/");
	const discovered: Array<string> = [];
	discoverNonInstrumentedFiles(posixRoot, posixRoot, discovered);

	const files: Record<string, NonInstrumentedFileRecord> = {};
	let changed = false;

	for (const relativePath of discovered) {
		const sourcePath = `${posixRoot}/${relativePath}`;
		const shadowPath = `${shadowDirectory}/${relativePath}`;

		const sourceBuffer = fs.readFileSync(path.resolve(sourcePath));
		const currentHash = hashBuffer(sourceBuffer);

		const previousRecord = previousNonInstrumented?.[sourcePath];
		if (previousRecord?.sourceHash === currentHash) {
			files[sourcePath] = previousRecord;
			continue;
		}

		const outputDirectory = path.dirname(shadowPath);
		fs.mkdirSync(outputDirectory, { recursive: true });
		fs.copyFileSync(path.resolve(sourcePath), shadowPath);

		files[sourcePath] = { shadowPath, sourceHash: currentHash, sourcePath };
		changed = true;
	}

	changed = pruneStaleNonInstrumented(posixRoot, previousNonInstrumented, files) || changed;

	return { changed, files };
}

function computeSkipFiles(luauRoot: string, previousManifest: PreviousManifest): Set<string> {
	const skipFiles = new Set<string>();
	const posixRoot = luauRoot.replaceAll("\\", "/");

	for (const [fileKey, record] of Object.entries(previousManifest.files)) {
		if (!fileKey.startsWith(`${posixRoot}/`)) {
			continue;
		}

		const relativePath = fileKey.slice(posixRoot.length + 1);
		const sourcePath = path.resolve(record.originalLuauPath);

		if (!fs.existsSync(sourcePath)) {
			continue;
		}

		const currentHash = hashBuffer(fs.readFileSync(sourcePath));
		if (currentHash === record.sourceHash) {
			skipFiles.add(relativePath);
		}
	}

	return skipFiles;
}

function countPreviousFilesForRoot(luauRoot: string, previousManifest: PreviousManifest): number {
	const posixRoot = luauRoot.replaceAll("\\", "/");
	let count = 0;
	for (const fileKey of Object.keys(previousManifest.files)) {
		if (fileKey.startsWith(`${posixRoot}/`)) {
			count++;
		}
	}

	return count;
}

/**
 * Check if all files in this root are unchanged (full cache hit).
 *
 * `changed` means previous files were deleted or modified — it does NOT cover
 * new files appearing on disk. When `allCached` is false but `changed` is also
 * false, new files exist and the caller detects them when `instrumentRoot`
 * returns non-empty results.
 */
function computeIncrementalState(
	luauRoot: string,
	previousManifest: PreviousManifest,
): { allCached: boolean; changed: boolean; skipFiles: Set<string> } {
	const skipFiles = computeSkipFiles(luauRoot, previousManifest);
	const previousCount = countPreviousFilesForRoot(luauRoot, previousManifest);
	const changed = skipFiles.size !== previousCount;

	if (changed) {
		return { allCached: false, changed, skipFiles };
	}

	// All previous files match. Check if any new files appeared on disk.
	const discovered = discoverInstrumentableFiles(luauRoot);
	const allCached = discovered.size === previousCount;

	return { allCached, changed, skipFiles };
}

function buildFullCacheResult(options: FullCacheOptions): InstrumentRootResult {
	const { luauRoot, previousManifest, rootEntry, shadowDirectory, skipFiles } = options;

	const allFiles: Record<string, InstrumentedFileRecord> = {};
	carryForwardRecords(luauRoot, previousManifest, allFiles, skipFiles);

	const syncResult = syncNonInstrumentedFiles(
		luauRoot,
		shadowDirectory,
		previousManifest.nonInstrumentedFiles,
	);

	return {
		changed: syncResult.changed,
		files: allFiles,
		nonInstrumentedFiles: syncResult.files,
		rootEntry,
	};
}

function instrumentRootWithCache(
	luauRoot: string,
	useIncremental: boolean,
	previousManifest: PreviousManifest | undefined,
): InstrumentRootResult {
	const shadowDirectory = path.join(COVERAGE_DIR, luauRoot).replaceAll("\\", "/");
	let changed = false;

	if (!useIncremental) {
		fs.mkdirSync(shadowDirectory, { recursive: true });
		fs.cpSync(luauRoot, shadowDirectory, { recursive: true });
	}

	const relocatedShadowDirectory = path
		.relative(COVERAGE_DIR, shadowDirectory)
		.replaceAll("\\", "/");
	const rootEntry: RootEntry = { luauRoot, relocatedShadowDirectory, shadowDir: shadowDirectory };

	let skipFiles: Set<string> | undefined;

	if (useIncremental && previousManifest !== undefined) {
		const {
			allCached,
			changed: hasChanges,
			skipFiles: computed,
		} = computeIncrementalState(luauRoot, previousManifest);
		skipFiles = computed;
		changed = hasChanges;

		if (allCached) {
			return buildFullCacheResult({
				luauRoot,
				previousManifest,
				rootEntry,
				shadowDirectory,
				skipFiles,
			});
		}
	}

	const files = instrumentRoot({
		luauRoot,
		shadowDir: shadowDirectory,
		skipFiles,
	});

	if (Object.keys(files).length > 0) {
		changed = true;
	}

	const allFiles: Record<string, InstrumentedFileRecord> = { ...files };

	if (useIncremental && previousManifest !== undefined && skipFiles !== undefined) {
		carryForwardRecords(luauRoot, previousManifest, allFiles, skipFiles);
	}

	const syncResult = syncNonInstrumentedFiles(
		luauRoot,
		shadowDirectory,
		previousManifest?.nonInstrumentedFiles,
	);

	if (syncResult.changed) {
		changed = true;
	}

	return {
		changed,
		files: allFiles,
		nonInstrumentedFiles: syncResult.files,
		rootEntry,
	};
}

function writeManifest(options: WriteManifestOptions): CoverageManifest {
	const { allFiles, luauRoots, manifestPath, nonInstrumentedFiles, placeFile } = options;

	const manifest = {
		files: allFiles,
		generatedAt: new Date().toISOString(),
		instrumenterVersion: INSTRUMENTER_VERSION,
		luauRoots,
		nonInstrumentedFiles,
		placeFilePath: placeFile,
		shadowDir: COVERAGE_DIR,
		version: 1,
	} satisfies CoverageManifest;

	fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
	fs.writeFileSync(manifestPath, JSON.stringify(manifest, undefined, "\t"));

	return manifest;
}

function buildRojoProject(
	rojoProjectPath: string,
	roots: Array<RootEntry>,
	placeFile: string,
): void {
	const rojoProjectRaw = rojoProjectSchema(JSON.parse(fs.readFileSync(rojoProjectPath, "utf-8")));
	if (rojoProjectRaw instanceof type.errors) {
		throw new Error(`Malformed Rojo project JSON: ${rojoProjectRaw.toString()}`);
	}

	const projectRelocation = path
		.relative(COVERAGE_DIR, path.dirname(rojoProjectPath))
		.replaceAll("\\", "/");

	const resolved = {
		...rojoProjectRaw,
		tree: resolveNestedProjects(rojoProjectRaw.tree, path.dirname(rojoProjectPath)),
	};
	const rewritten = rewriteRojoProject(resolved, { projectRelocation, roots });
	const rewrittenProjectPath = path.join(COVERAGE_DIR, path.basename(rojoProjectPath));

	fs.writeFileSync(rewrittenProjectPath, JSON.stringify(rewritten, undefined, "\t"));
	buildWithRojo(rewrittenProjectPath, placeFile);
}

function loadPreviousManifest(manifestPath: string): PreviousManifest | undefined {
	if (!fs.existsSync(manifestPath)) {
		return undefined;
	}

	try {
		const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
		const result = previousManifestSchema(parsed);
		if (result instanceof type.errors) {
			return undefined;
		}

		return result;
	} catch {
		return undefined;
	}
}

function canUseIncremental(
	previousManifest: PreviousManifest | undefined,
	config: ResolvedConfig,
): boolean {
	if (!config.cache) {
		return false;
	}

	if (previousManifest === undefined) {
		return false;
	}

	if (previousManifest.instrumenterVersion !== INSTRUMENTER_VERSION) {
		return false;
	}

	// Force cold rebuild when upgrading from a manifest that lacks
	// nonInstrumentedFiles tracking — prevents orphaned stale test files.
	if (previousManifest.nonInstrumentedFiles === undefined) {
		return false;
	}

	return true;
}

function detectDeletedFiles(
	previousManifest: PreviousManifest,
	currentFiles: Record<string, InstrumentedFileRecord>,
): Array<InstrumentedFileRecord> {
	const deleted: Array<InstrumentedFileRecord> = [];
	for (const [fileKey, record] of Object.entries(previousManifest.files)) {
		if (!(fileKey in currentFiles)) {
			deleted.push(record);
		}
	}

	return deleted;
}

function cleanupDeletedFiles(records: Array<InstrumentedFileRecord>): void {
	for (const record of records) {
		try {
			if (fs.existsSync(record.instrumentedLuauPath)) {
				fs.unlinkSync(record.instrumentedLuauPath);
			}

			if (fs.existsSync(record.coverageMapPath)) {
				fs.unlinkSync(record.coverageMapPath);
			}
		} catch {
			// Best-effort cleanup
		}
	}
}
