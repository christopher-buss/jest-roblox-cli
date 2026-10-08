import { describe, expect, it, vi } from "vitest";

import { spawnLute } from "./lute-spawner.ts";

describe(spawnLute, () => {
	it("should return stdout on successful execution", () => {
		expect.assertions(2);

		const execute = vi
			.fn<NonNullable<Parameters<typeof spawnLute>[1]>>()
			.mockReturnValue("output data");
		const result = spawnLute(
			{ args: ["arg1", "arg2"], scriptPath: "/tmp/script.luau" },
			execute,
		);

		expect(result).toBe("output data");
		expect(execute).toHaveBeenCalledWith(
			"lute",
			["run", "/tmp/script.luau", "--", "arg1", "arg2"],
			{
				encoding: "utf-8",
				maxBuffer: 1024 * 1024,
				timeout: 30_000,
				windowsHide: true,
			},
		);
	});

	it("should throw helpful message when lute is not found (ENOENT)", () => {
		expect.assertions(1);

		const error = Object.assign(new Error("spawn lute ENOENT"), { code: "ENOENT" });
		const execute = vi.fn<NonNullable<Parameters<typeof spawnLute>[1]>>(() => {
			throw error;
		});

		expect(() => spawnLute({ args: [], scriptPath: "/tmp/script.luau" }, execute)).toThrow(
			"lute is required but was not found on PATH",
		);
	});

	it("should re-throw non-ENOENT errors", () => {
		expect.assertions(1);

		const error = new Error("some other error");
		const execute = vi.fn<NonNullable<Parameters<typeof spawnLute>[1]>>(() => {
			throw error;
		});

		expect(() => spawnLute({ args: [], scriptPath: "/tmp/script.luau" }, execute)).toThrow(
			error,
		);
	});

	it("should pass custom maxBuffer and timeout", () => {
		expect.assertions(1);

		const execute = vi.fn<NonNullable<Parameters<typeof spawnLute>[1]>>().mockReturnValue("");
		spawnLute(
			{
				args: ["x"],
				maxBuffer: 5 * 1024 * 1024,
				scriptPath: "/tmp/script.luau",
				timeout: 60_000,
			},
			execute,
		);

		expect(execute).toHaveBeenCalledWith("lute", ["run", "/tmp/script.luau", "--", "x"], {
			encoding: "utf-8",
			maxBuffer: 5 * 1024 * 1024,
			timeout: 60_000,
			windowsHide: true,
		});
	});
});
