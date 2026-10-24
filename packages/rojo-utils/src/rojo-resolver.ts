import path from "node:path";

import type { FileSystem } from "./file-system.ts";
import { nodeFileSystem } from "./file-system.ts";
import type { PartitionInfo, RbxPath, RelativeRbxPath } from "./rbx-path.ts";
import { RbxPathParent } from "./rbx-path.ts";
import {
	CLIENT_SUB_EXTENSION,
	convertToLuau,
	INIT_NAME,
	isPathDescendantOf,
	isRojoProjectFileName,
	MODULE_SUB_EXTENSION,
	ROJO_DEFAULT_NAME,
	ROJO_OLD_NAME,
	ROJO_SCRIPT_EXTS,
	SERVER_SUB_EXTENSION,
	stripRojoExtensions,
} from "./rojo-file-paths.ts";
import type { RojoTree, RojoWalk } from "./rojo-walker.ts";
import { walkRojoConfig, walkRojoTree } from "./rojo-walker.ts";

export const RbxType = {
	LocalScript: 2,
	ModuleScript: 0,
	Script: 1,
	Unknown: 3,
} as const;

/** Compiler script classification after normalizing legacy Lua extensions. */
export type RbxType = (typeof RbxType)[keyof typeof RbxType];

const SUB_EXT_TYPE_MAP = new Map<string, RbxType>([
	[CLIENT_SUB_EXTENSION, RbxType.LocalScript],
	[MODULE_SUB_EXTENSION, RbxType.ModuleScript],
	[SERVER_SUB_EXTENSION, RbxType.Script],
]);

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

/** Import visibility across isolated game containers. */
export type FileRelation = (typeof FileRelation)[keyof typeof FileRelation];

export const NetworkType = {
	Client: 1,
	Server: 2,
	Unknown: 0,
} as const;

/** The execution side inferred from a DataModel service. */
export type NetworkType = (typeof NetworkType)[keyof typeof NetworkType];

/** Serializable snapshot of a {@link RojoResolver} for disk caching. */
export interface RojoResolverState {
	/** Exact file mappings, which take precedence over directory partitions. */
	filePathToRbxPathMap: Array<[string, RbxPath]>;
	/** Whether a DataModel root enables game-container visibility rules. */
	isGame: boolean;
	/** Container prefixes used to classify relative import visibility. */
	isolatedContainers: Array<RbxPath>;
	/** Mounts in lookup precedence order; the first containing prefix wins. */
	partitions: Array<PartitionInfo>;
	/** Project paths whose changes invalidate the captured walk. */
	walkedConfigFiles: Array<string>;
	/**
	 * Canonical directories whose listing changes invalidate the captured
	 * walk.
	 */
	walkedDirs: Array<string>;
	/** Recoverable discovery and parse diagnostics, in encounter order. */
	warnings: Array<string>;
}

/** Project discovery result with nonfatal ambiguity diagnostics. */
export interface RojoConfigFileResult {
	/** Selected project file, absent when discovery finds no candidate. */
	path: string | undefined;
	/** Recoverable discovery and parse diagnostics, in encounter order. */
	warnings: Array<string>;
}

/** Resolves source files and import visibility against a captured Rojo walk. */
export class RojoResolver {
	private filePathToRbxPathMap = new Map<string, RbxPath>();
	private isolatedContainers = [...DEFAULT_ISOLATED_CONTAINERS];
	private partitions = new Array<PartitionInfo>();
	private walkedConfigFilesInternal = new Set<string>();
	private walkedDirectoriesInternal = new Set<string>();
	private warnings = new Array<string>();

	public isGame = false;

	/**
	 * Prefers the default project file and reports ambiguous alternatives.
	 * @param projectPath - Project file or directory to inspect.
	 * @param fileSystem - Host for all reads and directory discovery.
	 * @returns The selected project path or undefined, together with discovery warnings.
	 */
	public static findRojoConfigFilePath(
		projectPath: string,
		fileSystem: FileSystem = nodeFileSystem,
	): RojoConfigFileResult {
		const warnings = new Array<string>();

		const defaultPath = path.join(projectPath, ROJO_DEFAULT_NAME);
		if (fileSystem.existsSync(defaultPath)) {
			return { path: defaultPath, warnings };
		}

		const candidates = new Array<string | undefined>();
		for (const fileName of fileSystem.readdirSync(projectPath)) {
			if (
				fileName !== ROJO_DEFAULT_NAME &&
				(fileName === ROJO_OLD_NAME || isRojoProjectFileName(fileName))
			) {
				candidates.push(path.join(projectPath, fileName));
			}
		}

		if (candidates.length > 1) {
			warnings.push(`Multiple *.project.json files found, using ${candidates[0]}`);
		}

		return { path: candidates[0], warnings };
	}

	/**
	 * Captures a filesystem walk for later pure resolver queries.
	 * @param rojoConfigFilePath - Project file to walk.
	 * @param fileSystem - Host for all reads and directory discovery.
	 * @returns A resolver holding the captured walk and its recoverable warnings.
	 */
	public static fromPath(
		rojoConfigFilePath: string,
		fileSystem: FileSystem = nodeFileSystem,
	): RojoResolver {
		return RojoResolver.fromWalk(walkRojoConfig(rojoConfigFilePath, fileSystem));
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
		resolver.isolatedContainers = state.isolatedContainers.map((container) => {
			return container.slice();
		});
		resolver.isGame = state.isGame;
		resolver.warnings = state.warnings.slice();
		resolver.walkedDirectoriesInternal = new Set(state.walkedDirs);
		resolver.walkedConfigFilesInternal = new Set(state.walkedConfigFiles);

		return resolver;
	}

