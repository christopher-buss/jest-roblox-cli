import { describe, expect, it } from "vitest";

import type { ExpectedPlaceIdentity } from "./place-identity-guard.ts";
import {
	formatPlaceMismatch,
	placeIdentityGuardSource,
	readRefusedPlaceVersion,
} from "./place-identity-guard.ts";

describe(placeIdentityGuardSource, () => {
	it("should compare the stamped content id when the host holds one", () => {
		expect.assertions(1);

		// Locked to the literal, because this line and readRefusedPlaceVersion
		// are the two halves of one wire format: changing either alone breaks
		// every task that boots the wrong build.
		expect(placeIdentityGuardSource({ contentId: "abc123" })).toBe(
			'do local stamp = game:GetService("ReplicatedStorage"):FindFirstChild("__place_content_id") ' +
				'if stamp == nil or not stamp:IsA("StringValue") ' +
				'or stamp.Value ~= "abc123" then ' +
				'return "ROBLOX_RUNNER_PLACE_MISMATCH:" .. tostring(game.PlaceVersion) end end',
		);
	});

	it("should compare the version when that is the identity the host holds", () => {
		expect.assertions(1);

		expect(placeIdentityGuardSource({ placeVersion: 42 })).toBe(
			'if game.PlaceVersion ~= 42 then return "ROBLOX_RUNNER_PLACE_MISMATCH:" .. tostring(game.PlaceVersion) end',
		);
	});

	it.for<[string, ExpectedPlaceIdentity]>([
		["a stamped place", { contentId: "abc123" }],
		["an unstamped one", { placeVersion: 7 }],
	])("should stay one statement for %s, so a caller may splice it anywhere", ([, expected]) => {
		expect.assertions(1);

		expect(placeIdentityGuardSource(expected)).not.toContain("\n");
	});

	it.for<[string, string]>([
		["a double quote", 'ab"cd'],
		["a backslash", "ab\\cd"],
		["a newline", "ab\ncd"],
		["a carriage return", "ab\rcd"],
	])("should refuse a content id carrying %s", ([, contentId]) => {
		expect.assertions(1);

		// The id is spliced into a Luau double-quoted literal. A value that
		// literal cannot hold either breaks the script or closes the string and
		// runs whatever follows it, so it is refused while it is still a value.
		expect(() => placeIdentityGuardSource({ contentId })).toThrow(/cannot be embedded/);
	});
});

describe(formatPlaceMismatch, () => {
	it("should write what the guard writes, so a fake task can stand in for one", () => {
		expect.assertions(1);

		expect(formatPlaceMismatch(118)).toBe("ROBLOX_RUNNER_PLACE_MISMATCH:118");
	});
});

describe(readRefusedPlaceVersion, () => {
	it("should read the version a refusal names", () => {
		expect.assertions(1);

		// Against the literal, not against formatPlaceMismatch: a reader checked
		// only against its own writer agrees with it through any drift.
		expect(readRefusedPlaceVersion("ROBLOX_RUNNER_PLACE_MISMATCH:118")).toBe(118);
	});

	it.for<[string, string | undefined]>([
		["a missing output", undefined],
		["an unrelated output", "all tests passed"],
		["the sentinel with no version", "ROBLOX_RUNNER_PLACE_MISMATCH"],
		["a non-numeric version", "ROBLOX_RUNNER_PLACE_MISMATCH:head"],
		["trailing text", "ROBLOX_RUNNER_PLACE_MISMATCH:118 and more"],
		["leading text", "ran: ROBLOX_RUNNER_PLACE_MISMATCH:118"],
	])("should not read a version from %s", ([, output]) => {
		expect.assertions(1);

		expect(readRefusedPlaceVersion(output)).toBeUndefined();
	});
});
