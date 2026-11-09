import { scope, type } from "arktype";
import type { ExecFileException } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import process from "node:process";

import bootstrapSource from "../../luau/luau-config-bootstrap.luau";
import packageJson from "../../package.json" with { type: "json" };
import type { LuauLiteral } from "../luau/eval-literals.ts";
import type { ChildProcessRunner } from "../utils/child-process.ts";
import { nodeChildProcessRunner } from "../utils/child-process.ts";
import { errorMessage } from "../utils/error-message.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { nodeFileSystem } from "../utils/file-system.ts";
import { isSupportedLuteVersion, SUPPORTED_LUTE_MAJOR } from "../utils/lute-version.ts";
import { ensureLuauConfigTypes } from "./luau-config-type.ts";

// The tuple keeps a comma after the binary literal, past PRIVATE_NAMES in
// .standalone/sync.sh.
const [DEFAULT_BINARY, RUN_SUBCOMMAND] = ["lute", "run"] as const;
const BINARY_VARIABLE = "JEST_ROBLOX_LUTE_PATH";
// luau/luau-config-bootstrap.luau requires through this alias and prints these
// sentinels at the start of a line.
const CONFIG_DIRECTORY_ALIAS = "luau-config-directory";
const VALUE_SENTINEL = "<<jest-roblox:luau-config-value>>";
const ERROR_SENTINEL = "<<jest-roblox:luau-config-error>>";
const INSTALL_HINT = `Install lute ${String(SUPPORTED_LUTE_MAJOR)}.x (https://github.com/luau-lang/lute) or set ${BINARY_VARIABLE} to its path.`;

const LUTE_EVALUATION_TIMEOUT = 30_000;

const bootstrapErrorSchema = type({ kind: "'evaluate'", message: "string" })
	.or({ kind: "'root'", type: "string" })
	.or({ kind: "'serialize'", path: "string", type: "string" });

const bootstrapValueSchema = scope({
	table: { "[string]": "value" },
	value: "boolean | number | string | table | value[]",
})
	.type("value")
	.as<LuauLiteral>();

/** The collaborators a lute config run reaches. */
export interface LuteEvaluationContext {
	/** Runs lute. */
	childProcess: ChildProcessRunner;
	/** Environment that names the lute binary. */
	environment: NodeJS.ProcessEnv;
	/** Writes the type module and the bootstrap folder. */
	fileSystem: FileSystem;
	/** Home folder that holds the Luau Config type module. */
	homeDirectory: string;
	/** Parent of the bootstrap folder. */
	temporaryDirectory: string;
}

/** A Luau Config the static evaluator could not read. */
export interface LuteEvaluationRequest {
	/** Absolute path of the Luau Config. */
	readonly configFile: string;
	/** The first syntax the static evaluator could not read. */
	readonly unreadable: {
		/** Line of the syntax. */
		readonly line: number;
		/** Kind of the syntax. */
		readonly syntax: string;
	};
}

interface LuteRun {
	readonly error: ExecFileException | null;
	readonly stderr: string;
	readonly stdout: string;
}

/**
 * The real collaborators, with the home and temporary folders read now.
 * @returns The context of this process.
 */
export function nodeLuteEvaluationContext(): LuteEvaluationContext {
	return {
		childProcess: nodeChildProcessRunner,
		environment: process.env,
		fileSystem: nodeFileSystem,
		homeDirectory: os.homedir(),
		temporaryDirectory: os.tmpdir(),
	};
}

/**
 * Run a Luau Config through `lute run` on a bootstrap in a temporary folder.
 *
 * @param request - Config file and the syntax that needs lute.
 * @param context - Collaborators the run reaches.
 * @returns The value the config returns.
 * @rejects If lute is missing or unsupported, or the config fails in lute.
 */
export async function evaluateLuauConfigWithLute(
	request: LuteEvaluationRequest,
	context: LuteEvaluationContext,
): Promise<LuauLiteral> {
	const { configFile } = request;
	const configured = context.environment[BINARY_VARIABLE];
	const binary = configured !== undefined && configured !== "" ? configured : DEFAULT_BINARY;
	await assertLuteVersion({ binary, childProcess: context.childProcess, request });

	const typesFailure = ensureLuauConfigTypes({
		fileSystem: context.fileSystem,
		homeDirectory: context.homeDirectory,
		version: packageJson.version,
	});
	try {
		return await runBootstrap({ binary, configFile, context });
	} catch (err) {
		if (typesFailure === undefined) {
			throw err;
		}

		throw new Error(`${errorMessage(err)}\n${typesFailure.message}`, { cause: err });
	}
}

function writeBootstrap({
	configFile,
	directory,
	fileSystem,
}: {
	readonly configFile: string;
	readonly directory: string;
	readonly fileSystem: FileSystem;
}): string {
	const bootstrapFile = path.join(directory, "bootstrap.luau");
	fileSystem.writeFileSync(bootstrapFile, bootstrapSource);
	const configDirectory = path.dirname(configFile).replaceAll(path.win32.sep, "/");
	fileSystem.writeFileSync(
		path.join(directory, ".luaurc"),
		JSON.stringify({ aliases: { [CONFIG_DIRECTORY_ALIAS]: configDirectory } }),
	);

	return bootstrapFile;
}

