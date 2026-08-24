import { type, type Type } from "arktype";
import type { Dirent } from "node:fs";
import * as fs from "node:fs";
import path from "node:path";

import type { PartitionInfo, RbxPath } from "./rbx-path.ts";
import {
	convertToLuau,
	isRojoProjectFileName,
	ROJO_DEFAULT_NAME,
	ROJO_MODULE_EXTS,
} from "./rojo-file-paths.ts";

export type RojoTree = RojoTreeMembers & RojoTreeMetadata;

/**
 * Everything a walk of a Rojo project discovers. The resolver owns these
 * collections once the walk returns; the walker keeps no reference.
 */
export interface RojoWalk {
	filePathToRbxPathMap: Map<string, RbxPath>;
	isGame: boolean;
	partitions: Array<PartitionInfo>;
	walkedConfigFiles: Set<string>;
	walkedDirectories: Set<string>;
	warnings: Array<string>;
}

/**
 * Rojo `$properties` entry.
 *
 * @external
 */
interface RojoTreeProperty {
	Type: string;
	Value: unknown;
}

interface RojoTreeMetadata {
	$className?: string;
	$ignoreUnknownInstances?: boolean;
	$path?: string | { optional: string };
	$properties?: Array<RojoTreeProperty>;
}

interface RojoTreeMembers {
	// Members are trees, but the metadata keys above live in the same object, so
	// the index signature has to admit their value types too. Walkers narrow
	// with `isRojoTree` after filtering out the `$`-prefixed keys.
	[name: string]:
		| Array<RojoTreeProperty>
		| boolean
		| RojoTree
		| string
		| undefined
		| { optional: string };
}

interface RojoFile {
	name: string;
	servePort?: number;
	tree: RojoTree;
}

let rojoFileSchema: Type<RojoFile> | undefined;

/**
 * Mutable state for a single walk. Kept private to this module: callers go
 * through {@link walkRojoConfig} / {@link walkRojoTree} and receive a plain
 * {@link RojoWalk}.
 */
class RojoWalker {
	private readonly filePathToRbxPathMap = new Map<string, RbxPath>();
	private readonly partitions = new Array<PartitionInfo>();
	private readonly rbxPath = new Array<string>();
	private readonly realpathCache = new Map<string, string>();
	private readonly walkedConfigFiles = new Set<string>();
	private readonly walkedDirectories = new Set<string>();
	private readonly warnings = new Array<string>();

	private isGame = false;

	public parseConfig(rojoConfigFilePath: string, doNotPush = false): void {
		if (!fs.existsSync(rojoConfigFilePath)) {
			this.warn(`RojoResolver: Path does not exist "${rojoConfigFilePath}"`);
			return;
		}

		const realPath = this.cachedRealpath(rojoConfigFilePath);
		this.walkedConfigFiles.add(realPath);

		let configJson: JSONValue | undefined;
		try {
			configJson = JSON.parse(fs.readFileSync(realPath, "utf8"));
		} catch {
			// Malformed JSON: leave configJson undefined and fall through so it
			// is reported as an invalid configuration rather than crashing the
			// caller.
		}

		const config = parseRojoConfig(configJson);
		if (config === undefined) {
			this.warn("RojoResolver: Invalid configuration!");
			return;
		}

		this.parseTree(path.dirname(rojoConfigFilePath), config.name, config.tree, doNotPush);
	}

	public parseTree(basePath: string, name: string, tree: RojoTree, doNotPush = false): void {
		if (!doNotPush) {
			this.rbxPath.push(name);
		}

		if (tree.$path !== undefined) {
			this.parsePath(
				path.resolve(
					basePath,
					typeof tree.$path === "string" ? tree.$path : tree.$path.optional,
				),
			);
		}

		if (tree.$className === "DataModel") {
			this.isGame = true;
		}

		const childNames = Object.keys(tree).filter((value) => !value.startsWith("$"));
		for (const childName of childNames) {
			const child = tree[childName];
			if (isRojoTree(child)) {
				this.parseTree(basePath, childName, child);
			}
		}

		if (!doNotPush) {
			this.rbxPath.pop();
		}
	}

