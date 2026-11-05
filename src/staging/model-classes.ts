/**
 * Class names a rojo mount would bring into the place, read straight off disk.
 *
 * Only the classes matter, so this reads far less than a model parser would:
 * the binary format's class table, the XML's `class` attributes, or a JSON
 * descriptor's `ClassName`. Anything rojo mounts but that cannot declare a
 * class of its own — a `.luau` source, a plain directory — reports nothing.
 */
import { type } from "arktype";
import { Buffer } from "node:buffer";
import * as path from "node:path";

import type { FileSystem } from "../utils/file-system.ts";
import { nodeFileSystem } from "../utils/file-system.ts";

const BINARY_MAGIC = "<roblox!";
/**
 * `<roblox!` plus signature, version, class count, instance count, reserved.
 */
const BINARY_HEADER_BYTES = 32;
const CHUNK_HEADER_BYTES = 16;
const XML_CLASS_ATTRIBUTE = /<Item\s+class="([^"]+)"/g;
const MODEL_JSON_SUFFIX = ".model.json";

/**
 * The one field this reader wants out of a JSON descriptor, under either
 * spelling. Everything else the consumer wrote is rojo's business.
 */
const descriptorSchema = type({
	"[string]": "unknown",
	"ClassName?": "string",
	"className?": "string",
});

/** The name rojo gives a mounted file is its basename, less one of these. */
export const MODEL_EXTENSIONS: ReadonlyArray<string> = [MODEL_JSON_SUFFIX, ".rbxmx", ".rbxm"];
/** A directory declares its own class here rather than in a sibling file. */
export const META_JSON_FILE = "init.meta.json";

/** Where the LZ4 decoder is reading from and writing to. */
interface Cursor {
	offset: number;
	written: number;
}

/** One token of an LZ4 block, and the buffers it moves bytes between. */
interface Lz4Step {
	cursor: Cursor;
	destination: Buffer;
	source: Buffer;
	token: number;
}

/** A chunk's name and the byte counts its body was written with. */
interface ChunkHeader {
	name: string;
	compressedBytes: number;
	decompressedBytes: number;
	storedBytes: number;
}

/**
 * Whether the path has a format that can declare a class.
 * @param filePath - Path to test by extension.
 * @returns True for `.rbxm`, `.rbxmx`, `.model.json` or `init.meta.json`.
 */
export function isModelFile(filePath: string): boolean {
	return readerFor(filePath) !== undefined;
}

/**
 * Every class the file declares, or an empty array for a file that declares
 * none. An unreadable or malformed file also reports none: rojo is about to
 * read the same bytes, and its own error says far more about what is wrong
 * than a second parser's would.
 * @param filePath - Path of the model or descriptor file.
 * @param fileSystem - Reads the file.
 * @returns The declared class names.
 */
export function readDeclaredClasses(
	filePath: string,
	fileSystem: FileSystem = nodeFileSystem,
): Array<string> {
	try {
		return readerFor(filePath)?.(fileSystem, filePath) ?? [];
	} catch {
		return [];
	}
}

function readXmlClasses(fileSystem: FileSystem, filePath: string): Array<string> {
	const xml = fileSystem.readFileSync(filePath, "utf-8");
	return Array.from(xml.matchAll(XML_CLASS_ATTRIBUTE), ([, declared]) => String(declared));
}

/**
 * `.model.json` spells it `ClassName`, `init.meta.json` spells it `className`.
 * Both are read because both land in the same auto-mounted directory.
 *
 * Schema-checked rather than hand-narrowed: these are consumer-authored config
 * files, and anything else in them is rojo's business, not this reader's.
 * @param fileSystem - Reads the file.
 * @param filePath - Path of the JSON descriptor.
 * @returns The class names under either spelling.
 * @throws {SyntaxError} When the file is not valid JSON.
 */
