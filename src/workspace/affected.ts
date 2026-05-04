import { type } from "arktype";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { NX_MARKER, TURBO_MARKER } from "./discovery.ts";

const turboLsOutputSchema = type({
	"+": "reject",
	"packages": {
		items: type({ name: "string" }).array(),
	},
});

const nxShowProjectsOutputSchema = type("string[]");

// turbo.json takes precedence when both markers are present (hybrid monorepo).
export function getAffectedPackages(workspaceRoot: string, ref: string): Array<string> {
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

function readStderr(err: unknown): string | undefined {
	if (!(err instanceof Error) || !("stderr" in err)) {
		return undefined;
	}

	// runTool passes `encoding: "utf8"` so child_process surfaces stderr as a
	// string — Buffer would only appear if we dropped that option.
	const { stderr } = err;
	return typeof stderr === "string" ? stderr.trim() : undefined;
}

function runTool(command: string, args: Array<string>, cwd: string): string {
	try {
		return cp.execFileSync(command, args, { cwd, encoding: "utf8", stdio: "pipe" });
	} catch (err) {
		if (err instanceof Error && "code" in err && err.code === "ENOENT") {
			throw new Error(`${command} was not found on PATH`);
		}

		const stderr = readStderr(err);
		const message =
			stderr !== undefined && stderr.length > 0
				? `${command} failed: ${stderr}`
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
