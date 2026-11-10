import { type, type Type } from "arktype";

import type { Config, GlobalTestConfig, ProjectConfigFile } from "./config-types.ts";
import { objectDefinition } from "./option-row.ts";
import { isTestKey } from "./options.ts";
import { ROOT_ROWS } from "./root-options.ts";
import { GLOBAL_TEST_ROWS, PROJECT_TEST_ROWS } from "./test-options.ts";

const projectConfigFileTestSchema = type(
	objectDefinition(
		PROJECT_TEST_ROWS,
		(row) => row.projectRequired === true && row.key !== "include",
	),
).as<ProjectConfigFile>();

/** A project config file: a bare `test` block or a `defineProject` wrapper. */
export const projectConfigFileSchema: Type<ProjectConfigFile> = type({
	"+": "reject",
	"test": projectConfigFileTestSchema,
})
	.pipe(({ test }) => test)
	.or(projectConfigFileTestSchema)
	.as<ProjectConfigFile>();

const globalTestConfigSchema = type(objectDefinition(GLOBAL_TEST_ROWS)).as<GlobalTestConfig>();

export const configSchema: Type<Config> = type({
	...objectDefinition(ROOT_ROWS),
	"test?": globalTestConfigSchema,
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

	const misplaced = Object.keys(raw).filter(isTestKey).sort();
	if (misplaced.length > 0) {
		throw new Error(
			`jest options must be wrapped in a \`test:\` block. Move these keys under \`test:\`: ${misplaced.join(", ")}`,
		);
	}
}
