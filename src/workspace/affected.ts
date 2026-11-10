import { type } from "arktype";
import assert from "node:assert";
import type * as cp from "node:child_process";
import * as path from "node:path";
import process from "node:process";

import type { ChildProcessRunner } from "../utils/child-process.ts";
import { isFileNotFound } from "../utils/file-not-found.ts";
import type { FileSystem } from "../utils/file-system.ts";
import type { PackageInfo } from "./package-resolver.ts";
import { readPackageJsonName } from "./pnpm-packages.ts";
import { NX_MARKER, TURBO_MARKER } from "./workspace-root.ts";

const JEST_CONFIG_MARKER = /^jest\.config\.[^.]+$/;

/** What the affected walk reads, and what it launches. */
export interface AffectedContext {
	/** What runs `turbo` / `nx`. */
	childProcess: ChildProcessRunner;
	/** Where the workspace markers are read. */
	fileSystem: FileSystem;
}

interface AffectedTarget {
	readonly ref: string;
	readonly workspaceRoot: string;
}

interface ToolInvocation {
	readonly args: Array<string>;
	readonly command: string;
	readonly cwd: string;
}

function resolvePosixShim({
	binDirectory,
	command,
	fileSystem,
}: {
	readonly binDirectory: string;
	readonly command: string;
	readonly fileSystem: FileSystem;
}): string {
	const candidate = path.join(binDirectory, command);
	return fileSystem.existsSync(candidate) ? candidate : command;
}

/**
 * Args rely on `validRefPattern` to keep `"` out. Keep `command` unquoted: a
 * quoted name breaks `%~dp0` in npm `.cmd` shims.
 *
 * @param command - Bare tool name, `turbo` or `nx`.
 * @param args - Tool arguments, each quoted.
 * @returns The cmd.exe argument list.
 */
function buildCommandExeArgs(command: string, args: Array<string>): Array<string> {
	const quotedArgs = args.map((argument) => `"${argument}"`).join(" ");
	return ["/d", "/s", "/c", `"${command} ${quotedArgs}"`];
}

const turboLsOutputSchema = type({
	packages: {
		items: type({ name: "string", path: "string" }).array(),
	},
});

const nxShowProjectsOutputSchema = type("string[]");

const nxShowProjectOutputSchema = type({ root: "string" });

// Guards `ref` against injection into the cmd.exe line `runTool` builds.
const validRefPattern = /^[\w./~^-]+$/;

interface TurboPackage {
	name: string;
	relativePath: string;
}

/**
 * The packages turbo or nx report as affected since `ref`.
 * @param options - Workspace root, ref and process seams.
 * @param options.childProcess - Runner that spawns turbo or nx.
 * @param options.fileSystem - File system that finds the workspace marker.
 * @param options.ref - Git ref to compare against.
 * @param options.workspaceRoot - Workspace root directory.
 * @returns Each affected package with its absolute directory.
 * @throws {Error} When the ref is invalid or turbo or nx fails.
 */
export function getAffectedPackages({
	childProcess,
	fileSystem,
	ref,
	workspaceRoot,
}: AffectedContext & AffectedTarget): Array<PackageInfo> {
	if (!validRefPattern.test(ref) || ref.startsWith("-")) {
		throw new Error(
			`Invalid --affected-since ref ${JSON.stringify(ref)}. ` +
				"Allowed: letters, digits, _ . / ~ ^ -.",
		);
	}

	if (fileSystem.existsSync(path.join(workspaceRoot, TURBO_MARKER))) {
		return resolveTurboAffected({ childProcess, fileSystem, ref, workspaceRoot });
	}

	if (fileSystem.existsSync(path.join(workspaceRoot, NX_MARKER))) {
		return resolveNxAffected({ childProcess, fileSystem, ref, workspaceRoot });
	}

	throw new Error(
		"--affected-since requires turbo or nx at the workspace root. " +
			"Use --packages to specify packages explicitly.",
	);
}

function hasJestConfig(fileSystem: FileSystem, packageDirectory: string): boolean {
	if (!fileSystem.existsSync(packageDirectory)) {
		return false;
	}

	return fileSystem.readdirSync(packageDirectory).some((entry) => JEST_CONFIG_MARKER.test(entry));
}

// Strings only because `runTool` passes `encoding: "utf8"`.
const toolFailureSchema = type({ "stderr?": "string", "stdout?": "string" });

type ToolFailure = typeof toolFailureSchema.infer;

function readStream(failure: ToolFailure, key: "stderr" | "stdout"): string | undefined {
	const stream = failure[key]?.trim();
	return stream !== undefined && stream.length > 0 ? stream : undefined;
}

function toToolError(command: string, err: unknown): Error {
	if (isFileNotFound(err)) {
		return new Error(`${command} was not found on PATH`);
	}

	const parsed = toolFailureSchema(err);
	const failure = parsed instanceof type.errors ? {} : parsed;
	const detail = readStream(failure, "stderr") ?? readStream(failure, "stdout");
	const message = detail === undefined ? `${command} failed` : `${command} failed: ${detail}`;
	return new Error(message, { cause: err });
}

