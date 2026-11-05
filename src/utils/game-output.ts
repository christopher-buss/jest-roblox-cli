import { type } from "arktype";
import * as path from "node:path";

import type { GameOutputEntry, PackageGameOutput } from "../types/game-output-types.ts";
import type { FileSystem } from "./file-system.ts";
import { nodeFileSystem } from "./file-system.ts";

/** One contributor to an Aggregated Game Output file. */
export interface GameOutputSource {
	/** The workspace package the output belongs to. */
	package?: string;
	/** The project the output belongs to. */
	project: string;
	/** The captured output as JSON text, if any. */
	raw: string | undefined;
}

/** What a batch-scoped group names instead of a project. */
const BATCH_PROJECT_LABEL = "(all projects)";

const gameOutputEntriesSchema = type({
	message: "string",
	messageType: "number",
	timestamp: "number",
}).array();

/** Inputs for {@link writeGameOutput}. */
export interface WriteGameOutputOptions {
	/** The messages to write. */
	readonly entries: Array<GameOutputEntry>;
	/** Where the JSON file goes. */
	readonly filePath: string;
	/** Where the file is written. Defaults to the real filesystem. */
	readonly fileSystem?: FileSystem;
}

/** Inputs for {@link writeGroupedGameOutput}. */
export interface WriteGroupedGameOutputOptions {
	/** Where the JSON file goes. */
	readonly filePath: string;
	/** Where the file is written. Defaults to the real filesystem. */
	readonly fileSystem?: FileSystem;
	/** The groups to write. */
	readonly groups: Array<PackageGameOutput>;
}

/**
 * The line telling the user where the game output was written.
 * @param filePath - Where the output was written.
 * @param entryCount - How many messages it holds.
 * @returns The notice, or an empty string for no messages.
 */
export function formatGameOutputNotice(filePath: string, entryCount: number): string {
	if (entryCount === 0) {
		return "";
	}

	return `Game output (${String(entryCount)} entries) written to ${filePath}`;
}

/**
 * Parse captured game output, treating anything malformed as empty.
 * @param raw - The captured output as JSON text.
 * @returns The messages, or an empty array.
 */
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

/**
 * Write messages as a JSON file, creating its directory.
 * @param options - The messages, the path and the filesystem.
 */
export function writeGameOutput({
	entries,
	filePath,
	fileSystem = nodeFileSystem,
}: WriteGameOutputOptions): void {
	writeJsonFile({ filePath, fileSystem, value: entries });
}

/**
 * Build the grouped shape for an Aggregated Game Output file: one group per
 * source, in the order given (deterministic package/project order). Sources
 * with no captured output still produce a group with an empty `entries`
 * array, so the file is a complete manifest of what ran.
 * @param sources - The contributors, in output order.
 * @returns One group per source.
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
 * @param raw - The batch's captured output as JSON text.
 * @returns The one batch group.
 */
export function buildBatchGameOutput(raw: string | undefined): Array<PackageGameOutput> {
	return [{ entries: parseGameOutput(raw), project: BATCH_PROJECT_LABEL, scope: "batch" }];
}

/**
 * Write grouped game output as a JSON file, creating its directory.
 * @param options - The groups, the path and the filesystem.
 */
export function writeGroupedGameOutput({
	filePath,
	fileSystem = nodeFileSystem,
	groups,
}: WriteGroupedGameOutputOptions): void {
	writeJsonFile({ filePath, fileSystem, value: groups });
}

/**
 * Count the messages across every group.
 * @param groups - The groups to count.
 * @returns The total message count.
 */
export function countGroupedEntries(groups: ReadonlyArray<PackageGameOutput>): number {
	return groups.reduce((total, group) => total + group.entries.length, 0);
}

function writeJsonFile({
	filePath,
	fileSystem,
	value,
}: {
	readonly filePath: string;
	readonly fileSystem: FileSystem;
	readonly value: Array<GameOutputEntry> | Array<PackageGameOutput>;
}): void {
	const absolutePath = path.resolve(filePath);
	const directoryPath = path.dirname(absolutePath);

	fileSystem.mkdirSync(directoryPath, { recursive: true });

	fileSystem.writeFileSync(absolutePath, JSON.stringify(value, null, 2));
}
