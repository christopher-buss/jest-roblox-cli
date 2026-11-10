import { describe, expect, it } from "vitest";

import { formatBytes } from "./bytes.ts";

describe(formatBytes, () => {
	it("should give whole bytes under a kilobyte", () => {
		expect.assertions(1);

		expect(formatBytes(1023)).toBe("1023 B");
	});

	it("should give kilobytes with one decimal up to a megabyte", () => {
		expect.assertions(2);

		expect(formatBytes(1024)).toBe("1.0 KB");
		expect(formatBytes(1_048_575)).toBe("1024.0 KB");
	});

	it("should give megabytes from a megabyte on", () => {
		expect.assertions(1);

		expect(formatBytes(1_048_576)).toBe("1.0 MB");
	});
});
