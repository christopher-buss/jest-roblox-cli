import { fromAny } from "@total-typescript/shoehorn";

import * as cp from "node:child_process";
import { describe, expect, it, vi } from "vitest";

import { buildWithRojoAsync } from "./rojo-builder.ts";

vi.mock(import("node:child_process"));

type ExecCallback = (cause: Error | null, stdout: string, stderr: string) => void;

/**
 * Settles the mocked `execFile` the way the real one does: the error carries no
 * output of its own, and stderr arrives as the callback's own argument.
 */
function answerWith(cause: Error | null, stderr = ""): void {
	vi.mocked(cp.execFile).mockImplementation(
		fromAny((_file: string, _args: Array<string>, _options: object, callback: ExecCallback) => {
			callback(cause, "", stderr);
		}),
	);
}

describe(buildWithRojoAsync, () => {
	it("should invoke rojo build with the project path and output path", async () => {
		expect.assertions(1);

		answerWith(null);

		await buildWithRojoAsync("my.project.json", "output/game.rbxl");

		expect(vi.mocked(cp.execFile)).toHaveBeenCalledWith(
			"rojo",
			["build", "my.project.json", "-o", "output/game.rbxl"],
			{ windowsHide: true },
			expect.any(Function),
		);
	});

	it("should throw a friendly error when rojo is not found on PATH", async () => {
		expect.assertions(1);

		answerWith(Object.assign(new Error("spawn rojo ENOENT"), { code: "ENOENT" }));

		await expect(
			buildWithRojoAsync("my.project.json", "output/game.rbxl"),
		).rejects.toThrowWithMessage(Error, "rojo was not found on PATH");
	});

	it("should report what the failed child wrote to stderr", async () => {
		expect.assertions(1);

		answerWith(
			Object.assign(new Error("rojo exited with code 1"), { code: "EPERM" }),
			"  Found an error in project at path node.project.json\n",
		);

		await expect(
			buildWithRojoAsync("my.project.json", "output/game.rbxl"),
		).rejects.toThrowWithMessage(
			Error,
			"rojo build failed: Found an error in project at path node.project.json",
		);
	});

	it("should use the generic message when the child wrote no stderr", async () => {
		expect.assertions(1);

		answerWith(new Error("rojo exited with code 1"));

		await expect(
			buildWithRojoAsync("my.project.json", "output/game.rbxl"),
		).rejects.toThrowWithMessage(Error, "rojo build failed");
	});

	it("should propagate other rojo errors with context", async () => {
		expect.assertions(2);

		const originalError = new Error("rojo exited with code 1");
		answerWith(originalError);

		await expect(
			buildWithRojoAsync("my.project.json", "output/game.rbxl"),
		).rejects.toThrowWithMessage(Error, "rojo build failed");
		await expect(buildWithRojoAsync("my.project.json", "output/game.rbxl")).rejects.toThrow(
			expect.objectContaining({ cause: originalError }),
		);
	});
});
