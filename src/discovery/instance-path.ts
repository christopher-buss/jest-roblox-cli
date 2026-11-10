import type { Mount } from "@isentinel/rojo-utils";

import * as path from "node:path";

import type { TsconfigMapping } from "../tsconfig/tsconfig-mappings.ts";
import { replacePrefix } from "../tsconfig/tsconfig-mappings.ts";
import { isTsSource, stripTsExtension } from "../utils/extensions.ts";
import {
	dropDriveLetter,
	isAbsolutePath,
	normalizeWindowsPath,
} from "../utils/normalize-windows-path.ts";

const INDEX_STEM = /(^|\/)index(\.[^/]*)?$/;

/** Maps a test file to its Jest Instance path, or undefined. */
export type InstancePathResolver = (file: string) => string | undefined;

/** Inputs for building an `InstancePathResolver`. */
export interface InstancePathOptions {
	/** Base the mounts and tsconfig mappings are relative to. */
	mountBase: string;
	/** Rojo mounts that map filesystem directories to Instances. */
	mounts: ReadonlyArray<Mount>;
	/** Base discovery relativized its files against. */
	rootDirectory: string;
	/** `rootDir`→`outDir` rewrites for a roblox-ts project. */
	tsconfigMappings?: ReadonlyArray<TsconfigMapping> | undefined;
}

interface MountPrefix {
	fsPrefix: string;
	instanceName: string;
}

/**
 * Strips the extension and applies the roblox-ts `index` → `init` rename.
 *
 * @param filePath - Source file path.
 * @returns The path with its extension stripped and an `index` stem renamed.
 */
export function toInstanceStem(filePath: string): string {
	const stripped = stripTsExtension(filePath);
	return isTsSource(filePath) ? stripped.replace(INDEX_STEM, "$1init$2") : stripped;
}

/**
 * Builds a resolver from test file path to Jest Instance path.
 *
 * @param options - Mounts, bases and tsconfig mappings.
 * @returns A resolver that gives the Instance path of a file, or undefined
 *   when no mount owns it.
 */
export function createInstancePathResolver({
	mountBase,
	mounts,
	rootDirectory,
	tsconfigMappings = [],
}: InstancePathOptions): InstancePathResolver {
	const fileBase = toComparablePath(rootDirectory);
	const mountRoot = toComparablePath(mountBase);
	const prefixes = toMountPrefixes(mounts, mountRoot);
	const mappings = tsconfigMappings.map((mapping) => {
		return {
			outDir: toAbsolute(mapping.outDir, mountRoot),
			rootDir: toAbsolute(mapping.rootDir, mountRoot),
		};
	});

	return function toInstancePath(file): string | undefined {
		const absoluteFile = toAbsolute(file, fileBase);
		const candidates = toOutputCandidates(absoluteFile, mappings);

		for (const { fsPrefix, instanceName } of prefixes) {
			const owned = candidates.find((candidate) => candidate.startsWith(`${fsPrefix}/`));
			if (owned !== undefined) {
				return `${instanceName}/${owned.slice(fsPrefix.length + 1)}`;
			}
		}

		return undefined;
	};
}

function toOutputCandidates(
	absoluteFile: string,
	mappings: ReadonlyArray<TsconfigMapping>,
): Array<string> {
	const stem = toInstanceStem(absoluteFile);
	if (!isTsSource(absoluteFile)) {
		return [stem];
	}

	return [
		...mappings.map((mapping) => {
			return replacePrefix({ filePath: stem, from: mapping.rootDir, to: mapping.outDir });
		}),
		stem,
	];
}

function toComparablePath(filePath: string): string {
	return dropDriveLetter(normalizeWindowsPath(filePath));
}

function toAbsolute(filePath: string, base: string): string {
	const normalized = toComparablePath(filePath);
	return isAbsolutePath(normalized) ? normalized : path.posix.join(base, normalized);
}

function toMountPrefixes(mounts: ReadonlyArray<Mount>, base: string): Array<MountPrefix> {
	return mounts
		.map((mount) => {
			const segments = mount.dataModelPath.split("/");
			return {
				fsPrefix: toAbsolute(mount.fsPath, base),
				// oxlint-disable-next-line typescript/no-non-null-assertion -- split always yields one
				instanceName: segments.at(-1)!,
			};
		})
		.sort((a, b) => b.fsPrefix.length - a.fsPrefix.length);
}
