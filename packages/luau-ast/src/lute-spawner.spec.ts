import { fromPartial } from "@total-typescript/shoehorn";

import path from "node:path";
import process from "node:process";
import { describe, expect, it, vi } from "vitest";

import { spawnLute, writeTemporaryLuauScript } from "./lute-spawner.ts";

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

	it("should rethrow a non-Error process failure unchanged", () => {
		expect.assertions(1);

		const failure = Object.assign(new Error("process failure"), { code: "ENOENT" });
		Object.setPrototypeOf(failure, Object.prototype);
		const execute = vi.fn<NonNullable<Parameters<typeof spawnLute>[1]>>(() => {
			throw failure;
		});

		expect(() => spawnLute({ args: [], scriptPath: "script.luau" }, execute)).toThrow(
			"process failure",
		);
	});

	it("should include the install URL in the missing-Lute diagnostic", () => {
		expect.assertions(1);

		const execute = vi.fn<NonNullable<Parameters<typeof spawnLute>[1]>>(() => {
			throw Object.assign(new Error("missing"), { code: "ENOENT" });
		});

		expect(() => spawnLute({ args: [], scriptPath: "script.luau" }, execute)).toThrow(
			"lute is required but was not found on PATH. Install it from https://github.com/luau-lang/lute",
		);
	});
});

describe(writeTemporaryLuauScript, () => {
	it("should write a process-specific script after creating its directory", () => {
		expect.assertions(4);

		const calls: Array<unknown> = [];
		const mkdir = vi.fn<(...args: Array<unknown>) => void>((...args) => {
			calls.push(args);
		});
		const write = vi.fn<(...args: Array<unknown>) => void>((...args) => {
			calls.push(args);
		});
		const files = fromPartial<NonNullable<Parameters<typeof writeTemporaryLuauScript>[1]>>({
			mkdirSync: mkdir,
			writeFileSync: write,
		});

		const script = writeTemporaryLuauScript({ name: "worker", source: "return 7" }, files);

		expect(path.basename(script)).toBe(`worker.${String(process.pid)}.luau`);
		expect(path.basename(path.dirname(script))).toBe("luau-ast");
		expect(path.isAbsolute(script)).toBeTrue();
		expect(calls).toStrictEqual([
			[path.dirname(script), { recursive: true }],
			[script, "return 7"],
		]);
	});
});

describe("process error codes", () => {
	it.for(["EACCES", "ETIMEDOUT"])("should preserve a process failure with code %s", (code) => {
		expect.assertions(1);

		const failure = Object.assign(new Error("process denied"), { code });
		const execute = vi.fn<NonNullable<Parameters<typeof spawnLute>[1]>>(() => {
			throw failure;
		});

		expect(() => spawnLute({ args: [], scriptPath: "script.luau" }, execute)).toThrow(failure);
	});
});
