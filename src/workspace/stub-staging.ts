import * as path from "node:path";
import process from "node:process";

import type { ResolvedProjectConfig } from "../config/projects.ts";
import {
	cleanLeftoverStubs,
	generateProjectStubs,
	hasUserAuthoredConfig,
	STUB_FILENAME,
} from "../config/stubs.ts";
import type { WorkspacePackageCoverage } from "../coverage-pipeline/workspace-prepare.ts";
import type { PackageDescriptor, StubMount } from "../staging/synthesizer.ts";
import type { TimingCollector } from "../timing/orchestration-collector.ts";
import type { PackageContext } from "./project-contexts.ts";
import type { PendingEntry } from "./test-selection.ts";

/**
 * Clears leftover stubs, writes each live project's `jest.config` stub into the
 * package cache root, and returns the synthesizer descriptors — each carrying
 * its `stubMounts` plus, for instrumented packages, the `coverageRoots` that
 * redirect its `$path` entries at the shadow tree and the `coverageSpine` the
 * demote mounts in place of the ones above them.
 */
export function stageWorkspaceStubs({
	contexts,
	coverageByPackage,
	pending,
	timing,
}: {
	contexts: Array<PackageContext>;
	coverageByPackage: Map<string, WorkspacePackageCoverage>;
	pending: Array<PendingEntry>;
	timing: TimingCollector;
}): Array<PackageDescriptor> {
	const liveProjects = liveProjectsByPackage(pending);
	cleanLeftoverWorkspaceStubs(contexts, liveProjects);

	return timing
		.profile("buildStubs", () => writeStubsAndBuildDescriptors(contexts, liveProjects))
		.map((descriptor) => {
			const coverage = coverageByPackage.get(descriptor.name);
			return coverage !== undefined
				? {
						...descriptor,
						coverageRoots: coverage.coverageRoots,
						coverageSpine: coverage.coverageSpine,
					}
				: descriptor;
		});
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

// Pre-flight cleanup: walks live projects' known mount paths in each package
// source tree and removes marker-bearing leftover stubs from pre-refactor
// multi-project runs. Without this, the synthesizer's `assertNoSourceCollision`
// would reject them and re-trigger the original cross-mode bug this refactor
// exists to fix.
function cleanLeftoverWorkspaceStubs(
	contexts: Array<PackageContext>,
	liveProjects: Map<string, Set<string>>,
): void {
	for (const ctx of contexts) {
		const cleaned = cleanLeftoverStubs(
			liveProjectsFor(ctx, liveProjects),
			ctx.info.packageDirectory,
		);
		if (cleaned.length > 0) {
			process.stderr.write(
				`jest-roblox: cleaned ${String(cleaned.length)} leftover stub(s) from ${ctx.info.name}:\n${cleaned
					.map((stubPath) => `  ${stubPath}\n`)
					.join("")}`,
			);
		}
	}
}

function collectLiveProjectStubMounts(
	project: ResolvedProjectConfig,
	ctx: PackageContext,
): Array<StubMount> {
	const stubMounts: Array<StubMount> = [];
	for (const mount of project.rojoMounts) {
		const sourceMount = path.resolve(ctx.info.packageDirectory, mount.fsPath);
		if (hasUserAuthoredConfig(sourceMount)) {
			continue;
		}

		stubMounts.push({
			absStubPath: path.resolve(ctx.cacheRoot, mount.fsPath, STUB_FILENAME),
			dataModelPath: mount.dataModelPath,
		});
	}

	return stubMounts;
}

// stubMounts inject `jest.config` at each rojoMount leaf. Projects whose
// runtime discovery returned zero files are already dropped from `pending`, so
// their stubs would never run. Emitting them anyway is worse than wasteful: a
// project's `outDir` may legitimately not exist on disk when the compiler had
// nothing to produce, and the synthesizer would fail walking that missing path
// (e.g. `out-test/src` when no specs exist). Skip stub emission for non-live
// projects; the package's own rojo tree still mounts so cross-package consumers
// resolve normally.
function writeStubsAndBuildDescriptors(
	contexts: Array<PackageContext>,
	liveProjects: Map<string, Set<string>>,
): Array<PackageDescriptor> {
	return contexts.map((ctx) => {
		const liveProjectsForPackage = liveProjectsFor(ctx, liveProjects);

		// `generateProjectStubs` skips per-mount when the user already has
		// a `jest.config.luau` on disk at that mount, so pass the full
		// live list. The `stubMounts` loop below applies the same filter
		// so we only emit `$path` references for mounts that actually got
		// a cache stub written.
		generateProjectStubs(liveProjectsForPackage, ctx.info.packageDirectory, ctx.cacheRoot);

		const stubMounts: Array<StubMount> = [];
		for (const project of liveProjectsForPackage) {
			stubMounts.push(...collectLiveProjectStubMounts(project, ctx));
		}

		return { ...ctx.descriptor, stubMounts };
	});
}
