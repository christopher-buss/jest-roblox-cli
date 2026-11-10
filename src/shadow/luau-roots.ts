import type { RojoProject } from "@isentinel/rojo-utils";
import { tryLoadRojoProject } from "@isentinel/rojo-utils";

import * as path from "node:path";
import process from "node:process";
import picomatch from "picomatch";

import type { ResolvedConfig } from "../config/resolved-config.ts";
import type { CopyIgnoreMatcher } from "../instrument/discover-files.ts";
import type { InstrumentUniverse } from "../instrument/instrument-universe.ts";
import type { TsconfigReader } from "../tsconfig/tsconfig-mappings.ts";
import { errorMessage } from "../utils/error-message.ts";
import type { FileSystem } from "../utils/file-system.ts";
import type { PosixRoot } from "../utils/normalize-windows-path.ts";
import { isAbsolutePath, toPosixRoot } from "../utils/normalize-windows-path.ts";
import type { ExplicitRootCheck } from "./discover-roots.ts";
import { discoverLuauRoots, isLuauFile } from "./discover-roots.ts";
import type { NarrowedMount } from "./narrow-roots.ts";
import { narrowRootsInFrame } from "./narrow-roots.ts";
import { collectRojoMounts } from "./root-reachability.ts";

interface RojoProjectInFrame {
	project: RojoProject;
	rojoDirectory: string;
}

interface RojoProjectRead {
	failure: Error | undefined;
	loaded: RojoProjectInFrame | undefined;
}

interface RojoContext {
	check: ExplicitRootCheck | undefined;
	config: ResolvedConfig;
	fileSystem: FileSystem;
	read: () => RojoProjectRead;
	tsconfigReader: TsconfigReader;
}

/**
 * The run's luau roots from config, rojo mounts or tsconfig `outDir`, deduped
 * in canonical spelling.
 * @param options - Config, file system and tsconfig reader.
 * @returns Canonical luau roots.
 * @throws {Error} When no source supplies roots or the rojo project is
 *   malformed.
 */
export function resolveLuauRoots({
	config,
	fileSystem,
	tsconfigReader,
}: {
	config: ResolvedConfig;
	fileSystem: FileSystem;
	tsconfigReader: TsconfigReader;
}): Array<PosixRoot> {
	return resolveLuauRootsWithRojo(
		readRojoContext({
			check: undefined,
			config,
			fileSystem,
			rojoProjectPath: config.rojoProject,
			tsconfigReader,
		}),
	);
}

/**
 * The luau roots this run instruments: the configured or auto-detected ones,
 * narrowed to the directories the coverage universe actually reaches.
 * @param options - Config, file system, copy-ignore gate, rojo project path,
 *   tsconfig reader and universe.
 * @returns Narrowed mounts.
 * @throws {Error} When no roots are found, a root is absolute, or the rojo
 *   project is malformed.
 */
export function narrowConfiguredRoots({
	config,
	fileSystem,
	isCopyIgnored,
	rojoProjectPath,
	tsconfigReader,
	universe,
}: {
	config: ResolvedConfig;
	fileSystem: FileSystem;
	isCopyIgnored: CopyIgnoreMatcher;
	rojoProjectPath: string | undefined;
	tsconfigReader: TsconfigReader;
	universe: InstrumentUniverse | undefined;
}): Array<NarrowedMount> {
	if (config.luauRoots !== undefined) {
		validateRelativeRoots(config.luauRoots.map(toPosixRoot));
	}

	const rojo = readRojoContext({
		check: {
			frameName: "rootDir",
			warn: (text) => {
				process.stderr.write(text);
			},
		},
		config,
		fileSystem,
		rojoProjectPath,
		tsconfigReader,
	});
	const mounts = resolveLuauRootsWithRojo(rojo);

	validateRelativeRoots(mounts);

	return narrowRootsInFrame(mounts, {
		fileSystem,
		frame: config.rootDir,
		isCopyIgnored,
		rojoMounts: resolveRojoMounts(rojo),
		universe,
	});
}

