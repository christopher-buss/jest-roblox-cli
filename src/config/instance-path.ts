import type { Mount } from "@isentinel/rojo-utils";

import * as path from "node:path";

import type { TsconfigMapping } from "../types/tsconfig.ts";
import { isTsSource, stripTsExtension } from "../utils/extensions.ts";
import {
	dropDriveLetter,
	isAbsolutePath,
	normalizeWindowsPath,
} from "../utils/normalize-windows-path.ts";
import { replacePrefix } from "../utils/tsconfig-mapping.ts";

// Anchored to the final segment so a *directory* named `index` keeps its name.
const INDEX_STEM = /(^|\/)index(\.[^/]*)?$/;

/**
 * Maps a discovered test file to the Instance path Jest matches it by, or
 * `undefined` when no Rojo mount owns it.
 */
export type InstancePathResolver = (file: string) => string | undefined;

export interface InstancePathOptions {
	/**
	 * Base the mounts and the tsconfig mappings are relative to — the directory
	 * the Rojo project and the `tsconfig*.json` files were read from.
	 *
	 * Separate from `rootDirectory` because the two genuinely differ: `rootDir`
	 * is not a project-only key, so a project (or package) may point discovery
	 * at a subdirectory while its mounts stay relative to the Rojo root. Both
	 * sides resolve to absolute paths before anything is compared, so no caller
	 * has to keep the two coordinate systems in step by hand.
	 */
	mountBase: string;
	mounts: ReadonlyArray<Mount>;
	/**
	 * Base discovery relativized its files against (the config's `rootDir`).
	 */
	rootDirectory: string;
	/**
	 * `rootDir`→`outDir` rewrites. Required for a roblox-ts project, whose
	 * discovered files are `src/...` sources while its mounts name `out/...`;
	 * a hand-authored Luau project needs none.
	 */
	tsconfigMappings?: ReadonlyArray<TsconfigMapping> | undefined;
}

interface MountPrefix {
	/** Absolute filesystem directory the mount publishes. */
	fsPrefix: string;
	/** The mount's own Instance name, which the Jest-side path carries. */
	instanceName: string;
}

/**
 * Strip the language extension and apply the roblox-ts `index` → `init` rename,
 * leaving the name the Roblox Instance carries.
 *
 * roblox-ts renames a filename stem of exactly `index` to `init`
 * (PathTranslator), so the Instance — and thus the path Jest matches against —
 * is named `init`, never `index`. The rename is scoped to TS sources: a
 * hand-authored Luau `index` file keeps its name through Rojo, so renaming it
 * would match zero tests.
 *
 * Not the exact inverse of `luauInitToIndex` in the source mapper, which
 * rewrites an `init` segment anywhere in a path. This one rewrites the filename
 * stem only, because a *directory* named `index` is not renamed by roblox-ts.
 */
export function toInstanceStem(filePath: string): string {
	const stripped = stripTsExtension(filePath);
	return isTsSource(filePath) ? stripped.replace(INDEX_STEM, "$1init$2") : stripped;
}

/**
 * Translate a filesystem test path into the Instance path Jest matches it by:
 * the mount's own Instance name followed by the path below that mount, so
 * `src/server/systems/attack/index.test.ts` becomes
 * `PkgServer/systems/attack/init.test`.
 *
 * Jest matches `testPathPattern` with an unanchored, case-insensitive substring
 * test (`testPathPatternToRegExp` is `RegExp(pattern, "i")`), which is why the
 * mount's Instance name has to be on the front. Without it the path below the
 * mount is a bare suffix, and naming `a/index.spec.ts` would also select
 * `nested/a/index.spec.ts` — the same namesake bug one level up.
 *
 * Only the mount's *last* segment is used, never its full `dataModelPath`.
 * Jest's path is `CoreScriptSyncService:GetScriptFilePath` when that service
 * answers (this CLI installs a mock that returns the DataModel-root form) and
 * `getRelativePath(script, rootDir)` otherwise, which starts at the project
 * mount's own name. Both forms contain `<mountName>/<pathBelowMount>`, so this
 * narrows identically whichever one Jest reports.
 */
export function createInstancePathResolver({
	mountBase,
	mounts,
	rootDirectory,
	tsconfigMappings = [],
}: InstancePathOptions): InstancePathResolver {
	// Both bases are canonicalized once, so every comparison below is between
	// two absolute, drive-letter-free paths.
	const fileBase = toComparablePath(rootDirectory);
	const mountRoot = toComparablePath(mountBase);
	const prefixes = toMountPrefixes(mounts, mountRoot);
	const mappings = tsconfigMappings.map((mapping) => {
		return {
			outDir: toAbsolute(mapping.outDir, mountRoot),
			rootDir: toAbsolute(mapping.rootDir, mountRoot),
		};
	});

	return function toInstancePath(file: string): string | undefined {
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

/**
 * Every output path the file could compile to.
 *
 * Plural rather than one best mapping: a repo root commonly holds several
 * `tsconfig*.json` sharing a `rootDir` but emitting to different `outDir`s (a
 * type-check-only `out-tsc` alongside the real one), and picking between them
 * by prefix length would be a coin flip. Offering all of them lets the mount
 * decide, which is the only authority on where the code actually lands.
 *
 * `replacePrefix` returns its input unchanged when a mapping does not own the
 * path, so a non-matching mapping simply repeats the unmapped candidate — which
 * the list needs anyway, for a project that mounts its sources directly.
 *
 * Only a TS source is ever rebased. A Luau source is already in the output
 * namespace, and a `rootDirs` tsconfig collapses to a `rootDir` that owns every
 * path under the base — so rebasing one would prepend the outDir a second time
 * (`out/out/shared/…`) and, under a mount at the outDir root, hand back a path
 * that matches nothing on the Luau side.
 */
function toOutputCandidates(
	absoluteFile: string,
	mappings: ReadonlyArray<TsconfigMapping>,
): Array<string> {
	const stem = toInstanceStem(absoluteFile);
	if (!isTsSource(absoluteFile)) {
		return [stem];
	}

	return [
		...mappings.map((mapping) => replacePrefix(stem, mapping.rootDir, mapping.outDir)),
		stem,
	];
}

function toComparablePath(filePath: string): string {
	return dropDriveLetter(normalizeWindowsPath(filePath));
}

/**
 * Resolve to one absolute, comparable form.
 *
 * The drive letter comes off every path. `discoverTestFiles` resolves
 * positionals with the platform `path.resolve`, which on Windows stamps the
 * cwd's drive onto a drive-less root — so a file and the root it came from can
 * disagree about the prefix. One process cannot span two drives, which makes
 * the letter carry no information worth comparing.
 */
function toAbsolute(filePath: string, base: string): string {
	const normalized = toComparablePath(filePath);
	return isAbsolutePath(normalized) ? normalized : path.posix.join(base, normalized);
}

// Deepest mount first, so one nested inside another wins the prefix test.
// `base` is already canonical.
function toMountPrefixes(mounts: ReadonlyArray<Mount>, base: string): Array<MountPrefix> {
	return mounts
		.map((mount) => {
			const segments = mount.dataModelPath.split("/");
			return {
				fsPrefix: toAbsolute(mount.fsPath, base),
				// eslint-disable-next-line ts/no-non-null-assertion -- split always yields one
				instanceName: segments.at(-1)!,
			};
		})
		.sort((a, b) => b.fsPrefix.length - a.fsPrefix.length);
}
