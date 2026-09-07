import * as path from "node:path";

import type { ResolvedConfig } from "../config/schema.ts";
import { tryResolveLuauRoots } from "../coverage-pipeline/prepare.ts";
import type { TsconfigReader } from "../executor/tsconfig-mappings.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { nodeFileSystem } from "../utils/file-system.ts";
import type { PosixRoot } from "../utils/normalize-windows-path.ts";
import { toPosixRoot } from "../utils/normalize-windows-path.ts";

export interface CodeRootsRequest {
	/**
	 * Which backend the run resolved. Only Open Cloud ever gets a harness: a
	 * Studio backend runs the place a caller opens, so code taken out of it
	 * would be code that never arrives.
	 */
	backendKind: string | undefined;
	/**
	 * The run's resolved `binaryInput`, false where it ships the whole place.
	 */
	binaryInput: boolean;
	/**
	 * One per project (multi) or per package (workspace). Each contributes the
	 * compiled-Luau directories it runs against, in its own frame.
	 */
	configs: ReadonlyArray<ResolvedConfig>;
	/** Where the roots are probed. Defaults to the real filesystem. */
	fileSystem?: FileSystem;
	/**
	 * The run's own staging directory. Everything this run wrote for itself
	 * lives under it — the coverage shadow, the spine copies a demoted mount
	 * serves, and the generated `jest.config` stubs — and all of it is code the
	 * task can rebuild.
	 */
	stagingDirectory: string;
	/**
	 * How a tsconfig is read, for a project whose roots come from its `outDir`.
	 * Defaults to the real one.
	 */
	tsconfigReader?: TsconfigReader | undefined;
}

/**
 * The Code Roots a run's bundle is split against, or none where the run ships
 * the whole place.
 *
 * Absolute, canonical and deduplicated, because two spellings of one directory
 * would read as two roots and a mount can only travel once.
 *
 * The same function serves both dispatch modes, gate included. What differs is
 * only what a caller passes — multi hands its projects and its `.jest-roblox`
 * directory, workspace hands its packages and the workspace cache — so a mount
 * is judged by one rule either way, and neither mode can decide on its own that
 * a backend may be served a harness.
 */
export function resolveCodeRoots({
	backendKind,
	binaryInput,
	configs,
	fileSystem = nodeFileSystem,
	stagingDirectory,
	tsconfigReader,
}: CodeRootsRequest): Array<PosixRoot> | undefined {
	if (backendKind !== "open-cloud" || !binaryInput) {
		return undefined;
	}

	const roots = new Set<PosixRoot>([toPosixRoot(stagingDirectory)]);
	for (const config of configs) {
		const luauRoots = tryResolveLuauRoots({ config, fileSystem, tsconfigReader });
		for (const root of luauRoots) {
			// Resolved against the config's own `rootDir`, which is the frame
			// `luauRoots` are written in, and absolute because a `$path` in the
			// synthesized project already is.
			roots.add(toPosixRoot(path.resolve(config.rootDir, root)));
		}
	}

	return [...roots];
}
