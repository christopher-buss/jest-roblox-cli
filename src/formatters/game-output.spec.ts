import { describe, expect, it } from "vitest";

import { createTaggedStyles } from "#test/mocks/format-tagged-styles.ts";
import { formatGameOutputBlock } from "./game-output.ts";

describe(formatGameOutputBlock, () => {
	it("should return no lines when the package printed nothing", () => {
		expect.assertions(1);

		expect(formatGameOutputBlock([], createTaggedStyles())).toStrictEqual([]);
	});

	it("should paint warnings as pending, errors as failures, and split multiline messages", () => {
		expect.assertions(1);

		expect(
			formatGameOutputBlock(
				[
					{ message: "info", messageType: 0, timestamp: 0 },
					{ message: "careful", messageType: 2, timestamp: 1 },
					{ message: "boom\ntrace", messageType: 3, timestamp: 2 },
				],
				createTaggedStyles(),
			),
		).toStrictEqual([
			"  <dim>Game output:</dim>",
			"    info",
			"    <pending>careful</pending>",
			"    <fail>boom</fail>",
			"    <fail>trace</fail>",
		]);
	});
});
