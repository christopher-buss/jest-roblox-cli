import type { RojoTreeNode } from "@isentinel/rojo-utils";
import {
	collectPaths,
	parseRojoProject,
	resolveMountPath,
	resolveNestedProjectSources,
} from "@isentinel/rojo-utils";

import * as path from "node:path";
import process from "node:process";

import { mapWithLimitAsync } from "../utils/concurrency.ts";
import { errorMessage } from "../utils/error-message.ts";
import type { FileSystem, Stats } from "../utils/file-system.ts";
import { hashString } from "../utils/hash.ts";
import type { InputDigestCache } from "../utils/input-digest-cache.ts";
import { openInputDigestCache } from "../utils/input-digest-cache.ts";
import { isWithinRoot, normalizeWindowsPath } from "../utils/normalize-windows-path.ts";

/** What the rojo build input hash reads. */
export interface RojoInputsOptions {
	/** Where this walk keeps a digest per file. */
	digestCacheFile: string;
	/** Where the inputs are read. */
	fileSystem: FileSystem;
	/** Instrumented roots to skip, relative to `rootDirectory`. */
	luauRoots: Array<string>;
	/** Project text hashed in place of the file at `rojoProjectPath`. */
	projectJson?: string | undefined;
	/** Path of the rojo project file. */
	rojoProjectPath: string;
	/** Directory input paths are hashed relative to. */
	rootDirectory: string;
}

const HASH_CONCURRENCY = 32;

interface InputWalk {
	files: Set<string>;
	fileSystem: FileSystem;
	luauRootKeys: Array<string>;
	visitedDirectories: Set<string>;
}

interface ProjectDigest {
	key: string;
	hash: string;
}

/**
 * Hash the rojo build inputs outside the luauRoots; warn and return
 * `undefined` on failure.
 * @param options - Project, roots, digest cache and file system.
 * @returns Hex digest of the inputs, or undefined after a warning.
 */
export async function tryComputeRojoInputsHashAsync(
	options: RojoInputsOptions,
): Promise<string | undefined> {
	try {
		return await computeRojoInputsHashAsync(options);
	} catch (err) {
		process.stderr.write(`Warning: could not hash rojo build inputs: ${errorMessage(err)}
`);
		return undefined;
	}
}

function toKey(filePath: string): string {
	return normalizeWindowsPath(filePath);
}

async function walkMountedInputsAsync({
	projectDirectory,
	tree,
	walk,
}: {
	projectDirectory: string;
	tree: RojoTreeNode;
	walk: InputWalk;
}): Promise<void> {
	const mounts: Array<string> = [];
	collectPaths(tree, mounts);
	const distinctMounts = new Set(mounts);
	for (const mount of distinctMounts) {
		await collectInputFilesAsync(toKey(resolveMountPath(projectDirectory, mount)), walk);
	}
}

async function digestFilesAsync({
	digests,
	files,
	project,
	rootDirectory,
}: {
	digests: InputDigestCache;
	files: Set<string>;
	project: ProjectDigest;
	rootDirectory: string;
}): Promise<string> {
	const lines = await mapWithLimitAsync({
		func: async (file) => {
			const relativePath = toKey(path.relative(rootDirectory, file));
			const hash = file === project.key ? project.hash : await digests.hashOfAsync(file);
			return `${relativePath}\0${hash}`;
		},
		items: [...files],
		limit: HASH_CONCURRENCY,
	});

	lines.sort();
	return hashString(lines.join("\n"));
}

async function computeRojoInputsHashAsync({
	digestCacheFile,
	fileSystem,
	luauRoots,
	projectJson,
	rojoProjectPath,
	rootDirectory,
}: RojoInputsOptions): Promise<string> {
	// Must open before any read: digests record only files older than this.
	const digests = openInputDigestCache(digestCacheFile, fileSystem);
	const projectDirectory = path.dirname(rojoProjectPath);
	// Parse and hash the same text; a second read could see another state.
	const projectText =
		projectJson ?? (await fileSystem.promises.readFile(rojoProjectPath, "utf-8"));
	const project: ProjectDigest = { key: toKey(rojoProjectPath), hash: hashString(projectText) };

	const { tree: rawTree } = parseRojoProject(projectText, rojoProjectPath);
	const { projectFiles, tree } = resolveNestedProjectSources(
		{ rootDirectory: projectDirectory, tree: rawTree },
		fileSystem,
	);

	const files = new Set<string>([project.key]);
	for (const projectFile of projectFiles) {
		files.add(toKey(projectFile));
	}

	await walkMountedInputsAsync({
		projectDirectory,
		tree,
		walk: {
			files,
			fileSystem,
			luauRootKeys: luauRoots.map((root) => toKey(path.join(rootDirectory, root))),
			visitedDirectories: new Set<string>(),
		},
	});

	const hash = await digestFilesAsync({ digests, files, project, rootDirectory });
	// Save only after the last read, so a failed walk keeps the old record.
	digests.save();
	return hash;
}

function coveredByLuauRoot(directoryKey: string, luauRootKeys: Array<string>): boolean {
	return luauRootKeys.some((root) => isWithinRoot(directoryKey, root));
}

async function collectInputFilesAsync(target: string, walk: InputWalk): Promise<void> {
	let stats: Stats;
	try {
		stats = await walk.fileSystem.promises.stat(target);
	} catch {
		return;
	}

	if (stats.isDirectory()) {
		await descendAsync({ directory: target, walk });
		return;
	}

	walk.files.add(target);
}

async function descendAsync({
	directory,
	inheritedReal,
	walk,
}: {
	directory: string;
	inheritedReal?: string | undefined;
	walk: InputWalk;
}): Promise<void> {
	if (coveredByLuauRoot(directory, walk.luauRootKeys)) {
		return;
	}

	const real = inheritedReal ?? toKey(await walk.fileSystem.promises.realpath(directory));
	if (walk.visitedDirectories.has(real)) {
		return;
	}

	walk.visitedDirectories.add(real);

	const entries = await walk.fileSystem.promises.readdir(directory, { withFileTypes: true });
	for (const entry of entries) {
		if (entry.name.startsWith(".")) {
			continue;
		}

		const target = `${directory}/${entry.name}`;
		if (entry.isDirectory()) {
			await descendAsync({ directory: target, inheritedReal: `${real}/${entry.name}`, walk });
			continue;
		}

		if (entry.isSymbolicLink()) {
			await collectInputFilesAsync(target, walk);
			continue;
		}

		walk.files.add(target);
	}
}
