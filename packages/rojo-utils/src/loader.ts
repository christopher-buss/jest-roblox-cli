import { type ArkErrors, type } from "arktype";
import { dirname, join } from "node:path";

import type { FileSystem } from "./file-system.ts";
import { nodeFileSystem } from "./file-system.ts";
import { treeSchema } from "./project-schema.ts";
import { resolveNestedProjects } from "./rojo-tree.ts";
import type { LoadedRojoProject, RojoProject } from "./rojo-types.ts";

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

function orThrow<T>(result: ArkErrors | T, projectPath: string): T {
	if (result instanceof type.errors) {
		throw new Error(`Invalid Rojo project ${projectPath}: ${result.summary}`);
	}

	return result;
}

function rejectArray(
	value: unknown,
	ctx: { reject: (reason: { actual: string; expected: string }) => false },
): boolean {
	if (!Array.isArray(value)) {
		return true;
	}

	return ctx.reject({ actual: "an array", expected: "an object" });
}

const objectSchema = type("object").narrow(rejectArray).as<JSONObject>();

const fieldsSchema = type.declare<RojoProject>().type({
	"name": "string > 0",
	"servePort?": "number.integer | undefined",
	"tree": treeSchema,
});

function parseProject(content: string, projectPath: string): ParsedProject {
	let parsed: JSONValue;
	try {
		parsed = JSON.parse(content);
	} catch (err) {
		throw new Error(`Failed to parse Rojo project: ${projectPath}`, { cause: err });
	}

	const raw = orThrow(objectSchema(parsed), projectPath);
	return { fields: orThrow(fieldsSchema(raw), projectPath), raw };
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
	// `fields` IS `raw`, undeclared keys and all. Spreading it would surface
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
