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

	const defined = Object.fromEntries(
		Object.entries(config).filter(([, value]) => value !== undefined),
	);

	return Object.assign({}, DEFAULT_CONFIG, defined);
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

	return import(id) as unknown as JSONValue;
}

// c12's merger signature and defuFn's generic signature are structurally
// incompatible. This wrapper bridges the two with a single boundary cast.
function merger(...sources: Array<Config | null | undefined>): Config {
	return defuFn(...(sources.filter(Boolean) as [Config, ...Array<Config>]));
}

function isMergerFunction(value: unknown): value is (defaults: undefined) => unknown {
	return typeof value === "function";
}

function resolveFunctionValues(config: Config): Config {
	const resolved: Record<string, unknown> = {};

	for (const [key, value] of Object.entries(config)) {
		resolved[key] = isMergerFunction(value) ? value(undefined) : value;
	}

	return resolved as Config;
}
