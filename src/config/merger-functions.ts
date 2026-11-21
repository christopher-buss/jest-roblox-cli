import process from "node:process";
import { keys } from "remeda";

import { resolveLuauRoots } from "../shadow/luau-roots.ts";
import { nodeTsconfigReader, type TsconfigReader } from "../tsconfig/tsconfig-mappings.ts";
import { type FileSystem, nodeFileSystem } from "../utils/file-system.ts";
import { validateConfig } from "./config-validation.ts";
import { defaultFormatters } from "./default-formatters.ts";
import type { ConfigInput } from "./define-config.ts";
import { MERGER_KINDS, type MergerKey } from "./option-row.ts";
import type { ResolvedConfig } from "./resolved-config.ts";
import { DEFAULT_CONFIG } from "./resolved-config.ts";
import { resolveLayoutProject } from "./rojo-project.ts";

type MergerDefault = NonNullable<ResolvedConfig[MergerKey]>;

const MERGER_KEYS = keys(MERGER_KINDS);

/**
 * Replace each merger function on a mergeable key, top level and under
 * `test`, with its result against a copy of the default.
 *
 * @param config - Config that may hold merger functions.
 * @param root1 - Root directory and readers for auto-detected defaults.
 * @returns The config with merger functions resolved to values.
 */
export function resolveFunctionValues(
	{ luauRoots, test, ...rest }: ConfigInput,
	{
		fileSystem = nodeFileSystem,
		rootDirectory = process.cwd(),
		tsconfigReader = nodeTsconfigReader,
	}: { fileSystem?: FileSystem; rootDirectory?: string; tsconfigReader?: TsconfigReader } = {},
): Record<string, unknown> {
	const resolvedRest = resolveEntries(rest);
	const resolvedTest = resolveEntries(test ?? {});

	const resolved = test === undefined ? resolvedRest : { ...resolvedRest, test: resolvedTest };
	if (typeof luauRoots !== "function") {
		return luauRoots === undefined ? resolved : { ...resolved, luauRoots };
	}

	const parsed = validateConfig(resolved);
	const config = {
		...DEFAULT_CONFIG,
		...parsed.test,
		rojoProject: parsed.rojoProject,
		rootDir: rootDirectory,
	} satisfies ResolvedConfig;
	return {
		...resolved,
		luauRoots: luauRoots(
			resolveLuauRoots({
				config: resolveLayoutProject({ config, fileSystem }),
				fileSystem,
				tsconfigReader,
			}),
		),
	};
}

function isMergerFunction(value: unknown): value is (defaults: MergerDefault) => MergerDefault {
	return typeof value === "function";
}

function defaultForMergerKey(key: MergerKey): MergerDefault {
	const defaultValue = key === "formatters" ? defaultFormatters() : DEFAULT_CONFIG[key];
	if (Array.isArray(defaultValue)) {
		return structuredClone(defaultValue);
	}

	if (MERGER_KINDS[key] === "array") {
		return [];
	}

	return {};
}

function resolveEntries(entries: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(entries).map(([key, value]) => {
			const mergerKey = MERGER_KEYS.find((candidate) => candidate === key);
			return [
				key,
				mergerKey !== undefined && isMergerFunction(value)
					? value(defaultForMergerKey(mergerKey))
					: value,
			];
		}),
	);
}
