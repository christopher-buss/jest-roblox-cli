import { describe, expect, it } from "vitest";

import { getTerminalWidth, readTerminalColumns } from "./width.ts";

describe(getTerminalWidth, () => {
	it("should read the stream column count", () => {
		expect.assertions(1);

		expect(getTerminalWidth({ columns: 120 })).toBe(120);
	});

	it("should default to 80 columns when the stream reports none", () => {
		expect.assertions(2);

		expect(getTerminalWidth({ columns: 0 })).toBe(80);
		expect(getTerminalWidth({})).toBe(80);
	});
});

describe(readTerminalColumns, () => {
	it("should prefer the stream column count", () => {
		expect.assertions(1);

		expect(
			readTerminalColumns({ environment: { COLUMNS: "200" }, stream: { columns: 120 } }),
		).toBe(120);
	});

	it("should fall back to a positive COLUMNS", () => {
		expect.assertions(1);

		expect(readTerminalColumns({ environment: { COLUMNS: "200" }, stream: {} })).toBe(200);
	});

	it.for(["", "0", "-5", "abc"])("should ignore COLUMNS %j", (columns) => {
		expect.assertions(1);

		expect(
			readTerminalColumns({ environment: { COLUMNS: columns }, stream: {} }),
		).toBeUndefined();
	});
});