	/**
	 * Captures an in-memory tree against the supplied filesystem host.
	 * @param options - Tree and directory its mounts are written against.
	 * @param fileSystem - Host for all reads and directory discovery.
	 * @returns A resolver holding mappings discovered below the supplied base directory.
	 */
	public static fromTree(
		{ basePath, tree }: { basePath: string; tree: RojoTree },
		fileSystem: FileSystem = nodeFileSystem,
	): RojoResolver {
		return RojoResolver.fromWalk(walkRojoTree({ basePath, tree }, fileSystem));
	}

	/**
	 * Classifies whether two instances share an isolated game container.
	 * @param fileRbxPath - Importing file instance path.
	 * @param moduleRbxPath - Imported module instance path.
	 * @returns The visibility relation between the importing file and imported module.
	 */
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

	/**
	 * Infers client or server execution from the containing service.
	 * @param rbxPath - DataModel instance names from the root.
	 * @returns The inferred execution side, or Unknown outside recognized game services.
	 */
	public getNetworkType(rbxPath: RbxPath): NetworkType {
		if (this.getContainer(SERVER_CONTAINERS, rbxPath)) {
			return NetworkType.Server;
		}

		if (this.getContainer(CLIENT_CONTAINERS, rbxPath)) {
			return NetworkType.Client;
		}

		return NetworkType.Unknown;
	}

	/**
	 * Returns mounts in the precedence used by file lookup.
	 *
	 * @returns Mounts in first-match lookup order.
	 */
	public getPartitions(): ReadonlyArray<PartitionInfo> {
		return this.partitions;
	}

	/**
	 * Uses exact file mappings before the first containing directory mount.
	 * @param filePath - Filesystem path to classify or resolve.
	 * @returns Instance names from the containing mount, or undefined for an unmapped file.
	 */
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

				return [...partition.rbxPath, ...relativeParts];
			}
		}

		return undefined;
	}

	/**
	 * Normalizes Lua extensions before interpreting Rojo script suffixes.
	 * @param filePath - Filesystem path to classify or resolve.
	 * @returns The script kind or Unknown for an unrecognized script-side qualifier.
	 */
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
			walkedConfigFiles: [...this.walkedConfigFilesInternal],
			walkedDirs: [...this.walkedDirectoriesInternal],
			warnings: this.warnings.slice(),
		};
	}

	/**
	 * Returns recoverable diagnostics from project discovery and traversal.
	 *
	 * @returns Recoverable diagnostics in traversal order.
	 */
	public getWarnings(): ReadonlyArray<string> {
		return this.warnings;
	}

	/**
	 * Tests whether a game instance is inside an isolated container.
	 * @param rbxPath - DataModel instance names from the root.
	 * @returns Whether isolation applies to this instance in a game tree.
	 */
	public isIsolated(rbxPath: RbxPath): boolean {
		return this.getContainer(this.isolatedContainers, rbxPath) !== undefined;
	}

	/**
	 * Builds named and parent steps after the shared DataModel prefix.
	 * @param rbxFrom - Starting instance path.
	 * @param rbxTo - Destination instance path.
	 * @returns One parent symbol per ascent followed by the destination child names.
	 */
	public static relative(rbxFrom: RbxPath, rbxTo: RbxPath): RelativeRbxPath {
		let common = 0;
		for (const [index, part] of rbxFrom.entries()) {
			if (part !== rbxTo[index]) {
				break;
			}

			common++;
		}

		return [
			...rbxFrom.slice(common).map((): RbxPathParent => RbxPathParent),
			...rbxTo.slice(common),
		];
	}

	/**
	 * Create a synthetic RojoResolver for ProjectType.Package. Forces all imports
	 * to be relative.
	 * @param basePath - The base filesystem path the package resolves against.
	 * @returns A resolver that maps every file in the package relatively.
	 */
	public static synthetic(basePath: string): RojoResolver {
		return RojoResolver.fromTree({ basePath, tree: { $path: basePath } });
	}

	/**
	 * Project paths whose changes invalidate the captured walk.
	 *
	 * @returns Project paths whose changes invalidate the captured walk.
	 */
	public get walkedConfigFiles(): ReadonlySet<string> {
		return this.walkedConfigFilesInternal;
	}

	/**
	 * Canonical directories visited while discovering nested projects.
	 *
	 * @returns Canonical directories visited while discovering nested projects.
	 */
	public get walkedDirectories(): ReadonlySet<string> {
		return this.walkedDirectoriesInternal;
	}

	private static fromWalk(walk: RojoWalk): RojoResolver {
		const resolver = new RojoResolver();
		resolver.filePathToRbxPathMap = walk.filePathToRbxPathMap;
		resolver.isGame = walk.isGame;
		resolver.partitions = walk.partitions;
		resolver.walkedConfigFilesInternal = walk.walkedConfigFiles;
		resolver.walkedDirectoriesInternal = walk.walkedDirectories;
		resolver.warnings = walk.warnings;
		return resolver;
	}

	private getContainer(from: Array<RbxPath>, rbxPath: RbxPath): RbxPath | undefined {
		if (this.isGame) {
			for (const container of from) {
				if (arrayStartsWith(rbxPath, container)) {
					return container;
				}
			}
		}

		return undefined;
	}
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
