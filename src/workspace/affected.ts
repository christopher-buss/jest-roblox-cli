import { type } from "arktype";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import process from "node:process";

import { NX_MARKER, TURBO_MARKER } from "./discovery.ts";

function resolvePosixShim(binDirectory: string, command: string): string {
	const candidate = path.join(binDirectory, command);
	return fs.existsSync(candidate) ? candidate : command;
}

// Validate only the fields we read — turbo adds top-level fields between
// versions (e.g. `packageManager`), so we tolerate unknown keys here.
const turboLsOutputSchema = type({
	packages: {
		items: type({ name: "string" }).array(),
	},
});

const nxShowProjectsOutputSchema = type("string[]");

// cspell:words metacharacter
// On Windows we route through cmd.exe via `shell: true`, so any shell
// metacharacter in `ref` becomes an injection vector when interpolated into
// the turbo / nx command line. The allowed charset matches what
// git-check-ref-format permits plus `~` and `^` for revision arithmetic
// (e.g. HEAD~1, main^). A leading `-` is rejected separately so the ref
// can't be confused with a CLI flag.
const validRefPattern = /^[\w./~^-]+$/;

// turbo.json takes precedence when both markers are present (hybrid monorepo).
export function getAffectedPackages(workspaceRoot: string, ref: string): Array<string> {
	if (!validRefPattern.test(ref) || ref.startsWith("-")) {
		throw new Error(
			`Invalid --affected-since ref ${JSON.stringify(ref)}. ` +
				"Allowed: letters, digits, _ . / ~ ^ -.",
		);
	}

	if (fs.existsSync(path.join(workspaceRoot, TURBO_MARKER))) {
		const stdout = runTool(
			"turbo",
			["ls", "--affected", `--filter=...[${ref}]`, "--output=json"],
			workspaceRoot,
		);
		return parseTurboOutput(stdout);
	}

	if (fs.existsSync(path.join(workspaceRoot, NX_MARKER))) {
		const stdout = runTool(
			"nx",
			["show", "projects", "--affected", `--base=${ref}`, "--json"],
			workspaceRoot,
		);
		return parseNxOutput(stdout);
	}

	throw new Error(
		"--affected-since requires turbo or nx at the workspace root. " +
			"Use --packages to specify packages explicitly.",
	);
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
//   - Windows: prepend the local bin to PATH and let cmd.exe resolve the
//     binary via PATHEXT (this is what `shell: true` opts into). We can't
//     spawn the `.cmd` shim directly without a shell — Node's
//     CVE-2024-27980 guard rejects it with EINVAL on Node 21+.
//   - POSIX: pin the absolute path of the locally installed shim. Scripts
//     in `.bin` are directly executable (`#!/usr/bin/env node`), so no
//     shell is needed and the bare-PATH lookup isn't required.
function runTool(command: string, args: Array<string>, cwd: string): string {
	const binDirectory = path.join(cwd, "node_modules", ".bin");
	const isWindows = process.platform === "win32";
	const file = isWindows ? command : resolvePosixShim(binDirectory, command);
	const childEnvironment = isWindows
		? { ...process.env, PATH: `${binDirectory}${path.delimiter}${process.env["PATH"]}` }
		: process.env;
	try {
		return cp.execFileSync(file, args, {
			cwd,
			encoding: "utf8",
			env: childEnvironment,
			shell: isWindows,
			stdio: "pipe",
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

function parseTurboOutput(stdout: string): Array<string> {
	const validated = turboLsOutputSchema(parseJson(stdout, "turbo"));
	if (validated instanceof type.errors) {
		throw new Error(`Unexpected turbo ls output: ${validated.summary}`);
	}

	return validated.packages.items.map((item) => item.name);
}

function parseNxOutput(stdout: string): Array<string> {
	const validated = nxShowProjectsOutputSchema(parseJson(stdout, "nx"));
	if (validated instanceof type.errors) {
		throw new Error(`Unexpected nx show projects output: ${validated.summary}`);
	}

	return validated;
}
