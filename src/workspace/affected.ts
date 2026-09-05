import { type } from "arktype";
import assert from "node:assert";
import type * as cp from "node:child_process";
import * as path from "node:path";
import process from "node:process";

import type { ChildProcessRunner } from "../utils/child-process.ts";
import { nodeChildProcessRunner } from "../utils/child-process.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { nodeFileSystem } from "../utils/file-system.ts";
import { NX_MARKER, TURBO_MARKER } from "./discovery.ts";
import { type PackageInfo, readPackageJsonName } from "./package-resolver.ts";

const JEST_CONFIG_MARKER = /^jest\.config\.[^.]+$/;

/** What the affected walk reads, and what it launches. */
export interface AffectedContext {
	/** What runs `turbo` / `nx`. Defaults to the real launcher. */
	childProcess?: ChildProcessRunner;
	/**
	 * Where the workspace markers are read. Defaults to the real filesystem.
	 */
	fileSystem?: FileSystem;
}

/** The same, with both seams settled. */
type ResolvedAffectedContext = Required<AffectedContext>;

function resolvePosixShim(fileSystem: FileSystem, binDirectory: string, command: string): string {
	const candidate = path.join(binDirectory, command);
	return fileSystem.existsSync(candidate) ? candidate : command;
}

// Build cmd.exe args for `cmd.exe /d /s /c "<command> <args>"`. Each argument
// is wrapped in double quotes — cmd metacharacters (^, &, |, <, >) are literal
// inside quotes, and `ref` is already restricted by validRefPattern so no `"`
// can appear. The outer pair of quotes around the whole command is stripped
// by /s, leaving cmd.exe to parse the inner `cmd "tok" "tok" ...` normally.
//
// The command itself MUST stay unquoted: npm-cli batch shims (turbo.cmd,
// nx.cmd) compute `%~dp0` from %0, and when cmd.exe runs a *quoted* command
// resolved via PATHEXT it sets %0 to the bare name — so `%~dp0` falls back
// to the cwd. The shim then does `node "%~dp0\..\turbo\bin\turbo"`, which
// resolves to `<cwd>\..\turbo\bin\turbo` (one directory above the workspace),
// and node errors with MODULE_NOT_FOUND. Leaving the command unquoted lets
// cmd resolve it through PATH normally and %~dp0 points at the shim's own
// directory. `command` here is a hard-coded "turbo" or "nx", so no quoting
// is required for safety.
function buildCommandExeArgs(command: string, args: Array<string>): Array<string> {
	const quotedArgs = args.map((argument) => `"${argument}"`).join(" ");
	return ["/d", "/s", "/c", `"${command} ${quotedArgs}"`];
}

// Validate only the fields we read — turbo adds top-level fields between
// versions (e.g. `packageManager`), so we tolerate unknown keys here. `path`
// is relative to the workspace root (forward or back slashes depending on
// platform) and lets us locate each package without re-walking
// pnpm-workspace.yaml ourselves.
const turboLsOutputSchema = type({
	packages: {
		items: type({ name: "string", path: "string" }).array(),
	},
});

const nxShowProjectsOutputSchema = type("string[]");

// `nx show project <name> --json` returns the full project config — name,
// root, source-root, targets, tags, etc. We only need `root`; tolerate the
// rest so nx version drift doesn't break us.
const nxShowProjectOutputSchema = type({ root: "string" });

// cspell:words metacharacter
// On Windows we invoke cmd.exe explicitly (see runTool), so any shell
// metacharacter in `ref` becomes an injection vector when interpolated into
// the turbo / nx command line. The allowed charset matches what
// git-check-ref-format permits plus `~` and `^` for revision arithmetic
// (e.g. HEAD~1, main^). A leading `-` is rejected separately so the ref
// can't be confused with a CLI flag.
const validRefPattern = /^[\w./~^-]+$/;

interface TurboPackage {
	name: string;
	relativePath: string;
}

