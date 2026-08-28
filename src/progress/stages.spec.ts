import { Buffer } from "node:buffer";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";

import { describePlaceFile, describeProjectCount } from "./stages.ts";

/** Writes a file of exactly `bytes` and returns its path, cleaning up after. */
function makePlaceFile(bytes: number): string {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jest-roblox-stage-"));
	onTestFinished(() => {
		fs.rmSync(directory, { force: true, recursive: true });
	});

	const placeFilePath = path.join(directory, "game.rbxl");
	fs.writeFileSync(placeFilePath, Buffer.alloc(bytes));
	return placeFilePath;
}

describe(describePlaceFile, () => {
	it("should report a place under a kilobyte in whole bytes", () => {
		expect.assertions(1);

		expect(describePlaceFile(makePlaceFile(512))).toBe("512 B");
	});

	it("should report a kilobyte-scale place to one decimal", () => {
		expect.assertions(1);

		expect(describePlaceFile(makePlaceFile(1536))).toBe("1.5 KB");
	});

	it("should report a megabyte-scale place to one decimal", () => {
		expect.assertions(1);

		expect(describePlaceFile(makePlaceFile(13_002_342))).toBe("12.4 MB");
	});

	it("should turn over to kilobytes at exactly one kilobyte", () => {
		expect.assertions(2);

		expect(describePlaceFile(makePlaceFile(1023))).toBe("1023 B");
		expect(describePlaceFile(makePlaceFile(1024))).toBe("1.0 KB");
	});

	it("should turn over to megabytes at exactly one megabyte", () => {
		expect.assertions(2);

		expect(describePlaceFile(makePlaceFile(1_048_575))).toBe("1024.0 KB");
		expect(describePlaceFile(makePlaceFile(1_048_576))).toBe("1.0 MB");
	});

	it("should report nothing for a place that cannot be read", () => {
		expect.assertions(1);

		expect(describePlaceFile(path.join(os.tmpdir(), "no-such-place.rbxl"))).toBeUndefined();
	});
});

describe(describeProjectCount, () => {
	it("should say a lone project in the singular", () => {
		expect.assertions(1);

		expect(describeProjectCount(1)).toBe("1 project");
	});

	it("should count several projects in the plural", () => {
		expect.assertions(1);

		expect(describeProjectCount(42)).toBe("42 projects");
	});

	it("should count no projects in the plural", () => {
		expect.assertions(1);

		expect(describeProjectCount(0)).toBe("0 projects");
	});
});
