import { fromAny } from "@total-typescript/shoehorn";

import type * as childProcess from "node:child_process";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import packageJson from "../../package.json" with { type: "json" };
import type { ChildProcessRunner } from "../utils/child-process.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { evaluateLuauConfigWithLute } from "./luau-config-lute.ts";

const CONFIG_FILE = path.resolve("/project/configs/jest.config.luau");
const TEMPORARY_DIRECTORY = path.resolve("/temporary");
const HOME_DIRECTORY = path.resolve("/home/user");
const TYPE_MODULE = path.join(
	HOME_DIRECTORY,
	".jest-roblox",
	"typedefs",
	packageJson.version,
	"config.luau",
);
const VALUE = "<<jest-roblox:luau-config-value>>";
const ERROR = "<<jest-roblox:luau-config-error>>";

interface Reply {
	readonly error?: Partial<childProcess.ExecFileException>;
	readonly stderr?: string;
	readonly stdout?: string;
}

interface Invocation {
	readonly args: Array<string>;
	readonly binary: string;
	readonly cwd: string | undefined;
	readonly files: Array<string>;
	readonly timeout: number | undefined;
	readonly typeModuleExists: boolean;
	readonly windowsHide: boolean | undefined;
}

type Callback = (error: Error | null, stdout: string, stderr: string) => void;

interface ExecOptions {
	readonly cwd?: string;
	readonly timeout?: number;
	readonly windowsHide?: boolean;
}

function setup({
	configFile = CONFIG_FILE,
	environment = {},
	fileSystemOverrides = {},
	run,
	seed = {},
	version = { stdout: "1.0.1\n" },
}: {
	configFile?: string;
	environment?: NodeJS.ProcessEnv;
	fileSystemOverrides?: Partial<FileSystem>;
	run?: Reply;
	seed?: Record<string, string>;
	version?: Reply;
}) {
	const memory = createMemoryFileSystem({
		[configFile]: "return {}",
		[path.join(TEMPORARY_DIRECTORY, "keep")]: "",
		...seed,
	});
	const { volume } = memory;
	const fileSystem: FileSystem = { ...memory.fileSystem, ...fileSystemOverrides };
	const invocations: Array<Invocation> = [];
	const execFile: typeof childProcess.execFile = fromAny(
		// eslint-disable-next-line better-max-params/better-max-params -- fakes the Node execFile signature.
		(binary: string, args: Array<string>, options: ExecOptions, callback: Callback) => {
			invocations.push({
				args,
				binary,
				cwd: options.cwd,
				files:
					args[0] === "run"
						? [args[1]!, path.join(path.dirname(args[1]!), ".luaurc")].map((file) => {
								return fileSystem.readFileSync(file, "utf-8");
							})
						: [],
				timeout: options.timeout,
				typeModuleExists: volume.existsSync(TYPE_MODULE),
				windowsHide: options.windowsHide,
			});
			const reply = (args[0] === "--version" ? version : run) ?? { stdout: "" };
			const error =
				reply.error === undefined ? null : Object.assign(new Error("failed"), reply.error);
			callback(error, reply.stdout ?? "", reply.stderr ?? "");
			return fromAny({});
		},
	);
	const runner: ChildProcessRunner = fromAny({ execFile });

	async function evaluate() {
		return evaluateLuauConfigWithLute(
			{ configFile, unreadable: { line: 4, syntax: "a function call" } },
			{
				childProcess: runner,
				environment,
				fileSystem,
				homeDirectory: HOME_DIRECTORY,
				temporaryDirectory: TEMPORARY_DIRECTORY,
			},
		);
	}

	function leftovers(): Array<string> {
		return fileSystem
			.readdirSync(TEMPORARY_DIRECTORY)
			.map(String)
			.filter((name) => name !== "keep");
	}

	return { evaluate, invocations, leftovers, volume };
}

