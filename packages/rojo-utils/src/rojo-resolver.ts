import * as fs from "node:fs";
import path from "node:path";

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

export interface RojoConfigFileResult {
	path: string | undefined;
	warnings: Array<string>;
}

export class RojoResolver {
	private filePathToRbxPathMap = new Map<string, RbxPath>();
	private isolatedContainers = [...DEFAULT_ISOLATED_CONTAINERS];
	private partitions = new Array<PartitionInfo>();
	private walkedConfigFilesInternal = new Set<string>();
	private walkedDirectoriesInternal = new Set<string>();
	private warnings = new Array<string>();

	public isGame = false;

	public static findRojoConfigFilePath(projectPath: string): RojoConfigFileResult {
		const warnings = new Array<string>();

		const defaultPath = path.join(projectPath, ROJO_DEFAULT_NAME);
		if (fs.existsSync(defaultPath)) {
			return { path: defaultPath, warnings };
		}

		const candidates = new Array<string | undefined>();
		for (const fileName of fs.readdirSync(projectPath)) {
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

	public static fromPath(rojoConfigFilePath: string): RojoResolver {
		return RojoResolver.fromWalk(walkRojoConfig(rojoConfigFilePath));
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

	public static fromTree(basePath: string, tree: RojoTree): RojoResolver {
		return RojoResolver.fromWalk(walkRojoTree(basePath, tree));
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

				return [...partition.rbxPath, ...relativeParts];
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
			walkedConfigFiles: [...this.walkedConfigFilesInternal],
			walkedDirs: [...this.walkedDirectoriesInternal],
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
		return RojoResolver.fromWalk(walkRojoTree(basePath, { $path: basePath }));
	}

	public get walkedConfigFiles(): ReadonlySet<string> {
		return this.walkedConfigFilesInternal;
	}

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

	private getContainer(from: Array<RbxPath>, rbxPath?: RbxPath): RbxPath | undefined {
		if (rbxPath && this.isGame) {
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
