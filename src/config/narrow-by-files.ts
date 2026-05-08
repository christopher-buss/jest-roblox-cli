import type { ResolvedConfig } from "./schema.ts";

const REGEX_METACHARACTERS = /[.*+?^${}()|[\]\\]/g;
const TEST_FILE_EXTENSION = /\.(tsx?|luau?)$/;

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
 * intended file.
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

function toBasenamePattern(file: string): string {
	const posix = file.replaceAll("\\", "/");
	const lastSlash = posix.lastIndexOf("/");
	const basename = lastSlash >= 0 ? posix.substring(lastSlash + 1) : posix;
	const stripped = basename.replace(TEST_FILE_EXTENSION, "");
	return stripped.replace(REGEX_METACHARACTERS, "\\$&");
}
