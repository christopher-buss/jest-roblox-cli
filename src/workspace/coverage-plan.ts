import { pickCoverageSettings } from "../config/coverage-settings.ts";
import type { PrepareWorkspaceCoverageOptions } from "../shadow/workspace-prepare.ts";
import type { prepareWorkspaceCoverageMap } from "./coverage-attach.ts";

/**
 * Select the packages that ran and opted into coverage.
 * @param input - Package contexts, loaded packages and pending entries.
 * @returns The packages to instrument, with their coverage settings.
 */
export function buildWorkspaceCoveragePlan({
	contexts,
	loaded,
	pending,
}: Pick<
	Parameters<typeof prepareWorkspaceCoverageMap>[0],
	"contexts" | "loaded" | "pending"
>): Pick<PrepareWorkspaceCoverageOptions, "packages"> {
	const pendingPackageNames = new Set(pending.map((entry) => entry.job.pkg));
	const coverageOptIn = new Set(
		contexts.filter((ctx) => ctx.pkgConfig.collectCoverage).map((ctx) => ctx.info.name),
	);
	return {
		packages: loaded
			.filter(
				({ info }) => pendingPackageNames.has(info.name) && coverageOptIn.has(info.name),
			)
			.map(({ descriptor, pkgConfig }) => {
				return { ...descriptor, ...pickCoverageSettings(pkgConfig) };
			}),
	};
}
