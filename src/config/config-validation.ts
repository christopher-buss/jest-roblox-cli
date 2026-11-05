import { type, type Type } from "arktype";

import { isAbsolutePath, normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import { KEY_LOCATIONS } from "./config-keys.ts";
import type { Config, ProjectConfigFile } from "./schema.ts";

const snapshotFormatSchema = type({
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

const coverageThresholdSchema = type({
	"+": "reject",
	"branches?": "number",
	"functions?": "number",
	"lines?": "number",
	"statements?": "number",
});

const displayNameSchema = type({
	"name": "string",
	"+": "reject",
	"color": "string",
});

const typecheckConfigSchema = type({
	"+": "reject",
	"enabled?": "boolean",
	"exclude?": "string[]",
	"ignoreSourceErrors?": "boolean",
	"include?": "string[]",
	"only?": "boolean",
	"spawnTimeout?": "number > 0",
	"tsconfig?": "string",
});

const sharedTestDefinition = type.define({
	"automock?": "boolean",
	"clearMocks?": "boolean",
	"injectGlobals?": "boolean",
	"mockDataModel?": "boolean",
	"projectTimeout?": "number >= 0",
	"resetMocks?": "boolean",
	"resetModules?": "boolean",
	"restoreMocks?": "boolean",
	"setupFiles?": "string[]",
	"setupFilesAfterEnv?": "string[]",
	"slowTestThreshold?": "number > 0",
	"snapshotFormat?": snapshotFormatSchema,
	"snapshotSerializers?": "string[]",
	"testEnvironment?": "string",
	"testEnvironmentOptions?": type("string").or(type("object")),
	"testMatch?": "string[]",
	"testPathIgnorePatterns?": "string[]",
	"testRegex?": type("string").or(type("string[]")),
	"testTimeout?": "number",
	"typecheck?": typecheckConfigSchema,
});

// Everything a project's `test` block carries except `include`, which is
// required once resolved but optional as authored — see ProjectConfigFile.
const projectTestDefinition = type.define({
	...sharedTestDefinition,
	"displayName": type("string").or(displayNameSchema),
	"exclude?": "string[]",
	"outDir?": "string",
	"root?": "string",
});

const projectTestConfigSchema = type({
	"+": "reject",
	...projectTestDefinition,
	"include": "string[]",
});

const inlineProjectSchema = type({
	"+": "reject",
	"test": projectTestConfigSchema,
});

const projectConfigFileTestSchema = type({
	"+": "reject",
	...projectTestDefinition,
	"include?": "string[]",
});

/**
 * Both shapes a project config file may export — a bare `test` block, or the
 * `defineProject` wrapper around one — parsed into the block either way. A
 * config file is loaded by c12, which merges layers but validates nothing, so
 * this is where it becomes a domain type.
 */
export const projectConfigFileSchema: Type<ProjectConfigFile> = type({
	"+": "reject",
	"test": projectConfigFileTestSchema,
})
	.pipe(({ test }) => test)
	.or(projectConfigFileTestSchema)
	.as<ProjectConfigFile>();

const workspaceConfigSchema = type({
	"+": "reject",
	"exclude?": "string[]",
	"gameOutput?": "true",
	"outputFile?": "true",
	"packages?": "string[]",
	"root?": "string",
});

const formatterEntrySchema = type("string").or(type(["string", type("object")]));

const projectEntrySchema = type("string").or(inlineProjectSchema);

export const absolutePathSchema: Type<string> = type("string").narrow((value, ctx) => {
	if (isAbsolutePath(normalizeWindowsPath(value))) {
		return true;
	}

	return ctx.reject({ actual: `"${value}"`, expected: "an absolute path" });
});

const globalTestConfigSchema = type({
	"+": "reject",
	...sharedTestDefinition,
	"all?": "boolean",
	"bail?": type("boolean").or(type("number")),
	"changedSince?": "string",
	"ci?": "boolean",
	"clearCache?": "boolean",
	"collectCoverage?": "boolean",
	"collectCoverageFrom?": "string[]",
	"coverage?": "boolean",
	"coverageCopyIgnorePatterns?": "string[]",
	"coverageDirectory?": "string",
	"coveragePathIgnorePatterns?": "string[]",
	"coverageReporters?": "string[]",
	"coverageThreshold?": coverageThresholdSchema,
	"debug?": "boolean",
	"displayName?": type("string").or(displayNameSchema),
	"env?": "string",
	"exclude?": "string[]",
	"expand?": "boolean",
	"globals?": "string",
	"include?": "string[]",
	"maxWorkers?": type("number").or(type("string")),
	"noStackTrace?": "boolean",
	"outDir?": "string",
	"passWithNoTests?": "boolean",
	"preset?": "string",
	"projects?": projectEntrySchema.array(),
	"reporters?": "string[]",
	"roots?": "string[]",
	"runInBand?": "boolean",
	"selectProjects?": "string[]",
	"showConfig?": "boolean",
	"silent?": "boolean",
	"testFailureExitCode?": "string",
	"testNamePattern?": "string",
	"testPathPattern?": "string",
	"timers?": "string",
	"updateSnapshot?": "boolean",
	"verbose?": "boolean",
});

export const configSchema: Type<Config> = type({
	"+": "reject",
	"backend?": type("'auto'|'open-cloud'|'studio'|'studio-cli'"),
	"bootProbeTimeout?": "number",
	"color?": "boolean",
	"config?": "string",
	"coverageCache?": "boolean",
	"extends?": type("string").or(type("string[]")),
	"formatters?": formatterEntrySchema.array(),
	"gameOutput?": type("string").or("true"),
	"hiddenDesktop?": "boolean",
	"jestPath?": "string",
	"luauRoots?": "string[]",
	"outputFile?": type("string").or("true"),
	"parallel?": type("'auto'").or("number.integer >= 1"),
	"placeFile?": "string",
	"placeId?": "string",
	"pluginsDirectory?": absolutePathSchema,
	"port?": "number",
	"rojoProject?": "string",
	"rootDir?": "string",
	"showLuau?": "boolean",
	"sourceMap?": "boolean",
	"studioPath?": "string",
	"test?": globalTestConfigSchema,
	"timeout?": "number",
	"universeId?": "string",
	"uploadCache?": "boolean",
	"workspace?": workspaceConfigSchema,
}).as<Config>();

const MIGRATED_TYPECHECK_KEYS = new Map([
	["typecheck", "test.typecheck.enabled"],
	["typecheckOnly", "test.typecheck.only"],
	["typecheckTsconfig", "test.typecheck.tsconfig"],
]);

/**
 * Validate one config layer against the schema.
 *
 * @param raw - Layer as loaded.
 * @returns The typed layer.
 * @throws If the layer uses legacy keys or fails the schema.
 */
export function validateConfigLayer(raw: unknown): Config {
	assertNoLegacyKeys(raw);

	const result = configSchema(raw);
	if (result instanceof type.errors) {
		throw new Error(`Invalid config: ${result.summary}`);
	}

	return result;
}

/**
 * Validate a merged config, including cross-field rules.
 *
 * @param raw - Merged config as loaded.
 * @returns The typed config.
 * @throws If the config fails the schema, uses legacy keys, or declares only
 *   one of `workspace.root` and `workspace.packages`.
 */
export function validateConfig(raw: unknown): Config {
	const result = validateConfigLayer(raw);
	const { workspace } = result;
	if (
		workspace !== undefined &&
		(workspace.root === undefined) !== (workspace.packages === undefined)
	) {
		throw new Error("workspace.root and workspace.packages must be declared together.");
	}

	return result;
}

/**
 * Reject configs still written against the pre-`test:` layout. Both checks run
 * before the arktype pass so a migrating config gets a directive naming the
 * replacement keys, rather than a generic "unknown key" schema summary.
 *
 * @param raw - Layer as loaded.
 * @throws If the layer uses a pre-`test:` key.
 */
function assertNoLegacyKeys(raw: unknown): void {
	if (typeof raw !== "object" || raw === null) {
		return;
	}

	const migrated = Object.keys(raw)
		.flatMap((key) => {
			const replacement = MIGRATED_TYPECHECK_KEYS.get(key);
			return replacement === undefined ? [] : [`${key} → ${replacement}`];
		})
		.sort();
	if (migrated.length > 0) {
		throw new Error(
			`\`typecheck\` options have moved under \`test.typecheck\`. Replace these keys: ${migrated.join(", ")}`,
		);
	}

	const misplaced = Object.keys(raw)
		.filter((key) => KEY_LOCATIONS[key] === "test")
		.sort();
	if (misplaced.length > 0) {
		throw new Error(
			`jest options must be wrapped in a \`test:\` block. Move these keys under \`test:\`: ${misplaced.join(", ")}`,
		);
	}
}
