import { type } from "arktype";
import { Buffer } from "node:buffer";
import { execFile, execFileSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import nodeProcess from "node:process";
import { onTestFinished } from "vitest";

import type { JestResult } from "../../../src/types/jest-result.ts";

export interface JestEnvelopePayload {
	runner: { setup: number };
	success: true;
	value: JestResult;
}

interface ExecResult {
	exitCode: number;
	stderr: string;
	stdout: string;
}

interface RunCliOptions {
	cwd?: string;
	env?: Record<string, string | undefined>;
	timeoutMs?: number;
}

const BIN = path.resolve(__dirname, "../../../bin/jest-roblox.js");

const mergedResultSchema = type({ testResults: type({ testFilePath: "string" }).array() });

// runCli passes `encoding: "utf-8"`, so the thrown failure carries the captured
// streams as strings — Buffer would only appear if we dropped that option.
const execFailureSchema = type({
	"status?": "number | null",
	"stderr?": "string",
	"stdout?": "string",
});

// cspell:ignore LOCALAPPDATA MSYSTEM PATHEXT PROGRAMDATA WINDIR
const ALLOWED_ENV_VARS = [
	"APPDATA",
	"CI",
	"ComSpec",
	"HOME",
	"JEST_ROBLOX_OCALE_MAX_RETRIES",
	"LOCALAPPDATA",
	"MSYSTEM",
	"NODE_OPTIONS",
	"NUMBER_OF_PROCESSORS",
	"PATH",
	"PATHEXT",
	"PNPM_HOME",
	"PROGRAMDATA",
	"ProgramData",
	"ProgramFiles",
	"ProgramFiles(x86)",
	"SystemDrive",
	"SystemRoot",
	"TEMP",
	"TERM",
	"TMP",
	"USERPROFILE",
	"WINDIR",
] as const;

export function runCli(args: Array<string>, cwdOrOptions?: RunCliOptions | string): ExecResult {
	const options = typeof cwdOrOptions === "string" ? { cwd: cwdOrOptions } : (cwdOrOptions ?? {});

	try {
		const stdout = execFileSync("node", [BIN, ...withIsolatedBackendPort(args)], {
			cwd: options.cwd,
			encoding: "utf-8",
			env: buildCliEnvironment(options.env),
			timeout: options.timeoutMs ?? 30_000,
			windowsHide: true,
		});
		return { exitCode: 0, stderr: "", stdout };
	} catch (err) {
		const failure = execFailureSchema(err);
		if (failure instanceof type.errors) {
			return { exitCode: 1, stderr: "", stdout: "" };
		}

		return {
			exitCode: failure.status ?? 1,
			stderr: failure.stderr ?? "",
			stdout: failure.stdout ?? "",
		};
	}
}

export async function runCliAsync(
	args: Array<string>,
	cwdOrOptions?: RunCliOptions | string,
): Promise<ExecResult> {
	const options = typeof cwdOrOptions === "string" ? { cwd: cwdOrOptions } : (cwdOrOptions ?? {});

	return new Promise((resolve) => {
		execFile(
			"node",
			[BIN, ...withIsolatedBackendPort(args)],
			{
				cwd: options.cwd,
				encoding: "utf-8",
				env: buildCliEnvironment(options.env),
				maxBuffer: 16 * 1024 * 1024,
				timeout: options.timeoutMs ?? 30_000,
				windowsHide: true,
			},
			(error, stdout, stderr) => {
				if (error === null) {
					resolve({ exitCode: 0, stderr, stdout });
					return;
				}

				const status = "code" in error ? error.code : undefined;

				resolve({
					exitCode: typeof status === "number" ? status : 1,
					stderr,
					stdout,
				});
			},
		);
	});
}

export function readJsonSync(filePath: string): JSONValue {
	return JSON.parse(readFileSync(filePath, "utf-8"));
}

/**
 * Whether rojo can be shelled out to. The specs that build a real place gate on
 * it, because a machine without rojo should skip them rather than fail them.
 *
 * Rojo is the only place builder: `buildWithRojo` shells `rojo build` and
 * throws "rojo was not found on PATH" with no fallback. Some of these specs
 * used to gate on `rojo || lute`, which would have let a lute-only machine
 * reach a build that could not run — lute is the coverage instrumenter and the
 * Luau config loader, and never builds a place.
 *
 * Memoized because the probe sits in `it.skipIf(...)`, which every `it`
 * evaluates at collection: 15 spawns of `rojo --version` across the suite, at
 * roughly 200ms each on Windows, to answer one unchanging question. Vitest
 * isolates each spec file in its own worker, so the answer is cached per file
 * and installing rojo mid-run is still picked up by the next one.
 */
export function rojoOnPath(): boolean {
	isRojoOnPath ??= probeRojo();
	return isRojoOnPath;
}

let isRojoOnPath: boolean | undefined;

/**
 * The `testFilePath`s of a merged result sink (`--outputFile`), validated
 * against the one field the type-test e2e specs read rather than asserted onto
 * the parsed JSON.
 */
export function readMergedTestFilePaths(filePath: string): Array<string> {
	const merged = mergedResultSchema.assert(readJsonSync(filePath));
	return merged.testResults.map((file) => file.testFilePath);
}

function probeRojo(): boolean {
	try {
		execFileSync("rojo", ["--version"], { stdio: "pipe", windowsHide: true });
		return true;
	} catch {
		return false;
	}
}

/**
 * What a previous run wrote into a fixture, rather than what the fixture is.
 * The specs that drive the CLI at a fixture path directly (rather than at a
 * sandbox) leave these behind, and they are gitignored, so which of them exist
 * depends on what ran on this machine before.
 *
 * Copying them into a sandbox is how a spec ends up asserting on an artifact it
 * did not produce: `.jest-roblox/cache/<mount>/jest.config.luau` is a generated
 * stub, so a spec that checks the CLI generated one would pass against a stale
 * copy with generation entirely broken.
 */
const FIXTURE_RUN_ARTIFACTS = new Set([".jest-roblox", "coverage"]);

export function createFixtureSandbox(sourcePath: string): string {
	const sandboxRoot = path.resolve(__dirname, ".tmp");
	mkdirSync(sandboxRoot, { recursive: true });
	const directory = mkdtempSync(path.join(sandboxRoot, "jest-roblox-cli-e2e-"));
	const sandboxPath = path.join(directory, path.basename(sourcePath));
	cpSync(sourcePath, sandboxPath, {
		filter: (source) => !FIXTURE_RUN_ARTIFACTS.has(path.basename(source)),
		recursive: true,
	});
	absolutizeEscapingProjectPaths(sourcePath, sandboxPath);
	onTestFinished(() => {
		rmSync(directory, { force: true, recursive: true });
	});
	return sandboxPath;
}

export function createRbxtsFixtureSandbox(sourcePath: string): string {
	const sandboxPath = createFixtureSandbox(sourcePath);
	const outDirectory = path.join(sandboxPath, "out");

	mkdirSync(outDirectory, { recursive: true });
	writeFileSync(path.join(sandboxPath, "game.rbxl"), Buffer.from("fake-rbxl-place", "utf-8"));
	writeFileSync(path.join(outDirectory, "example.luau"), RBXTS_EXAMPLE_LUAU);
	writeFileSync(path.join(outDirectory, "example.luau.map"), RBXTS_EXAMPLE_LUAU_MAP);
	writeFileSync(path.join(outDirectory, "example.spec.luau"), RBXTS_EXAMPLE_SPEC_LUAU);
	writeFileSync(path.join(outDirectory, "example.spec.luau.map"), RBXTS_EXAMPLE_SPEC_LUAU_MAP);
	writeFileSync(
		path.join(outDirectory, "example.d.ts"),
		"export declare function greet(name: string): string;\nexport declare function add(a: number, b: number): number;\n",
	);
	writeFileSync(path.join(outDirectory, "example.spec.d.ts"), "export {};\n");
	writeFileSync(path.join(outDirectory, "jest.config.luau"), RBXTS_JEST_CONFIG_LUAU);

	return sandboxPath;
}

function rewriteEscapingPaths(
	node: JSONValue,
	sourceResolved: string,
	sandboxResolved: string,
): void {
	if (node === null || typeof node !== "object" || Array.isArray(node)) {
		return;
	}

	const value = node["$path"];
	if (typeof value === "string" && !path.isAbsolute(value)) {
		const absolute = path.resolve(sourceResolved, value);
		const relativeFromSource = path.relative(sourceResolved, absolute);
		if (relativeFromSource.startsWith("..") || path.isAbsolute(relativeFromSource)) {
			const fromSandbox = path.relative(sandboxResolved, absolute).replaceAll("\\", "/");
			node["$path"] = fromSandbox;
		}
	}

	for (const child of Object.values(node)) {
		rewriteEscapingPaths(child, sourceResolved, sandboxResolved);
	}
}

// Rojo project files use `$path` values relative to the project file. When a
// fixture references siblings outside its own directory (e.g. `rojo-sync/`),
// the relative path is calibrated to the fixture's location in the repo —
// copying the fixture to a temp sandbox at a different depth breaks those
// references. For each `$path` that escapes the source fixture, rewrite it
// to a sandbox-relative path that points back at the original target.
// Sandbox-relative (rather than absolute) lets downstream consumers like the
// coverage rewriter still relocate the project tree without mangling the path.
function absolutizeEscapingProjectPaths(sourceDirectory: string, sandboxDirectory: string): void {
	const projectFile = path.join(sandboxDirectory, "default.project.json");
	if (!existsSync(projectFile)) {
		return;
	}

	const sourceResolved = path.resolve(sourceDirectory);
	const sandboxResolved = path.resolve(sandboxDirectory);
	const raw = JSON.parse(readFileSync(projectFile, "utf-8"));

	rewriteEscapingPaths(raw, sourceResolved, sandboxResolved);
	writeFileSync(projectFile, `${JSON.stringify(raw, null, "\t")}\n`);
}

// The `auto` backend opens a WebSocket server on the configured port and waits
// for a Studio plugin to connect. A developer's running Studio connects to the
// fixed default port, so e2e runs flakily detect it and route to the Studio
// backend (or hang). Binding the probe to an ephemeral port (0) — which no
// Studio plugin knows to dial — makes `auto` deterministically fall through to
// Open Cloud. Callers that need a real port pass their own `--port` and opt out.
function withIsolatedBackendPort(args: Array<string>): Array<string> {
	const hasPort = args.some(
		(argument) => argument === "--port" || argument.startsWith("--port="),
	);
	return hasPort ? args : ["--port", "0", ...args];
}

/* eslint-disable unicorn/no-incorrect-template-string-interpolation -- Luau `{name}` interpolation syntax, not a JS placeholder; fixture text for a compiled Luau file, must stay byte-exact */
const RBXTS_EXAMPLE_LUAU = `-- Compiled with @isentinel/roblox-ts v3.1.5
local function greet(name)
	return \`hello {name}\`
end
local function add(a, b)
	return a + b
end
return {
	greet = greet,
	add = add,
}
`;
/* eslint-enable unicorn/no-incorrect-template-string-interpolation */

// cspell:ignore AACC AACD AAEA AACA
const RBXTS_EXAMPLE_LUAU_MAP = JSON.stringify({
	file: "example.luau",
	ignoreList: [],
	mappings: ";AAAA;AACC;AACD;AAEA;AACC;AACD",
	names: [],
	sources: ["../src/example.ts"],
	sourcesContent: [
		"export function greet(name: string): string {\n\treturn `hello ${" +
			"name}`;\n}\n\nexport function add(a: number, b: number): number {\n\treturn a + b;\n}\n",
	],
	version: 3,
});

const RBXTS_EXAMPLE_SPEC_LUAU = `-- Compiled with @isentinel/roblox-ts v3.1.5
local TS = _G[script]
local _example = TS.import(script, script.Parent, "example")
local add = _example.add
local greet = _example.greet
local result = greet("Alice")
print(result)
local sum = add(2, 3)
print(sum)
`;

const RBXTS_EXAMPLE_SPEC_LUAU_MAP = JSON.stringify({
	file: "example.spec.luau",
	ignoreList: [],
	mappings: ";;AAAA;AAAA;AAAA;AAEA;AACA;AAEA;AACA",
	names: [],
	sources: ["../src/example.spec.ts"],
	sourcesContent: [
		'import { add, greet } from "./example";\n\nconst result = greet("Alice");\nprint(result);\n\nconst sum = add(2, 3);\nprint(sum);\n',
	],
	version: 3,
});

const RBXTS_JEST_CONFIG_LUAU = `-- Auto-generated by jest-roblox (do not edit)
return {
	color = true,
	passWithNoTests = true,
	silent = false,
	testMatch = { "**/*.spec" },
	testPathIgnorePatterns = { "/node_modules/", "/dist/", "/out/" },
	verbose = false,
	displayName = "rbxts-e2e",
}
`;

/**
 * Mixed stdout the Luau runner produces around the Jest JSON payload —
 * exercises `extractJsonFromOutput`'s log-noise stripping.
 */
export function buildMixedOutput(payload: JestEnvelopePayload): string {
	return [
		"Booting fake Roblox runner",
		JSON.stringify(payload),
		"Finished fake Roblox runner",
	].join("\n");
}

/** A minimal passing single-suite Jest payload in the runner's wire shape. */
// eslint-disable-next-line flawless/max-lines-per-function -- Returns a cohesive single object; splitting would scatter the fields and make it harder to see the shape.
export function buildPassingPayload(): JestEnvelopePayload {
	return {
		runner: {
			setup: 0.1,
		},
		success: true,
		value: {
			numFailedTests: 0,
			numPassedTests: 1,
			numPendingTests: 0,
			numTotalTests: 1,
			startTime: 1_710_000_000_000,
			success: true,
			testResults: [
				{
					numFailingTests: 0,
					numPassingTests: 1,
					numPendingTests: 0,
					testFilePath: "ReplicatedStorage/shared/example.spec",
					testResults: [
						{
							ancestorTitles: ["example"],
							duration: 12,
							failureMessages: [],
							fullName: "example greets",
							status: "passed",
							title: "greets",
						},
					],
				},
			],
		},
	};
}

/**
 * The serialized Jest payload a `FakeOpenCloudTask` carries when the run under
 * test only needs the task to succeed. Counts, not results — a spec asserting
 * on pipeline shape reads `1 passed` and the server-side call record, never the
 * suite bodies.
 */
export function buildPassingJestOutput(): string {
	return JSON.stringify({
		numFailedTests: 0,
		numPassedTests: 1,
		numPendingTests: 0,
		numTotalTests: 1,
		startTime: 0,
		success: true,
		testResults: [],
	});
}

/** Env vars pointing the CLI's open-cloud backend at a fake server. */
export function createOpenCloudEnvironment(baseUrl: string): NonNullable<RunCliOptions["env"]> {
	return {
		JEST_ROBLOX_OPEN_CLOUD_BASE_URL: baseUrl,
		ROBLOX_OPEN_CLOUD_API_KEY: "test-api-key",
		ROBLOX_PLACE_ID: "456",
		ROBLOX_UNIVERSE_ID: "123",
	};
}

function buildCliEnvironment(overrides?: Record<string, string | undefined>): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = { FORCE_COLOR: "0", NO_COLOR: "1" };

	for (const key of ALLOWED_ENV_VARS) {
		const value = nodeProcess.env[key];
		if (value !== undefined) {
			environment[key] = value;
		}
	}

	const overrideEntries = Object.entries(overrides ?? {});
	for (const [key, value] of overrideEntries) {
		if (value === undefined) {
			delete environment[key];
		} else {
			environment[key] = value;
		}
	}

	return environment;
}
