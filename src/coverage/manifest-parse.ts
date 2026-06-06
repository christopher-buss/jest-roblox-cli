import { type } from "arktype";
import * as fs from "node:fs";

import { isErrnoException } from "../utils/errno.ts";

/**
 * Shared read result for the sibling manifest readers. `BuildManifest`'s reader
 * extends this with artifact-rehash variants after a successful parse.
 */
export type ParsedManifest<T> =
	| { actual: unknown; expected: number; kind: "version-mismatch" }
	| { kind: "invalid"; summary: string }
	| { kind: "malformed-json" }
	| { kind: "missing" }
	| { kind: "ok"; manifest: T };

/**
 * Read a JSON manifest, classify failures, and validate it against `schema`.
 * A numeric `version` that disagrees with `expectedVersion` is reported as a
 * `version-mismatch` before schema validation, so a stale on-disk version reads
 * as an upgrade signal rather than a generic schema error. A missing file is
 * `missing`; any other IO error propagates rather than masquerading as
 * malformed JSON.
 */
export function parseVersionedManifest<T>(
	filePath: string,
	schema: type<T>,
	expectedVersion: number,
): ParsedManifest<T> {
	let contents: string;
	try {
		contents = fs.readFileSync(filePath, "utf-8");
	} catch (err) {
		if (isErrnoException(err) && err.code === "ENOENT") {
			return { kind: "missing" };
		}

		throw err;
	}

	let raw: unknown;
	try {
		raw = JSON.parse(contents);
	} catch {
		return { kind: "malformed-json" };
	}

	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { kind: "invalid", summary: "manifest must be a JSON object" };
	}

	const peeked = (raw as { version?: unknown }).version;
	if (typeof peeked === "number" && peeked !== expectedVersion) {
		return { actual: peeked, expected: expectedVersion, kind: "version-mismatch" };
	}

	const parsed = schema(raw);
	if (parsed instanceof type.errors) {
		return { kind: "invalid", summary: parsed.summary };
	}

	// `schema` is a `type<T>`, so a non-error result is `T` at runtime; the
	// generic distillation type just can't prove that to the compiler.
	return { kind: "ok", manifest: parsed as T };
}
