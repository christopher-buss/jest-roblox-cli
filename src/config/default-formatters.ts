import process from "node:process";
import { isAgent } from "std-env";

import type { FormatterEntry } from "./formatter-selection.ts";

/**
 * The formatters a run uses when neither the CLI nor a config names one.
 *
 * @param isAgentRuntime - Whether the run is inside an agent runtime.
 * @returns The default formatter entries.
 */
export function defaultFormatters(isAgentRuntime: boolean = isAgent): Array<FormatterEntry> {
	const defaults: Array<FormatterEntry> = isAgentRuntime ? ["agent"] : ["default"];

	if (process.env["GITHUB_ACTIONS"] === "true") {
		defaults.push("github-actions");
	}

	return defaults;
}
