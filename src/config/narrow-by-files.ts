import type { ResolvedConfig } from "./schema.ts";

const REGEX_METACHARACTERS = /[.*+?^${}()|[\]\\]/g;
const TEST_FILE_EXTENSION = /\.(tsx?|luau?)$/;
const TS_SOURCE_EXTENSION = /\.tsx?$/;
const INDEX_STEM = /^index(\.|$)/;

/**
 * Translate a list of explicit test files (typically from CLI positional args)
 * into a `testPathPattern` regex that constrains Jest on the Luau side. Each
 * file's basename (without test-file extension) becomes a regex-escaped
 * fragment; multiple files are joined with `|`. An existing `testPathPattern`
 * is preserved by appending it as another alternative so user-specified
 * narrowing still applies.
 *
 * Basename-only is deliberate: the Luau-side path Jest matches against is
 * built from Roblox Instance names (e.g. `ReplicatedStorage/shared/.../foo`),
 * which won't contain the FS path prefix (`src/...`). Instance.Name preserves
 * the original file basename, so matching on basename reliably finds the
 * intended file — the one exception being an `index` stem, which roblox-ts
 * renames to `init` (see `indexStemToInit`).
 */
export function narrowConfigByFiles(
	config: ResolvedConfig,
	files: ReadonlyArray<string>,
): ResolvedConfig {
	if (files.length === 0) {
		return config;
	}

	// All alternatives go inside a single `(...)` group. The Luau-side RegExp
	// engine was observed to short-circuit on top-level `|` (matching only the
	// first branch), but it honors alternation when wrapped — so `(a|b)` works
	// but `a|b` and `(a)|(b)` do not.
	const fileBranches = [...new Set(files.map(toBasenamePattern))];
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
 * `filterActive` gates the rewrite: a bare run (no positionals, no
 * `testPathPattern`) leaves the config untouched so the Luau side runs every
 * `testMatch` file rather than a giant basename alternation.
 */
export function narrowForLuauRun(
	config: ResolvedConfig,
	runtimeFiles: ReadonlyArray<string>,
	filterActive: boolean,
): ResolvedConfig {
	if (!filterActive) {
		return config;
	}

	return narrowConfigByFiles({ ...config, testPathPattern: undefined }, runtimeFiles);
}

/**
 * roblox-ts renames an `index` module to `init` (PathTranslator: a filename stem
 * of exactly `index` becomes `init`), so the Roblox Instance — and thus the path
 * Jest matches against — is named `init`, never `index`. Mirror that rename on
 * the basename stem so a positional `index.spec.ts` resolves to the on-Roblox
 * `init.spec`. Inverse of `luauInitToIndex` in the source mapper.
 *
 * Scoped to TS/TSX sources by the caller: the rename is roblox-ts-specific, so a
 * hand-authored Luau/Lua `index` file keeps its name in Rojo and must not be
 * rewritten (else a pure-Luau project's positional arg matches zero tests).
 */
function indexStemToInit(basename: string): string {
	return basename.replace(INDEX_STEM, "init$1");
}

function toBasenamePattern(file: string): string {
	const posix = file.replaceAll("\\", "/");
	const lastSlash = posix.lastIndexOf("/");
	const basename = lastSlash >= 0 ? posix.substring(lastSlash + 1) : posix;
	const stripped = basename.replace(TEST_FILE_EXTENSION, "");
	const renamed = TS_SOURCE_EXTENSION.test(basename) ? indexStemToInit(stripped) : stripped;
	return renamed.replace(REGEX_METACHARACTERS, "\\$&");
}
