import { fromAny } from "@total-typescript/shoehorn";

import type * as childProcess from "node:child_process";
import * as path from "node:path";
import process from "node:process";
import { assert, describe, expect, it, onTestFinished, vi } from "vitest";

import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { posixPath } from "#test/mocks/posix-path.ts";
import { ConfigError } from "../config/errors.ts";
import type { ChildProcessRunner } from "../utils/child-process.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { runTypecheckAsync } from "./runner.ts";

const LUAU_SPEC = path.resolve("/project/src/a.spec-d.luau");
const LUAU_SOURCE = [
	"--!strict",
	'describe("suite", function()',
	'\tit("passes", function() end)',
	'\tit("fails", function()',
	'\t\tlocal _s = "ü"; local _n: number = "x"',
	"\tend)",
	"end)",
].join("\n");

const TSC_7_MANIFEST = JSON.stringify({ bin: { tsc: "./bin/tsc" }, version: "7.0.2" });

describe(runTypecheckAsync, () => {
	interface TsgoSpawnError extends Error {
		code?: number | string;
		killed?: boolean;
		signal?: string;
	}

	type TsgoCallback = (error: null | TsgoSpawnError, stdout: string, stderr: string) => void;

	/** One `execFile` invocation, in the shape `spawnTsgo` calls it. */
	interface TsgoInvocation {
		arguments: Array<string>;
		options: { timeout?: number };
	}

	/**
	 * `spawnTsgo` drives `execFile` in callback form and listens once for the
	 * child `spawn` event to clear its launch timer. `stubTsgo` returns the
	 * recorded invocations plus a fake child (`emitSpawn` fires the registered
	 * `spawn` listener, `kill` is the spy `spawnTsgo` calls on a launch timeout)
	 * and lets a test simulate tsgo finishing (exit 0), exiting non-zero with
	 * diagnostics, failing to spawn, or never launching.
	 * @param respond - Answers each `execFile` call through its callback.
	 * @returns The stub runner, `emitSpawn`, the invocations and the spies.
	 */
	function stubTsgo(respond: (callback: TsgoCallback) => void) {
		let spawnListener: (() => void) | undefined;
		const invocations: Array<TsgoInvocation> = [];
		const kill = vi.fn<() => void>();
		const once = vi.fn<(event: string, listener: () => void) => childProcess.ChildProcess>(
			(event, listener) => {
				if (event === "spawn") {
					spawnListener = listener;
				}

				return child;
			},
		);
		const child: childProcess.ChildProcess = fromAny({ kill, once });
		const execFileStub: typeof childProcess.execFile = fromAny(
			(
				...[, commandArguments, options, callback]: [
					string,
					Array<string>,
					{ timeout?: number },
					TsgoCallback,
				]
			) => {
				invocations.push({ arguments: commandArguments, options });
				respond(callback);
				return child;
			},
		);
		const runner: ChildProcessRunner = fromAny({ execFile: execFileStub });
		return {
			childProcess: runner,
			emitSpawn: () => spawnListener?.(),
			invocations,
			kill,
			once,
		};
	}

	function exitWith(code: number): TsgoSpawnError {
		return Object.assign(new Error(`tsgo exit ${String(code)}`), { code });
	}

	/**
	 * A volume answering every tsconfig read with one text and every other read
	 * with another, which is the only distinction these cases need.
	 *
	 * @param tsconfigContent - What a tsconfig read returns.
	 * @param testFileContent - What every other read returns.
	 * @returns The stub filesystem.
	 */
	function readingFiles(tsconfigContent: string, testFileContent: string): FileSystem {
		return fromAny({
			readFileSync: (filePath: string) => {
				const fileString = filePath;
				if (fileString.endsWith("package.json")) {
					return JSON.stringify({ bin: { tsc: "./bin/tsc" }, version: "7.0.2" });
				}

				return fileString.endsWith("tsconfig.json") ||
					fileString.endsWith("tsconfig.test.json")
					? tsconfigContent
					: testFileContent;
			},
		});
	}

	type TypecheckOverrides = Partial<Parameters<typeof runTypecheckAsync>[0]>;

	async function compileAsync(
		overrides: TypecheckOverrides = {},
	): Promise<Array<TsgoInvocation>> {
		const { childProcess, invocations } = stubTsgo((callback) => {
			callback(null, "", "");
		});
		const fileSystem = readingFiles(
			JSON.stringify({ compilerOptions: {} }),
			'it("should pass", () => {});',
		);

		await runTypecheckAsync({
			childProcess,
			files: ["src/test.spec.ts"],
			fileSystem,
			rootDir: "/project",
			...overrides,
		});
		return invocations;
	}

	async function typecheckWithSourceErrorAsync(
		overrides: TypecheckOverrides = {},
	): ReturnType<typeof runTypecheckAsync> {
		const filePath = "src/test.spec.ts";
		const { childProcess } = stubTsgo((callback) => {
			callback(
				exitWith(2),
				"other.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.",
				"",
			);
		});
		const fileSystem = readingFiles(
			JSON.stringify({ compilerOptions: {} }),
			'it("should pass", () => {});',
		);

		return runTypecheckAsync({
			childProcess,
			files: [filePath],
			fileSystem,
			rootDir: path.dirname(path.resolve(filePath)),
			...overrides,
		});
	}

	it("should pass tsconfig option to tsgo for non-composite project", async () => {
		expect.assertions(4);

		const { childProcess, invocations } = stubTsgo((callback) => {
			callback(null, "", "");
		});
		const fileSystem = readingFiles(
			JSON.stringify({ compilerOptions: {} }),
			'it("should pass", () => {});',
		);

		const result = await runTypecheckAsync({
			childProcess,
			files: ["src/test.spec.ts"],
			fileSystem,
			rootDir: "/project",
			tsconfig: "tsconfig.test.json",
		});

		expect(result.success).toBeTrue();

		const [tsgoScript, ...callArgs] = invocations[0]!.arguments;

		expect(posixPath(tsgoScript!)).toEndWith("/bin/tsc");
		expect(callArgs).toStrictEqual([
			"--noEmit",
			"--pretty",
			"false",
			"-p",
			path.resolve("/project", "tsconfig.test.json"),
		]);
		expect(invocations[0]!.options).toStrictEqual({
			cwd: "/project",
			encoding: "utf-8",
			timeout: 300_000,
			windowsHide: true,
		});
	});

	it("should use --noEmit for non-composite projects", async () => {
		expect.assertions(2);

		const { childProcess, invocations } = stubTsgo((callback) => {
			callback(null, "", "");
		});
		const fileSystem = readingFiles(
			JSON.stringify({ compilerOptions: {} }),
			'it("should pass", () => {});',
		);

		const result = await runTypecheckAsync({
			childProcess,
			files: ["src/test.spec.ts"],
			fileSystem,
			rootDir: "/project",
		});

		const callArgs = invocations[0]!.arguments;

		expect(result.success).toBeTrue();
		expect(callArgs).toContain("--noEmit");
	});

	it("should use --build --emitDeclarationOnly for composite projects", async () => {
		expect.assertions(2);

		const { childProcess, invocations } = stubTsgo((callback) => {
			callback(null, "", "");
		});
		const fileSystem = readingFiles(
			JSON.stringify({ compilerOptions: { composite: true } }),
			'it("should pass", () => {});',
		);

		const result = await runTypecheckAsync({
			childProcess,
			files: ["src/test.spec.ts"],
			fileSystem,
			rootDir: "/project",
		});

		const [, ...callArgs] = invocations[0]!.arguments;

		expect(result.success).toBeTrue();
		expect(callArgs).toStrictEqual(["--build", "--emitDeclarationOnly", "--pretty", "false"]);
	});

	it("should pass tsconfig as positional arg for composite --build", async () => {
		expect.assertions(1);

		const { childProcess, invocations } = stubTsgo((callback) => {
			callback(null, "", "");
		});
		const fileSystem = readingFiles(
			JSON.stringify({ compilerOptions: { composite: true } }),
			'it("should pass", () => {});',
		);

		await runTypecheckAsync({
			childProcess,
			files: ["src/test.spec.ts"],
			fileSystem,
			rootDir: "/project",
			tsconfig: "tsconfig.test.json",
		});

		const [, ...callArgs] = invocations[0]!.arguments;

		expect(callArgs).toStrictEqual([
			"--build",
			"--emitDeclarationOnly",
			"--pretty",
			"false",
			path.resolve("/project", "tsconfig.test.json"),
		]);
	});

	it("should store testFilePath as relative to rootDir", async () => {
		expect.assertions(1);

		const { childProcess } = stubTsgo((callback) => {
			callback(null, "", "");
		});
		const fileSystem = readingFiles(
			JSON.stringify({ compilerOptions: {} }),
			'it("should pass", () => {});',
		);

		const result = await runTypecheckAsync({
			childProcess,
			files: ["src/test.spec.ts"],
			fileSystem,
			rootDir: "/project",
		});

		expect(result.testResults[0]!.testFilePath).toBe(
			posixPath(path.relative("/project", path.resolve("src/test.spec.ts"))),
		);
	});

	it("should bound the tsgo compile with the default run timeout", async () => {
		expect.assertions(1);

		const invocations = await compileAsync();

		expect(invocations[0]!.options.timeout).toBe(300_000);
	});

	it("should bound the tsgo compile with a custom run timeout", async () => {
		expect.assertions(1);

		const invocations = await compileAsync({ timeout: 250 });

		expect(invocations[0]!.options.timeout).toBe(250);
	});

	it("should throw when the tsgo compile exceeds the run timeout", async () => {
		expect.assertions(1);

		const { childProcess } = stubTsgo((callback) => {
			callback(
				Object.assign(new Error("killed"), { killed: true, signal: "SIGTERM" }),
				"",
				"",
			);
		});
		const fileSystem = readingFiles(
			JSON.stringify({ compilerOptions: {} }),
			'it("should pass", () => {});',
		);

		await expect(
			runTypecheckAsync({
				childProcess,
				files: ["src/test.spec.ts"],
				fileSystem,
				rootDir: "/project",
				timeout: 250,
			}),
		).rejects.toThrow(/timed out after 250ms \(timeout\)/);
	});

	it("should throw and kill tsgo when it does not launch within spawnTimeout", async () => {
		expect.assertions(3);

		// Capture but never invoke the callback, and never emit `spawn`: the
		// process is stuck before launch, so only the launch timer can settle
		// the promise.
		let captured: TsgoCallback | undefined;
		const { childProcess, kill } = stubTsgo((callback) => {
			captured = callback;
		});
		const fileSystem = readingFiles(
			JSON.stringify({ compilerOptions: {} }),
			'it("should pass", () => {});',
		);

		await expect(
			runTypecheckAsync({
				childProcess,
				files: ["src/test.spec.ts"],
				fileSystem,
				rootDir: "/project",
				spawnTimeout: 1,
			}),
		).rejects.toThrow(/spawn timed out after 1ms \(spawnTimeout\)/);

		expect(kill).toHaveBeenCalledExactlyOnceWith();

		// The kill's late `killed` callback arrives after the launch timer
		// already settled the promise — it must be a silent no-op.
		expect(() => {
			captured!(Object.assign(new Error("killed"), { killed: true }), "", "");
		}).not.toThrow();
	});

	it("should clear the launch timer once tsgo spawns", async () => {
		expect.assertions(2);

		// Defer the exit callback past the synchronous setup so the launch timer
		// is armed, then `emitSpawn` exercises the clear-on-spawn path.
		const { childProcess, emitSpawn, kill } = stubTsgo((callback) => {
			queueMicrotask(() => {
				callback(null, "", "");
			});
		});
		const fileSystem = readingFiles(
			JSON.stringify({ compilerOptions: {} }),
			'it("should pass", () => {});',
		);

		const promise = runTypecheckAsync({
			childProcess,
			files: ["src/test.spec.ts"],
			fileSystem,
			rootDir: "/project",
			spawnTimeout: 10_000,
		});
		emitSpawn();

		const result = await promise;

		expect(result.success).toBeTrue();
		expect(kill).not.toHaveBeenCalled();
	});

	it("should cancel the launch deadline when execution completes before spawn", async () => {
		expect.assertions(2);

		vi.useFakeTimers();
		onTestFinished(() => {
			vi.useRealTimers();
		});
		let completed: TsgoCallback | undefined;
		const { childProcess, kill } = stubTsgo((callback) => {
			completed = callback;
		});
		const manifestPath = "/tsgo/package.json";
		const { fileSystem } = createMemoryFileSystem({
			"/project/src/test.spec.ts": 'it("passes", () => {});',
			"/project/tsconfig.json": "{}",
			[manifestPath]: JSON.stringify({ bin: { tsc: "./bin/tsc" }, version: "7.0.2" }),
		});
		const pending = runTypecheckAsync({
			childProcess,
			files: ["/project/src/test.spec.ts"],
			fileSystem,
			resolveModule: () => manifestPath,
			rootDir: "/project",
			spawnTimeout: 5,
		});
		assert(completed !== undefined);
		completed(null, "", "");

		await pending;

		expect(vi.getTimerCount()).toBe(0);

		await vi.advanceTimersByTimeAsync(10);

		expect(kill).not.toHaveBeenCalled();
	});

	it("should register the spawn listener and keep a launched process alive past its launch deadline", async () => {
		expect.assertions(3);

		vi.useFakeTimers();
		onTestFinished(() => {
			vi.useRealTimers();
		});

		let captured: TsgoCallback | undefined;
		const { childProcess, emitSpawn, kill, once } = stubTsgo((callback) => {
			captured = callback;
		});
		const fileSystem = readingFiles(
			JSON.stringify({ compilerOptions: {} }),
			'it("should pass", () => {});',
		);

		const guarded = runTypecheckAsync({
			childProcess,
			files: ["src/test.spec.ts"],
			fileSystem,
			rootDir: "/project",
			spawnTimeout: 5,
		}).catch((err: unknown) => err);
		emitSpawn();
		await vi.advanceTimersByTimeAsync(10);

		expect(once).toHaveBeenCalledExactlyOnceWith("spawn", expect.any(Function));
		expect(kill).not.toHaveBeenCalled();

		captured!(null, "", "");
		const result = await guarded;

		expect(result).toMatchObject({ success: true });
	});

	it("should not arm the launch timer after a synchronous completion", async () => {
		expect.assertions(1);

		vi.useFakeTimers();
		onTestFinished(() => {
			vi.useRealTimers();
		});

		const { childProcess, kill } = stubTsgo((callback) => {
			callback(null, "", "");
		});
		const fileSystem = readingFiles(
			JSON.stringify({ compilerOptions: {} }),
			'it("should pass", () => {});',
		);

		await runTypecheckAsync({
			childProcess,
			files: ["src/test.spec.ts"],
			fileSystem,
			rootDir: "/project",
			spawnTimeout: 5,
		});
		await vi.advanceTimersByTimeAsync(10);

		expect(kill).not.toHaveBeenCalled();
	});

	it("should rethrow when the tsgo spawn fails to start", async () => {
		expect.assertions(2);

		const spawnFailure = Object.assign(new Error("spawn failed"), { code: "ENOENT" });
		const { childProcess } = stubTsgo((callback) => {
			callback(spawnFailure, "", "");
		});
		const fileSystem = readingFiles(
			JSON.stringify({ compilerOptions: {} }),
			'it("should pass", () => {});',
		);

		const error: unknown = await runTypecheckAsync({
			childProcess,
			files: ["src/test.spec.ts"],
			fileSystem,
			rootDir: "/project",
		}).catch((err: unknown) => err);

		expect(error).toBeInstanceOf(Error);
		expect(error).toMatchObject({ cause: spawnFailure });
	});

	// The guard throws before `executeTsgo`, so this test needs no spawn stub.
	it("should name the optional peer dependency when tsgo is not installed", async () => {
		expect.assertions(1);

		function resolveModule(): string {
			throw Object.assign(new Error("Cannot find module"), { code: "MODULE_NOT_FOUND" });
		}

		const error: unknown = await runTypecheckAsync({
			files: ["src/test.spec.ts"],
			resolveModule,
			rootDir: "/project",
		}).catch((err: unknown) => err);

		assert(error instanceof ConfigError, "expected a ConfigError");

		expect({ hint: error.hint, message: error.message }).toStrictEqual({
			hint: "npm install -D typescript@7 — or run without --typecheck/--typecheckOnly.",
			message:
				"Type tests need TypeScript 7 ('typescript' 7+, or '@typescript/native' beside TypeScript 6), an optional peer dependency that is not installed.",
		});
	});

	/**
	 * Resolves each listed specifier to its manifest path; any other package
	 * reads as not installed.
	 *
	 * @param manifests - Manifest path per `<package>/package.json` specifier.
	 * @returns A resolver that throws `MODULE_NOT_FOUND` for unlisted specifiers.
	 */
	function resolvingManifests(manifests: Record<string, string>): (specifier: string) => string {
		return (specifier) => {
			const manifest = manifests[specifier];
			if (manifest === undefined) {
				throw Object.assign(new Error("Cannot find module"), { code: "MODULE_NOT_FOUND" });
			}

			return manifest;
		};
	}

	it("should prefer '@typescript/native' over 'typescript'", async () => {
		expect.assertions(1);

		const { childProcess, invocations } = stubTsgo((callback) => {
			callback(null, "", "");
		});
		const { fileSystem } = createMemoryFileSystem({
			"/native/package.json": TSC_7_MANIFEST,
			"/project/src/test.spec.ts": 'it("passes", () => {});',
			"/project/tsconfig.json": "{}",
			"/typescript/package.json": TSC_7_MANIFEST,
		});

		await runTypecheckAsync({
			childProcess,
			files: ["/project/src/test.spec.ts"],
			fileSystem,
			resolveModule: resolvingManifests({
				"@typescript/native/package.json": "/native/package.json",
				"typescript/package.json": "/typescript/package.json",
			}),
			rootDir: "/project",
		});

		expect(posixPath(invocations[0]!.arguments[0]!)).toBe("/native/bin/tsc");
	});

	it("should fall back to 'typescript' when it is TypeScript 7", async () => {
		expect.assertions(1);

		const { childProcess, invocations } = stubTsgo((callback) => {
			callback(null, "", "");
		});
		const { fileSystem } = createMemoryFileSystem({
			"/project/src/test.spec.ts": 'it("passes", () => {});',
			"/project/tsconfig.json": "{}",
			"/typescript/package.json": JSON.stringify({
				bin: { tsc: "./bin/tsc" },
				version: "7.1.0-dev.20260924.1",
			}),
		});

		await runTypecheckAsync({
			childProcess,
			files: ["/project/src/test.spec.ts"],
			fileSystem,
			resolveModule: resolvingManifests({
				"typescript/package.json": "/typescript/package.json",
			}),
			rootDir: "/project",
		});

		expect(posixPath(invocations[0]!.arguments[0]!)).toBe("/typescript/bin/tsc");
	});

	it("should fall back to '@typescript/native-preview'", async () => {
		expect.assertions(1);

		const { childProcess, invocations } = stubTsgo((callback) => {
			callback(null, "", "");
		});
		const { fileSystem } = createMemoryFileSystem({
			"/preview/package.json": JSON.stringify({
				bin: { tsgo: "./bin/tsgo" },
				version: "7.0.0-dev.20260707.2",
			}),
			"/project/src/test.spec.ts": 'it("passes", () => {});',
			"/project/tsconfig.json": "{}",
			"/typescript/package.json": JSON.stringify({
				bin: { tsc: "./bin/tsc" },
				version: "6.0.3",
			}),
		});

		await runTypecheckAsync({
			childProcess,
			files: ["/project/src/test.spec.ts"],
			fileSystem,
			resolveModule: resolvingManifests({
				"@typescript/native-preview/package.json": "/preview/package.json",
				"typescript/package.json": "/typescript/package.json",
			}),
			rootDir: "/project",
		});

		expect(posixPath(invocations[0]!.arguments[0]!)).toBe("/preview/bin/tsgo");
	});

	it("should not run a 'typescript' older than 7", async () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({
			"/typescript/package.json": JSON.stringify({
				bin: { tsc: "./bin/tsc", tsserver: "./bin/tsserver" },
				version: "6.0.3",
			}),
		});

		await expect(
			runTypecheckAsync({
				files: ["src/test.spec.ts"],
				fileSystem,
				resolveModule: resolvingManifests({
					"typescript/package.json": "/typescript/package.json",
				}),
				rootDir: "/project",
			}),
		).rejects.toThrow(
			expect.objectContaining({
				hint: "npm install -D typescript@7 — or run without --typecheck/--typecheckOnly.",
				message:
					"Type tests need TypeScript 7 ('typescript' 7+, or '@typescript/native' beside TypeScript 6), an optional peer dependency that is not installed.",
			}),
		);
	});

	// Only a missing module means "not installed". Relabelling every failure
	// would tell someone whose install is present but unreadable to install it
	// again.
	it("should rethrow a resolution failure that is not a missing module", async () => {
		expect.assertions(1);

		function resolveModule(): string {
			throw Object.assign(new Error("permission denied"), { code: "EACCES" });
		}

		await expect(
			runTypecheckAsync({
				files: ["src/test.spec.ts"],
				resolveModule,
				rootDir: "/project",
			}),
		).rejects.toThrow("permission denied");
	});

	it("should parse tsgo diagnostics from stdout on a non-zero exit", async () => {
		expect.assertions(1);

		const filePath = "src/test.spec.ts";
		const resolvedFile = path.resolve(filePath);
		const rootDirectory = path.dirname(resolvedFile);
		const relativePath = path.relative(rootDirectory, resolvedFile);

		const { childProcess } = stubTsgo((callback) => {
			callback(
				exitWith(2),
				`${relativePath}(1,7): error TS2322: Type 'string' is not assignable to type 'number'.`,
				"",
			);
		});
		const fileSystem = readingFiles(
			JSON.stringify({ compilerOptions: {} }),
			'const x: number = "bad";\nit("should fail", () => {});',
		);

		const result = await runTypecheckAsync({
			childProcess,
			files: [filePath],
			fileSystem,
			rootDir: rootDirectory,
		});

		expect(result.numFailedTests).toBePositive();
	});

	it("should fall back to stderr diagnostics when stdout is empty", async () => {
		expect.assertions(1);

		const filePath = "src/test.spec.ts";
		const resolvedFile = path.resolve(filePath);
		const rootDirectory = path.dirname(resolvedFile);
		const relativePath = path.relative(rootDirectory, resolvedFile);

		const { childProcess } = stubTsgo((callback) => {
			callback(
				exitWith(2),
				"",
				`${relativePath}(1,7): error TS2322: Type 'string' is not assignable to type 'number'.`,
			);
		});
		const fileSystem = readingFiles(
			JSON.stringify({ compilerOptions: {} }),
			'const x: number = "bad";\nit("should fail", () => {});',
		);

		const result = await runTypecheckAsync({
			childProcess,
			files: [filePath],
			fileSystem,
			rootDir: rootDirectory,
		});

		expect(result.numFailedTests).toBePositive();
	});

	it("should treat a non-zero exit with empty output as success", async () => {
		expect.assertions(1);

		const { childProcess } = stubTsgo((callback) => {
			callback(exitWith(2), "", "");
		});
		const fileSystem = readingFiles(
			JSON.stringify({ compilerOptions: {} }),
			'it("should pass", () => {});',
		);

		const result = await runTypecheckAsync({
			childProcess,
			files: ["src/test.spec.ts"],
			fileSystem,
			rootDir: "/project",
		});

		expect(result.success).toBeTrue();
	});

	it("should surface tsgo errors in non-test source files by default", async () => {
		expect.assertions(2);

		const result = await typecheckWithSourceErrorAsync();

		const sourceResult = result.testResults.find((file) => file.testFilePath === "other.ts");

		expect(result.success).toBeFalse();
		expect(sourceResult).toBeDefined();
	});

	it("should suppress non-test source file errors when ignoreSourceErrors is true", async () => {
		expect.assertions(1);

		const result = await typecheckWithSourceErrorAsync({ ignoreSourceErrors: true });

		expect(result.success).toBeTrue();
	});

	it.for(["a.spec-d.ts", "a.test-d.ts"])(
		"should check %s with tsgo and report its diagnostic",
		async (fileName) => {
			expect.assertions(2);

			const resolvedFile = path.resolve("src", fileName);
			const { childProcess } = stubTsgo((callback) => {
				callback(exitWith(2), `${fileName}(1,7): error TS2345: Bad argument.`, "");
			});
			const fileSystem = readingFiles(
				JSON.stringify({ compilerOptions: {} }),
				'const x: number = "bad";',
			);

			const result = await runTypecheckAsync({
				childProcess,
				files: [path.join("src", fileName)],
				fileSystem,
				rootDir: path.dirname(resolvedFile),
			});

			expect(result.success).toBeFalse();
			expect(result.testResults[0]!.testResults[0]!.failureMessages[0]).toContain(
				"TS2345: Bad argument.",
			);
		},
	);

	it("should check a file no checker claims with tsgo", async () => {
		expect.assertions(2);

		const { childProcess, invocations } = stubTsgo((callback) => {
			callback(null, "", "");
		});
		const fileSystem = readingFiles(
			JSON.stringify({ compilerOptions: {} }),
			'it("passes", () => {});',
		);

		const result = await runTypecheckAsync({
			childProcess,
			files: ["/project/src/a.spec.ts"],
			fileSystem,
			rootDir: "/project",
		});

		expect(invocations).toHaveLength(1);
		expect(result.testResults[0]!.testFilePath).toBe("src/a.spec.ts");
	});

	it("should run tsgo once when given no files", async () => {
		expect.assertions(2);

		const { childProcess, invocations } = stubTsgo((callback) => {
			callback(exitWith(2), "src/source.ts(1,7): error TS2322: Bad source.", "");
		});
		const fileSystem = readingFiles(JSON.stringify({ compilerOptions: {} }), "");

		const result = await runTypecheckAsync({
			childProcess,
			files: [],
			fileSystem,
			rootDir: "/project",
		});

		expect(invocations).toHaveLength(1);
		expect(result.testResults[0]!.testResults[0]!.title).toBe("<source type error>");
	});
});