/**
 * Windows goes through cmd.exe: `shell: true` with args trips Node DEP0190,
 * and spawning a `.cmd` directly trips the CVE-2024-27980 guard (EINVAL).
 *
 * @param invocation - Tool, arguments, working directory and process seams.
 * @returns The tool's stdout.
 */
function runTool({
	args,
	childProcess,
	command,
	cwd,
	fileSystem,
}: AffectedContext & ToolInvocation): string {
	const binDirectory = path.join(cwd, "node_modules", ".bin");
	const isWindows = process.platform === "win32";
	const childEnvironment = isWindows
		? { ...process.env, PATH: `${binDirectory}${path.delimiter}${process.env["PATH"]}` }
		: process.env;
	const file = isWindows ? "cmd.exe" : resolvePosixShim({ binDirectory, command, fileSystem });
	const spawnArgs = isWindows ? buildCommandExeArgs(command, args) : args;
	const options = {
		cwd,
		encoding: "utf8",
		env: childEnvironment,
		shell: false,
		stdio: "pipe",
	} satisfies cp.ExecFileSyncOptionsWithStringEncoding;
	const windowsOptions = { ...options, windowsVerbatimArguments: true } satisfies cp.SpawnOptions;
	try {
		return isWindows
			? childProcess.execFileSync(file, spawnArgs, {
					...windowsOptions,
					windowsHide: true,
				})
			: childProcess.execFileSync(file, spawnArgs, {
					...options,
					windowsHide: true,
				});
	} catch (err) {
		throw toToolError(command, err);
	}
}

function parseJson(stdout: string, command: string): JSONValue {
	try {
		return JSON.parse(stdout);
	} catch (err) {
		throw new Error(`${command} returned non-JSON output: ${stdout.slice(0, 200)}`, {
			cause: err,
		});
	}
}

function parseTurboOutput(stdout: string): Array<TurboPackage> {
	const validated = turboLsOutputSchema(parseJson(stdout, "turbo"));
	if (validated instanceof type.errors) {
		throw new Error(`Unexpected turbo ls output: ${validated.summary}`);
	}

	return validated.packages.items.map((item) => ({ name: item.name, relativePath: item.path }));
}

function resolveTurboAffected({
	ref,
	workspaceRoot,
	...context
}: AffectedContext & AffectedTarget): Array<PackageInfo> {
	// No `--affected`: it narrows to its own base, and turbo 2.8.x rejects it
	// with `--filter`.
	const stdout = runTool({
		...context,
		args: ["ls", `--filter=...[${ref}]`, "--output=json"],
		command: "turbo",
		cwd: workspaceRoot,
	});
	return parseTurboOutput(stdout)
		.filter((item) => {
			return hasJestConfig(context.fileSystem, path.join(workspaceRoot, item.relativePath));
		})
		.map((item) => {
			return {
				name: item.name,
				packageDirectory: path.join(workspaceRoot, item.relativePath),
			};
		});
}

function parseNxOutput(stdout: string): Array<string> {
	const validated = nxShowProjectsOutputSchema(parseJson(stdout, "nx"));
	if (validated instanceof type.errors) {
		throw new Error(`Unexpected nx show projects output: ${validated.summary}`);
	}

	return validated;
}

function nxProjectRoot({
	name,
	workspaceRoot,
	...context
}: AffectedContext & {
	readonly name: string;
	readonly workspaceRoot: string;
}): string {
	const errorContext = `nx show project ${JSON.stringify(name)}`;
	let parsed: JSONValue;
	try {
		const stdout = runTool({
			...context,
			args: ["show", "project", name, "--json"],
			command: "nx",
			cwd: workspaceRoot,
		});
		parsed = parseJson(stdout, "nx");
	} catch (err) {
		assert(err instanceof Error);
		throw new Error(`${errorContext}: ${err.message}`, { cause: err });
	}

	const validated = nxShowProjectOutputSchema(parsed);
	if (validated instanceof type.errors) {
		throw new Error(`${errorContext}: missing root in output (${validated.summary})`);
	}

	return validated.root;
}

function resolveNxAffected({
	ref,
	workspaceRoot,
	...context
}: AffectedContext & AffectedTarget): Array<PackageInfo> {
	const affected = parseNxOutput(
		runTool({
			...context,
			args: ["show", "projects", "--affected", `--base=${ref}`, "--json"],
			command: "nx",
			cwd: workspaceRoot,
		}),
	);
	return affected.flatMap((nxName) => {
		const packageDirectory = path.join(
			workspaceRoot,
			nxProjectRoot({ ...context, name: nxName, workspaceRoot }),
		);
		if (!hasJestConfig(context.fileSystem, packageDirectory)) {
			return [];
		}

		const name =
			readPackageJsonName(path.join(packageDirectory, "package.json"), context.fileSystem) ??
			nxName;
		return [{ name, packageDirectory }];
	});
}
