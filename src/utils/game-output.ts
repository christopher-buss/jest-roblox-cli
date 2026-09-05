import { type } from "arktype";
import * as path from "node:path";

import type { GameOutputEntry, PackageGameOutput } from "../types/game-output.ts";
import type { FileSystem } from "./file-system.ts";
import { nodeFileSystem } from "./file-system.ts";

/** One contributor to an Aggregated Game Output file. */
export interface GameOutputSource {
	package?: string;
	project: string;
	raw: string | undefined;
}

/** What a batch-scoped group names instead of a project. */
const BATCH_PROJECT_LABEL = "(all projects)";

const gameOutputEntriesSchema = type({
	message: "string",
	messageType: "number",
	timestamp: "number",
}).array();

export function formatGameOutputNotice(filePath: string, entryCount: number): string {
	if (entryCount === 0) {
		return "";
	}

	return `Game output (${String(entryCount)} entries) written to ${filePath}`;
}

export function parseGameOutput(raw: string | undefined): Array<GameOutputEntry> {
	if (raw === undefined) {
		return [];
	}

	try {
		const parsed = gameOutputEntriesSchema(JSON.parse(raw));
		if (parsed instanceof type.errors) {
			return [];
		}

		return parsed;
	} catch {
		return [];
	}
}

export function writeGameOutput(
	filePath: string,
	entries: Array<GameOutputEntry>,
	fileSystem: FileSystem = nodeFileSystem,
): void {
	writeJsonFile(fileSystem, filePath, entries);
}

/**
 * Build the grouped shape for an Aggregated Game Output file: one group per
 * source, in the order given (deterministic package/project order). Sources
 * with no captured output still produce a group with an empty `entries`
 * array, so the file is a complete manifest of what ran.
 */
export function buildGroupedGameOutput(
	sources: ReadonlyArray<GameOutputSource>,
): Array<PackageGameOutput> {
	return sources.map((source) => {
		const group: PackageGameOutput = {
			entries: parseGameOutput(source.raw),
			project: source.project,
		};

		if (source.package !== undefined) {
			group.package = source.package;
		}

		return group;
	});
}

/**
 * The single batch-scoped group an experimental vm-parallel run writes.
 *
 * Under parallel the capture belongs to the batch, not to a project, so one
 * labelled group is the whole truth: splitting the same lines across
 * per-project groups would duplicate them and attribute each copy to a project
 * that may not have printed any of it.
 */
export function buildBatchGameOutput(raw: string | undefined): Array<PackageGameOutput> {
	return [{ entries: parseGameOutput(raw), project: BATCH_PROJECT_LABEL, scope: "batch" }];
}

export function writeGroupedGameOutput(
	filePath: string,
	groups: Array<PackageGameOutput>,
	fileSystem: FileSystem = nodeFileSystem,
): void {
	writeJsonFile(fileSystem, filePath, groups);
}

export function countGroupedEntries(groups: ReadonlyArray<PackageGameOutput>): number {
	return groups.reduce((total, group) => total + group.entries.length, 0);
}

function writeJsonFile(
	fileSystem: FileSystem,
	filePath: string,
	value: Array<GameOutputEntry> | Array<PackageGameOutput>,
): void {
	const absolutePath = path.resolve(filePath);
	const directoryPath = path.dirname(absolutePath);

	if (!fileSystem.existsSync(directoryPath)) {
		fileSystem.mkdirSync(directoryPath, { recursive: true });
	}

	fileSystem.writeFileSync(absolutePath, JSON.stringify(value, null, 2));
}
