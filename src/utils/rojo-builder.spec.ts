import { fromAny } from "@total-typescript/shoehorn";

import { describe, it, vi } from "vitest";

import type { ChildProcessRunner } from "./child-process.ts";
import { buildWithRojoAsync } from "./rojo-builder.ts";

type ExecCallback = (cause: Error | null, stdout: string, stderr: string) => void;

function answeringWith(cause: Error | null, stderr = ""): ChildProcessRunner {
	return fromAny({
		execFile: vi.fn<
			(file: string, args: Array<string>, options: object, callback: ExecCallback) => void
		>((...args) => {
			args[3](cause, "", stderr);
		}),
	});
}

describe(buildWithRojoAsync, () => {
	it("should invoke rojo build with the project path and output path", async ({ expect }) => {
		expect.assertions(1);

		const childProcess = answeringWith(null);

		await buildWithRojoAsync({
			childProcess,
			outputPath: "output/game.rbxl",
			projectPath: "my.project.json",
		});

		expect(childProcess.execFile).toHaveBeenCalledWith(
			"rojo",
			["build", "my.project.json", "-o", "output/game.rbxl"],
			{ windowsHide: true },
			expect.any(Function),
		);
	});

	it("should throw a friendly error when rojo is not found on PATH", async ({ expect }) => {
		expect.assertions(1);

		const childProcess = answeringWith(
			Object.assign(new Error("spawn rojo ENOENT"), { code: "ENOENT" }),
		);

		await expect(
			buildWithRojoAsync({
				childProcess,
				outputPath: "output/game.rbxl",
				projectPath: "my.project.json",
			}),
		).rejects.toThrowWithMessage(Error, "rojo was not found on PATH");
	});

	it("should report what the failed child wrote to stderr", async ({ expect }) => {
		expect.assertions(1);

		const childProcess = answeringWith(
			Object.assign(new Error("rojo exited with code 1"), { code: "EPERM" }),
			"  Found an error in project at path node.project.json\n",
		);

		await expect(
			buildWithRojoAsync({
				childProcess,
				outputPath: "output/game.rbxl",
				projectPath: "my.project.json",
			}),
		).rejects.toThrowWithMessage(
			Error,
			"rojo build failed: Found an error in project at path node.project.json",
		);
	});

	it("should use the generic message when the child wrote no stderr", async ({ expect }) => {
		expect.assertions(1);

		const childProcess = answeringWith(new Error("rojo exited with code 1"));

		await expect(
			buildWithRojoAsync({
				childProcess,
				outputPath: "output/game.rbxl",
				projectPath: "my.project.json",
			}),
		).rejects.toThrowWithMessage(Error, "rojo build failed");
	});

	it("should propagate other rojo errors with context", async ({ expect }) => {
		expect.assertions(2);

		const originalError = new Error("rojo exited with code 1");
		const childProcess = answeringWith(originalError);

		await expect(
			buildWithRojoAsync({
				childProcess,
				outputPath: "output/game.rbxl",
				projectPath: "my.project.json",
			}),
		).rejects.toThrowWithMessage(Error, "rojo build failed");
		await expect(
			buildWithRojoAsync({
				childProcess,
				outputPath: "output/game.rbxl",
				projectPath: "my.project.json",
			}),
		).rejects.toThrow(expect.objectContaining({ cause: originalError }));
	});
});