describe(evaluateLuauConfigWithLute, () => {
	it("should return the value after the value sentinel and skip the config's own prints", async () => {
		expect.assertions(1);

		const { evaluate } = setup({
			run: { stdout: `hello\n${VALUE}{"x":1}\n\n${VALUE}{"test":{"verbose":true}}\n` },
		});

		await expect(evaluate()).resolves.toStrictEqual({ test: { verbose: true } });
	});

	it("should run the bootstrap with the config's module name from the config's directory", async () => {
		expect.assertions(4);

		const { evaluate, invocations } = setup({ run: { stdout: `${VALUE}{}` } });

		await evaluate();

		const run = invocations[1]!;
		const bootstrap = run.args[1]!;

		expect([run.binary, ...run.args]).toStrictEqual(["lute", "run", bootstrap, "jest.config"]);
		expect(run.cwd).toBe(path.dirname(CONFIG_FILE));
		expect(run.files[0]).toContain('require("@luau-config-directory/"');
		expect(JSON.parse(run.files[1]!)).toStrictEqual({
			aliases: { "luau-config-directory": path.dirname(CONFIG_FILE).replaceAll("\\", "/") },
		});
	});

	it("should write the bootstrap with the sentinels the parser reads", async () => {
		expect.assertions(3);

		const { evaluate, invocations } = setup({ run: { stdout: `${VALUE}{}` } });

		await evaluate();

		const source = invocations[1]!.files[0]!;

		expect(source).toContain(`local VALUE_SENTINEL = "${VALUE}"`);
		expect(source).toContain(`local ERROR_SENTINEL = "${ERROR}"`);
		expect(source).not.toMatch(/__[A-Z_]+__/);
	});

	it("should run lute hidden on a bootstrap in a named temporary folder", async () => {
		expect.assertions(2);

		const { evaluate, invocations } = setup({ run: { stdout: `${VALUE}{}` } });

		await evaluate();

		const run = invocations[1]!;

		expect(path.relative(TEMPORARY_DIRECTORY, run.args[1]!)).toMatch(
			/^jest-roblox-luau-config-\w+[/\\]bootstrap\.luau$/,
		);
		expect(run.windowsHide).toBeTrue();
	});

	it("should write the type module for its own version before the run when it is missing", async () => {
		expect.assertions(2);

		const { evaluate, invocations, volume } = setup({ run: { stdout: `${VALUE}{}` } });

		await evaluate();

		expect(invocations[1]!.typeModuleExists).toBeTrue();
		expect(volume.readFileSync(TYPE_MODULE, "utf-8")).toContain("export type Config =");
	});

	it("should keep a type module that is already there", async () => {
		expect.assertions(1);

		const { evaluate, volume } = setup({
			run: { stdout: `${VALUE}{}` },
			seed: { [TYPE_MODULE]: "-- kept" },
		});

		await evaluate();

		expect(volume.readFileSync(TYPE_MODULE, "utf-8")).toBe("-- kept");
	});

	it("should return the value when the home folder cannot be written", async () => {
		expect.assertions(1);

		const { evaluate } = setup({
			fileSystemOverrides: {
				mkdirSync: () => {
					throw new Error("EACCES: permission denied");
				},
			},
			run: { stdout: `${VALUE}{"test":{"verbose":true}}` },
		});

		await expect(evaluate()).resolves.toStrictEqual({ test: { verbose: true } });
	});

	it("should name the failed type write when the config then fails in lute", async () => {
		expect.assertions(2);

		const { evaluate } = setup({
			fileSystemOverrides: {
				mkdirSync: () => {
					throw new Error("EACCES: permission denied");
				},
			},
			run: {
				stdout: `${ERROR}{"kind":"evaluate","message":"module not found: @jest-roblox/config"}\n`,
			},
		});
		const evaluation = evaluate();

		await expect(evaluation).rejects.toThrowWithMessage(
			Error,
			`Luau config ${CONFIG_FILE} failed in lute: module not found: @jest-roblox/config\nCould not write the Luau Config types to ${path.dirname(TYPE_MODULE)}: EACCES: permission denied`,
		);
		await expect(evaluation).rejects.toHaveProperty(
			"cause.message",
			`Luau config ${CONFIG_FILE} failed in lute: module not found: @jest-roblox/config`,
		);
	});

	it("should write no type module when lute is missing", async () => {
		expect.assertions(2);

		const { evaluate, volume } = setup({ version: { error: { code: "ENOENT" } } });

		await expect(evaluate()).rejects.toThrow("needs lute to run");
		expect(volume.existsSync(path.dirname(TYPE_MODULE))).toBeFalse();
	});

	it("should give the config directory alias forward slashes", async () => {
		expect.assertions(1);

		const { evaluate, invocations } = setup({
			configFile: path.resolve("/project/configs\\nested/jest.config.luau"),
			run: { stdout: `${VALUE}{}` },
		});

		await evaluate();

		expect(JSON.parse(invocations[1]!.files[1]!)).toStrictEqual({
			aliases: {
				"luau-config-directory": `${path.resolve("/").replaceAll("\\", "/")}project/configs/nested`,
			},
		});
	});

	it("should read the value line apart from what lute prints after it", async () => {
		expect.assertions(1);

		const { evaluate } = setup({ run: { stdout: `${VALUE}{"a":1}\nlute exited\n` } });

		await expect(evaluate()).resolves.toStrictEqual({ a: 1 });
	});

	it("should name the config when the value lute printed is not a Luau value", async () => {
		expect.assertions(1);

		const { evaluate } = setup({ run: { stdout: `${VALUE}{"test":{"verbose":null}}` } });

		await expect(evaluate()).rejects.toThrow(
			`Luau config ${CONFIG_FILE} gave lute output that is not a Luau value`,
		);
	});

	it("should read a value whose string holds the sentinel text", async () => {
		expect.assertions(1);

		const { evaluate } = setup({ run: { stdout: `\n${VALUE}{"name":"${VALUE}{}"}\n` } });

		await expect(evaluate()).resolves.toStrictEqual({ name: `${VALUE}{}` });
	});

	it.for([VALUE, ERROR])(
		"should name the config when the line after %s is not JSON",
		async (sentinel) => {
			expect.assertions(2);

			const { evaluate } = setup({ run: { stdout: `${sentinel}{"x":` } });
			const evaluation = evaluate();

			await expect(evaluation).rejects.toThrow(
				`Luau config ${CONFIG_FILE} gave lute output that is not JSON: `,
			);
			await expect(evaluation).rejects.toHaveProperty("cause.name", "SyntaxError");
		},
	);

	it("should name the config when the error lute printed is not a bootstrap error", async () => {
		expect.assertions(1);

		const { evaluate } = setup({ run: { stdout: `${ERROR}{"kind":"other"}` } });

		await expect(evaluate()).rejects.toThrow(
			`Luau config ${CONFIG_FILE} gave a lute error that is not a bootstrap error: `,
		);
	});

	it("should put each bootstrap in a new folder and remove it after success", async () => {
		expect.assertions(2);

		const { evaluate, invocations, leftovers } = setup({ run: { stdout: `${VALUE}{}` } });

		await evaluate();
		await evaluate();

		expect(path.dirname(invocations[1]!.args[1]!)).not.toBe(
			path.dirname(invocations[3]!.args[1]!),
		);
		expect(leftovers()).toStrictEqual([]);
	});

	it("should remove the bootstrap folder after a failure", async () => {
		expect.assertions(2);

		const { evaluate, leftovers } = setup({
			run: { stdout: `${ERROR}{"kind":"evaluate","message":"boom"}` },
		});

		await expect(evaluate()).rejects.toThrow("boom");
		expect(leftovers()).toStrictEqual([]);
	});

	it("should run the binary that JEST_ROBLOX_LUTE_PATH names", async () => {
		expect.assertions(2);

		const { evaluate, invocations } = setup({
			environment: { JEST_ROBLOX_LUTE_PATH: "/tools/custom-binary" },
			run: { stdout: `${VALUE}{}` },
		});

		await evaluate();

		expect(invocations.map(({ binary }) => binary)).toStrictEqual([
			"/tools/custom-binary",
			"/tools/custom-binary",
		]);
		expect(invocations[1]!.timeout).toBeGreaterThan(0);
	});

	it("should fall back to PATH when JEST_ROBLOX_LUTE_PATH is empty", async () => {
		expect.assertions(1);

		const { evaluate, invocations } = setup({
			environment: { JEST_ROBLOX_LUTE_PATH: "" },
			run: { stdout: `${VALUE}{}` },
		});

		await evaluate();

		expect(invocations.map(({ binary }) => binary).join(" ")).toBe("lute lute");
	});

	it("should say lute is needed and name the unreadable line when the binary is missing", async () => {
		expect.assertions(2);

		const { evaluate, invocations } = setup({
			environment: { JEST_ROBLOX_LUTE_PATH: "/missing/binary" },
			version: { error: { code: "ENOENT" } },
		});

		await expect(evaluate()).rejects.toThrowWithMessage(
			Error,
			`Luau config ${CONFIG_FILE}:4 holds a function call, which needs lute to run, and "/missing/binary" was not found. Install lute 1.x (https://github.com/luau-lang/lute) or set JEST_ROBLOX_LUTE_PATH to its path.`,
		);
		expect(invocations).toHaveLength(1);
	});

	it.for(["2.0.0", "lute 0.9.1", "garbage"])(
		"should reject a binary whose version prints %s",
		async (printed) => {
			expect.assertions(1);

			const { evaluate } = setup({ version: { stdout: `${printed}\n` } });

			await expect(evaluate()).rejects.toThrow(
				`Luau config ${CONFIG_FILE} needs lute 1.x, but "`,
			);
		},
	);

	it("should accept a version printed after the program name", async () => {
		expect.assertions(1);

		const { evaluate } = setup({
			run: { stdout: `${VALUE}{"a":1}` },
			version: { stdout: "lute 1.4.0-rc.1\n" },
		});

		await expect(evaluate()).resolves.toStrictEqual({ a: 1 });
	});

	it("should name the version command when it fails to run", async () => {
		expect.assertions(1);

		const { evaluate } = setup({ version: { error: { code: "EACCES", message: "denied" } } });

		await expect(evaluate()).rejects.toThrow(/--version" failed: denied$/);
	});

	it.for([
		["the version check", { version: { error: { killed: true } } }],
		["the run", { run: { error: { killed: true }, stdout: "partial" } }],
	] as const)("should name the file when %s times out", async ([, replies]) => {
		expect.assertions(1);

		const { evaluate } = setup(replies);

		await expect(evaluate()).rejects.toThrow(
			new RegExp(
				`^Luau config ${RegExp.escape(CONFIG_FILE)} did not finish in lute within \\d+ms\\.$`,
			),
		);
	});

	it("should pass on lute's message when the config fails to evaluate", async () => {
		expect.assertions(1);

		const { evaluate } = setup({
			run: {
				stdout: `${ERROR}{"kind":"evaluate","message":"jest.config.luau:2: attempt to call a nil value\\n"}\n`,
			},
		});

		await expect(evaluate()).rejects.toThrowWithMessage(
			Error,
			`Luau config ${CONFIG_FILE} failed in lute: jest.config.luau:2: attempt to call a nil value`,
		);
	});

	it("should name what the config returned when it is not a table", async () => {
		expect.assertions(1);

		const { evaluate } = setup({
			run: { stdout: `${ERROR}{"kind":"root","type":"a number"}` },
		});

		await expect(evaluate()).rejects.toThrowWithMessage(
			Error,
			`Luau config ${CONFIG_FILE} must return a table, but it returned a number`,
		);
	});

	it.for([
		["test.setupFiles[2]", "at test.setupFiles[2]"],
		["", "at its root"],
	])("should name the value at %j that cannot serialize", async ([keyPath, location]) => {
		expect.assertions(1);

		const { evaluate } = setup({
			run: {
				stdout: `${ERROR}${JSON.stringify({ kind: "serialize", path: keyPath, type: "a function" })}`,
			},
		});

		await expect(evaluate()).rejects.toThrowWithMessage(
			Error,
			`Luau config ${CONFIG_FILE} holds a function ${location}, which cannot cross into JSON. Move that value to a TypeScript config.`,
		);
	});

	it.for([
		[{ error: { code: 1 }, stderr: " lute crashed \n", stdout: "noise" }, "lute crashed"],
		[{ error: { code: 1 }, stdout: " noise \n" }, "noise"],
		[{ error: { code: 1, message: "Command failed" } }, "Command failed"],
		[{}, "no output"],
	] as const)(
		"should pass on what lute printed when no sentinel arrives (%#)",
		async ([run, message]) => {
			expect.assertions(1);

			const { evaluate } = setup({ run });

			await expect(evaluate()).rejects.toThrowWithMessage(
				Error,
				`Luau config ${CONFIG_FILE} failed in lute: ${message}`,
			);
		},
	);
});
