import { fromAny } from "@total-typescript/shoehorn";

import type * as childProcess from "node:child_process";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { ConfigError } from "../config/errors.ts";
import type { ChildProcessRunner } from "../utils/child-process.ts";
import { spawnLuauCheckAsync } from "./luau-check.ts";

type Callback = (error: Error | null, stdout: string, stderr: string) => void;

interface Invocation {
	args: Array<string>;
	command: string;
	options: { cwd?: string; timeout?: number };
}

function fakeRunner(respond: (callback: Callback) => void) {
	const invocations: Array<Invocation> = [];
	const child: childProcess.ChildProcess = fromAny({
		kill: vi.fn<() => void>(),
		once: vi.fn<() => void>(),
	});
	const execFile: typeof childProcess.execFile = fromAny(
		(
			...[command, args, options, callback]: [
				string,
				Array<string>,
				{ cwd?: string; timeout?: number },
				Callback,
			]
		) => {
			invocations.push({ args, command, options });
			respond(callback);
			return child;
		},
	);
	const runner: ChildProcessRunner = fromAny({ execFile });
	return { invocations, runner };
}

async function checkAsync(runner: ChildProcessRunner, files: Array<string>) {
	return spawnLuauCheckAsync({
		childProcess: runner,
		files,
		rootDir: "/project",
		runTimeout: 1234,
		spawnTimeout: 5000,
	});
}

describe(spawnLuauCheckAsync, () => {
	it("should run the checker on absolute paths with the run timeout", async () => {
		expect.assertions(4);

		const { invocations, runner } = fakeRunner((callback) => {
			callback(null, "", "");
		});

		await checkAsync(runner, ["src/a.spec-d.luau", "/abs/b.spec-d.luau"]);

		const [invocation] = invocations;

		expect(invocation!.args).toStrictEqual([
			"check",
			path.resolve("src/a.spec-d.luau"),
			"/abs/b.spec-d.luau",
		]);
		expect(invocation!.command).toMatch(/^lu/);
		expect(invocation!.options.timeout).toBe(1234);
		expect(invocation!.options.cwd).toBe("/project");
	});

	it("should resolve diagnostics from stdout on a non-zero exit", async () => {
		expect.assertions(1);

		const { runner } = fakeRunner((callback) => {
			callback(Object.assign(new Error("exit 1"), { code: 1 }), "diagnostics", "noise");
		});

		await expect(checkAsync(runner, ["/a.spec-d.luau"])).resolves.toBe("diagnostics");
	});

	it("should raise a ConfigError with an install hint when the checker is missing", async () => {
		expect.assertions(2);

		const { runner } = fakeRunner((callback) => {
			callback(Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }), "", "");
		});

		const error: unknown = await checkAsync(runner, ["/a.spec-d.luau"]).catch(
			(err: unknown) => err,
		);

		expect(error).toBeInstanceOf(ConfigError);
		expect(error).toMatchObject({ hint: expect.stringContaining("Install") });
	});

	it("should rethrow any other spawn failure", async () => {
		expect.assertions(2);

		const failure = Object.assign(new Error("spawn EACCES"), { code: "EACCES" });
		const { runner } = fakeRunner((callback) => {
			callback(failure, "", "");
		});

		const error: unknown = await checkAsync(runner, ["/a.spec-d.luau"]).catch(
			(err: unknown) => err,
		);

		expect(error).not.toBeInstanceOf(ConfigError);
		expect(error).toMatchObject({ cause: failure });
	});

	it("should report the checker by name when the run times out", async () => {
		expect.assertions(1);

		const { runner } = fakeRunner((callback) => {
			callback(Object.assign(new Error("killed"), { killed: true }), "", "");
		});

		await expect(checkAsync(runner, ["/a.spec-d.luau"])).rejects.toThrow(
			"typecheck timed out after 1234ms",
		);
	});
});
