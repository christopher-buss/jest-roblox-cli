import { describe, expect, it } from "vitest";

import { LuauScriptError } from "./luau-script-error.ts";

describe(LuauScriptError, () => {
	it.for([
		["TaskScript:7: failed", "failed"],
		["TaskScript:123:failed", "failed"],
		[" TaskScript:7: failed", " TaskScript:7: failed"],
		["TaskScript:x: failed", "TaskScript:x: failed"],
		["TaskScript:7 failed", "TaskScript:7 failed"],
	] as const)(
		"should normalize only a leading numeric TaskScript frame in %j",
		([raw, expected]) => {
			expect.assertions(1);

			const error = new LuauScriptError(raw);

			expect(error.message).toBe(expected);
		},
	);
});
