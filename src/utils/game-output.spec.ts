import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";

import type { GameOutputEntry } from "../types/game-output.ts";
import { formatGameOutputNotice, parseGameOutput, writeGameOutput } from "./game-output.ts";

describe(parseGameOutput, () => {
	it("should parse valid JSON array of log entries", () => {
		expect.assertions(2);

		const entries: Array<GameOutputEntry> = [
			{ message: "Hello", messageType: 0, timestamp: 1000 },
			{ message: "Warning!", messageType: 1, timestamp: 1001 },
		];

		const result = parseGameOutput(JSON.stringify(entries));

		expect(result).toHaveLength(2);
		expect(result[0]!.message).toBe("Hello");
	});

	it("should return empty array for undefined input", () => {
		expect.assertions(1);

		const result = parseGameOutput(undefined);

		expect(result).toBeEmpty();
	});

	it("should return empty array for invalid JSON", () => {
		expect.assertions(1);

		const result = parseGameOutput("not json");

		expect(result).toBeEmpty();
	});

	it("should return empty array for empty array JSON", () => {
		expect.assertions(1);

		const result = parseGameOutput("[]");

		expect(result).toBeEmpty();
	});
});

describe(writeGameOutput, () => {
	const testDirectory = path.join(import.meta.dirname, "__test-output__");
	const testFile = path.join(testDirectory, "game-output.json");

	it("should write entries to file as JSON", () => {
		expect.assertions(1);

		const entries: Array<GameOutputEntry> = [
			{ message: "test", messageType: 0, timestamp: 1000 },
		];

		writeGameOutput(testFile, entries);

		onTestFinished(() => {
			fs.rmSync(testDirectory, { force: true, recursive: true });
		});

		const written = JSON.parse(fs.readFileSync(testFile, "utf-8"));

		expect(written).toStrictEqual(entries);
	});

	it("should write to existing directory without creating it", () => {
		expect.assertions(1);

		// First call creates the directory
		writeGameOutput(testFile, []);

		onTestFinished(() => {
			fs.rmSync(testDirectory, { force: true, recursive: true });
		});

		// Second call writes into the already-existing directory
		const entries: Array<GameOutputEntry> = [
			{ message: "second", messageType: 0, timestamp: 2000 },
		];

		writeGameOutput(testFile, entries);

		const written = JSON.parse(fs.readFileSync(testFile, "utf-8"));

		expect(written).toStrictEqual(entries);
	});

	it("should create parent directories", () => {
		expect.assertions(1);

		const nested = path.join(testDirectory, "nested", "game-output.json");
		writeGameOutput(nested, []);

		onTestFinished(() => {
			fs.rmSync(testDirectory, { force: true, recursive: true });
		});

		expect(fs.existsSync(nested)).toBeTrue();
	});
});

describe(formatGameOutputNotice, () => {
	it("should return notice with file path and entry count", () => {
		expect.assertions(2);

		const notice = formatGameOutputNotice("/tmp/output.json", 5);

		expect(notice).toContain("/tmp/output.json");
		expect(notice).toContain("5");
	});

	it("should return empty string for zero entries", () => {
		expect.assertions(1);

		const notice = formatGameOutputNotice("/tmp/output.json", 0);

		expect(notice).toBe("");
	});
});
