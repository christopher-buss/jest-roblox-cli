import * as path from "node:path";
import process from "node:process";

import type { ResolvedProjectConfig } from "../config/projects.ts";
import type { TimingCollector } from "../timing/orchestration-collector.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { WORK_DIRECTORY } from "../utils/work-directory.ts";
import { cleanLeftoverStubs, generateProjectStubs } from "./stubs.ts";

/** One package root whose live projects get stubs. */
export interface StubPackage {
	/** Directory the package's stubs are generated into. */
	cacheRoot: string;
	/** Package name the cleanup notice names. */
	label?: string | undefined;
	/** Live projects of the package. */
	projects: Array<ResolvedProjectConfig>;
	/** Package root the projects resolve against. */
	rootDirectory: string;
}

/**
 * Where a run under `rootDirectory` writes its generated `jest.config` stubs.
 * @param rootDirectory - Root directory of the run.
 * @returns The absolute stub cache directory.
 */
export function stubCacheRoot(rootDirectory: string): string {
	return path.resolve(rootDirectory, WORK_DIRECTORY, "cache");
}

/**
 * Clear leftover stubs, then generate each live project's stub.
 * @param options - Packages, file system and profiler.
 * @param options.fileSystem - File system to write through.
 * @param options.packages - Packages to stage.
 * @param options.timing - Collector for the two spans.
 * @returns Time the two phases took; the cleanup notice is not charged.
 */
export function stageProjectStubs({
	fileSystem,
	packages,
	timing,
}: {
	fileSystem: FileSystem;
	packages: Array<StubPackage>;
	timing: TimingCollector;
}): number {
	const { elapsedMs: cleanMs, value: cleaned } = timing.profileTimed("cleanLeftoverStubs", () => {
		return packages.map((entry) => {
			return {
				label: entry.label,
				paths: cleanLeftoverStubs({
					fileSystem,
					projects: entry.projects,
					rootDirectory: entry.rootDirectory,
				}),
			};
		});
	});
	for (const { label, paths } of cleaned) {
		reportCleanedStubs(paths, label);
	}

	const { elapsedMs: generateMs } = timing.profileTimed("generateProjectStubs", () => {
		for (const entry of packages) {
			generateProjectStubs({
				fileSystem,
				outputRoot: entry.cacheRoot,
				projects: entry.projects,
				rootDirectory: entry.rootDirectory,
			});
		}
	});

	return cleanMs + generateMs;
}

function reportCleanedStubs(cleaned: Array<string>, label: string | undefined): void {
	if (cleaned.length === 0) {
		return;
	}

	const source = label === undefined ? "" : ` from ${label}`;
	process.stderr.write(
		`jest-roblox: cleaned ${String(cleaned.length)} leftover stub(s)${source}:\n${cleaned
			.map((stubPath) => `  ${stubPath}\n`)
			.join("")}`,
	);
}
