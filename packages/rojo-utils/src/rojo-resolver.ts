import { type } from "arktype";
import type { Dirent } from "node:fs";
import * as fs from "node:fs";
import path from "node:path";

const LUA_EXT = ".lua";
const LUAU_EXT = ".luau";
const JSON_EXT = ".json";
const TOML_EXT = ".toml";

const ROJO_MODULE_EXTS = new Set([JSON_EXT, LUAU_EXT, TOML_EXT]);
const ROJO_SCRIPT_EXTS = new Set([LUAU_EXT]);

const INIT_NAME = "init";

const SERVER_SUB_EXTENSION = ".server";
const CLIENT_SUB_EXTENSION = ".client";
const MODULE_SUB_EXTENSION = "";

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

type RojoTree = RojoTreeMembers & RojoTreeMetadata;

interface RojoTreeMembers {
	[name: string]: RojoTree;
}

interface RojoFile {
	name: string;
	servePort?: number;
	tree: RojoTree;
}

const ROJO_FILE_REGEX = /^.+\.project\.json$/;
const ROJO_DEFAULT_NAME = "default.project.json";
const ROJO_OLD_NAME = "roblox-project.json";

export const RbxType = {
	LocalScript: 2,
	ModuleScript: 0,
	Script: 1,
	Unknown: 3,
} as const;

export type RbxType = (typeof RbxType)[keyof typeof RbxType];

const SUB_EXT_TYPE_MAP = new Map<string, RbxType>([
	[CLIENT_SUB_EXTENSION, RbxType.LocalScript],
	[MODULE_SUB_EXTENSION, RbxType.ModuleScript],
	[SERVER_SUB_EXTENSION, RbxType.Script],
]);

/** Represents a roblox tree path. */
export type RbxPath = ReadonlyArray<string>;
export type RelativeRbxPath = ReadonlyArray<RbxPathParent | string>;

export interface PartitionInfo {
	fsPath: string;
	rbxPath: RbxPath;
}

const DEFAULT_ISOLATED_CONTAINERS: Array<RbxPath> = [
	["StarterPack"],
	["StarterGui"],
	["StarterPlayer", "StarterPlayerScripts"],
	["StarterPlayer", "StarterCharacterScripts"],
	["StarterPlayer", "StarterCharacter"],
	["PluginDebugService"],
];

const CLIENT_CONTAINERS: Array<RbxPath> = [["StarterPack"], ["StarterGui"], ["StarterPlayer"]];
const SERVER_CONTAINERS: Array<RbxPath> = [["ServerStorage"], ["ServerScriptService"]];

export const FileRelation = {
	InToIn: 3,
	InToOut: 2,
	OutToIn: 1,
	OutToOut: 0,
} as const;

export type FileRelation = (typeof FileRelation)[keyof typeof FileRelation];

export const NetworkType = {
	Client: 1,
	Server: 2,
	Unknown: 0,
} as const;

export type NetworkType = (typeof NetworkType)[keyof typeof NetworkType];

/** Serializable snapshot of a {@link RojoResolver} for disk caching. */
export interface RojoResolverState {
	filePathToRbxPathMap: Array<[string, RbxPath]>;
	isGame: boolean;
	isolatedContainers: Array<RbxPath>;
	partitions: Array<PartitionInfo>;
	walkedConfigFiles: Array<string>;
	walkedDirs: Array<string>;
	warnings: Array<string>;
}

function stripRojoExtensions(filePath: string): string {
	let stripped = filePath;
	const extension = path.extname(stripped);
	if (ROJO_MODULE_EXTS.has(extension)) {
		stripped = stripped.slice(0, -extension.length);
		if (ROJO_SCRIPT_EXTS.has(extension)) {
			const subExtension = path.extname(stripped);
			if (subExtension === SERVER_SUB_EXTENSION || subExtension === CLIENT_SUB_EXTENSION) {
				stripped = stripped.slice(0, -subExtension.length);
			}
		}
	}

	return stripped;
}

function arrayStartsWith<T>(a: ReadonlyArray<T>, b: ReadonlyArray<T>): boolean {
	const minLength = Math.min(a.length, b.length);
	for (let index = 0; index < minLength; index++) {
		if (a[index] !== b[index]) {
			return false;
		}
	}

	return true;
}

