import { Buffer } from "node:buffer";
import * as cp from "node:child_process";
import { describe, expect, it, vi } from "vitest";

import { buildWithRojo } from "./rojo-builder.ts";

vi.mock(import("node:child_process"));

describe(buildWithRojo, () => {
	it("should invoke rojo build with the project path and output path", () => {
		expect.assertions(1);

		vi.mocked(cp.execFileSync).mockReturnValue("");

		buildWithRojo("my.project.json", "output/game.rbxl");

		expect(vi.mocked(cp.execFileSync)).toHaveBeenCalledWith(
			"rojo",
			["build", "my.project.json", "-o", "output/game.rbxl"],
			expect.objectContaining({ stdio: "pipe" }),
		);
	});

	it("should throw a friendly error when rojo is not found on PATH", () => {
		expect.assertions(1);

		const enoentError = Object.assign(new Error("spawn rojo ENOENT"), {
			code: "ENOENT",
		});
		vi.mocked(cp.execFileSync).mockImplementation(() => {
			throw enoentError;
		});

		expect(() => {
			buildWithRojo("my.project.json", "output/game.rbxl");
		}).toThrowWithMessage(Error, "rojo is required for --coverage but was not found on PATH");
	});

	it("should include stderr content in error message when rojo build fails", () => {
		expect.assertions(1);

		const stderrError = Object.assign(new Error("rojo exited with code 1"), {
			stderr: Buffer.from("Found an error in project at path node.project.json"),
		});
		vi.mocked(cp.execFileSync).mockImplementation(() => {
			throw stderrError;
		});

		expect(() => {
			buildWithRojo("my.project.json", "output/game.rbxl");
		}).toThrow(/Found an error in project at path node\.project\.json/);
	});

	it("should propagate other rojo errors with context", () => {
		expect.assertions(2);

		const originalError = new Error("rojo exited with code 1");
		vi.mocked(cp.execFileSync).mockImplementation(() => {
			throw originalError;
		});

		function act() {
			buildWithRojo("my.project.json", "output/game.rbxl");
		}

		expect(act).toThrowWithMessage(Error, "rojo build failed");
		expect(act).toThrow(expect.objectContaining({ cause: originalError }) as Error);
	});
});
