import cp from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { describe, expect, it, vi } from "vitest";

import { spawnLute, writeTemporaryLuauScript } from "./lute-spawner.ts";

vi.mock(import("node:child_process"));
vi.mock(import("node:fs"));
vi.mock(import("node:os"));

describe(spawnLute, () => {
	it("should return stdout on successful execution", () => {
		expect.assertions(2);

		vi.mocked(cp.execFileSync).mockReturnValue("output data");

		const result = spawnLute({
			args: ["arg1", "arg2"],
			scriptPath: "/tmp/script.luau",
		});

		expect(result).toBe("output data");
		expect(cp.execFileSync).toHaveBeenCalledWith(
			"lute",
			["run", "/tmp/script.luau", "--", "arg1", "arg2"],
			{
				encoding: "utf-8",
				maxBuffer: 1024 * 1024,
				timeout: 30_000,
			},
		);
	});

	it("should throw helpful message when lute is not found (ENOENT)", () => {
		expect.assertions(1);

		const error = new Error("spawn lute ENOENT");
		Object.assign(error, { code: "ENOENT" });
		vi.mocked(cp.execFileSync).mockImplementation(() => {
			throw error;
		});

		expect(() => spawnLute({ args: [], scriptPath: "/tmp/script.luau" })).toThrow(
			"lute is required but was not found on PATH",
		);
	});

	it("should re-throw non-ENOENT errors", () => {
		expect.assertions(1);

		const error = new Error("some other error");
		vi.mocked(cp.execFileSync).mockImplementation(() => {
			throw error;
		});

		expect(() => spawnLute({ args: [], scriptPath: "/tmp/script.luau" })).toThrow(error);
	});

	it("should pass custom maxBuffer and timeout", () => {
		expect.assertions(1);

		vi.mocked(cp.execFileSync).mockReturnValue("");

		spawnLute({
			args: ["x"],
			maxBuffer: 5 * 1024 * 1024,
			scriptPath: "/tmp/script.luau",
			timeout: 60_000,
		});

		expect(cp.execFileSync).toHaveBeenCalledWith(
			"lute",
			["run", "/tmp/script.luau", "--", "x"],
			{
				encoding: "utf-8",
				maxBuffer: 5 * 1024 * 1024,
				timeout: 60_000,
			},
		);
	});
});

describe(writeTemporaryLuauScript, () => {
	it("should create directory, write file, and return path", () => {
		expect.assertions(3);

		vi.mocked(os.tmpdir).mockReturnValue("/tmp");

		const result = writeTemporaryLuauScript("print('hello')", "test-script");

		expect(fs.mkdirSync).toHaveBeenCalledWith(expect.stringContaining("luau-ast"), {
			recursive: true,
		});
		expect(fs.writeFileSync).toHaveBeenCalledWith(
			expect.stringContaining("test-script.luau"),
			"print('hello')",
		);
		expect(result).toMatch(/test-script\.luau$/);
	});
});
