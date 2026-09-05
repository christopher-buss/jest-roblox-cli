import { fromAny } from "@total-typescript/shoehorn";

import { describe, expect, it, vi } from "vitest";

import type { ChildProcessRunner } from "./child-process.ts";
import { buildWithRojoAsync } from "./rojo-builder.ts";

type ExecCallback = (cause: Error | null, stdout: string, stderr: string) => void;

/**
 * A launcher that settles the way the real `execFile` does: the error carries
 * no output of its own, and stderr arrives as the callback's own argument.
 *
 * @param cause - What the child failed with, or `null` for a clean exit.
 * @param stderr - What the child wrote to stderr.
 */
function answeringWith(cause: Error | null, stderr = ""): ChildProcessRunner {
	return fromAny({
		execFile: vi.fn<
			(file: string, args: Array<string>, options: object, callback: ExecCallback) => void
		>((_file, _args, _options, callback) => {
			callback(cause, "", stderr);
		}),
	});
}

describe(buildWithRojoAsync, () => {
	it("should invoke rojo build with the project path and output path", async () => {
		expect.assertions(1);

		const childProcess = answeringWith(null);

		await buildWithRojoAsync("my.project.json", "output/game.rbxl", childProcess);

		expect(childProcess.execFile).toHaveBeenCalledWith(
			"rojo",
			["build", "my.project.json", "-o", "output/game.rbxl"],
			{ windowsHide: true },
			expect.any(Function),
		);
	});

	it("should throw a friendly error when rojo is not found on PATH", async () => {
		expect.assertions(1);

		const childProcess = answeringWith(
			Object.assign(new Error("spawn rojo ENOENT"), { code: "ENOENT" }),
		);

		await expect(
			buildWithRojoAsync("my.project.json", "output/game.rbxl", childProcess),
		).rejects.toThrowWithMessage(Error, "rojo was not found on PATH");
	});

	it("should report what the failed child wrote to stderr", async () => {
		expect.assertions(1);

		const childProcess = answeringWith(
			Object.assign(new Error("rojo exited with code 1"), { code: "EPERM" }),
			"  Found an error in project at path node.project.json\n",
		);

		await expect(
			buildWithRojoAsync("my.project.json", "output/game.rbxl", childProcess),
		).rejects.toThrowWithMessage(
			Error,
			"rojo build failed: Found an error in project at path node.project.json",
		);
	});

	it("should use the generic message when the child wrote no stderr", async () => {
		expect.assertions(1);

		const childProcess = answeringWith(new Error("rojo exited with code 1"));

		await expect(
			buildWithRojoAsync("my.project.json", "output/game.rbxl", childProcess),
		).rejects.toThrowWithMessage(Error, "rojo build failed");
	});

	it("should propagate other rojo errors with context", async () => {
		expect.assertions(2);

		const originalError = new Error("rojo exited with code 1");
		const childProcess = answeringWith(originalError);

		await expect(
			buildWithRojoAsync("my.project.json", "output/game.rbxl", childProcess),
		).rejects.toThrowWithMessage(Error, "rojo build failed");
		await expect(
			buildWithRojoAsync("my.project.json", "output/game.rbxl", childProcess),
		).rejects.toThrow(expect.objectContaining({ cause: originalError }));
	});
});
