import assert from "node:assert";
import process from "node:process";
import type { Except } from "type-fest";

import type { RunnerCredentials } from "./runner-types.ts";

/**
 * Explicit credentials and environment precedence for one runner.
 */
export interface ResolveCredentialsInput {
	/**
	 * Fallback place and universe IDs; API keys never come from defaults.
	 */
	defaults?: Tolerant<Except<RunnerCredentials, "apiKey">> | undefined;
	/**
	 * Try these prefixed environment variables before their ordinary names.
	 */
	envPrefix?: string | undefined;
	/**
	 * Explicit values take precedence over environment and defaults.
	 */
	overrides?: Tolerant<RunnerCredentials> | undefined;
}

/**
 * Optional properties tolerate an explicit `undefined`. Every field is read
 * by value below (`normalize(overrides?.[field])`), so a present-but-undefined
 * key behaves exactly like an absent one — and callers forwarding optional CLI
 * flags would otherwise need a conditional spread per field.
 * @template T
 */
type Tolerant<T> = { [K in keyof T]?: T[K] | undefined };

interface FieldSpec {
	envSuffix: string;
	field: keyof RunnerCredentials;
}

const FIELD_SPECS: ReadonlyArray<FieldSpec> = [
	{ envSuffix: "OPEN_CLOUD_API_KEY", field: "apiKey" },
	{ envSuffix: "UNIVERSE_ID", field: "universeId" },
	{ envSuffix: "PLACE_ID", field: "placeId" },
];

/**
 * Resolve explicit and environment credentials, rejecting missing fields.
 * @param input - Explicit overrides, environment prefix and fallback IDs.
 * @returns Complete trimmed credentials from the documented precedence chain.
 */
export function resolveCredentials(input?: ResolveCredentialsInput): RunnerCredentials {
	const overrides = input?.overrides;
	const defaults = input?.defaults;
	const environmentPrefix = input?.envPrefix;

	const resolved: Partial<Record<keyof RunnerCredentials, string>> = {};
	const missing: Array<FieldSpec> = [];

	for (const spec of FIELD_SPECS) {
		const value =
			normalize(overrides?.[spec.field]) ??
			(environmentPrefix !== undefined
				? readEnvironment(`${environmentPrefix}ROBLOX_${spec.envSuffix}`)
				: undefined) ??
			readEnvironment(`ROBLOX_${spec.envSuffix}`) ??
			(spec.field !== "apiKey" ? normalize(defaults?.[spec.field]) : undefined);

		if (value === undefined) {
			missing.push(spec);
		} else {
			resolved[spec.field] = value;
		}
	}

	if (missing.length > 0) {
		throw new Error(formatMissingError(missing, environmentPrefix));
	}

	// The throw above proves every field resolved, which the `Partial` cannot
	// express.
	const { apiKey, placeId, universeId } = resolved;
	assert(apiKey !== undefined && placeId !== undefined && universeId !== undefined);
	return { apiKey, placeId, universeId };
}

function normalize(value: string | undefined): string | undefined {
	if (value === undefined) {
		return undefined;
	}

	const trimmed = value.trim();
	return trimmed === "" ? undefined : trimmed;
}

function readEnvironment(key: string): string | undefined {
	return normalize(process.env[key]);
}

function formatMissingError(
	missing: Array<FieldSpec>,
	environmentPrefix: string | undefined,
): string {
	const list = missing.map((spec) => spec.field).join(", ");
	const environmentVariables = missing
		.map((spec) => {
			const canonical = `ROBLOX_${spec.envSuffix}`;
			return environmentPrefix !== undefined
				? `${canonical} (or ${environmentPrefix}${canonical})`
				: canonical;
		})
		.join(", ");

	return `Open Cloud credentials are required. Missing: ${list}. Set ${environmentVariables}.`;
}
