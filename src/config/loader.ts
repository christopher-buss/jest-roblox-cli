import { loadConfig as c12LoadConfig } from "c12";
import { defuFn } from "defu";
import { readFileSync } from "node:fs";
import process from "node:process";

import type { Config, ResolvedConfig } from "./schema.ts";
import { DEFAULT_CONFIG, validateConfig } from "./schema.ts";

export function applySnapshotFormatDefaults(
	config: ResolvedConfig,
	isLuauProject: boolean,
): ResolvedConfig {
	if (config.snapshotFormat?.printBasicPrototype !== undefined) {
		return config;
	}

	return {
		...config,
		snapshotFormat: {
			...config.snapshotFormat,
			printBasicPrototype: isLuauProject,
		},
	};
}

export function resolveConfig(config: Config): ResolvedConfig {
	validateConfig(config);

	const { test, ...rest } = config;
	const definedRest = Object.fromEntries(
		Object.entries(rest).filter(([, value]) => value !== undefined),
	);
	const definedTest =
		test === undefined
			? {}
			: Object.fromEntries(Object.entries(test).filter(([, value]) => value !== undefined));

	// Flatten test: block onto resolved config so downstream consumers
	// (executor, projects, test-script, formatters) see jest options at the
	// top level. HAL-167: refactor consumers to read `config.test.*` directly.
	return Object.assign({}, DEFAULT_CONFIG, definedTest, definedRest);
}

export async function loadConfig(
	configPath?: string,
	cwd: string = process.cwd(),
): Promise<ResolvedConfig> {
	let result;
	const extendWarnings: Array<string> = [];
	const originalWarn = console.warn;

	try {
		console.warn = (...args: Array<unknown>) => {
			const message = args.join(" ");
			if (typeof message === "string" && message.includes("Cannot extend config")) {
				extendWarnings.push(message);
				return;
			}

			originalWarn.apply(console, args);
		};

		result = await c12LoadConfig<Config>({
			name: "jest",
			configFile: configPath,
			configFileRequired: configPath !== undefined,
			cwd,
			dotenv: false,
			globalRc: false,
			// In SEA mode, jiti's babel.cjs can't be resolved from the
			// single-executable archive. Bypass jiti entirely by providing a
			// custom import function.
			import: isSea() ? seaImport : undefined,
			merger,
			omit$Keys: true,
			packageJson: false,
			rcFile: false,
		});
	} catch (err) {
		if (configPath !== undefined) {
			throw new Error(`Config file not found: ${configPath}`, { cause: err });
		}

		throw err;
	} finally {
		console.warn = originalWarn;
	}

	if (extendWarnings.length > 0) {
		const extendsPath = extendWarnings[0]?.match(/`([^`]+)`/)?.[1];
		throw new Error(
			`Failed to resolve extends: "${extendsPath}". If the file exists, try adding the file extension (e.g. ".ts").`,
		);
	}

	const config = resolveFunctionValues(result.config);

	config.rootDir ??= cwd;

	return resolveConfig(config);
}

function isSea(): boolean {
	return process.env["JEST_ROBLOX_SEA"] === "true";
}

async function seaImport(id: string): Promise<JSONValue> {
	if (id.endsWith(".json")) {
		const content = readFileSync(id, "utf-8");
		return JSON.parse(content);
	}

	// eslint-disable-next-line ts/no-unnecessary-type-assertion -- import(id) returns any
	return import(id) as unknown as JSONValue;
}

// c12's merger signature and defuFn's generic signature are structurally
// incompatible. This wrapper bridges the two with a single boundary cast.
function merger(...sources: Array<Config | null | undefined>): Config {
	return defuFn(...(sources.filter(Boolean) as [Config, ...Array<Config>]));
}

const EMPTY_ARRAY_DEFAULT_KEYS = new Set([
	"collectCoverageFrom",
	"formatters",
	"luauRoots",
	"reporters",
	"roots",
	"selectProjects",
	"setupFiles",
	"setupFilesAfterEnv",
	"snapshotSerializers",
]);

const EMPTY_OBJECT_DEFAULT_KEYS = new Set(["coverageThreshold", "snapshotFormat"]);

const MERGEABLE_KEYS = new Set([
	...EMPTY_ARRAY_DEFAULT_KEYS,
	...EMPTY_OBJECT_DEFAULT_KEYS,
	"coveragePathIgnorePatterns",
	"coverageReporters",
	"testMatch",
	"testPathIgnorePatterns",
]);

function isMergerFunction(value: unknown): value is (defaults: unknown) => unknown {
	return typeof value === "function";
}

function shouldResolveMergerFunction(
	key: string,
	value: unknown,
): value is (defaults: unknown) => unknown {
	return isMergerFunction(value) && MERGEABLE_KEYS.has(key);
}

function defaultForMergerKey(key: string): unknown {
	const defaultValue = (DEFAULT_CONFIG as unknown as Record<string, unknown>)[key];
	if (Array.isArray(defaultValue)) {
		return [...defaultValue];
	}

	if (EMPTY_ARRAY_DEFAULT_KEYS.has(key)) {
		return [];
	}

	return {};
}

function resolveFunctionValues(config: Config): Config {
	const { test, ...rest } = config;

	const resolvedRest: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(rest)) {
		resolvedRest[key] = shouldResolveMergerFunction(key, value)
			? value(defaultForMergerKey(key))
			: value;
	}

	if (test === undefined) {
		return resolvedRest;
	}

	const resolvedTest: Record<string, unknown> = {};
	for (const [innerKey, innerValue] of Object.entries(test)) {
		resolvedTest[innerKey] = shouldResolveMergerFunction(innerKey, innerValue)
			? innerValue(defaultForMergerKey(innerKey))
			: innerValue;
	}

	return { ...resolvedRest, test: resolvedTest };
}