function findRawLuauRoots({
	check,
	config,
	fileSystem,
	read,
	tsconfigReader,
}: RojoContext): Array<string> | undefined {
	const hasExplicit = config.luauRoots !== undefined && config.luauRoots.length > 0;
	const { failure, loaded } = read();
	if (!hasExplicit && failure !== undefined) {
		throw failure;
	}

	const roots = discoverLuauRoots({
		check,
		explicit: config.luauRoots,
		fileSystem,
		frame: config.rootDir,
		holdsRoot: isLuauFile,
		isIgnored: (relative) => {
			// Must match Jest's coveragePathIgnorePatterns substring semantics.
			return picomatch.isMatch(relative, config.coveragePathIgnorePatterns, {
				contains: true,
			});
		},
		rojo: loaded && { rojoDirectory: loaded.rojoDirectory, tree: loaded.project.tree },
	});
	if (roots !== undefined) {
		return roots;
	}

	const tsconfig = tsconfigReader(config.rootDir) ?? undefined;
	return tsconfig?.config.compilerOptions?.outDir === undefined
		? undefined
		: [tsconfig.config.compilerOptions.outDir];
}

function selectRawLuauRoots(context: RojoContext): Array<string> {
	const roots = findRawLuauRoots(context);
	if (roots === undefined) {
		throw new Error(
			"Could not determine luauRoots. Set luauRoots in config or ensure tsconfig has outDir.",
		);
	}

	return roots;
}

function dedupeRoots(roots: ReadonlyArray<string>): Array<PosixRoot> {
	return [...new Set(roots.map(toPosixRoot))];
}

function resolveLuauRootsWithRojo(context: RojoContext): Array<PosixRoot> {
	return dedupeRoots(selectRawLuauRoots(context));
}

function readNoRojoProject(): RojoProjectRead {
	return { failure: undefined, loaded: undefined };
}

function loadResolvedRojoProject(fileSystem: FileSystem, resolvedPath: string): RojoProjectRead {
	try {
		const project = tryLoadRojoProject(resolvedPath, fileSystem);
		return {
			failure: undefined,
			loaded:
				project === undefined
					? undefined
					: { project, rojoDirectory: path.dirname(resolvedPath) },
		};
	} catch (err) {
		return { failure: new Error(errorMessage(err), { cause: err }), loaded: undefined };
	}
}

function readOnce(read: () => RojoProjectRead): () => RojoProjectRead {
	let cached: RojoProjectRead | undefined;
	return () => {
		cached ??= read();
		return cached;
	};
}

function readRojoContext({
	check,
	config,
	fileSystem,
	rojoProjectPath,
	tsconfigReader,
}: {
	check: ExplicitRootCheck | undefined;
	config: ResolvedConfig;
	fileSystem: FileSystem;
	rojoProjectPath: string | undefined;
	tsconfigReader: TsconfigReader;
}): RojoContext {
	const read =
		rojoProjectPath === undefined
			? readNoRojoProject
			: () => loadResolvedRojoProject(fileSystem, rojoProjectPath);
	return { check, config, fileSystem, read: readOnce(read), tsconfigReader };
}

/**
 * Not `path.isAbsolute`: it answers for the host OS, not the root's spelling.
 *
 * @param luauRoots - Canonical roots to check.
 * @throws {Error} When a root is absolute.
 */
function validateRelativeRoots(luauRoots: ReadonlyArray<PosixRoot>): void {
	for (const root of luauRoots) {
		if (isAbsolutePath(root)) {
			throw new Error(
				"luauRoots must be relative paths, got absolute path. " +
					"Set a relative outDir in tsconfig or relative luauRoots in config.",
			);
		}
	}
}

function resolveRojoMounts({ read }: RojoContext): ReadonlySet<string> {
	const { loaded } = read();
	if (loaded === undefined) {
		return new Set();
	}

	return collectRojoMounts(loaded.project.tree, loaded.rojoDirectory);
}