function isPathDescendantOf(filePath: string, directoryPath: string): boolean {
	return directoryPath === filePath || !path.relative(directoryPath, filePath).startsWith("..");
}

let rojoFileSchema: type.Any | undefined;

function isValidRojoConfig(value: unknown): value is RojoFile {
	// Built lazily on first use (not at module top level) so consumers can
	// auto-mock this module without a hoisting TDZ on the arktype import, then
	// memoized so repeated tree-walk validations don't re-allocate the schema. We
	// validate only the fields the resolver reads; parseTree handles arbitrary
	// tree shapes defensively.
	rojoFileSchema ??= type({
		"name": "string",
		"servePort?": "number",
		"tree": "object",
	});
	return !(rojoFileSchema(value) instanceof type.errors);
}

function convertToLuau(filePath: string): string {
	const extension = path.extname(filePath);
	if (extension === LUA_EXT) {
		return filePath.slice(0, -extension.length) + LUAU_EXT;
	}

	return filePath;
}

export const RbxPathParent: unique symbol = Symbol("Parent");
export type RbxPathParent = typeof RbxPathParent;

export class RojoResolver {
	private readonly rbxPath = new Array<string>();
	private readonly realpathCache = new Map<string, string>();
	private readonly walkedConfigFilesInternal = new Set<string>();
	private readonly walkedDirectoriesInternal = new Set<string>();

	private filePathToRbxPathMap = new Map<string, RbxPath>();
	private isolatedContainers = [...DEFAULT_ISOLATED_CONTAINERS];
	private partitions = new Array<PartitionInfo>();
	private warnings = new Array<string>();

	public isGame = false;

	public static findRojoConfigFilePath(projectPath: string): {
		path: string | undefined;
		warnings: Array<string>;
	} {
		const warnings = new Array<string>();

		const defaultPath = path.join(projectPath, ROJO_DEFAULT_NAME);
		if (fs.existsSync(defaultPath)) {
			return { path: defaultPath, warnings };
		}

		const candidates = new Array<string | undefined>();
		for (const fileName of fs.readdirSync(projectPath)) {
			if (
				fileName !== ROJO_DEFAULT_NAME &&
				(fileName === ROJO_OLD_NAME || ROJO_FILE_REGEX.test(fileName))
			) {
				candidates.push(path.join(projectPath, fileName));
			}
		}

		if (candidates.length > 1) {
			warnings.push(`Multiple *.project.json files found, using ${candidates[0]}`);
		}

		return { path: candidates[0], warnings };
	}

	public static fromPath(rojoConfigFilePath: string): RojoResolver {
		const resolver = new RojoResolver();
		resolver.parseConfig(path.resolve(rojoConfigFilePath), true);
		return resolver;
	}

	/**
	 * Restore a resolver from a {@link RojoResolverState} snapshot.
	 * @param state - The serialized resolver state to restore from.
	 * @returns A resolver equivalent to the one the state was captured from.
	 */
	public static fromState(state: RojoResolverState): RojoResolver {
		const resolver = new RojoResolver();

		resolver.partitions = state.partitions.map((partition) => {
			return { fsPath: partition.fsPath, rbxPath: partition.rbxPath.slice() };
		});

		const filePathToRbxPathMap = new Map<string, RbxPath>();
		for (const [filePath, rbxPath] of state.filePathToRbxPathMap) {
			filePathToRbxPathMap.set(filePath, rbxPath.slice());
		}

		resolver.filePathToRbxPathMap = filePathToRbxPathMap;
		resolver.isolatedContainers = state.isolatedContainers.map((container) =>
			container.slice(),
		);
		resolver.isGame = state.isGame;
		resolver.warnings = state.warnings.slice();

		for (const directory of state.walkedDirs) {
			resolver.walkedDirectoriesInternal.add(directory);
		}

		for (const configFile of state.walkedConfigFiles) {
			resolver.walkedConfigFilesInternal.add(configFile);
		}

		return resolver;
	}

	public static fromTree(basePath: string, tree: RojoTree): RojoResolver {
		const resolver = new RojoResolver();
		resolver.parseTree(basePath, "", tree, true);
		return resolver;
	}