	public result(): RojoWalk {
		return {
			filePathToRbxPathMap: this.filePathToRbxPathMap,
			isGame: this.isGame,
			partitions: this.partitions,
			walkedConfigFiles: this.walkedConfigFiles,
			walkedDirectories: this.walkedDirectories,
			warnings: this.warnings,
		};
	}

	private cachedRealpath(targetPath: string): string {
		let resolved = this.realpathCache.get(targetPath);
		if (resolved === undefined) {
			resolved = fs.realpathSync(targetPath);
			this.realpathCache.set(targetPath, resolved);
		}

		return resolved;
	}

	private classifyEntry(
		directory: string,
		entry: Dirent,
	): undefined | { isDirectory: boolean; isFile: boolean } {
		let isFile = entry.isFile();
		let isDirectory = entry.isDirectory();
		if (isFile || isDirectory) {
			return { isDirectory, isFile };
		}

		// Symlinks (both flags false), unknown-type entries on NFS/SMB/FUSE
		// mounts and some Windows network drives, and NTFS junctions on Node
		// versions that don't classify them: resolve and stat the target so we
		// still discover nested *.project.json files and walkable directories. A
		// broken symlink throws ENOENT here — warn and skip rather than crash the
		// whole walk.
		const childPath = path.join(directory, entry.name);
		try {
			const stat = fs.statSync(this.cachedRealpath(childPath));
			isFile = stat.isFile();
			isDirectory = stat.isDirectory();
		} catch (err) {
			this.warn(`RojoResolver: Failed to resolve "${childPath}" (${String(err)})`);
			return undefined;
		}

		return { isDirectory, isFile };
	}

	private parsePath(itemPath: string): void {
		const luauPath = convertToLuau(itemPath);

		// A $path pointing straight at a *.project.json file embeds that nested
		// project at the current rbxPath (Rojo composes projects this way), the
		// same as a directory whose default.project.json is discovered below.
		// Without this, the .json extension routes the file into
		// filePathToRbxPathMap as an opaque leaf and the nested tree's mounts
		// (its partitions, its @rbxts mounts) are never read.
		if (isRojoProjectFileName(path.basename(luauPath))) {
			this.parseConfig(luauPath, true);
			return;
		}

		const realPath = fs.existsSync(luauPath) ? this.cachedRealpath(luauPath) : luauPath;
		const extension = path.extname(luauPath);
		if (ROJO_MODULE_EXTS.has(extension)) {
			this.filePathToRbxPathMap.set(luauPath, [...this.rbxPath]);
		} else {
			const isDirectory = fs.existsSync(realPath) && fs.statSync(realPath).isDirectory();
			if (isDirectory) {
				this.walkedDirectories.add(realPath);
			}

			if (isDirectory && fs.readdirSync(realPath).includes(ROJO_DEFAULT_NAME)) {
				this.parseConfig(path.join(luauPath, ROJO_DEFAULT_NAME), true);
			} else {
				this.partitions.unshift({
					fsPath: luauPath,
					rbxPath: [...this.rbxPath],
				});

				if (isDirectory) {
					this.searchDirectory(luauPath);
				}
			}
		}
	}

