import { fromAny } from "@total-typescript/shoehorn";

import { vol } from "memfs";
import { Buffer } from "node:buffer";
import * as fs from "node:fs";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { atomicWrite } from "./atomic-write.ts";

vi.mock(import("node:fs"), async () => {
	const memfs = await vi.importActual<typeof import("memfs")>("memfs");
	return fromAny({ ...memfs.fs, default: memfs.fs });
});

/**
 * Stands in for the rename primitive: throws the `EPERM` Windows raises while a
 * scanner holds the fresh temp file, for the first `failures` calls, then hands
 * off to the real one. `restoreMocks` puts the original back after each test.
 *
 * @param failures - How many attempts to refuse before letting one through.
 */
function failRenameTimes(failures: number): void {
	const realRename = fs.renameSync;
	let remaining = failures;
	vi.spyOn(fs, "renameSync").mockImplementation((sourcePath, targetPath) => {
		remaining -= 1;
		if (remaining >= 0) {
			throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
		}

		realRename(sourcePath, targetPath);
	});
}

describe(atomicWrite, () => {
	it("should write contents to the target path", () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		atomicWrite("/coverage/manifest.json", "hello");

		expect(vol.readFileSync("/coverage/manifest.json", "utf-8")).toBe("hello");
	});

	it("should create missing parent directories before writing", () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		atomicWrite("/nested/deep/coverage/manifest.json", "hello");

		expect(vol.existsSync("/nested/deep/coverage/manifest.json")).toBeTrue();
	});

	it("should accept Buffer contents", () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		atomicWrite("/coverage/place.rbxl", Buffer.from([0x00, 0x01, 0x02]));

		expect(vol.readFileSync("/coverage/place.rbxl")).toStrictEqual(
			Buffer.from([0x00, 0x01, 0x02]),
		);
	});

	it("should land the write when the first rename attempts fail", () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		failRenameTimes(2);

		atomicWrite("/coverage/manifest.json", "hello");

		expect(vol.readFileSync("/coverage/manifest.json", "utf-8")).toBe("hello");
	});

	it("should replace an existing target on the last retry left", () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		vol.fromJSON({ "/coverage/manifest.json": "old" });
		failRenameTimes(4);

		atomicWrite("/coverage/manifest.json", "new");

		expect(vol.readFileSync("/coverage/manifest.json", "utf-8")).toBe("new");
	});

	it("should leave no file at the target path once the rename attempts are spent", () => {
		expect.assertions(2);

		onTestFinished(() => {
			vol.reset();
		});

		failRenameTimes(5);

		expect(() => {
			atomicWrite("/coverage/manifest.json", "hello");
		}).toThrow("EPERM");
		expect(vol.existsSync("/coverage/manifest.json")).toBeFalse();
	});

	it("should normalize a non-Error rename failure", () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		vi.spyOn(fs, "renameSync").mockImplementation(() => {
			// eslint-disable-next-line ts/only-throw-error -- exercises the non-Error normalization branch
			throw "disk gone";
		});

		expect(() => {
			atomicWrite("/coverage/manifest.json", "hello");
		}).toThrow("disk gone");
	});

	it("should pause between rename attempts but not before the first", () => {
		expect.assertions(2);

		onTestFinished(() => {
			vol.reset();
		});

		const waitSpy = vi.spyOn(Atomics, "wait");
		failRenameTimes(2);

		atomicWrite("/coverage/manifest.json", "hello");

		expect(vol.readFileSync("/coverage/manifest.json", "utf-8")).toBe("hello");
		expect(waitSpy.mock.calls.map((call) => call[3])).toStrictEqual([2, 2]);
	});
});