	public getFileRelation(fileRbxPath: RbxPath, moduleRbxPath: RbxPath): FileRelation {
		const fileContainer = this.getContainer(this.isolatedContainers, fileRbxPath);
		const moduleContainer = this.getContainer(this.isolatedContainers, moduleRbxPath);
		if (fileContainer && moduleContainer) {
			if (fileContainer === moduleContainer) {
				return FileRelation.InToIn;
			}

			return FileRelation.OutToIn;
		}

		if (fileContainer && !moduleContainer) {
			return FileRelation.InToOut;
		}

		if (!fileContainer && moduleContainer) {
			return FileRelation.OutToIn;
		}

		// !fileContainer && !moduleContainer
		return FileRelation.OutToOut;
	}

	public getNetworkType(rbxPath: RbxPath): NetworkType {
		if (this.getContainer(SERVER_CONTAINERS, rbxPath)) {
			return NetworkType.Server;
		}

		if (this.getContainer(CLIENT_CONTAINERS, rbxPath)) {
			return NetworkType.Client;
		}

		return NetworkType.Unknown;
	}

	public getPartitions(): ReadonlyArray<PartitionInfo> {
		return this.partitions;
	}

	public getRbxPathFromFilePath(filePath: string): RbxPath | undefined {
		const resolved = convertToLuau(path.resolve(filePath));

		const rbxPath = this.filePathToRbxPathMap.get(resolved);
		if (rbxPath) {
			return rbxPath;
		}

		const extension = path.extname(resolved);
		for (const partition of this.partitions) {
			if (isPathDescendantOf(resolved, partition.fsPath)) {
				const stripped = stripRojoExtensions(resolved);
				const relativePath = path.relative(partition.fsPath, stripped);
				const relativeParts = relativePath === "" ? [] : relativePath.split(path.sep);
				if (ROJO_SCRIPT_EXTS.has(extension) && relativeParts.at(-1) === INIT_NAME) {
					relativeParts.pop();
				}

				return partition.rbxPath.concat(relativeParts);
			}
		}

		return undefined;
	}

	public getRbxTypeFromFilePath(filePath: string): RbxType {
		const resolved = convertToLuau(filePath);
		const extension = path.extname(resolved);
		const subExtension = path.extname(path.basename(resolved, extension));
		if (ROJO_SCRIPT_EXTS.has(extension)) {
			return SUB_EXT_TYPE_MAP.get(subExtension) ?? RbxType.Unknown;
		}

		// non-script exts cannot use .server, .client, etc.
		return RbxType.ModuleScript;
	}

	/**
	 * Serialize this resolver to a {@link RojoResolverState} snapshot.
	 * @returns A serializable snapshot of this resolver's state.
	 */
	public getState(): RojoResolverState {
		const filePathToRbxPathMap = new Array<[string, RbxPath]>();
		for (const [filePath, rbxPath] of this.filePathToRbxPathMap) {
			filePathToRbxPathMap.push([filePath, rbxPath.slice()]);
		}

		return {
			filePathToRbxPathMap,
			isGame: this.isGame,
			isolatedContainers: this.isolatedContainers.map((container) => container.slice()),
			partitions: this.partitions.map((partition) => {
				return { fsPath: partition.fsPath, rbxPath: partition.rbxPath.slice() };
			}),
			walkedConfigFiles: Array.from(this.walkedConfigFilesInternal),
			walkedDirs: Array.from(this.walkedDirectoriesInternal),
			warnings: this.warnings.slice(),
		};
	}

	public getWarnings(): ReadonlyArray<string> {
		return this.warnings;
	}

	public isIsolated(rbxPath: RbxPath): boolean {
		return this.getContainer(this.isolatedContainers, rbxPath) !== undefined;
	}

	public static relative(rbxFrom: RbxPath, rbxTo: RbxPath): RelativeRbxPath {
		const maxLength = Math.max(rbxFrom.length, rbxTo.length);
		let diffIndex = maxLength;
		for (let index = 0; index < maxLength; index++) {
			if (rbxFrom[index] !== rbxTo[index]) {
				diffIndex = index;
				break;
			}
		}

		const result = new Array<RbxPathParent | string>();
		if (diffIndex < rbxFrom.length) {
			for (let index = 0; index < rbxFrom.length - diffIndex; index++) {
				result.push(RbxPathParent);
			}
		}

		for (let index = diffIndex; index < rbxTo.length; index++) {
			// eslint-disable-next-line ts/no-non-null-assertion -- Loop index
			result.push(rbxTo[index]!);
		}

		return result;
	}

