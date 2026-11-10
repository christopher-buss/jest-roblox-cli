import { isOptionalPath, isRojoTreeNode } from "@isentinel/rojo-utils";

import assert from "node:assert";
import * as path from "node:path";

import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import { readDeclaredGlobIgnorePaths } from "./glob-ignore.ts";

/**
 * Rewrite every `$path` relative to the project file's directory.
 * @param projectJson - Serialized project with absolute `$path` values.
 * @param projectDirectory - Directory the project file is written to.
 * @returns The project re-serialized with relative `$path` values.
 */
export function relativizeProjectPaths(projectJson: string, projectDirectory: string): string {
	const project = JSON.parse(projectJson);
	assert(isJsonObject(project), "a rojo project is a JSON object");
	const globIgnorePaths = readDeclaredGlobIgnorePaths(project)?.map((entry) => {
		return relativizeMount(entry, projectDirectory);
	});
	const rewritten = {
		...rewriteMembers(project, projectDirectory),
		...(globIgnorePaths ? { globIgnorePaths } : {}),
	};
	return JSON.stringify(rewritten, undefined, 2);
}

function relativizeMount(mount: string, projectDirectory: string): string {
	return path.isAbsolute(mount)
		? normalizeWindowsPath(path.relative(projectDirectory, mount))
		: mount;
}

function isJsonObject(value: JSONValue): value is JSONObject {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function rewrite(value: JSONValue, projectDirectory: string): JSONValue {
	return isJsonObject(value) ? rewriteMembers(value, projectDirectory) : value;
}

function rewriteMembers(value: JSONObject, projectDirectory: string): JSONObject {
	const result: Record<string, JSONValue> = {};
	for (const [key, member] of Object.entries(value)) {
		if (key === "$path" && typeof member === "string") {
			result[key] = relativizeMount(member, projectDirectory);
			continue;
		}

		if (key === "$path" && isRojoTreeNode(member) && isOptionalPath(member)) {
			result[key] = { optional: relativizeMount(member.optional, projectDirectory) };
			continue;
		}

		result[key] = rewrite(member, projectDirectory);
	}

	return result;
}