function readJsonClasses(fileSystem: FileSystem, filePath: string): Array<string> {
	const parsed = descriptorSchema(JSON.parse(fileSystem.readFileSync(filePath, "utf-8")));
	if (parsed instanceof type.errors) {
		return [];
	}

	return [parsed.ClassName, parsed.className].filter(
		(value): value is string => value !== undefined,
	);
}

function readChunkHeader({
	fileSystem,
	handle,
	offset,
}: {
	fileSystem: FileSystem;
	handle: number;
	offset: number;
}): ChunkHeader | undefined {
	const header = Buffer.alloc(CHUNK_HEADER_BYTES);
	if (fileSystem.readSync(handle, header, 0, CHUNK_HEADER_BYTES, offset) < CHUNK_HEADER_BYTES) {
		return undefined;
	}

	const compressedBytes = header.readUInt32LE(4);
	const decompressedBytes = header.readUInt32LE(8);
	return {
		name: header.toString("ascii", 0, 4),
		compressedBytes,
		decompressedBytes,
		storedBytes: compressedBytes === 0 ? decompressedBytes : compressedBytes,
	};
}

/**
 * An `INST` chunk opens with a class id, then the length-prefixed class name.
 * @param chunk - Decompressed `INST` chunk body.
 * @returns The name the chunk declares, decoded as UTF-8.
 */
function readClassName(chunk: Buffer): string {
	const nameBytes = chunk.readUInt32LE(4);
	return chunk.toString("utf-8", 8, 8 + nameBytes);
}

/**
 * LZ4's `255`-terminated length continuation, shared by literals and matches.
 * @param source - Compressed bytes.
 * @param cursor - Read position; advanced past the extension.
 * @returns The extra length the continuation bytes add.
 */
function readLengthExtension(source: Buffer, cursor: Cursor): number {
	let total = 0;
	let byte = 255;
	while (byte === 255) {
		byte = source.readUInt8(cursor.offset);
		cursor.offset += 1;
		total += byte;
	}

	return total;
}

/**
 * The token's literal run, copied straight across.
 * @param step - Token, buffers and cursor; the cursor advances.
 */
function copyLiterals({ cursor, destination, source, token }: Lz4Step): void {
	let literals = token >> 4;
	if (literals === 15) {
		literals += readLengthExtension(source, cursor);
	}

	source.copy(destination, cursor.written, cursor.offset, cursor.offset + literals);
	cursor.offset += literals;
	cursor.written += literals;
}

/**
 * The token's back-reference, copied one byte at a time because LZ4 lets a
 * match overlap the bytes it is still writing.
 * @param step - Token, buffers and cursor; the cursor advances.
 */
function copyMatch({ cursor, destination, source, token }: Lz4Step): void {
	const short = token & 15;
	const distance = source.readUInt16LE(cursor.offset);
	cursor.offset += 2;

	let matchLength = short + 4;
	if (short === 15) {
		matchLength += readLengthExtension(source, cursor);
	}

	let copyFrom = cursor.written - distance;
	for (let index = 0; index < matchLength; index += 1) {
		destination.writeUInt8(destination.readUInt8(copyFrom), cursor.written);
		copyFrom += 1;
		cursor.written += 1;
	}
}

/**
 * LZ4 block decompression, the one codec the binary format's chunks use.
 * Inlined rather than taken as a dependency: the format never uses the framed
 * variant a library would bring, and this reads only the leading `INST`
 * chunks, which are a few hundred bytes even for a game-sized model.
 * @param source - Compressed block.
 * @param decompressedBytes - Size the block decompresses to.
 * @returns The decompressed bytes.
 * @throws {RangeError} When the output size does not match `decompressedBytes`.
 */
function decompressLz4(source: Buffer, decompressedBytes: number): Buffer {
	const destination = Buffer.alloc(decompressedBytes);
	const cursor: Cursor = { offset: 0, written: 0 };

	while (cursor.offset < source.length) {
		const token = source.readUInt8(cursor.offset);
		cursor.offset += 1;
		copyLiterals({ cursor, destination, source, token });
		if (cursor.offset >= source.length) {
			break;
		}

		copyMatch({ cursor, destination, source, token });
	}

	if (cursor.written !== decompressedBytes) {
		throw new RangeError();
	}

	return destination;
}

