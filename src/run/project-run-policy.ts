import type { DispatchKnobs } from "../backends/dispatch-request.ts";
import type { TypecheckCliOptions } from "../config/resolve-typecheck-config.ts";
import { resolveTypecheckConfig } from "../config/resolve-typecheck-config.ts";
import type { ResolvedConfig } from "../config/resolved-config.ts";
import type { TypecheckGroupPolicy } from "../typecheck/typecheck-groups.ts";

/**
 * Derive the run-wide dispatch and checker policies.
 * @param input - Root configuration and CLI checker overrides.
 * @param input.cliTypecheck - CLI checker overrides.
 * @param input.rootConfig - Effective root configuration.
 * @returns Policies shared by all selected projects.
 */
export function buildProjectRunPolicy({
	cliTypecheck,
	rootConfig,
}: {
	cliTypecheck: TypecheckCliOptions;
	rootConfig: ResolvedConfig;
}): { dispatch: DispatchKnobs; typecheck: TypecheckGroupPolicy } {
	const typecheck = resolveTypecheckConfig({ cli: cliTypecheck, root: rootConfig.typecheck });
	return {
		dispatch: { parallel: rootConfig.parallel, vmParallel: rootConfig.experimentalVmParallel },
		typecheck: {
			ignoreSourceErrors: typecheck.ignoreSourceErrors,
			spawnTimeout: typecheck.spawnTimeout,
			timeout: rootConfig.timeout,
		},
	};
}
