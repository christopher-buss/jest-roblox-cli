import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";

import { hashBuffer } from "./hash.ts";

describe(hashBuffer, () => {
	it("should return consistent SHA256 hash for same input", () => {
		expect.assertions(2);

		const data = Buffer.from("test data");
		const hash1 = hashBuffer(data);
		const hash2 = hashBuffer(data);

		expect(hash1).toBe(hash2);
		expect(hash1).toHaveLength(64);
	});

	it("should return different hash for different input", () => {
		expect.assertions(1);

		const hash1 = hashBuffer(Buffer.from("data1"));
		const hash2 = hashBuffer(Buffer.from("data2"));

		expect(hash1).not.toBe(hash2);
	});

	it("should return hex string", () => {
		expect.assertions(1);

		const hash = hashBuffer(Buffer.from("test"));

		expect(hash).toMatch(/^[0-9a-f]{64}$/);
	});
});
