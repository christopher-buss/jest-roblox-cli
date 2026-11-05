import type { OcaleRunnerOptions } from "@isentinel/roblox-runner";

import process from "node:process";

const BASE_URL_ENV = "JEST_ROBLOX_OPEN_CLOUD_BASE_URL";
const MAX_RETRIES_ENV = "JEST_ROBLOX_OCALE_MAX_RETRIES";

/**
 * Read the Open Cloud base URL override.
 *
 * @returns The URL without trailing slashes, or undefined when unset or empty.
 */
export function resolveOpenCloudBaseUrl(): string | undefined {
	const override = process.env[BASE_URL_ENV]?.trim();
	if (override === undefined || override === "") {
		return undefined;
	}

	let end = override.length;
	while (override.charAt(end - 1) === "/") {
		end -= 1;
	}

	return override.slice(0, end);
}

/**
 * Build Open Cloud runner options from the environment overrides.
 *
 * @returns The base URL and retry count overrides.
 */
export function resolveRunnerOptions(): OcaleRunnerOptions {
	const baseUrl = resolveOpenCloudBaseUrl();
	const maxRetries = resolveOcaleMaxRetries();
	return {
		baseUrl,
		maxRetries,
	};
}

/**
 * Reads {@link MAX_RETRIES_ENV} for an Open Cloud per-request retry override,
 * which bounds unguided 429s, 5xx and transport retries; a 429 with
 * `retry-after` > 0 spends none. Returns undefined for unset, empty, or
 * non-integer values so the client keeps its own default.
 *
 * @returns The retry count, or undefined.
 */
function resolveOcaleMaxRetries(): number | undefined {
	const raw = process.env[MAX_RETRIES_ENV]?.trim();
	if (raw === "") {
		return undefined;
	}

	// Number() (not parseInt) so partial/decimal strings like "8abc" or "8.5"
	// reject instead of silently truncating to 8.
	const parsed = Number(raw);
	return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}
