import assert from "node:assert";

import { atomicWrite } from "./atomic-write.ts";
import type { FileSystem, Stats } from "./file-system.ts";
import { hashFileAsync } from "./hash.ts";

/** Content digests for a file walk, carried between runs. */
export interface InputDigestCache {
	/** SHA-256 of the file's bytes, re-read only when its stat changed. */
	hashOfAsync: (filePath: string) => Promise<string>;
	/** Publish what this run looked at, replacing the previous record. */
	save: () => void;
}

interface DigestEntry {
	hash: string;
	mtimeMs: number;
	size: number;
}

// Bump when the line layout in `serialize` changes.
const FORMAT_VERSION = "v1";
const FIELD_SEPARATOR = "\0";
const LINE_SEPARATOR = "\n";
const FIELD_COUNT = 4;

/**
 * A digest per input file, keyed on the stat that produced it.
 * @param cacheFile - Where the record lives between runs.
 * @param fileSystem - Where the inputs and the record are read and written.
 * @returns The cache, loaded with the previous run's record.
 */
export function openInputDigestCache(cacheFile: string, fileSystem: FileSystem): InputDigestCache {
	// Must be taken before any file is stat'd.
	const openedAtMs = Date.now();
	const previous = readEntries(cacheFile, fileSystem);
	const publishable = new Map<string, DigestEntry>();
	let didReread = false;

	return {
		async hashOfAsync(filePath) {
			const stats = await fileSystem.promises.stat(filePath);
			let entry = previous.get(filePath);
			if (!describes(entry, stats)) {
				entry = { hash: await hashFileAsync(filePath, fileSystem), ...statOf(stats) };
				didReread = true;
			}

			if (entry.mtimeMs < openedAtMs && isRecordable(filePath)) {
				publishable.set(filePath, entry);
			}

			return entry.hash;
		},
		save() {
			if (!didReread && publishable.size === previous.size) {
				return;
			}

			atomicWrite({ contents: serialize(publishable), fileSystem, targetPath: cacheFile });
		},
	};
}

function statOf(stats: Stats): { mtimeMs: number; size: number } {
	return { mtimeMs: stats.mtimeMs, size: stats.size };
}

function describes(entry: DigestEntry | undefined, stats: Stats): entry is DigestEntry {
	return entry?.size === stats.size && entry.mtimeMs === stats.mtimeMs;
}

function isRecordable(filePath: string): boolean {
	return !filePath.includes(LINE_SEPARATOR);
}

/**
 * Field order must match the destructuring in `readEntries`.
 *
 * @param entries - The digests by path.
 * @returns The record text.
 */
function serialize(entries: Map<string, DigestEntry>): string {
	const lines = [FORMAT_VERSION];
	for (const [filePath, { hash, mtimeMs, size }] of entries) {
		lines.push(
			`${filePath}${FIELD_SEPARATOR}${size}${FIELD_SEPARATOR}${mtimeMs}${FIELD_SEPARATOR}${hash}`,
		);
	}

	return lines.join(LINE_SEPARATOR);
}

function readEntries(cacheFile: string, fileSystem: FileSystem): Map<string, DigestEntry> {
	const entries = new Map<string, DigestEntry>();

	let raw: string;
	try {
		raw = fileSystem.readFileSync(cacheFile, "utf-8");
	} catch {
		return entries;
	}

	const lines = raw.split(LINE_SEPARATOR);
	if (lines[0] !== FORMAT_VERSION) {
		return entries;
	}

	for (const line of lines) {
		const fields = line.split(FIELD_SEPARATOR);
		if (fields.length !== FIELD_COUNT) {
			continue;
		}

		const [filePath, size, mtimeMs, hash] = fields;
		assert(filePath !== undefined);
		assert(hash !== undefined);
		entries.set(filePath, { hash, mtimeMs: Number(mtimeMs), size: Number(size) });
	}

	return entries;
}