async function runLute({
	args,
	binary,
	childProcess,
	cwd,
}: {
	readonly args: Array<string>;
	readonly binary: string;
	readonly childProcess: ChildProcessRunner;
	readonly cwd?: string;
}): Promise<LuteRun> {
	return new Promise<LuteRun>((resolve) => {
		childProcess.execFile(
			binary,
			args,
			{ cwd, encoding: "utf-8", timeout: LUTE_EVALUATION_TIMEOUT, windowsHide: true },
			// eslint-disable-next-line better-max-params/better-max-params -- Node fixes the execFile callback signature.
			(error, stdout, stderr) => {
				resolve({ error, stderr, stdout });
			},
		);
	});
}

function timeoutError(configFile: string): Error {
	return new Error(
		`Luau config ${configFile} did not finish in lute within ${String(LUTE_EVALUATION_TIMEOUT)}ms.`,
	);
}

function parseSentinelLine({
	configFile,
	start,
	stdout,
}: {
	readonly configFile: string;
	readonly start: number;
	readonly stdout: string;
}): JSONValue {
	const end = stdout.indexOf("\n", start);
	const line = end === -1 ? stdout.slice(start) : stdout.slice(start, end);
	try {
		return JSON.parse(line);
	} catch (err) {
		throw new Error(
			`Luau config ${configFile} gave lute output that is not JSON: ${errorMessage(err)}`,
			{ cause: err },
		);
	}
}

function bootstrapFailure(failure: typeof bootstrapErrorSchema.infer, configFile: string): Error {
	switch (failure.kind) {
		case "evaluate": {
			return new Error(`Luau config ${configFile} failed in lute: ${failure.message.trim()}`);
		}
		case "root": {
			return new Error(
				`Luau config ${configFile} must return a table, but it returned ${failure.type}`,
			);
		}
		case "serialize": {
			const location = failure.path === "" ? "at its root" : `at ${failure.path}`;
			return new Error(
				`Luau config ${configFile} holds ${failure.type} ${location}, which cannot cross into JSON. Move that value to a TypeScript config.`,
			);
		}
	}
}

function readBootstrapFailure(location: {
	readonly configFile: string;
	readonly start: number;
	readonly stdout: string;
}): Error {
	const failure = bootstrapErrorSchema(parseSentinelLine(location));
	if (failure instanceof type.errors) {
		return new Error(
			`Luau config ${location.configFile} gave a lute error that is not a bootstrap error: ${failure.summary}`,
		);
	}

	return bootstrapFailure(failure, location.configFile);
}

function readBootstrapOutput(run: LuteRun, configFile: string): LuauLiteral {
	if (run.error?.killed === true) {
		throw timeoutError(configFile);
	}

	const stdout = `\n${run.stdout}`;
	const valueAt = stdout.lastIndexOf(`\n${VALUE_SENTINEL}`);
	const errorAt = stdout.lastIndexOf(`\n${ERROR_SENTINEL}`);
	const sentinelAt = Math.max(valueAt, errorAt);
	if (sentinelAt === -1) {
		const output =
			run.stderr.trim() || run.stdout.trim() || (run.error?.message ?? "no output");
		throw new Error(`Luau config ${configFile} failed in lute: ${output}`);
	}

	if (sentinelAt === valueAt) {
		const value = bootstrapValueSchema(
			parseSentinelLine({ configFile, start: valueAt + 1 + VALUE_SENTINEL.length, stdout }),
		);
		if (value instanceof type.errors) {
			throw new Error(
				`Luau config ${configFile} gave lute output that is not a Luau value: ${value.summary}`,
			);
		}

		return value;
	}

	throw readBootstrapFailure({
		configFile,
		start: errorAt + 1 + ERROR_SENTINEL.length,
		stdout,
	});
}

async function runBootstrap({
	binary,
	configFile,
	context,
}: {
	readonly binary: string;
	readonly configFile: string;
	readonly context: LuteEvaluationContext;
}): Promise<LuauLiteral> {
	const { fileSystem } = context;
	const directory = fileSystem.mkdtempSync(
		path.join(context.temporaryDirectory, "jest-roblox-luau-config-"),
	);
	try {
		const run = await runLute({
			args: [
				RUN_SUBCOMMAND,
				writeBootstrap({ configFile, directory, fileSystem }),
				path.basename(configFile, ".luau"),
			],
			binary,
			childProcess: context.childProcess,
			cwd: path.dirname(configFile),
		});

		return readBootstrapOutput(run, configFile);
	} finally {
		fileSystem.rmSync(directory, { recursive: true });
	}
}

async function assertLuteVersion({
	binary,
	childProcess,
	request,
}: {
	readonly binary: string;
	readonly childProcess: ChildProcessRunner;
	readonly request: LuteEvaluationRequest;
}): Promise<void> {
	const { configFile, unreadable } = request;
	const { error, stdout } = await runLute({ args: ["--version"], binary, childProcess });
	if (error?.code === "ENOENT") {
		throw new Error(
			`Luau config ${configFile}:${String(unreadable.line)} holds ${unreadable.syntax}, which needs lute to run, and "${binary}" was not found. ${INSTALL_HINT}`,
		);
	}

	if (error?.killed === true) {
		throw timeoutError(configFile);
	}

	if (error !== null) {
		throw new Error(
			`Luau config ${configFile} needs lute, but "${binary} --version" failed: ${error.message}`,
		);
	}

	const printed = stdout.trim();
	if (!isSupportedLuteVersion(printed)) {
		throw new Error(
			`Luau config ${configFile} needs lute ${String(SUPPORTED_LUTE_MAJOR)}.x, but "${binary} --version" printed "${printed}". ${INSTALL_HINT}`,
		);
	}
}
