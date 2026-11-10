import type { ResolvedConfig } from "../config/resolved-config.ts";
import type { InstancePathResolver } from "./instance-path.ts";
import { toInstanceStem } from "./instance-path.ts";

const REGEX_METACHARACTERS = /[.*+?^${}()|[\]\\]/g;

/** Inputs for `narrowForLuauRun`. */
export interface LuauRunNarrowing {
	/** Config to narrow. */
	config: ResolvedConfig;
	/** Whether a positional or `testPathPattern` asked for a narrow. */
	filterActive: boolean;
	/** Test files Node-side discovery resolved. */
	runtimeFiles: ReadonlyArray<string>;
	/** Maps a test file to its Jest Instance path. */
	toInstancePath: InstancePathResolver;
}

interface FileNarrowing {
	config: ResolvedConfig;
	files: ReadonlyArray<string>;
	/**
	 * Keep required: if omitted, narrowing silently falls back to file names.
	 */
	toInstancePath: InstancePathResolver;
}

/**
 * Forward an Instance-namespace `testPathPattern` to the Luau runner.
 *
 * @param options - Config, filter state, discovered files and resolver.
 * @returns The config to send to the Luau runner.
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
	return escapeRegex(stem.substring(stem.lastIndexOf("/") + 1));
}

function narrowConfigByFiles({ config, files, toInstancePath }: FileNarrowing): ResolvedConfig {
	if (files.length === 0) {
		return config;
	}

	// The Luau RegExp engine matches only the first branch of a top-level `|`;
	// one wrapping group `(a|b)` works around it.
	const fileBranches = [
		...new Set(
			files.map((file) => {
				const subPath = toInstancePath(file);
				return subPath === undefined ? toBasenamePattern(file) : escapeRegex(subPath);
			}),
		),
	];
	return { ...config, testPathPattern: `(${fileBranches.join("|")})` };
}
