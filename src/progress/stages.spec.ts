import { Buffer } from "node:buffer";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { describePlaceFile, describeProjectCount, LAST_STAGE, STAGE_IDS } from "./stages.ts";

describe("the stage the block settles on", () => {
	it("should be the last stage a run passes through", () => {
		expect.assertions(1);

		// The block settles here, so a stage listed after it would open onto a
		// terminal the reporter has already handed back and render nothing.
		expect(STAGE_IDS.at(-1)).toBe(LAST_STAGE);
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

function makePlaceFile(bytes: number): Parameters<typeof describePlaceFile> {
	const { fileSystem } = createMemoryFileSystem();
	const placeFilePath = path.resolve("game.rbxl");
	fileSystem.mkdirSync(path.dirname(placeFilePath), { recursive: true });
	fileSystem.writeFileSync(placeFilePath, Buffer.alloc(bytes));
	return [placeFilePath, fileSystem];
}

describe(describePlaceFile, () => {
	it("should report a place under a kilobyte in whole bytes", () => {
		expect.assertions(1);

		expect(describePlaceFile(...makePlaceFile(512))).toBe("512 B");
	});

	it("should report a kilobyte-scale place to one decimal", () => {
		expect.assertions(1);

		expect(describePlaceFile(...makePlaceFile(1536))).toBe("1.5 KB");
	});

	it("should report a megabyte-scale place to one decimal", () => {
		expect.assertions(1);

		expect(describePlaceFile(...makePlaceFile(13_002_342))).toBe("12.4 MB");
	});

	it("should turn over to kilobytes at exactly one kilobyte", () => {
		expect.assertions(2);

		expect(describePlaceFile(...makePlaceFile(1023))).toBe("1023 B");
		expect(describePlaceFile(...makePlaceFile(1024))).toBe("1.0 KB");
	});

	it("should turn over to megabytes at exactly one megabyte", () => {
		expect.assertions(2);

		expect(describePlaceFile(...makePlaceFile(1_048_575))).toBe("1024.0 KB");
		expect(describePlaceFile(...makePlaceFile(1_048_576))).toBe("1.0 MB");
	});

	it("should report nothing for a place that cannot be read", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();

		expect(describePlaceFile(path.resolve("no-such-place.rbxl"), fileSystem)).toBeUndefined();
	});

	it("should stat a missing place without building an error", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();
		const stat = vi.spyOn(fileSystem, "statSync");
		const placeFilePath = path.resolve("no-such-place.rbxl");
		describePlaceFile(placeFilePath, fileSystem);

		expect(stat).toHaveBeenCalledExactlyOnceWith(placeFilePath, { throwIfNoEntry: false });
	});

	it("should report nothing for a place whose stat fails", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();
		vi.spyOn(fileSystem, "statSync").mockImplementation(() => {
			throw Object.assign(new Error("permission denied"), { code: "EACCES" });
		});

		expect(describePlaceFile(path.resolve("locked.rbxl"), fileSystem)).toBeUndefined();
	});
});