	/**
	 * Create a synthetic RojoResolver for ProjectType.Package. Forces all imports
	 * to be relative.
	 * @param basePath - The base filesystem path the package resolves against.
	 * @returns A resolver that maps every file in the package relatively.
	 */
	public static synthetic(basePath: string): RojoResolver {
		const resolver = new RojoResolver();
		resolver.parseTree(basePath, "", { $path: basePath } as RojoTree, true);
		return resolver;
	}

	public get walkedConfigFiles(): ReadonlySet<string> {
		return this.walkedConfigFilesInternal;
	}

	public get walkedDirectories(): ReadonlySet<string> {
		return this.walkedDirectoriesInternal;
	}

	private cachedRealpath(targetPath: string): string {
		let resolved = this.realpathCache.get(targetPath);
		if (resolved === undefined) {
			resolved = fs.realpathSync(targetPath);
			this.realpathCache.set(targetPath, resolved);
		}

		return resolved;
	}

	private getContainer(from: Array<RbxPath>, rbxPath?: RbxPath): RbxPath | undefined {
		if (this.isGame && rbxPath) {
			for (const container of from) {
				if (arrayStartsWith(rbxPath, container)) {
					return container;
				}
			}
		}

		return undefined;
	}

	private parseConfig(rojoConfigFilePath: string, doNotPush = false): void {
		if (!fs.existsSync(rojoConfigFilePath)) {
			this.warn(`RojoResolver: Path does not exist "${rojoConfigFilePath}"`);
			return;
		}

		const realPath = this.cachedRealpath(rojoConfigFilePath);
		this.walkedConfigFilesInternal.add(realPath);

		let configJson: unknown;
		try {
			configJson = JSON.parse(fs.readFileSync(realPath, "utf8"));
		} catch {
			// Malformed JSON: leave configJson undefined and fall through so it
			// is reported as an invalid configuration rather than crashing the
			// caller.
		}

		if (isValidRojoConfig(configJson)) {
			this.parseTree(
				path.dirname(rojoConfigFilePath),
				configJson.name,
				configJson.tree,
				doNotPush,
			);
		} else {
			this.warn("RojoResolver: Invalid configuration!");
		}
	}

	private parsePath(itemPath: string): void {
		const luauPath = convertToLuau(itemPath);

		// A $path pointing straight at a *.project.json file embeds that nested
		// project at the current rbxPath (Rojo composes projects this way), the
		// same as a directory whose default.project.json is discovered below.
		// Without this, the .json extension routes the file into
		// filePathToRbxPathMap as an opaque leaf and the nested tree's mounts
		// (its partitions, its @rbxts mounts) are never read.
		if (ROJO_FILE_REGEX.test(path.basename(luauPath))) {
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
				this.walkedDirectoriesInternal.add(realPath);
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

	private parseTree(basePath: string, name: string, tree: RojoTree, doNotPush = false): void {
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

		for (const childName of Object.keys(tree).filter((value) => !value.startsWith("$"))) {
			// eslint-disable-next-line ts/no-non-null-assertion -- Object.keys ensures this is defined
			this.parseTree(basePath, childName, tree[childName]!);
		}

		if (!doNotPush) {
			this.rbxPath.pop();
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
			const childPath = path.join(directory, entry.name);
			let isFile = entry.isFile();
			let isDirectory = entry.isDirectory();
			// Symlinks (both flags false), unknown-type entries on NFS/SMB/FUSE
			// mounts and some Windows network drives, and NTFS junctions on
			// Node versions that don't classify them: resolve and stat the
			// target so we still discover nested *.project.json files and
			// walkable directories. A broken symlink throws ENOENT here —
			// warn and skip rather than crash the whole walk.
			if (!isFile && !isDirectory) {
				try {
					const stat = fs.statSync(this.cachedRealpath(childPath));
					isFile = stat.isFile();
					isDirectory = stat.isDirectory();
				} catch (err) {
					this.warn(
						`RojoResolver: Failed to resolve "${childPath}" (${(err as Error).message})`,
					);
					continue;
				}
			}

			if (isFile && ROJO_FILE_REGEX.test(entry.name)) {
				projectFiles.push(childPath);
			} else if (isDirectory) {
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
		this.walkedDirectoriesInternal.add(realPath);
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

	private warn(str: string): void {
		this.warnings.push(str);
	}
}
