import { type } from "arktype";
import { Buffer } from "node:buffer";
import * as path from "node:path";

import type { FileSystem } from "../utils/file-system.ts";
import { nodeFileSystem } from "../utils/file-system.ts";

const BINARY_MAGIC = "<roblox!";
const BINARY_HEADER_BYTES = 32;
const CHUNK_HEADER_BYTES = 16;
const XML_CLASS_ATTRIBUTE = /<Item\s+class="([^"]+)"/g;
const MODEL_JSON_SUFFIX = ".model.json";

const descriptorSchema = type({
	"[string]": "unknown",
	"ClassName?": "string",
	"className?": "string",
});

/** The name rojo gives a mounted file is its basename, less one of these. */
export const MODEL_EXTENSIONS: ReadonlyArray<string> = [MODEL_JSON_SUFFIX, ".rbxmx", ".rbxm"];
/** A directory declares its own class here rather than in a sibling file. */
export const META_JSON_FILE = "init.meta.json";

interface Cursor {
	offset: number;
	written: number;
}

interface Lz4Step {
	cursor: Cursor;
	destination: Buffer;
	source: Buffer;
	token: number;
}

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
 * Every class the file declares; none for an unreadable or malformed file.
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

function readClassName(chunk: Buffer): string {
	const nameBytes = chunk.readUInt32LE(4);
	return chunk.toString("utf-8", 8, 8 + nameBytes);
}

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
 * Byte at a time: an LZ4 match can overlap the bytes it is still writing.
 *
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
			// Metadata chunks may precede the `INST` chunks; stop only after one.
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
