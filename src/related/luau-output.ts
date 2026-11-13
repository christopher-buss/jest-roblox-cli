import * as path from "node:path";

import { toInstanceStem } from "../discovery/instance-path.ts";
import type { TsconfigReader } from "../tsconfig/tsconfig-mappings.ts";
import {
	createTsconfigMappingCache,
	replacePrefix,
	resolveAllTsconfigMappings,
} from "../tsconfig/tsconfig-mappings.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";

/** Inputs of {@link createLuauOutputResolver}. */
export interface LuauOutputResolverOptions {
	/** File system the tsconfigs and compiled modules are found on. */
	fileSystem: FileSystem;
	/** Reader of each package's tsconfig files. */
	tsconfigReader: TsconfigReader;
}

/**
 * Finds the compiled Luau module of a TypeScript source file, or `undefined`
 * when no module exists on disk.
 */
export type LuauOutputResolver = (sourceFile: string) => string | undefined;

const LUAU_EXTENSIONS = [".luau", ".lua"];
const TSCONFIG = "tsconfig.json";

/**
 * Build the resolver from a TypeScript source to its compiled Luau module. The
 * package of a file is the nearest folder above it with a `tsconfig.json`, and
 * each `rootDir`→`outDir` pair of that folder's tsconfig files is tried until
 * one names a module that exists.
 *
 * @param options - Where the tsconfigs and modules are read, and how.
 * @returns A function from a source file to its module.
 */
export function createLuauOutputResolver({
	fileSystem,
	tsconfigReader,
}: LuauOutputResolverOptions): LuauOutputResolver {
	const cache = createTsconfigMappingCache();
	return (sourceFile) => {
		const packageDirectory = findPackageDirectory(fileSystem, path.dirname(sourceFile));
		if (packageDirectory === undefined) {
			return;
		}

		const stem = toInstanceStem(
			normalizeWindowsPath(path.relative(packageDirectory, sourceFile)),
		);
		const mappings = resolveAllTsconfigMappings({
			cache,
			fileSystem,
			projectRoot: packageDirectory,
			tsconfigReader,
		});
		const outputs = mappings
			.map((mapping) => {
				return replacePrefix({ filePath: stem, from: mapping.rootDir, to: mapping.outDir });
			})
			.filter((output) => output !== stem)
			.flatMap((output) => {
				return LUAU_EXTENSIONS.map((extension) => {
					return path.join(packageDirectory, output + extension);
				});
			});
		return outputs.find((output) => fileSystem.existsSync(output));
	};
}

function findPackageDirectory(fileSystem: FileSystem, start: string): string | undefined {
	for (let directory = start; ; directory = path.dirname(directory)) {
		if (fileSystem.existsSync(path.join(directory, TSCONFIG))) {
			return directory;
		}

		if (path.dirname(directory) === directory) {
			return undefined;
		}
	}
}