/**
 * The class an `INST` chunk names, or `undefined` when the file ends mid-chunk.
 * A short read is reported rather than decompressed: the partly-zeroed buffer
 * would yield an arbitrary class name instead of merely a missing one.
 * @param fileSystem - Reads the open file.
 * @param chunk - Where the chunk body sits.
 * @param chunk.handle - Open file descriptor.
 * @param chunk.header - The chunk's parsed header.
 * @param chunk.offset - File offset of the chunk body.
 * @returns The class name, or `undefined` on a short read.
 */
function readChunkClass(
	fileSystem: FileSystem,
	{
		handle,
		header,
		offset,
	}: {
		handle: number;
		header: ChunkHeader;
		offset: number;
	},
): string | undefined {
	const stored = Buffer.alloc(header.storedBytes);
	if (fileSystem.readSync(handle, stored, 0, header.storedBytes, offset) < header.storedBytes) {
		return undefined;
	}

	return readClassName(
		header.compressedBytes === 0 ? stored : decompressLz4(stored, header.decompressedBytes),
	);
}

function readInstanceChunks(fileSystem: FileSystem, handle: number): Array<string> {
	const classes: Array<string> = [];
	let offset = BINARY_HEADER_BYTES;
	let hasClassTable = false;

	for (;;) {
		const header = readChunkHeader({ fileSystem, handle, offset });
		if (header === undefined) {
			return classes;
		}

		offset += CHUNK_HEADER_BYTES;
		if (header.name !== "INST") {
			// The metadata and shared-string chunks may precede the class table,
			// so a chunk that is not an `INST` only ends the scan once one has
			// been seen.
			if (hasClassTable) {
				return classes;
			}

			offset += header.storedBytes;
			continue;
		}

		hasClassTable = true;
		const declared = readChunkClass(fileSystem, { handle, header, offset });
		if (declared === undefined) {
			return classes;
		}

		offset += header.storedBytes;
		classes.push(declared);
	}
}

/**
 * Read the binary format's `INST` chunks, which each name one class, and stop
 * at the first chunk that is not one. The writer emits every `INST` before the
 * first `PROP`, so the classes are known well before the property data — the
 * bulk of a game-sized model — has to be read or decompressed at all.
 * @param fileSystem - Opens and reads the file.
 * @param filePath - Path of the `.rbxm` file.
 * @returns The class names, or an empty array without the binary magic.
 */
function readBinaryClasses(fileSystem: FileSystem, filePath: string): Array<string> {
	const handle = fileSystem.openSync(filePath, "r");
	try {
		const header = Buffer.alloc(BINARY_HEADER_BYTES);
		fileSystem.readSync(handle, header, 0, BINARY_HEADER_BYTES, 0);

		if (header.toString("ascii", 0, BINARY_MAGIC.length) !== BINARY_MAGIC) {
			return [];
		}

		return readInstanceChunks(fileSystem, handle);
	} finally {
		fileSystem.closeSync(handle);
	}
}

/**
 * The reader for a path's format, or `undefined` for a path that declares no
 * class. One dispatch, so {@link isModelFile} and {@link readDeclaredClasses}
 * cannot drift on which extensions count.
 * @param filePath - Path whose extension picks the reader.
 * @returns The reader, or `undefined`.
 */
function readerFor(
	filePath: string,
): ((fileSystem: FileSystem, filePath: string) => Array<string>) | undefined {
	const lower = filePath.toLowerCase();
	if (lower.endsWith(".rbxm")) {
		return readBinaryClasses;
	}

	if (lower.endsWith(".rbxmx")) {
		return readXmlClasses;
	}

	if (lower.endsWith(MODEL_JSON_SUFFIX) || path.basename(lower) === META_JSON_FILE) {
		return readJsonClasses;
	}

	return undefined;
}
