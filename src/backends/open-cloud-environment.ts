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

function resolveOcaleMaxRetries(): number | undefined {
	const raw = process.env[MAX_RETRIES_ENV]?.trim();
	if (raw === "") {
		return undefined;
	}

	const parsed = Number(raw);
	return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}
