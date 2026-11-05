import process from "node:process";
import { isAgent } from "std-env";

import type { FormatterEntry } from "../../src/config/schema.ts";

export function expectedDefaultFormatters(): Array<FormatterEntry> {
	const defaults: Array<FormatterEntry> = isAgent ? ["agent"] : ["default"];

	if (process.env["GITHUB_ACTIONS"] === "true") {
		defaults.push("github-actions");
	}

	return defaults;
}
