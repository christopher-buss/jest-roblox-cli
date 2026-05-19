import { type } from "arktype";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import process from "node:process";

import { NX_MARKER, TURBO_MARKER } from "./discovery.ts";
import { listPackages } from "./package-resolver.ts";

const JEST_CONFIG_MARKER = /^jest\.config\.[^.]+$/;

function resolvePosixShim(binDirectory: string, command: string): string {
	const candidate = path.join(binDirectory, command);
	return fs.existsSync(candidate) ? candidate : command;
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
function buildCmdExeArgs(command: string, args: Array<string>): Array<string> {
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
export function getAffectedPackages(workspaceRoot: string, ref: string): Array<string> {
	if (!validRefPattern.test(ref) || ref.startsWith("-")) {
		throw new Error(
			`Invalid --affected-since ref ${JSON.stringify(ref)}. ` +
				"Allowed: letters, digits, _ . / ~ ^ -.",
		);
	}

	if (fs.existsSync(path.join(workspaceRoot, TURBO_MARKER))) {
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
			"turbo",
			["ls", `--filter=...[${ref}]`, "--output=json"],
			workspaceRoot,
		);
		return parseTurboOutput(stdout)
			.filter((item) => hasJestConfig(path.join(workspaceRoot, item.relativePath)))
			.map((item) => item.name);
	}

	if (fs.existsSync(path.join(workspaceRoot, NX_MARKER))) {
		const stdout = runTool(
			"nx",
			["show", "projects", "--affected", `--base=${ref}`, "--json"],
			workspaceRoot,
		);
		return filterJestRobloxByName(workspaceRoot, parseNxOutput(stdout));
	}

	throw new Error(
		"--affected-since requires turbo or nx at the workspace root. " +
			"Use --packages to specify packages explicitly.",
	);
}

function hasJestConfig(packageDirectory: string): boolean {
	// Guard against a missing directory: turbo's package list can lag the
	// filesystem (stale cache, package deleted between turbo's read and ours),
	// and readdirSync would otherwise throw ENOENT and break the silent-drop
	// guarantee.
	if (!fs.existsSync(packageDirectory)) {
		return false;
	}

	return fs.readdirSync(packageDirectory).some((entry) => JEST_CONFIG_MARKER.test(entry));
}

function hasStringField<K extends string>(value: unknown, key: K): value is Record<K, string> {
	return (
		value !== null &&
		typeof value === "object" &&
		key in value &&
		typeof Reflect.get(value, key) === "string"
	);
}

function readStream(err: unknown, key: "stderr" | "stdout"): string | undefined {
	// runTool passes `encoding: "utf8"` so child_process surfaces these as
	// strings — Buffer would only appear if we dropped that option.
	if (!hasStringField(err, key)) {
		return undefined;
	}

	return err[key].trim();
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
function runTool(command: string, args: Array<string>, cwd: string): string {
	const binDirectory = path.join(cwd, "node_modules", ".bin");
	const isWindows = process.platform === "win32";
	const childEnvironment = isWindows
		? { ...process.env, PATH: `${binDirectory}${path.delimiter}${process.env["PATH"]}` }
		: process.env;
	const file = isWindows ? "cmd.exe" : resolvePosixShim(binDirectory, command);
	const spawnArgs = isWindows ? buildCmdExeArgs(command, args) : args;
	try {
		return cp.execFileSync(file, spawnArgs, {
			cwd,
			encoding: "utf8",
			env: childEnvironment,
			shell: false,
			stdio: "pipe",
			windowsHide: true,
			...(isWindows ? { windowsVerbatimArguments: true } : {}),
		});
	} catch (err) {
		if (err instanceof Error && "code" in err && err.code === "ENOENT") {
			throw new Error(`${command} was not found on PATH`);
		}

		// nx writes its branded diagnostic to stdout, not stderr, when --base
		// references an unknown ref — fall back to stdout so users see it.
		const stderr = readStream(err, "stderr");
		const detail =
			stderr !== undefined && stderr.length > 0 ? stderr : readStream(err, "stdout");
		const message =
			detail !== undefined && detail.length > 0
				? `${command} failed: ${detail}`
				: `${command} failed`;
		throw new Error(message, { cause: err });
	}
}

function parseJson(stdout: string, command: string): unknown {
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

function parseNxOutput(stdout: string): Array<string> {
	const validated = nxShowProjectsOutputSchema(parseJson(stdout, "nx"));
	if (validated instanceof type.errors) {
		throw new Error(`Unexpected nx show projects output: ${validated.summary}`);
	}

	return validated;
}

// nx's `show projects --affected` returns project names only — no path, so
// we map each name to its directory via pnpm-workspace.yaml and keep only
// those with a jest.config.*. The turbo path above doesn't go through here
// because turbo's JSON already includes each package's `path`, letting us
// skip the workspace round-trip entirely.
//
// Anything else (non-Roblox packages, nx project names that don't match a
// package.json name, etc.) is dropped silently — workspaces commonly contain
// non-jest tooling/libs we don't run.
function filterJestRobloxByName(workspaceRoot: string, names: Array<string>): Array<string> {
	if (names.length === 0) {
		// Avoid the pnpm-workspace.yaml read + glob walk when there's nothing
		// to filter. Common in CI where most pushes touch zero packages.
		return names;
	}

	const directoryByName = new Map(
		listPackages(workspaceRoot).map((info) => [info.name, info.packageDirectory]),
	);

	return names.filter((name) => {
		const directory = directoryByName.get(name);
		return directory !== undefined && hasJestConfig(directory);
	});
}
