import { fromAny } from "@total-typescript/shoehorn";

import type * as childProcess from "node:child_process";
import * as path from "node:path";
import process from "node:process";
import { describe, expect, it, vi } from "vitest";

import type { ChildProcessRunner } from "../utils/child-process.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { spawnTsgoAsync } from "./tsgo.ts";

const TSC_MANIFEST = JSON.stringify({ bin: { tsc: "./bin/tsc" }, version: "7.0.2" });

/**
 * A filesystem that serves the compiler manifest and answers every other read
 * with `contents`.
 *
 * @param contents - What a tsconfig read returns.
 * @returns The stub filesystem.
 */
function readingText(contents: string): FileSystem {
	return fromAny({
		readFileSync: (filePath: string) => {
			return filePath.endsWith("package.json") ? TSC_MANIFEST : contents;
		},
	});
}

/**
 * A filesystem that serves the compiler manifest and fails every other read.
 *
 * @param failure - What the read throws.
 * @returns The stub filesystem.
 */
function throwingOnRead(failure: unknown): FileSystem {
	return fromAny({
		readFileSync: (filePath: string) => {
			if (filePath.endsWith("package.json")) {
				return TSC_MANIFEST;
			}

			throw failure;
		},
	});
}

/**
 * Spawns tsgo against a launcher that exits cleanly, and returns the compiler
 * flags it was given.
 *
 * @param fileSystem - Where the tsconfig and manifest are read.
 * @param tsconfig - The configured tsconfig, if any.
 * @returns The arguments tsgo was launched with.
 */
async function spawnFlagsAsync(fileSystem: FileSystem, tsconfig?: string): Promise<Array<string>> {
	const invocations: Array<Array<string>> = [];
	const child: childProcess.ChildProcess = fromAny({ once: () => child });
	const execFile: typeof childProcess.execFile = fromAny(
		(
			...[, commandArguments, , callback]: [
				string,
				Array<string>,
				unknown,
				(error: null, stdout: string, stderr: string) => void,
			]
		) => {
			invocations.push(commandArguments);
			callback(null, "", "");
			return child;
		},
	);
	const runner: ChildProcessRunner = fromAny({ execFile });

	await spawnTsgoAsync({
		childProcess: runner,
		files: [],
		fileSystem,
		resolveModule: (specifier) => path.join("/modules", specifier),
		rootDir: "/project",
		runTimeout: 1000,
		spawnTimeout: 1000,
		tsconfig,
	});

	return invocations[0]!.slice(1);
}

describe(spawnTsgoAsync, () => {
	it("should name tsgo when the run deadline kills it", async () => {
		expect.assertions(1);

		const child: childProcess.ChildProcess = fromAny({ once: () => child });
		const execFile: typeof childProcess.execFile = fromAny(
			(
				...args: [
					string,
					Array<string>,
					unknown,
					(error: Error, stdout: string, stderr: string) => void,
				]
			) => {
				args[3](Object.assign(new Error("killed"), { killed: true }), "", "");
				return child;
			},
		);

		await expect(
			spawnTsgoAsync({
				childProcess: fromAny({ execFile }),
				files: [],
				fileSystem: readingText("{}"),
				resolveModule: (specifier) => path.join("/modules", specifier),
				rootDir: "/project",
				runTimeout: 1000,
				spawnTimeout: 1000,
			}),
		).rejects.toThrow("tsgo typecheck timed out after 1000ms (timeout)");
	});
});

describe("tsgo composite detection", () => {
	it("should build when compilerOptions.composite is true", async () => {
		expect.assertions(1);

		const fileSystem = readingText(JSON.stringify({ compilerOptions: { composite: true } }));

		await expect(spawnFlagsAsync(fileSystem)).resolves.toContain("--build");
	});

	it("should not build when composite is absent", async () => {
		expect.assertions(1);

		const fileSystem = readingText(JSON.stringify({ compilerOptions: { strict: true } }));

		await expect(spawnFlagsAsync(fileSystem)).resolves.toContain("--noEmit");
	});

	it("should not build when compilerOptions is absent", async () => {
		expect.assertions(1);

		const fileSystem = readingText(JSON.stringify({ include: ["src"] }));

		await expect(spawnFlagsAsync(fileSystem)).resolves.toContain("--noEmit");
	});

	it("should not build when compilerOptions is null", async () => {
		expect.assertions(1);

		const fileSystem = readingText('{ "compilerOptions": null }');

		await expect(spawnFlagsAsync(fileSystem)).resolves.toContain("--noEmit");
	});

	it("should not build when compilerOptions is an array", async () => {
		expect.assertions(1);

		const fileSystem = readingText('{ "compilerOptions": [] }');

		await expect(spawnFlagsAsync(fileSystem)).resolves.toContain("--noEmit");
	});

	it("should not build when tsconfig does not exist", async () => {
		expect.assertions(1);

		const fileSystem = throwingOnRead(new Error("ENOENT"));

		await expect(spawnFlagsAsync(fileSystem)).resolves.toContain("--noEmit");
	});

	it("should not build on malformed JSON", async () => {
		expect.assertions(1);

		const fileSystem = readingText("not json{{{");

		await expect(spawnFlagsAsync(fileSystem)).resolves.toContain("--noEmit");
	});

	it("should detect composite in tsconfig with comments", async () => {
		expect.assertions(1);

		const fileSystem = readingText(
			'// this is a comment\n{ "compilerOptions": { "composite": true } }',
		);

		await expect(spawnFlagsAsync(fileSystem)).resolves.toContain("--build");
	});

	it("should detect composite in tsconfig with trailing commas", async () => {
		expect.assertions(1);

		const fileSystem = readingText('{ "compilerOptions": { "composite": true, }, }');

		await expect(spawnFlagsAsync(fileSystem)).resolves.toContain("--build");
	});

	it("should warn when custom tsconfig cannot be read", async () => {
		expect.assertions(2);

		const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

		const fileSystem = throwingOnRead(new Error("ENOENT"));

		await expect(spawnFlagsAsync(fileSystem, "tsconfig.build.json")).resolves.toContain(
			"--noEmit",
		);
		expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("tsconfig.build.json"));
	});

	it("should warn with stringified error when thrown value is not an Error", async () => {
		expect.assertions(2);

		const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

		const fileSystem = throwingOnRead("raw string error");

		await expect(spawnFlagsAsync(fileSystem, "tsconfig.build.json")).resolves.toContain(
			"--noEmit",
		);
		expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("raw string error"));
	});

	it("should not warn when default tsconfig does not exist", async () => {
		expect.assertions(2);

		const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

		const fileSystem = throwingOnRead(new Error("ENOENT"));

		await expect(spawnFlagsAsync(fileSystem)).resolves.toContain("--noEmit");
		expect(stderrSpy).not.toHaveBeenCalled();
	});

	it("should resolve custom tsconfig path against root directory", async () => {
		expect.assertions(1);

		const fileSystem = readingText(JSON.stringify({ compilerOptions: { composite: true } }));
		const readFile = vi.spyOn(fileSystem, "readFileSync");

		await spawnFlagsAsync(fileSystem, "tsconfig.build.json");

		expect(readFile).toHaveBeenCalledWith(
			path.resolve("/project", "tsconfig.build.json"),
			"utf-8",
		);
	});
});
