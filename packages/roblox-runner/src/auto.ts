/* cspell:words ocale */
import process from "node:process";

import { OcaleRunner } from "./ocale-runner.ts";
import type { OcaleRunnerOptions } from "./ocale-runner.ts";
import { StudioRunner } from "./studio-runner.ts";
import type { StudioRunnerOptions } from "./studio-runner.ts";
import type { RunnerCredentials } from "./types.ts";

export function createOcaleRunner(
	credentials: RunnerCredentials,
	options?: OcaleRunnerOptions,
): OcaleRunner {
	return new OcaleRunner(credentials, options);
}

export function createStudioRunner(options: StudioRunnerOptions): StudioRunner {
	return new StudioRunner(options);
}

// eslint-disable-next-line id-length -- matches env var naming pattern
export function createOcaleRunnerFromEnvironment(options?: OcaleRunnerOptions): OcaleRunner {
	const apiKey = process.env["ROBLOX_OPEN_CLOUD_API_KEY"];
	if (apiKey === undefined || apiKey === "") {
		throw new Error("ROBLOX_OPEN_CLOUD_API_KEY environment variable is required");
	}

	const universeId = process.env["ROBLOX_UNIVERSE_ID"];
	if (universeId === undefined || universeId === "") {
		throw new Error("ROBLOX_UNIVERSE_ID environment variable is required");
	}

	const placeId = process.env["ROBLOX_PLACE_ID"];
	if (placeId === undefined || placeId === "") {
		throw new Error("ROBLOX_PLACE_ID environment variable is required");
	}

	return new OcaleRunner({ apiKey, placeId, universeId }, options);
}
