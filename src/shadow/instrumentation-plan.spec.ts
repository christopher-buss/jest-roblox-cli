import { describe, expect, it } from "vitest";

import { buildInstrumentationSkipFiles } from "./instrumentation-plan.ts";

describe(buildInstrumentationSkipFiles, () => {
	it.for([
		{ excluded: new Set<string>(), expected: undefined, skipFiles: undefined },
		{ excluded: new Set<string>(), expected: new Set<string>(), skipFiles: new Set<string>() },
		{
			excluded: new Set(["excluded.luau"]),
			expected: new Set(["excluded.luau"]),
			skipFiles: undefined,
		},
		{
			excluded: new Set(["cached.luau", "excluded.luau"]),
			expected: new Set(["cached.luau", "excluded.luau", "other.luau"]),
			skipFiles: new Set(["cached.luau", "other.luau"]),
		},
	])(
		"should combine cached and excluded files: $expected",
		({ excluded, expected, skipFiles }) => {
			expect.assertions(1);

			expect(buildInstrumentationSkipFiles({ excluded, skipFiles })).toStrictEqual(expected);
		},
	);
});