	private searchChildren(directory: string, directoryEntries: Array<Dirent>): void {
		// Two-phase: parse every sibling *.project.json before recursing into
		// sibling directories. parsePath / parseConfig insert partitions via
		// unshift, and getRbxPathFromFilePath returns the first match, so
		// interleaving in raw entry order would shuffle partition precedence
		// for overlapping mounts.
		const projectFiles = new Array<string>();
		const subDirectories = new Array<{ name: string; path: string }>();

		for (const entry of directoryEntries) {
			const kind = this.classifyEntry(directory, entry);
			if (kind === undefined) {
				continue;
			}

			const childPath = path.join(directory, entry.name);
			if (kind.isFile && isRojoProjectFileName(entry.name)) {
				projectFiles.push(childPath);
			} else if (kind.isDirectory) {
				subDirectories.push({ name: entry.name, path: childPath });
			}
		}

		for (const childPath of projectFiles) {
			this.parseConfig(childPath);
		}

		for (const { name, path: childPath } of subDirectories) {
			this.searchDirectory(childPath, name);
		}
	}

	private searchDirectory(directory: string, item?: string): void {
		const realPath = this.cachedRealpath(directory);
		this.walkedDirectories.add(realPath);
		// readdirSync transparently follows a symlink on the argument; the
		// result is equivalent to readdirSync(realpathSync(directory)).
		const directoryEntries = fs.readdirSync(directory, { withFileTypes: true });

		if (directoryEntries.some((entry) => entry.name === ROJO_DEFAULT_NAME)) {
			this.parseConfig(path.join(directory, ROJO_DEFAULT_NAME));
			return;
		}

		if (item !== undefined) {
			this.rbxPath.push(item);
		}

		this.searchChildren(directory, directoryEntries);

		if (item !== undefined) {
			this.rbxPath.pop();
		}
	}

	private warn(message: string): void {
		this.warnings.push(message);
	}
}

/**
 * Walk a Rojo project file, following every nested project and `$path` mount it
 * references.
 * @param rojoConfigFilePath - Path to the `*.project.json` file to walk.
 * @returns Everything the walk discovered.
 */
export function walkRojoConfig(rojoConfigFilePath: string): RojoWalk {
	const walker = new RojoWalker();
	walker.parseConfig(path.resolve(rojoConfigFilePath), true);
	return walker.result();
}

/**
 * Walk an in-memory Rojo tree rather than a project file on disk.
 * @param basePath - The directory `$path` values resolve against.
 * @param tree - The tree to walk.
 * @returns Everything the walk discovered.
 */
export function walkRojoTree(basePath: string, tree: RojoTree): RojoWalk {
	const walker = new RojoWalker();
	walker.parseTree(basePath, "", tree, true);
	return walker.result();
}

/**
 * Parse a project file's JSON into the fields the resolver reads.
 *
 * The schema is built lazily on first use (not at module top level) so
 * consumers can auto-mock this module without a hoisting TDZ on the arktype
 * import, then memoized so repeated tree-walk validations don't re-allocate
 * it. Only the fields the resolver reads are checked; `parseTree` handles
 * arbitrary tree shapes defensively.
 *
 * @param value - The parsed JSON of a `*.project.json` file, or undefined
 *   when the file could not be parsed.
 * @returns The project's fields, or undefined when the file is not a project.
 */
function parseRojoConfig(value: JSONValue | undefined): RojoFile | undefined {
	rojoFileSchema ??= type({
		"name": "string",
		"servePort?": "number",
		// `parseTree` dereferences `$path` and `$className` straight off the
		// value this returns, so the schema has to earn the `RojoFile` claim for
		// them — a `$path` of `42` otherwise types as `string | {optional}` and
		// reaches `path.resolve` as undefined. Members are left to `isRojoTree`;
		// a tree's key space mixes `$`-metadata with child nodes, so arktype
		// cannot recurse through it without rejecting the `$` keys Rojo adds
		// that this fork does not model.
		"tree": type({
			"$className?": "string",
			"$ignoreUnknownInstances?": "boolean",
			"$path?": ["string", "|", { optional: "string" }],
			"$properties?": "object",
		}).narrow((tree) => !Array.isArray(tree)),
	}).as<RojoFile>();

	const result = rojoFileSchema(value);
	return result instanceof type.errors ? undefined : result;
}

function isRojoTree(value: unknown): value is RojoTree {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
