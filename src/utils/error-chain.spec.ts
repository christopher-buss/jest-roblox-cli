import { describe, expect, it } from "vitest";

import { walkErrorChain } from "./error-chain.ts";

describe(walkErrorChain, () => {
	it("should return a single entry with name and message for a bare Error", () => {
		expect.assertions(2);

		const entries = walkErrorChain(new Error("something broke"));

		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({ name: "Error", message: "something broke" });
	});

	it("should return an empty array when given a non-Error input", () => {
		expect.assertions(1);

		expect(walkErrorChain(undefined)).toStrictEqual([]);
	});

	it("should treat null code/errno/syscall as absent on the entry", () => {
		expect.assertions(3);

		const cause = Object.assign(new Error("nulls everywhere"), {
			code: null,
			errno: null,
			syscall: null,
		});

		const [entry] = walkErrorChain(cause);

		expect(entry?.code).toBeUndefined();
		expect(entry?.errno).toBeUndefined();
		expect(entry?.syscall).toBeUndefined();
	});

	it("should walk Error.cause and emit entries in nest order", () => {
		expect.assertions(3);

		const inner = new Error("inner failure");
		const outer = new Error("outer wrapper", { cause: inner });

		const entries = walkErrorChain(outer);

		expect(entries).toHaveLength(2);
		expect(entries[0]).toMatchObject({ name: "Error", message: "outer wrapper" });
		expect(entries[1]).toMatchObject({ name: "Error", message: "inner failure" });
	});

	it("should capture node-style code, errno, and syscall on each entry", () => {
		expect.assertions(1);

		const cause = Object.assign(new Error("connect ECONNRESET 1.2.3.4:443"), {
			code: "ECONNRESET",
			errno: -54,
			syscall: "connect",
		});

		const [entry] = walkErrorChain(cause);

		expect(entry).toMatchObject({
			name: "Error",
			code: "ECONNRESET",
			errno: "-54",
			message: "connect ECONNRESET 1.2.3.4:443",
			syscall: "connect",
		});
	});

	it("should cap output at five entries when the cause chain runs deeper", () => {
		expect.assertions(3);

		let chain: Error = new Error("level 0");
		for (let level = 1; level <= 6; level += 1) {
			chain = new Error(`level ${level.toString()}`, { cause: chain });
		}

		const entries = walkErrorChain(chain);

		expect(entries).toHaveLength(5);
		expect(entries[0]).toMatchObject({ message: "level 6" });
		expect(entries[4]).toMatchObject({ message: "level 2" });
	});

	it("should terminate at the first non-Error link mid-chain", () => {
		expect.assertions(1);

		const middle = new Error("middle", { cause: "raw-string-cause" });
		const outer = new Error("outer", { cause: middle });

		const entries = walkErrorChain(outer);

		expect(entries.map((entry) => entry.message)).toStrictEqual(["outer", "middle"]);
	});
});
