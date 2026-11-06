import process from "node:process";

import type { ResolvedProjectConfig } from "../config/projects.ts";
import { cleanLeftoverStubs, collectStubMounts, generateProjectStubs } from "../config/stubs.ts";
import type { WorkspacePackageCoverage } from "../coverage-pipeline/workspace-prepare.ts";
import type { PackageDescriptor } from "../staging/synthesizer-types.ts";
import type { TimedPhase, TimingCollector } from "../timing/orchestration-collector.ts";
import type { FileSystem } from "../utils/file-system.ts";
import type { PendingEntry } from "./pending-entry.ts";
import type { PackageContext } from "./project-contexts.ts";

/** Package contexts and the projects that stay live in each. */
interface StubStagingOptions {
	readonly contexts: Array<PackageContext>;
	readonly fileSystem: FileSystem;
	readonly liveProjects: Map<string, Set<string>>;
}

/**
 * Clears leftover stubs, writes each live project's `jest.config` stub into the
 * package cache root, and returns the synthesizer descriptors — each carrying
 * its `stubMounts` plus, for instrumented packages, the `coverageRoots` that
 * redirect its `$path` entries at the shadow tree and the `coverageSpine` the
 * demote mounts in place of the ones above them.
 *
 * Reports what the two phases cost, which the caller charges to staging. The
 * leftover sweep is a filesystem walk and gets a span of its own, under the
 * name multi opens for the same work — the `TIMING` waterfall then reads the
 * same in either mode.
 * @param options - Contexts, coverage, pending entries and timing.
 * @param options.contexts - Package contexts to stage.
 * @param options.coverageByPackage - Coverage roots per instrumented package.
 * @param options.fileSystem - File system to write through.
 * @param options.pending - Live entries that decide which stubs to write.
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
	const { elapsedMs: cleanMs } = timing.profileTimed("cleanLeftoverStubs", () => {
		cleanLeftoverWorkspaceStubs({
			contexts,
			fileSystem,
			liveProjects,
		});
	});

	const { elapsedMs: writeMs, value: written } = timing.profileTimed("buildStubs", () => {
		return writeStubsAndBuildDescriptors({
			contexts,
			fileSystem,
			liveProjects,
		});
	});

	const descriptors = written.map((descriptor) => {
		const coverage = coverageByPackage.get(descriptor.name);
		return coverage !== undefined
			? {
					...descriptor,
					coverageRoots: coverage.coverageRoots,
					coverageSpine: coverage.coverageSpine,
				}
			: descriptor;
	});
	return { elapsedMs: cleanMs + writeMs, value: descriptors };
}

function liveProjectsByPackage(pending: Array<PendingEntry>): Map<string, Set<string>> {
	const live = new Map<string, Set<string>>();
	for (const entry of pending) {
		let names = live.get(entry.pkg);
		if (names === undefined) {
			names = new Set();
			live.set(entry.pkg, names);
		}

		names.add(entry.project.displayName);
	}

	return live;
}

function liveProjectsFor(
	ctx: PackageContext,
	liveProjects: Map<string, Set<string>>,
): Array<ResolvedProjectConfig> {
	const live = liveProjects.get(ctx.info.name) ?? new Set<string>();
	return ctx.projects.filter((project) => live.has(project.displayName));
}

/**
 * Pre-flight cleanup: walks live projects' known mount paths in each package
 * source tree and removes marker-bearing leftover stubs from pre-refactor
 * multi-project runs.
 * @param options - Contexts and the live projects.
 * @param options.contexts - Package contexts to sweep.
 * @param options.fileSystem - File system to delete through.
 * @param options.liveProjects - Live project names per package.
 */
function cleanLeftoverWorkspaceStubs({
	contexts,
	fileSystem,
	liveProjects,
}: StubStagingOptions): void {
	for (const ctx of contexts) {
		const cleaned = cleanLeftoverStubs({
			fileSystem,
			projects: liveProjectsFor(ctx, liveProjects),
			rootDirectory: ctx.info.packageDirectory,
		});
		if (cleaned.length > 0) {
			process.stderr.write(
				`jest-roblox: cleaned ${String(cleaned.length)} leftover stub(s) from ${ctx.info.name}:\n${cleaned
					.map((stubPath) => `  ${stubPath}\n`)
					.join("")}`,
			);
		}
	}
}

/**
 * The `stubMounts` inject `jest.config` at each rojoMount leaf. Projects whose
 * runtime discovery returned zero files are already dropped from `pending`, so
 * their stubs would never run. Emitting them anyway is worse than wasteful: a
 * project's `outDir` may legitimately not exist on disk when the compiler had
 * nothing to produce, and the synthesizer would fail walking that missing path
 * (such as `out-test/src` when no specs exist). Skip stub emission for non-live
 * projects; the package's own rojo tree still mounts so cross-package consumers
 * resolve normally.
 * @param options - Contexts and the live projects.
 * @param options.contexts - Package contexts to stage.
 * @param options.fileSystem - File system to write through.
 * @param options.liveProjects - Live project names per package.
 * @returns One synthesizer descriptor per package.
 */
function writeStubsAndBuildDescriptors({
	contexts,
	fileSystem,
	liveProjects,
}: StubStagingOptions): Array<PackageDescriptor> {
	return contexts.map((ctx) => {
		const liveProjectsForPackage = liveProjectsFor(ctx, liveProjects);

		generateProjectStubs({
			fileSystem,
			outputRoot: ctx.cacheRoot,
			projects: liveProjectsForPackage,
			rootDirectory: ctx.info.packageDirectory,
		});

		return {
			...ctx.descriptor,
			stubMounts: collectStubMounts({
				cacheRoot: ctx.cacheRoot,
				projects: liveProjectsForPackage,
			}),
		};
	});
}
