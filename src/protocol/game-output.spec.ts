import { type } from "arktype";
import { describe, expect, it } from "vitest";

import { gameOutputEntriesSchema } from "./game-output.ts";

describe("gameOutputEntriesSchema", () => {
	it("should decode a captured message list", () => {
		expect.assertions(1);

		const entries = [{ message: "hi", messageType: 0, timestamp: 1 }];

		expect(gameOutputEntriesSchema(entries)).toStrictEqual(entries);
	});

	it("should reject an entry with no message type", () => {
		expect.assertions(1);

		expect(gameOutputEntriesSchema([{ message: "hi", timestamp: 1 }])).toBeInstanceOf(
			type.errors,
		);
	});
});
