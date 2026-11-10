import { type ArkErrors, type, type Type } from "arktype";
import { dirname, join } from "node:path";

import type { FileSystem } from "./file-system.ts";
import { nodeFileSystem } from "./file-system.ts";
import { getTreeSchema } from "./project-schema.ts";
import { resolveNestedProjects } from "./rojo-tree.ts";
import type { LoadedRojoProject, RojoProject } from "./rojo-types.ts";

let objectSchema: Type<JSONObject> | undefined;
let fieldsSchema: Type<RojoProject> | undefined;

const PROJECT_FILE_SUFFIX = ".project.json";

/** Rojo project file used when the config names none. */
export const DEFAULT_ROJO_PROJECT = "default.project.json";

interface ParsedProject {
	fields: RojoProject;
	raw: JSONObject;
}

interface ProjectSource {
	content: string;
	fileSystem: FileSystem;
	projectPath: string;
}

/**
 * Find the Rojo project file in a directory.
 *
 * @param directory - Directory to search.
 * @param fileSystem - Where the directory is read.
 * @returns `default.project.json` when present, else the first `*.project.json`, else
 *   undefined, also when the directory does not exist.
 */
export function findRojoProjectFile(
	directory: string,
	fileSystem: FileSystem = nodeFileSystem,
): string | undefined {
	const defaultPath = join(directory, DEFAULT_ROJO_PROJECT);
	if (fileSystem.existsSync(defaultPath)) {
		return defaultPath;
	}

	let files: Array<string>;
	try {
		files = fileSystem.readdirSync(directory, "utf-8");
	} catch (err) {
		if (isMissing(err)) {
			return undefined;
		}

		throw err;
	}

	const projectFile = files.find((file) => file.endsWith(PROJECT_FILE_SUFFIX));
	return projectFile === undefined ? undefined : join(directory, projectFile);
}

/**
 * Parse and validate Rojo project text without resolving nested projects.
 *
 * @param content - The project JSON text.
 * @param projectPath - The file the text came from, named in errors.
 * @returns The validated fields.
 * @throws When the text is not JSON or fails the project schema.
 */
export function parseRojoProject(content: string, projectPath: string): RojoProject {
	return parseProject(content, projectPath).fields;
}

/**
 * {@link loadRojoProject}, answering `undefined` when the project file does not
 * exist. Every other failure still throws.
 *
 * @param projectPath - The project file to read.
 * @param fileSystem - Where it and its nested projects are read from.
 * @returns The loaded project, or undefined when the file is absent.
 */
export function tryLoadRojoProject(
	projectPath: string,
	fileSystem: FileSystem = nodeFileSystem,
): LoadedRojoProject | undefined {
	let content: string;
	try {
		content = fileSystem.readFileSync(projectPath, "utf-8");
	} catch (err) {
		if (isMissing(err)) {
			return undefined;
		}

		throw readError(projectPath, err);
	}

	return buildLoadedProject({ content, fileSystem, projectPath });
}

/**
 * Read and validate a Rojo project file, inlining every nested project it
 * names.
 *
 * @param projectPath - The project file to read.
 * @param fileSystem - Where it and its nested projects are read from.
 * @returns Validated fields, original JSON and expanded mounts; throws on read or parse failure.
 */
export function loadRojoProject(
	projectPath: string,
	fileSystem: FileSystem = nodeFileSystem,
): LoadedRojoProject {
	const content = readProjectText(fileSystem, projectPath);
	return buildLoadedProject({ content, fileSystem, projectPath });
}

function isMissing(err: unknown): boolean {
	return err instanceof Error && "code" in err && err.code === "ENOENT";
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
		"servePort?": "number.integer",
		"tree": getTreeSchema(),
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
 * An array sits in arktype's `object` domain, so it satisfies a schema whose
 * keys are all optional. Reject it, and name it "an array" so the reader does
 * not have to work out why their array is not an object.
 *
 * @param value - The candidate object.
 * @param ctx - Arktype's narrow context.
 * @returns True when the value is not an array.
 */
function rejectArray(
	value: unknown,
	ctx: { reject: (reason: { actual: string; expected: string }) => false },
): boolean {
	if (!Array.isArray(value)) {
		return true;
	}

	return ctx.reject({ actual: "an array", expected: "an object" });
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

function parseProject(content: string, projectPath: string): ParsedProject {
	let parsed: JSONValue;
	try {
		parsed = JSON.parse(content);
	} catch (err) {
		throw new Error(`Failed to parse Rojo project: ${projectPath}`, { cause: err });
	}

	const raw = orThrow(getObjectSchema()(parsed), projectPath);
	return { fields: orThrow(getFieldsSchema()(raw), projectPath), raw };
}

function readError(projectPath: string, cause: unknown): Error {
	return new Error(`Could not read Rojo project: ${projectPath}`, { cause });
}

function buildLoadedProject({
	content,
	fileSystem,
	projectPath,
}: ProjectSource): LoadedRojoProject {
	const { fields, raw } = parseProject(content, projectPath);

	// Named field by field, not spread: arktype applies no morph here, so
	// `fields` IS `raw` — undeclared keys and all. Spreading it would surface
	// gameId, placeId and the rest at the top level, where `LoadedRojoProject`
	// promises they live on `raw` alone.
	return {
		name: fields.name,
		raw,
		servePort: fields.servePort,
		tree: resolveNestedProjects(
			{ rootDirectory: dirname(projectPath), tree: fields.tree },
			fileSystem,
		),
	};
}

function readProjectText(fileSystem: FileSystem, projectPath: string): string {
	try {
		return fileSystem.readFileSync(projectPath, "utf-8");
	} catch (err) {
		throw readError(projectPath, err);
	}
}
