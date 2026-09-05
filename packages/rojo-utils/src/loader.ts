import type { ArkErrors } from "arktype";
import { type, type Type } from "arktype";
import { dirname } from "node:path";

import type { FileSystem } from "./file-system.ts";
import { nodeFileSystem } from "./file-system.ts";
import { resolveNestedProjects } from "./rojo-tree.ts";
import type { LoadedRojoProject, RojoProject } from "./types.ts";

let objectSchema: Type<JSONObject> | undefined;
let fieldsSchema: Type<RojoProject> | undefined;

/**
 * Read and validate a Rojo project file, inlining every nested project it
 * names.
 *
 * @param projectPath - The project file to read.
 * @param fileSystem - Where it and its nested projects are read from.
 */
export function loadRojoProject(
	projectPath: string,
	fileSystem: FileSystem = nodeFileSystem,
): LoadedRojoProject {
	const raw = readProjectJson(fileSystem, projectPath);
	const fields = orThrow(getFieldsSchema()(raw), projectPath);

	// Named field by field, not spread: arktype applies no morph here, so
	// `fields` IS `raw` — undeclared keys and all. Spreading it would surface
	// gameId, placeId and the rest at the top level, where `LoadedRojoProject`
	// promises they live on `raw` alone.
	return {
		name: fields.name,
		raw,
		servePort: fields.servePort,
		tree: resolveNestedProjects(fields.tree, dirname(projectPath), fileSystem),
	};
}

/**
 * An array sits in arktype's `object` domain, so it satisfies a schema whose
 * keys are all optional. Reject it, and name it "an array" so the reader does
 * not have to work out why their array is not an object.
 *
 * @param value - The candidate object.
 * @param ctx - Arktype's narrow context.
 * @returns True when the value is not an array.
 */
function rejectArray(
	value: object,
	ctx: { reject: (reason: { actual: string; expected: string }) => false },
): boolean {
	if (!Array.isArray(value)) {
		return true;
	}

	return ctx.reject({ actual: "an array", expected: "an object" });
}

/**
 * Schema for the fields this loader reads. Undeclared top-level keys (gameId,
 * placeId, globIgnorePaths, …) pass through untouched and reach callers via
 * `raw`. The tree is checked one level deep: its `$`-metadata must have the
 * right types, but its members are left to the tree walkers, which handle
 * arbitrary shapes by design.
 *
 * Built lazily on first use (not at module top level) so consumers can
 * auto-mock this module without a hoisting TDZ on the arktype import,
 * mirroring `rojo-resolver.ts`.
 *
 * @returns The memoized schema.
 */
function getFieldsSchema(): Type<RojoProject> {
	fieldsSchema ??= type({
		"name": "string > 0",
		"servePort?": "number",
		"tree": type({
			"$className?": "string",
			"$ignoreUnknownInstances?": "boolean",
			"$path?": ["string", "|", { optional: "string" }],
			"$properties?": "object",
		}).narrow(rejectArray),
	}).as<RojoProject>();

	return fieldsSchema;
}

/**
 * Unwrap an arktype result, turning a failure into the loader's error.
 *
 * @template T - The schema's output type.
 * @param result - What the schema returned.
 * @param projectPath - The file being parsed, named in the error.
 * @returns The parsed value.
 * @throws When the schema rejected the value.
 */
function orThrow<T>(result: ArkErrors | T, projectPath: string): T {
	if (result instanceof type.errors) {
		throw new Error(`Invalid Rojo project ${projectPath}: ${result.summary}`);
	}

	return result;
}

/**
 * Schema for "the file holds a JSON object". Separate from
 * {@link getFieldsSchema} because its output is what callers read as `raw`.
 *
 * @returns The memoized schema.
 */
function getObjectSchema(): Type<JSONObject> {
	objectSchema ??= type("object").narrow(rejectArray).as<JSONObject>();
	return objectSchema;
}

function readProjectJson(fileSystem: FileSystem, projectPath: string): JSONObject {
	let content: string;
	try {
		content = fileSystem.readFileSync(projectPath, "utf-8");
	} catch (err) {
		throw new Error(`Could not read Rojo project: ${projectPath}`, { cause: err });
	}

	let parsed: JSONValue;
	try {
		parsed = JSON.parse(content);
	} catch (err) {
		throw new Error(`Failed to parse Rojo project: ${projectPath}`, { cause: err });
	}

	return orThrow(getObjectSchema()(parsed), projectPath);
}
