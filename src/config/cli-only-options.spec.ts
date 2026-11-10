import { describe, expect, it } from "vitest";

import { CLI_ONLY_ROWS } from "./cli-only-options.ts";
import type { OptionRow } from "./option-row.ts";

function isMalformed({ cli, schema }: OptionRow): boolean {
	return cli === undefined || schema !== undefined;
}

describe("cLI-only options", () => {
	it("should give every row a flag and no schema", () => {
		expect.assertions(1);

		expect(CLI_ONLY_ROWS.filter(isMalformed)).toStrictEqual([]);
	});
});
