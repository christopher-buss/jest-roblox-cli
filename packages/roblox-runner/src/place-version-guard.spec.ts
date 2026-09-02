import { describe, expect, it } from "vitest";

import {
	formatPlaceVersionRefusal,
	placeVersionGuardSource,
	readRefusedPlaceVersion,
} from "./place-version-guard.ts";

describe(placeVersionGuardSource, () => {
	it("should emit the wire format the reader accepts", () => {
		expect.assertions(1);

		// Locked to the literal, because this line and readRefusedPlaceVersion
		// are the two halves of one wire format: changing either alone breaks
		// every task that boots the wrong build.
		expect(placeVersionGuardSource(42)).toBe(
			'if game.PlaceVersion ~= 42 then return "ROBLOX_RUNNER_PLACE_VERSION_MISMATCH:" .. tostring(game.PlaceVersion) end',
		);
	});

	it("should stay one statement, so a caller may splice it anywhere", () => {
		expect.assertions(1);

		expect(placeVersionGuardSource(7)).not.toContain("\n");
	});
});

describe(formatPlaceVersionRefusal, () => {
	it("should write what the guard writes, so a fake task can stand in for one", () => {
		expect.assertions(1);

		expect(formatPlaceVersionRefusal(118)).toBe("ROBLOX_RUNNER_PLACE_VERSION_MISMATCH:118");
	});
});

describe(readRefusedPlaceVersion, () => {
	it("should read the version a refusal names", () => {
		expect.assertions(1);

		// Against the literal, not against formatPlaceVersionRefusal: a reader
		// checked only against its own writer agrees with it through any drift.
		expect(readRefusedPlaceVersion("ROBLOX_RUNNER_PLACE_VERSION_MISMATCH:118")).toBe(118);
	});

	it.for<[string, string | undefined]>([
		["a missing output", undefined],
		["an unrelated output", "all tests passed"],
		["the sentinel with no version", "ROBLOX_RUNNER_PLACE_VERSION_MISMATCH"],
		["a non-numeric version", "ROBLOX_RUNNER_PLACE_VERSION_MISMATCH:head"],
		["trailing text", "ROBLOX_RUNNER_PLACE_VERSION_MISMATCH:118 and more"],
		["leading text", "ran: ROBLOX_RUNNER_PLACE_VERSION_MISMATCH:118"],
	])("should not read a version from %s", ([, output]) => {
		expect.assertions(1);

		expect(readRefusedPlaceVersion(output)).toBeUndefined();
	});
});
