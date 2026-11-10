import { defaultFormatters } from "./default-formatters.ts";
import { CONFIG_ROWS } from "./options.ts";
import type { CliOptions, ResolvedConfig } from "./resolved-config.ts";

const FLAGGED_CONFIG_KEYS: ReadonlyArray<string> = CONFIG_ROWS.filter(
	(row) => row.cli !== undefined,
).map(({ key }) => key);

/**
 * Overlay CLI options on a resolved config; a CLI value wins when set.
 *
 * @param cli - Parsed CLI options.
 * @param config - Resolved config.
 * @returns The merged config.
 */
export function mergeCliWithConfig(cli: CliOptions, config: ResolvedConfig): ResolvedConfig {
	const merged: ResolvedConfig = {
		...config,
		experimentalVmParallel: cli.experimentalVmParallel,
	};
	for (const key of FLAGGED_CONFIG_KEYS) {
		Reflect.set(merged, key, Reflect.get(cli, key) ?? Reflect.get(config, key));
	}

	merged.formatters ??= defaultFormatters();
	return merged;
}
