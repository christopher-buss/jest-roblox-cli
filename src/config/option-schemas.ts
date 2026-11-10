import { type, type Type } from "arktype";

import { isAbsolutePath, normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import type {
	DisplayName,
	GlobalTestConfig,
	SnapshotFormatOptions,
	WorkspaceConfig,
} from "./config-types.ts";
import type { TypecheckConfig } from "./resolve-typecheck-config.ts";

export const snapshotFormatSchema: Type<SnapshotFormatOptions> = type({
	"+": "reject",
	"callToJSON?": "boolean",
	"escapeRegex?": "boolean",
	"escapeString?": "boolean",
	"indent?": "number",
	"maxDepth?": "number",
	"min?": "boolean",
	"printBasicPrototype?": "boolean",
	"printFunctionName?": "boolean",
});

export const coverageThresholdSchema: Type<NonNullable<GlobalTestConfig["coverageThreshold"]>> =
	type({
		"+": "reject",
		"branches?": "number",
		"functions?": "number",
		"lines?": "number",
		"statements?": "number",
	});

export const displayNameSchema: Type<DisplayName | string> = type("string").or({
	"name": "string",
	"+": "reject",
	"color": "string",
});

export const typecheckConfigSchema: Type<TypecheckConfig> = type({
	"+": "reject",
	"enabled?": "boolean",
	"exclude?": "string[]",
	"ignoreSourceErrors?": "boolean",
	"include?": "string[]",
	"only?": "boolean",
	"spawnTimeout?": "number > 0",
	"tsconfig?": "string",
});

export const workspaceConfigSchema: Type<WorkspaceConfig> = type({
	"+": "reject",
	"exclude?": "string[]",
	"gameOutput?": "true",
	"outputFile?": "true",
	"packages?": "string[]",
	"root?": "string",
});

export const absolutePathSchema: Type<string> = type("string").narrow((value, ctx) => {
	if (isAbsolutePath(normalizeWindowsPath(value))) {
		return true;
	}

	return ctx.reject({ actual: `"${value}"`, expected: "an absolute path" });
});
