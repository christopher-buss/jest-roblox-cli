import assert from "node:assert";
import * as fs from "node:fs";

import { atomicWrite } from "./atomic-write.ts";
import { hashFileAsync } from "./hash.ts";

/**
 * Content digests for a file walk, carried between runs so an untouched tree is
 * stat'd rather than re-read.
 */
export interface InputDigestCache {
	/**
	 * SHA-256 of the file's bytes — read only when the file's `(size, mtime)`
	 * differs from what the last run recorded beside its digest. Throws when
	 * the file cannot be stat'd, exactly as reading it would.
	 */
	hashOfAsync: (filePath: string) => Promise<string>;
	/**
	 * Publish what this run looked at, replacing the previous record. A file
	 * the walk no longer reaches is dropped with it, so the record tracks the
	 * input set rather than growing forever.
	 */
	save: () => void;
}

/** What one run recorded about a file it read: the bytes, and their stat. */
interface DigestEntry {
	hash: string;
	mtimeMs: number;
	size: number;
}

/**
 * Bumped whenever a line means something other than it did — the reader trusts
 * the fields positionally, so a record from another layout has to be discarded
 * rather than misread.
 */
const FORMAT_VERSION = "v1";
/** Separates the fields of one line. Cannot occur in a path or a digest. */
const FIELD_SEPARATOR = "\0";
/** Separates lines. CAN occur in a POSIX path — see {@link isRecordable}. */
const LINE_SEPARATOR = "\n";
/** Path, size, mtime, digest. */
const FIELD_COUNT = 4;

/**
 * A digest per input file, keyed on the stat that produced it.
 *
 * What it gives up: a file whose bytes change while both its size and its
 * mtime stay put reads as unchanged, and a gate built on these digests would
 * hand back what it built from the old bytes. Two things narrow that. The size
 * has to match as well as the timestamp, and a digest is recorded only for a
 * file whose mtime already predates the moment the run opened.
 *
 * The stat is the one taken before the read, and deliberately so. A write that
 * lands between them does get recorded, against the stat the file had first —
 * and can then never be matched, because the file now carries the writer's
 * newer stamp instead. The entry is dead on arrival rather than wrong, and the
 * next run reads. Re-stat'ing after the read would move that entry from dead to
 * absent and change nothing else, at the price of a second stat per file.
 *
 * Three cases survive. A deliberately restored timestamp (`touch -r`, an
 * archive unpacked with times preserved) over same-length content. On a mount
 * whose timestamps are coarse — FAT, some network shares — two same-length
 * writes that fall in one tick, since the guard cannot see below the stamp's
 * own resolution. And a mount whose clock lags the host's, where a write during
 * the run still stamps older than `openedAtMs`. Nothing here is free; a caller
 * that cannot afford any of them should hash the bytes itself.
 *
 * `cacheFile` need not exist; an absent, unreadable or foreign-format record
 * reads as "nothing known", which costs a full re-read and no correctness.
 *
 * One line per file rather than the JSON-plus-arktype shape its sibling caches
 * use (`backends/upload-cache.ts`, the manifests): those hold tens of entries
 * and this holds tens of thousands. Measured over 23k inputs, the JSON round
 * trip with a per-entry schema costs ~68ms against ~15ms here — a fifth of the
 * time this cache exists to save. Anything that reaches this file has to hold
 * that ratio, which is why the format is checked rather than validated.
 */
export function openInputDigestCache(cacheFile: string): InputDigestCache {
	// Read before the walk, so every mtime compared against it belongs to a
	// write that finished earlier — see the note above. Read synchronously
	// because it is one file: the async pass below exists for the tens of
	// thousands this record stands in for, not for the record itself.
	const openedAtMs = Date.now();
	const previous = readEntries(cacheFile);
	const publishable = new Map<string, DigestEntry>();
	// Whether any file was read this run. Without one, a record identical to
	// the one on disk would be serialized and rewritten on exactly the run this
	// cache exists to make cheap.
	let didReread = false;

	return {
		async hashOfAsync(filePath) {
			const stats = await fs.promises.stat(filePath);
			let entry = previous.get(filePath);
			if (!describes(entry, stats)) {
				entry = { hash: await hashFileAsync(filePath), ...statOf(stats) };
				didReread = true;
			}

			// Kept only when the file already stood still before this run
			// opened. One written since cannot promise its timestamp separates
			// the bytes read from the bytes now on disk, so it is left out and
			// paid for again next time.
			if (entry.mtimeMs < openedAtMs && isRecordable(filePath)) {
				publishable.set(filePath, entry);
			}

			return entry.hash;
		},
		save() {
			// Nothing read and nothing dropped means every entry came from the
			// record already on disk, which is therefore the record to keep —
			// and this is exactly the run the cache exists to make cheap.
			if (!didReread && publishable.size === previous.size) {
				return;
			}

			atomicWrite({ contents: serialize(publishable), targetPath: cacheFile });
		},
	};
}

/** The two stat fields a recorded digest is keyed on. */
function statOf(stats: fs.Stats): { mtimeMs: number; size: number } {
	return { mtimeMs: stats.mtimeMs, size: stats.size };
}

/** Whether a recorded entry still answers for the file now on disk. */
function describes(entry: DigestEntry | undefined, stats: fs.Stats): entry is DigestEntry {
	return entry?.size === stats.size && entry.mtimeMs === stats.mtimeMs;
}

/**
 * Whether a path can be written as one line and read back as itself.
 *
 * A newline is legal in a POSIX filename and would split its own entry in two,
 * leaving the tail to be read as an entry for whatever path it happens to
 * spell. Such a file is simply never recorded — it is re-read every run, which
 * costs one file and no correctness.
 */
function isRecordable(filePath: string): boolean {
	return !filePath.includes(LINE_SEPARATOR);
}

/** The record as it goes to disk: a version marker, then one line per file. */
function serialize(entries: Map<string, DigestEntry>): string {
	const lines = [FORMAT_VERSION];
	for (const [filePath, { hash, mtimeMs, size }] of entries) {
		lines.push(
			`${filePath}${FIELD_SEPARATOR}${size}${FIELD_SEPARATOR}${mtimeMs}${FIELD_SEPARATOR}${hash}`,
		);
	}

	return lines.join(LINE_SEPARATOR);
}

/**
 * The previous run's record, or an empty one.
 *
 * Lines are read positionally, so one short of its fields says nothing this
 * reader can act on and is dropped. A corrupt record costs a re-read, never a
 * wrong digest.
 */
function readEntries(cacheFile: string): Map<string, DigestEntry> {
	const entries = new Map<string, DigestEntry>();

	let raw: string;
	try {
		raw = fs.readFileSync(cacheFile, "utf-8");
	} catch {
		// No previous run, or its cache was cleaned away. Not a fault.
		return entries;
	}

	// Not destructured off the front: that copies every line into a second
	// array of the same tens of thousands of entries to drop one.
	const lines = raw.split(LINE_SEPARATOR);
	if (lines[0] !== FORMAT_VERSION) {
		return entries;
	}

	// The version line is walked with the rest and falls out on its own: it
	// matched `FORMAT_VERSION` exactly to get here, so it carries one field
	// where an entry carries four.
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
