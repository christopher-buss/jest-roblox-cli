import type { ResolvedProjectConfig } from "../config/projects.ts";
import { toPathRedirects } from "../shadow/coverage-root.ts";
import type { WorkspacePackageCoverage } from "../shadow/workspace-prepare.ts";
import { stageProjectStubs } from "../staging/stage-stubs.ts";
import { collectStubMounts } from "../staging/stubs.ts";
import type { PackageDescriptor } from "../staging/synthesizer-types.ts";
import type { TimedPhase, TimingCollector } from "../timing/orchestration-collector.ts";
import type { FileSystem } from "../utils/file-system.ts";
import type { PackageContext } from "./project-contexts.ts";
import type { PendingEntry } from "./test-selection.ts";

/**
 * Write live project stubs and build the synthesizer descriptors.
 * @param options - Contexts, coverage, pending entries and timing.
 * @param options.contexts - Package contexts to stage.
 * @param options.coverageByPackage - Coverage roots per instrumented package.
 * @param options.fileSystem - File system to write through.
 * @param options.pending - Live entries whose resolved projects get stubs.
 * @param options.timing - Collector for the two phase spans.
 * @returns The descriptors and the time each phase took.
 */
export function stageWorkspaceStubs({
	contexts,
	coverageByPackage,
	fileSystem,
	pending,
	timing,
}: {
	contexts: Array<PackageContext>;
	coverageByPackage: Map<string, WorkspacePackageCoverage>;
	fileSystem: FileSystem;
	pending: Array<PendingEntry>;
	timing: TimingCollector;
}): TimedPhase<Array<PackageDescriptor>> {
	const liveProjects = liveProjectsByPackage(pending);
	const stubsMs = stageProjectStubs({
		fileSystem,
		packages: contexts.map((ctx) => {
			return {
				cacheRoot: ctx.cacheRoot,
				label: ctx.info.name,
				projects: liveProjectsFor(ctx, liveProjects),
				rootDirectory: ctx.info.packageDirectory,
			};
		}),
		timing,
	});
	return {
		elapsedMs: stubsMs,
		value: buildDescriptors({ contexts, coverageByPackage, liveProjects }),
	};
}

function liveProjectsByPackage(
	pending: Array<PendingEntry>,
): Map<string, Array<ResolvedProjectConfig>> {
	const live = new Map<string, Array<ResolvedProjectConfig>>();
	for (const entry of pending) {
		live.set(entry.job.pkg, [...(live.get(entry.job.pkg) ?? []), entry.project]);
	}

	return live;
}

function liveProjectsFor(
	ctx: PackageContext,
	liveProjects: Map<string, Array<ResolvedProjectConfig>>,
): Array<ResolvedProjectConfig> {
	return liveProjects.get(ctx.info.name) ?? [];
}

function buildDescriptors({
	contexts,
	coverageByPackage,
	liveProjects,
}: {
	contexts: Array<PackageContext>;
	coverageByPackage: Map<string, WorkspacePackageCoverage>;
	liveProjects: Map<string, Array<ResolvedProjectConfig>>;
}): Array<PackageDescriptor> {
	return contexts.map((ctx) => {
		const { name, packageDirectory, rojoProjectPath } = ctx.descriptor;
		const coverage = coverageByPackage.get(name);
		const stubMounts = collectStubMounts({
			cacheRoot: ctx.cacheRoot,
			projects: liveProjectsFor(ctx, liveProjects),
		});
		return coverage === undefined
			? { name, rojoProjectPath, stubMounts }
			: {
					name,
					redirects: toPathRedirects(packageDirectory, coverage.coverageRoots),
					rojoProjectPath,
					spine: toPathRedirects(packageDirectory, coverage.coverageSpine),
					stubMounts,
				};
	});
}
