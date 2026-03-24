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
import type { CoverageManifest, InstrumentedFileRecord } from "./types.ts";

const COVERAGE_DIR = ".jest-roblox-coverage";

const previousManifestSchema = type({
	"files": type({ "[string]": { sourceHash: "string" } }),
	"instrumenterVersion": "number",
	"luauRoots": "string[]",
	"placeFilePath?": "string",
	"shadowDir": "string",
	"version": "number",
}).as<CoverageManifest>();

export interface PrepareCoverageResult {
	manifest: CoverageManifest;
	placeFile: string;
}

interface InstrumentRootResult {
	changed: boolean;
	files: Record<string, InstrumentedFileRecord>;
	rootEntry: RootEntry;
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
	const roots: Array<RootEntry> = [];
	let hasChanges = !useIncremental;

	for (const luauRoot of luauRoots) {
		const rootResult = instrumentRootWithCache(luauRoot, useIncremental, previousManifest);

		if (rootResult.changed) {
			hasChanges = true;
		}

		Object.assign(allFiles, rootResult.files);
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
	const manifest = writeManifest(manifestPath, allFiles, luauRoots, placeFile);

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

function computeSkipFiles(luauRoot: string, previousManifest: CoverageManifest): Set<string> {
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

function countPreviousFilesForRoot(luauRoot: string, previousManifest: CoverageManifest): number {
	const posixRoot = luauRoot.replaceAll("\\", "/");
	let count = 0;
	for (const fileKey of Object.keys(previousManifest.files)) {
		if (fileKey.startsWith(`${posixRoot}/`)) {
			count++;
		}
	}

	return count;
}

function carryForwardRecords(
	luauRoot: string,
	previousManifest: CoverageManifest,
	allFiles: Record<string, InstrumentedFileRecord>,
	skipFiles: Set<string>,
): void {
	const posixRoot = luauRoot.replaceAll("\\", "/");

	for (const relativePath of skipFiles) {
		const fileKey = `${posixRoot}/${relativePath}`;
		Object.assign(allFiles, { [fileKey]: previousManifest.files[fileKey] });
	}
}

function instrumentRootWithCache(
	luauRoot: string,
	useIncremental: boolean,
	previousManifest: CoverageManifest | undefined,
): InstrumentRootResult {
	const shadowDirectory = path.join(COVERAGE_DIR, luauRoot).replaceAll("\\", "/");
	let changed = false;

	if (!useIncremental) {
		fs.mkdirSync(shadowDirectory, { recursive: true });
		fs.cpSync(luauRoot, shadowDirectory, { recursive: true });
	}

	let skipFiles: Set<string> | undefined;

	if (useIncremental && previousManifest !== undefined) {
		skipFiles = computeSkipFiles(luauRoot, previousManifest);
		const previousCount = countPreviousFilesForRoot(luauRoot, previousManifest);
		// skipFiles.size < previousCount when files changed hash or were deleted
		if (skipFiles.size !== previousCount) {
			changed = true;
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

	const relocatedShadowDirectory = path
		.relative(COVERAGE_DIR, shadowDirectory)
		.replaceAll("\\", "/");

	return {
		changed,
		files: allFiles,
		rootEntry: { luauRoot, relocatedShadowDirectory, shadowDir: shadowDirectory },
	};
}

function writeManifest(
	manifestPath: string,
	allFiles: Record<string, InstrumentedFileRecord>,
	luauRoots: Array<string>,
	placeFile: string,
): CoverageManifest {
	const manifest = {
		files: allFiles,
		generatedAt: new Date().toISOString(),
		instrumenterVersion: INSTRUMENTER_VERSION,
		luauRoots,
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

function loadPreviousManifest(manifestPath: string): CoverageManifest | undefined {
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
	previousManifest: CoverageManifest | undefined,
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

	return true;
}

function detectDeletedFiles(
	previousManifest: CoverageManifest,
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