// turbo.json takes precedence when both markers are present (hybrid monorepo).
//
// Returns full `PackageInfo` (name + absolute directory), not bare names: the
// name must match `package.json#name` so downstream resolution doesn't fail,
// and turbo/nx already hand us the directory, so resolving it here skips a
// redundant `resolvePackage` round-trip in the caller.
export function getAffectedPackages(
	workspaceRoot: string,
	ref: string,
	{ childProcess = nodeChildProcessRunner, fileSystem = nodeFileSystem }: AffectedContext = {},
): Array<PackageInfo> {
	if (!validRefPattern.test(ref) || ref.startsWith("-")) {
		throw new Error(
			`Invalid --affected-since ref ${JSON.stringify(ref)}. ` +
				"Allowed: letters, digits, _ . / ~ ^ -.",
		);
	}

	const resolved = { childProcess, fileSystem } satisfies ResolvedAffectedContext;

	if (resolved.fileSystem.existsSync(path.join(workspaceRoot, TURBO_MARKER))) {
		return resolveTurboAffected(resolved, workspaceRoot, ref);
	}

	if (resolved.fileSystem.existsSync(path.join(workspaceRoot, NX_MARKER))) {
		return resolveNxAffected(resolved, workspaceRoot, ref);
	}

	throw new Error(
		"--affected-since requires turbo or nx at the workspace root. " +
			"Use --packages to specify packages explicitly.",
	);
}

function hasJestConfig(fileSystem: FileSystem, packageDirectory: string): boolean {
	// Guard against a missing directory: turbo's package list can lag the
	// filesystem (stale cache, package deleted between turbo's read and ours),
	// and readdirSync would otherwise throw ENOENT and break the silent-drop
	// guarantee.
	if (!fileSystem.existsSync(packageDirectory)) {
		return false;
	}

	return fileSystem.readdirSync(packageDirectory).some((entry) => JEST_CONFIG_MARKER.test(entry));
}

// runTool passes `encoding: "utf8"` so child_process surfaces these as strings
// — Buffer would only appear if we dropped that option.
const toolFailureSchema = type({ "stderr?": "string", "stdout?": "string" });

type ToolFailure = typeof toolFailureSchema.infer;

function readStream(failure: ToolFailure, key: "stderr" | "stdout"): string | undefined {
	const stream = failure[key]?.trim();
	return stream !== undefined && stream.length > 0 ? stream : undefined;
}

// Reshape a failed tool invocation into a readable error. nx writes its branded
// diagnostic to stdout, not stderr, when --base references an unknown ref —
// fall back to stdout so users see it.
function toToolError(command: string, err: unknown): Error {
	if (err instanceof Error && "code" in err && err.code === "ENOENT") {
		return new Error(`${command} was not found on PATH`);
	}

	const parsed = toolFailureSchema(err);
	const failure = parsed instanceof type.errors ? {} : parsed;
	const detail = readStream(failure, "stderr") ?? readStream(failure, "stdout");
	const message = detail === undefined ? `${command} failed` : `${command} failed: ${detail}`;
	return new Error(message, { cause: err });
}

