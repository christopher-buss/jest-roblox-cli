import process from "node:process";
import { isAgent } from "std-env";

import type { FormatterEntry } from "./schema.ts";

/**
 * The formatters a run falls back to when neither the CLI nor a config names
 * one. `std-env` resolves `isAgent` once at module load, so no later env change
 * moves it.
 */
export function defaultFormatters(isAgentRuntime: boolean = isAgent): Array<FormatterEntry> {
	const defaults: Array<FormatterEntry> = isAgentRuntime ? ["agent"] : ["default"];

	if (process.env["GITHUB_ACTIONS"] === "true") {
		defaults.push("github-actions");
	}

	return defaults;
}