describe("runTypecheckAsync with Luau Type Tests", () => {
	type Callback = (error: Error | null, stdout: string, stderr: string) => void;

	function exitOne(): Error {
		return Object.assign(new Error("exit 1"), { code: 1 });
	}

	function runnerByCommand(outputs: { luau: string; node?: string }) {
		const commands: Array<string> = [];
		const child: childProcess.ChildProcess = fromAny({
			kill: vi.fn<() => void>(),
			once: vi.fn<() => void>(),
		});
		const execFile: typeof childProcess.execFile = fromAny(
			(...[command, args, , callback]: [string, Array<string>, object, Callback]) => {
				commands.push([command, ...args].join(" "));
				const output = command === process.execPath ? outputs.node : outputs.luau;
				callback(
					output === undefined || output === "" ? null : exitOne(),
					output ?? "",
					"",
				);
				return child;
			},
		);
		const runner: ChildProcessRunner = fromAny({ execFile });
		return { childProcess: runner, commands };
	}

	function luauFiles(files: Record<string, string>): FileSystem {
		return fromAny({
			readFileSync: (filePath: string) => {
				if (filePath.endsWith("package.json")) {
					return TSC_7_MANIFEST;
				}

				return files[filePath] ?? "{}";
			},
		});
	}

	it("should attribute a lute diagnostic in byte columns to its it", async () => {
		expect.assertions(3);

		const { childProcess, commands } = runnerByCommand({
			luau: `${LUAU_SPEC}:5:38-40: (W0) TypeError: Expected this to be 'number', but got 'string'\n`,
		});

		const result = await runTypecheckAsync({
			childProcess,
			files: [LUAU_SPEC],
			fileSystem: luauFiles({ [LUAU_SPEC]: LUAU_SOURCE }),
			rootDir: "/project",
		});

		const cases = result.testResults[0]!.testResults;

		expect(commands).toHaveLength(1);
		expect(cases.map(({ status, title }) => [title, status])).toStrictEqual([
			["passes", "passed"],
			["fails", "failed"],
		]);
		expect(cases[1]!.failureMessages).toStrictEqual([
			"TypeError: Expected this to be 'number', but got 'string'",
		]);
	});

	it("should fail the file when the spec lacks --!strict", async () => {
		expect.assertions(2);

		const { childProcess } = runnerByCommand({ luau: "" });

		const result = await runTypecheckAsync({
			childProcess,
			files: [LUAU_SPEC],
			fileSystem: luauFiles({
				[LUAU_SPEC]: LUAU_SOURCE.replace("--!strict", "--!nonstrict"),
			}),
			rootDir: "/project",
		});

		const [fileCase] = result.testResults[0]!.testResults;

		expect(fileCase!.title).toBe("<file-level type error>");
		expect(fileCase!.failureMessages[0]).toContain("--!strict");
	});

	it("should replace lute diagnostics with the parser message when the spec does not parse", async () => {
		expect.assertions(1);

		const { childProcess } = runnerByCommand({
			luau: `${LUAU_SPEC}:2:1-3: (W0) SyntaxError: Expected identifier\n`,
		});

		const result = await runTypecheckAsync({
			childProcess,
			files: [LUAU_SPEC],
			fileSystem: luauFiles({ [LUAU_SPEC]: "--!strict\nlocal x = " }),
			rootDir: "/project",
		});

		expect(result.testResults[0]!.testResults[0]!.failureMessages).toStrictEqual([
			expect.stringMatching(/^SyntaxError: /),
		]);
	});

	it("should merge diagnostics two checkers report against the same file", async () => {
		expect.assertions(2);

		const tsSpec = path.resolve("/project/src/b.spec-d.ts");
		const shared = path.resolve("/project/src/shared.luau");
		const { childProcess, commands } = runnerByCommand({
			luau: `${shared}:1:1-2: (W0) TypeError: From lute\n`,
			node: "src/shared.luau(1,1): error TS1000: From tsgo.",
		});

		const result = await runTypecheckAsync({
			childProcess,
			files: [LUAU_SPEC, tsSpec],
			fileSystem: luauFiles({
				[LUAU_SPEC]: LUAU_SOURCE,
				[tsSpec]: 'it("passes", () => {});',
			}),
			rootDir: "/project",
		});

		const sourceResult = result.testResults.find(
			({ testFilePath }) => testFilePath === "src/shared.luau",
		);

		expect(commands).toHaveLength(2);
		expect(sourceResult!.testResults[0]!.failureMessages).toStrictEqual([
			"TypeError: From lute",
			"TS1000: From tsgo.",
		]);
	});
});