// cspell:words PATHEXT
// pnpm only prepends `node_modules/.bin` to PATH for `pnpm exec` / `pnpm run`,
// so a direct `node bin/jest-roblox.js` invocation can't see local tools.
// Resolution differs per platform:
//   - Windows: prepend the local bin to PATH and invoke cmd.exe with /d /s /c
//     so it resolves the `.cmd` shim via PATHEXT. Args are pre-quoted and
//     passed verbatim — `shell: true` with an args array trips Node 25's
//     DEP0190, and spawning the `.cmd` shim directly trips Node's
//     CVE-2024-27980 guard (EINVAL on Node 21+).
//   - POSIX: pin the absolute path of the locally installed shim. Scripts
//     in `.bin` are directly executable (`#!/usr/bin/env node`), so no
//     shell is needed and the bare-PATH lookup isn't required.
function runTool(
	{ childProcess, fileSystem }: ResolvedAffectedContext,
	command: string,
	args: Array<string>,
	cwd: string,
): string {
	const binDirectory = path.join(cwd, "node_modules", ".bin");
	const isWindows = process.platform === "win32";
	const childEnvironment = isWindows
		? { ...process.env, PATH: `${binDirectory}${path.delimiter}${process.env["PATH"]}` }
		: process.env;
	const file = isWindows ? "cmd.exe" : resolvePosixShim(fileSystem, binDirectory, command);
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

function resolveTurboAffected(
	context: ResolvedAffectedContext,
	workspaceRoot: string,
	ref: string,
): Array<PackageInfo> {
	// `--filter=...[<ref>]` = packages changed since <ref> plus their
	// dependents. That's exactly the set the user asked for.
	//
	// Don't pass `--affected` alongside it. `--affected` doesn't take a
	// ref — it auto-detects a base (GITHUB_BASE_REF, then merge-base with
	// main) and intersects with the filter. If the auto-detected base
	// differs from <ref> (common on CI where GITHUB_BASE_REF is set), the
	// intersection silently narrows the result. Some turbo versions
	// (e.g. 2.8.x) also reject the combination outright. The filter alone
	// is the precise expression of intent and works on every 2.x.
	const stdout = runTool(
		context,
		"turbo",
		["ls", `--filter=...[${ref}]`, "--output=json"],
		workspaceRoot,
	);
	// turbo names projects by `package.json#name` by convention, so the
	// name needs no further resolution — just anchor the directory. Filter
	// before mapping so dropped packages don't pay for an extra alloc.
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

// Ask nx itself where a project lives. Errors surface with the project name
// in the message regardless of failure mode (exec failure, non-JSON output,
// schema mismatch) — nx reporting an affected project it can't subsequently
// locate is a real inconsistency the user needs to see, not silently drop.
function nxProjectRoot(
	context: ResolvedAffectedContext,
	workspaceRoot: string,
	name: string,
): string {
	const errorContext = `nx show project ${JSON.stringify(name)}`;
	let parsed: JSONValue;
	try {
		const stdout = runTool(context, "nx", ["show", "project", name, "--json"], workspaceRoot);
		parsed = parseJson(stdout, "nx");
	} catch (err) {
		// Both runTool and parseJson surface failures as Error instances —
		// no need to defend against non-Error throws.
		assert(err instanceof Error);
		throw new Error(`${errorContext}: ${err.message}`, { cause: err });
	}

	const validated = nxShowProjectOutputSchema(parsed);
	if (validated instanceof type.errors) {
		throw new Error(`${errorContext}: missing root in output (${validated.summary})`);
	}

	return validated.root;
}

function resolveNxAffected(
	context: ResolvedAffectedContext,
	workspaceRoot: string,
	ref: string,
): Array<PackageInfo> {
	// nx project names live in a separate namespace from `package.json.name`,
	// so we can't map them via pnpm-workspace.yaml without false-green-ing
	// affected projects whose two names diverge. Ask nx itself for each
	// project's root via `nx show project --json`, then read the real
	// `package.json#name` there (falling back to the nx name when no
	// package.json exists). Mirrors the turbo path, which gets `path` and the
	// package name for free from `turbo ls`.
	const affected = parseNxOutput(
		runTool(
			context,
			"nx",
			["show", "projects", "--affected", `--base=${ref}`, "--json"],
			workspaceRoot,
		),
	);
	return affected.flatMap((nxName) => {
		const packageDirectory = path.join(
			workspaceRoot,
			nxProjectRoot(context, workspaceRoot, nxName),
		);
		if (!hasJestConfig(context.fileSystem, packageDirectory)) {
			return [];
		}

		// Fall back to the nx name (not the directory basename, as
		// `inferPackageName` does): a Luau-only nx project may have no
		// package.json, and the nx name is its only stable identifier.
		const name =
			readPackageJsonName(path.join(packageDirectory, "package.json"), context.fileSystem) ??
			nxName;
		return [{ name, packageDirectory }];
	});
}
