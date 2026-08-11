import type { InstancePathResolver } from "./instance-path.ts";
import { toInstanceStem } from "./instance-path.ts";
import type { ResolvedConfig } from "./schema.ts";

const REGEX_METACHARACTERS = /[.*+?^${}()|[\]\\]/g;

export interface FileNarrowing {
	config: ResolvedConfig;
	files: ReadonlyArray<string>;
	/**
	 * Required, not optional: omitting it compiles, passes, and silently
	 * restores basename-only narrowing — every namesake of the named file runs
	 * again. Return `undefined` per file that no Rojo mount owns.
	 */
	toInstancePath: InstancePathResolver;
}

export interface LuauRunNarrowing {
	config: ResolvedConfig;
	/**
	 * Whether anything asked for a narrow. A bare run (no positionals, no
	 * `testPathPattern`) leaves the config untouched so the Luau side runs
	 * every `testMatch` file rather than a giant alternation.
	 */
	filterActive: boolean;
	runtimeFiles: ReadonlyArray<string>;
	/** Each mode builds this from its own Rojo mounts. */
	toInstancePath: InstancePathResolver;
}

/**
 * Translate a list of explicit test files (typically from CLI positional args)
 * into a `testPathPattern` regex that constrains Jest on the Luau side. Each
 * file becomes a regex-escaped fragment; multiple files are joined with `|`. An
 * existing `testPathPattern` is preserved by appending it as another
 * alternative so user-specified narrowing still applies.
 *
 * The fragment is the file's Instance sub-path (`systems/attack/init.test`)
 * whenever `toInstancePath` can place the file under a Rojo mount. Path
 * context is what makes the narrowing exact: a repo that names every test
 * `index.test.ts` collapses to one basename, so a basename fragment would run
 * every one of them.
 *
 * A file no mount owns falls back to the basename (without test-file
 * extension). The Luau-side path Jest matches against is built from Roblox
 * Instance names (e.g. `ReplicatedStorage/shared/.../foo`), which won't contain
 * the FS path prefix (`src/...`); Instance.Name preserves the original file
 * basename, so a basename still finds the intended file — alongside any
 * namesake — the one exception being an `index` stem, which roblox-ts renames
 * to `init` (see `toInstanceStem`).
 */
export function narrowConfigByFiles({
	config,
	files,
	toInstancePath,
}: FileNarrowing): ResolvedConfig {
	if (files.length === 0) {
		return config;
	}

	// All alternatives go inside a single `(...)` group. The Luau-side RegExp
	// engine was observed to short-circuit on top-level `|` (matching only the
	// first branch), but it honors alternation when wrapped — so `(a|b)` works
	// but `a|b` and `(a)|(b)` do not.
	const fileBranches = [
		...new Set(
			files.map((file) => {
				const subPath = toInstancePath(file);
				return subPath === undefined ? toBasenamePattern(file) : escapeRegex(subPath);
			}),
		),
	];
	const branches =
		config.testPathPattern !== undefined && config.testPathPattern !== ""
			? [...fileBranches, config.testPathPattern]
			: fileBranches;

	return { ...config, testPathPattern: `(${branches.join("|")})` };
}

/**
 * Forward an Instance-namespace `testPathPattern` to the Luau runner.
 *
 * Node-side discovery is the source of truth: the FS-namespace filter
 * (positional args or `--testPathPattern`) has already resolved to a concrete
 * file set against real paths. Drop the raw FS-shaped pattern and re-narrow by
 * the discovered files so Jest-on-Roblox matches the same files — its paths are
 * Roblox Instance names (e.g. `ServerScriptService/...`) with no `src/` prefix,
 * so a raw FS pattern like `src/server/foo.spec` matches zero files there.
 *
 * This is the seam every dispatch mode narrows through, so `toInstancePath`
 * belongs here rather than in either caller: each mode builds the resolver from
 * whatever it knows about its own Rojo mounts and hands it to one shared
 * translation.
 */
export function narrowForLuauRun({
	config,
	filterActive,
	runtimeFiles,
	toInstancePath,
}: LuauRunNarrowing): ResolvedConfig {
	if (!filterActive) {
		return config;
	}

	return narrowConfigByFiles({
		config: { ...config, testPathPattern: undefined },
		files: runtimeFiles,
		toInstancePath,
	});
}

function escapeRegex(value: string): string {
	return value.replace(REGEX_METACHARACTERS, "\\$&");
}

function toBasenamePattern(file: string): string {
	const stem = toInstanceStem(file.replaceAll("\\", "/"));
	const lastSlash = stem.lastIndexOf("/");
	return escapeRegex(lastSlash >= 0 ? stem.substring(lastSlash + 1) : stem);
}
