import type { distill } from "arktype";
import { type } from "arktype";

import { isFileNotFound } from "../utils/file-not-found.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { nodeFileSystem } from "../utils/file-system.ts";

/**
 * Read result shared by the manifest readers.
 * @template T - Manifest shape on success.
 */
export type ParsedManifest<T> =
	| { actual: unknown; expected: number; kind: "version-mismatch" }
	| { kind: "invalid"; summary: string }
	| { kind: "malformed-json" }
	| { kind: "missing" }
	| { kind: "ok"; manifest: T };

/**
 * Reads a text file, treating a missing file as absent.
 * @param filePath - File to read.
 * @param fileSystem - File system to read through.
 * @returns The file contents, or undefined when the file does not exist.
 * @throws When reading fails for a reason other than a missing file.
 */
export function readUnlessMissing(filePath: string, fileSystem: FileSystem): string | undefined {
	try {
		return fileSystem.readFileSync(filePath, "utf-8");
	} catch (err) {
		if (isFileNotFound(err)) {
			return undefined;
		}

		throw err;
	}
}

/**
 * Reads, classifies, and validates a versioned JSON manifest.
 * @template T - Schema the manifest is validated against.
 * @param options - Expected version, path, filesystem and schema.
 * @returns The validated manifest, or why it was refused.
 * @throws When reading fails for a reason other than a missing file.
 */
export function parseVersionedManifest<T>({
	expectedVersion,
	filePath,
	fileSystem = nodeFileSystem,
	schema,
}: {
	expectedVersion: number;
	filePath: string;
	fileSystem?: FileSystem;
	schema: type<T>;
}): ParsedManifest<distill.Out<T>> {
	const contents = readUnlessMissing(filePath, fileSystem);
	if (contents === undefined) {
		return { kind: "missing" };
	}

	let raw: JSONValue;
	try {
		raw = JSON.parse(contents);
	} catch {
		return { kind: "malformed-json" };
	}

	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { kind: "invalid", summary: "manifest must be a JSON object" };
	}

	const peeked = raw["version"];
	if (typeof peeked === "number" && peeked !== expectedVersion) {
		return { actual: peeked, expected: expectedVersion, kind: "version-mismatch" };
	}

	const parsed = schema(raw);
	if (parsed instanceof type.errors) {
		return { kind: "invalid", summary: parsed.summary };
	}

	return { kind: "ok", manifest: parsed };
}
